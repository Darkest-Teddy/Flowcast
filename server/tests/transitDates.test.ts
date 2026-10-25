import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTransit } from '../src/chatData';

test('prior Sunday departures remain distinct from the following Sunday', () => {
  const trip = (weekdays: number[], departure: number) => ({ route: '57', direction: 0, weekdays, stops: [{stop:'a',departure},{stop:'b',departure:departure+60}] });
  const mbta = {dates:[],stops:{a:{mapStopId:'a'}},trips:[trip([-1],90000),trip([6],91000)]};
  const transit=buildTransit({routes:[],stops:[]},mbta,null);
  assert.equal(transit.priorDepartures.get('a')![0][0],90000);
  assert.equal(transit.departures.get('a')![6][0][0],91000);
});

test('BU historic feed cannot contribute current-week departures', () => {
  const mbta={dates:['2026-10-26'],stops:{},trips:[]};
  const shuttle={dates:['2026-10-26'],feed:{start:'20240830',end:'20251231'},trips:[{route:'BU-1',weekdays:[0],stops:[{stop:'a',departure:36000},{stop:'b',departure:36100}]}]};
  const transit=buildTransit({routes:[],stops:[]},mbta,shuttle);
  assert.equal(transit.departures.size,0);
});
