import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dayForecast, eventExample, peaks } from '../src/pages/landing/forecast.ts';
import type { EventImpactData } from '../src/data/types.ts';

function bundle(): EventImpactData {
  return {
    referenceWeekStart: '2026-10-26', attendanceProbability: 0.25, measure: 'test', assumptions: [],
    places: [{ id: 'library', name: 'Library', short: 'Library', kind: 'library', campus: 'charles-river', capacity: 100 }],
    baseline: { '1': { library: [] } }, dates: {},
  };
}

test('missing, invalid and negative occupancy is unavailable, while measured model zero is retained', () => {
  const data = bundle();
  data.baseline['1'].library[8] = 0;
  data.baseline['1'].library[9] = NaN;
  data.baseline['1'].library[10] = -1;
  data.baseline['1'].library[11] = 50;
  const day = dayForecast(data);
  assert.equal(day.share('library', 7), null);
  assert.equal(day.share('library', 8), 0);
  assert.equal(day.share('library', 9), null);
  assert.equal(day.share('library', 10), null);
  assert.deepEqual(peaks(day, 'library'), { busiest: 11, quietest: 8 });
  assert.deepEqual(peaks(day, 'missing'), { busiest: null, quietest: null });
  assert.deepEqual(peaks(day, 'library', []), { busiest: null, quietest: null });
  data.places[0].capacity = Infinity;
  assert.equal(dayForecast(data).share('library', 11), null);
});

test('event comparison requires both baseline and scenario readings for the same hour', () => {
  const data = bundle();
  data.dates['2026-10-27'] = {
    weekday: 1, projected: false, occupancy: { library: [] },
    gatherings: [{ eventId: 'event', name: 'Event', locationId: 'library', startSec: 36000, endSec: 39600, attendees: 20, capacity: 100, roomCode: null, endEstimated: false }],
  };
  data.dates['2026-10-27'].occupancy.library[10] = 20;
  assert.equal(eventExample(data), null);
  data.baseline['1'].library[10] = 0;
  assert.equal(eventExample(data)?.before, 0);
  assert.equal(eventExample(data)?.after, 0.2);
});
