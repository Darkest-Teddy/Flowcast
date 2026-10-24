import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Playback, occupancyShare } from '../src/sim/playback.ts';
import { advanceTime } from '../src/sim/clock.ts';

test('clock preserves elapsed time across slow frames and midnight', () => {
  assert.equal(advanceTime(100, 1200, 1), 101.2);
  assert.equal(advanceTime(86399, 2500, 1), 1.5);
  assert.equal(advanceTime(100, 1200, 60), 172);
  assert.equal(advanceTime(100, 0, 60), 100);
});

test('walking buckets retain long trips, exclude endpoints, and support scrubbing backwards', () => {
  const trip = { agent: 'a', from: 'home', to: 'class', path: [[-71,42],[-71.01,42]], timestamps: [100, 800] };
  const playback = new Playback({ day: 'Monday', buildings: [], locations: [], agents: [{id:'a',home:'off-campus',model:0}], trips: [trip] });
  for (const time of [99,100,299,300,600,799,800,500,100]) {
    assert.equal(playback.walkingAt(time).length, time >=100 && time <800 ? 1 : 0);
  }
  assert.equal(playback.walkingAt(450)[0].position[0], -71.005);
});

test('off-map stays are excluded from building occupancy without losing population', () => {
  const location = {id:'home',name:'Home',short:'Home',kind:'dorm',position:[-71,42],capacity:1,building:'h'};
  const playback = new Playback({ day:'Monday',buildings:[],locations:[location],agents:[{id:'a',home:'home',model:0},{id:'b',home:'off-campus',model:0}],trips:[],stays:[{agent:'a',location:'home',start:0,end:86400},{agent:'b',location:'off-campus',start:0,end:86400}] });
  assert.deepEqual(playback.populationAt(36000), {total:2,indoors:1,walking:0,offCampus:1});
});

test('shared footprint label and percentage refer to the same busiest modeled space', () => {
  const base={name:'Unknown dorm',short:'Dorm',kind:'dorm',position:[-71,42],building:'shared'};
  const dorm={...base,id:'dorm',capacity:0,activityModeled:false};
  const dining={...base,id:'dining',name:'Dining',short:'Dining',kind:'dining',capacity:100,activityModeled:true};
  const gym={...base,id:'gym',name:'Gym',short:'Gym',kind:'gym',capacity:20,activityModeled:true};
  const p=new Playback({day:'Monday',buildings:[],locations:[dorm,dining,gym],agents:[],trips:[]});
  const result=p.byBuilding([{location:dorm,count:0,share:0},{location:dining,count:40,share:.4},{location:gym,count:15,share:.75}]);
  assert.deepEqual(result.map(r=>[r.name,r.count,r.capacity,r.share,r.modeled]),[['Gym',15,20,.75,true]]);
  const unknown=p.occupancyAt(0).find(o=>o.location.id==='dorm');
  assert.equal(unknown.modeled,false);
});

test('playback rejects changed capacity references and duplicate students', () => {
  const day = {day:'Monday', buildings:[], trips:[], agents:[{id:'a',home:'off-campus',model:0}],
    locations:[{id:'hall',name:'Hall',short:'Hall',kind:'classroom',position:[-71,42],capacity:100,referenceCapacity:100,building:'hall'}]};
  assert.doesNotThrow(() => new Playback(day));
  assert.throws(() => new Playback({...day, locations:[{...day.locations[0],capacity:200}]}), /Capacity differs/);
  assert.throws(() => new Playback({...day,agents:[...day.agents,...day.agents]}), /Duplicate student/);
});

test('display ratios cannot be inflated independently of counts or hide an over-capacity result', () => {
  const location={id:'library',name:'Library',short:'Library',kind:'library',position:[-71,42],capacity:100,building:'library'};
  const p=new Playback({day:'Monday',buildings:[],locations:[location],agents:[],trips:[]});
  assert.equal(p.byBuilding([{location,count:40,share:.9}])[0].share,.4);
  assert.equal(occupancyShare(120,100),1.2);
  assert.equal(occupancyShare(12,0),0);
  for (const count of [-1, NaN, 1.5]) assert.throws(() => occupancyShare(count,100), /Invalid occupancy/);
});
