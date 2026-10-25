import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { Playback, occupancyShare } = await import('../src/sim/playback.ts');
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

test('walker positions and headings match a plain segment scan, including repeated timestamps', () => {
  const path = [[-71, 42], [-71.001, 42.0005], [-71.001, 42.0005], [-71.003, 42.001], [-71.004, 42.0002], [-71.006, 42.0004]];
  const timestamps = [100, 130, 130, 190, 240, 300];
  const playback = new Playback({ day: 'Monday', buildings: [], locations: [], agents: [{ id: 'a', home: 'off-campus', model: 3 }], trips: [{ agent: 'a', from: 'home', to: 'class', path, timestamps }] });
  const rad = Math.PI / 180;
  const bearing = (a, b) => {
    const dLon = (b[0] - a[0]) * rad, lat1 = a[1] * rad, lat2 = b[1] * rad;
    return (Math.atan2(Math.sin(dLon) * Math.cos(lat2), Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon)) / rad + 360) % 360;
  };
  for (let t = 100; t < 300; t += 2.5) {
    let i = 1;
    while (timestamps[i] <= t) i++;
    const a = path[i - 1], b = path[i];
    const f = (t - timestamps[i - 1]) / (timestamps[i] - timestamps[i - 1]);
    const [walker] = playback.walkingAt(t);
    assert.deepEqual(walker.position, [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0], `position at ${t}`);
    assert.equal(walker.bearing, bearing(a, b), `bearing at ${t}`);
    assert.equal(walker.model, 3);
  }
});

test('trail windows retain fading and long walks, cache candidates, and follow scrubbing and speed', () => {
  const trip = (start, end) => ({agent:'a', from:'home', to:'class', path:[[-71,42],[-71.01,42]], timestamps:[start,end]});
  const trips = [trip(10,50), trip(280,299), trip(100,1000), trip(600,650), trip(2000,2100)];
  const playback = new Playback({day:'Monday', buildings:[], locations:[], agents:[{id:'a',home:'off-campus',model:0}], trips});
  const window = playback.trailsAt(310,20);
  assert.ok(window.includes(trips[1]), 'a finished walk still has a fading trail');
  assert.ok(window.includes(trips[2]), 'long walks span buckets');
  assert.equal(playback.trailsAt(315,20), window);
  assert.equal(new Set(window).size, window.length);
  assert.ok(!window.includes(trips[4]), 'distant future trips stay off the GPU');
  for (const [time, length] of [[700,20],[700,600],[300,20],[299,20],[2100,600],[50,20],[0,600]]) {
    const candidates = playback.trailsAt(time,length);
    for (const trip of trips) {
      if (trip.timestamps[0] <= time && trip.timestamps.at(-1) > time-length) {
        assert.ok(candidates.includes(trip), `missing visible trail at ${time} with length ${length}`);
      }
    }
    assert.equal(new Set(candidates).size,candidates.length);
  }
  assert.deepEqual(playback.trailsAt(5000,20), []);
});

test('off-map stays are excluded from building occupancy without losing population', () => {
  const location = {id:'home',name:'Home',short:'Home',kind:'dorm',position:[-71,42],capacity:1,building:'h'};
  const playback = new Playback({ day:'Monday',buildings:[],locations:[location],agents:[{id:'a',home:'home',model:0},{id:'b',home:'off-campus',model:0}],trips:[],stays:[{agent:'a',location:'home',start:0,end:86400},{agent:'b',location:'off-campus',start:0,end:86400}] });
  assert.deepEqual(playback.populationAt(36000), {total:2,indoors:1,outdoors:0,walking:0,offCampus:1,injured:0,fatalities:0,alive:2});
});

test('outdoor assembly stays remain visible in population without becoming building occupancy', () => {
  const location = {id:'assembly',name:'Assembly',short:'Assembly',kind:'outdoor',position:[-71,42],capacity:0,building:''};
  const playback = new Playback({day:'Monday',buildings:[],locations:[location],
    agents:[{id:'a',home:'off-campus',model:2}],trips:[],
    stays:[{agent:'a',location:'off-campus',start:0,end:100},{agent:'a',location:'assembly',start:100,end:200},{agent:'a',location:'off-campus',start:200,end:86400}]});
  assert.deepEqual(playback.populationAt(150),{total:1,indoors:0,outdoors:1,walking:0,offCampus:0,injured:0,fatalities:0,alive:1});
  assert.equal(playback.occupancyAt(150)[0].count,1);
  assert.deepEqual(playback.byBuilding(playback.occupancyAt(150)),[]);
  assert.deepEqual(playback.outdoorAt(100),[{id:'a',model:2,position:[-71,42,0],bearing:0,to:'assembly'}]);
  assert.deepEqual(playback.outdoorAt(99),[]);
  assert.deepEqual(playback.outdoorAt(200),[]);
});

test('overlapping stays retain first-match occupancy semantics', () => {
  const location = id => ({id,name:id,short:id,kind:'dorm',position:[-71,42],capacity:10,building:id});
  const playback = new Playback({day:'Monday',buildings:[],locations:[location('a'),location('b')],
    agents:[{id:'student',home:'a',model:0}],trips:[],stays:[
      {agent:'student',location:'a',start:0,end:20},
      {agent:'student',location:'b',start:10,end:30},
    ]});
  for (const [time, expected] of [[15,[1,0]],[20,[0,1]],[30,[0,0]],[0,[1,0]]]) {
    assert.deepEqual(playback.occupancyAt(time).map(o => o.count), expected);
  }
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
