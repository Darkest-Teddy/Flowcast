import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { mobilityAt } from '../src/data/mobility.ts';

function fixture() {
  const site = { id:'site', name:'Campus street', campus:'charles-river', position:[-71.1,42.35], observedFrom:'2026-06-10', observedTo:'2026-06-17' };
  return {
    schemaVersion:1, generatedAt:'2026-10-24',
    roads:{sourceUrl:'https://www.boston.gov',locations:[{...site,profiles:[
      {weekday:2,hour:8,direction:'Eastbound',motorVehicles:100,bikes:20,samples:2},
      {weekday:2,hour:8,direction:'Westbound',motorVehicles:300,bikes:40,samples:1},
      {weekday:2,hour:9,direction:'Eastbound',motorVehicles:0,bikes:0,samples:1},
    ]}]},
    pedestrians:{sourceUrl:'https://www.bu.edu',locations:[{...site,profiles:[{weekday:null,weekdays:[2,3],hour:8,pedestrians:548,samples:1}]}]},
    bluebikes:{sourceUrl:'https://bluebikes.com',period:{start:'2026-09-01',end:'2026-09-30'},
      stations:[{id:'A',name:'Dock A',campus:'charles-river',position:[-71.1,42.35]},{id:'B',name:'Dock B',campus:'charles-river',position:[-71.11,42.35]}],
      flows:[{from:'A',to:'B',weekday:0,hour:8,trips:2,days:4,meanDurationSec:300}]},
  };
}

test('road volume sums directional means, not survey sample counts',()=>{
  const view = mobilityAt(fixture(),'roads','charles-river',2,8*3600);
  assert.equal(view.points[0].value,400);
  assert.equal(view.points[0].bikes,60);
  assert.match(view.points[0].details,/Eastbound: 100 vehicles\/h/);
});

test('missing weekdays or hours stay absent while a measured zero remains visible',()=>{
  const data=fixture();
  assert.equal(mobilityAt(data,'roads','charles-river',1,8*3600).points.length,0);
  assert.equal(mobilityAt(data,'roads','charles-river',2,10*3600).points.length,0);
  const zero=mobilityAt(data,'roads','charles-river',2,9*3600).points;
  assert.equal(zero.length,1);assert.equal(zero[0].value,0);
  assert.equal(mobilityAt(data,'roads','medical',2,8*3600).points.length,0);
});

test('bike hourly means use calendar-day denominator rather than only days containing rides',()=>{
  const view=mobilityAt(fixture(),'bikes','charles-river',0,8*3600);
  assert.equal(view.arcs.length,1);assert.equal(view.arcs[0].value,0.5);
  assert.equal(view.arcs[0].days,4);assert.equal(view.points[0].value,0.5);
  assert.equal(mobilityAt(fixture(),'bikes','charles-river',1,8*3600).arcs.length,0);
});

test('midweek pedestrian observations retain ambiguous day basis and do not extend to Monday',()=>{
  const data=fixture();
  assert.equal(mobilityAt(data,'pedestrians','charles-river',0,8*3600).points.length,0);
  const wed=mobilityAt(data,'pedestrians','charles-river',2,8*3600).points[0];
  assert.equal(wed.value,548);assert.match(wed.details,/Midweek/);
  assert.equal(mobilityAt(data,'pedestrians','charles-river',3,8*3600).points[0].value,548);
  assert.equal(mobilityAt(data,'pedestrians','charles-river',2,9*3600).points.length,0);
});

test('hour bins are half-open and out-of-day times never become observations',()=>{
  const data=fixture();
  assert.equal(mobilityAt(data,'roads','charles-river',2,8*3600+3599).points[0].value,400);
  for(const time of [-1,86400,NaN]) assert.equal(mobilityAt(data,'roads','charles-river',2,time).points.length,0);
});

test('saved bundle has observed data for all campus areas without altering population',()=>{
  const data=JSON.parse(readFileSync(new URL('../public/data/mobility.json',import.meta.url)));
  assert.equal(data.roads.locations.length,15);
  for(const campus of ['charles-river','medical','fenway']) {
    assert.ok(data.roads.locations.some(site=>site.campus===campus));
    let hasCounts=false;
    for(let day=0;day<7;day++) for(let hour=0;hour<24;hour++) {
      const view=mobilityAt(data,'roads',campus,day,hour*3600);
      hasCounts ||= view.points.length>0;
      assert.ok(view.points.every(point=>Number.isFinite(point.value)&&point.value>=0));
    }
    assert.ok(hasCounts);
  }
  assert.ok(!('agents' in data));
});
