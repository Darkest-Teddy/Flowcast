import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Playback } from '../src/sim/playback.ts';
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
