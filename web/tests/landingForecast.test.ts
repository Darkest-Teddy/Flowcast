import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clockLabel, dayForecast, eventExample, hourLabel, longDate, peaks, shortDate } from '../src/pages/landing/forecast.ts';
import type { EventImpactData } from '../src/data/types.ts';

const hours = (pairs: Record<number, number>) => Array.from({ length: 24 }, (_, h) => pairs[h] ?? 0);

const data: EventImpactData = {
  referenceWeekStart: '2026-10-26',
  attendanceProbability: 0.25,
  measure: 'test',
  assumptions: [],
  places: [
    { id: 'mugar', name: 'Mugar Memorial Library', short: 'Mugar Library', kind: 'library', campus: 'charles-river', capacity: 800 },
    { id: 'gsu', name: 'George Sherman Union', short: 'GSU', kind: 'dining', campus: 'charles-river', capacity: 600 },
  ],
  baseline: {
    '1': { mugar: hours({ 7: 0, 18: 480, 22: 616 }), gsu: hours({ 12: 150 }) },
    '4': { mugar: hours({ 15: 400 }), gsu: hours({ 15: 18 }) },
  },
  dates: {
    // Tuesday's events only changed GSU; Mugar follows the baseline.
    '2026-10-27': { weekday: 1, projected: false, occupancy: { gsu: hours({ 12: 300 }) }, gatherings: [
      { eventId: 'a', name: 'Small talk', locationId: 'gsu', startSec: 12 * 3600, endSec: 13 * 3600, attendees: 40, capacity: 600, roomCode: null, endEstimated: false },
    ] },
    '2026-10-30': { weekday: 4, projected: false, occupancy: { gsu: hours({ 15: 588 }) }, gatherings: [
      { eventId: 'b', name: 'Pop up', locationId: 'gsu', startSec: 14.25 * 3600, endSec: 18 * 3600, attendees: 573, capacity: 600, roomCode: null, endEstimated: false },
    ] },
  },
};

test('the landing day is the Tuesday of the reference week, with that date’s events', () => {
  const day = dayForecast(data);
  assert.equal(day.date, '2026-10-27');
  assert.equal(longDate(day.date), 'Tuesday, October 27');
  assert.equal(day.share('mugar', 18), 0.6);
  assert.equal(day.share('gsu', 12), 0.5); // from the date's occupancy, not the baseline 0.25
  assert.equal(day.share('nowhere', 12), null);
  assert.deepEqual(peaks(day, 'mugar'), { busiest: 22, quietest: 7 });
});

test('the event example is the week’s best-attended event, at the hour its venue changes most', () => {
  const ex = eventExample(data);
  assert.ok(ex);
  assert.equal(ex.date, '2026-10-30');
  assert.equal(ex.name, 'Pop up');
  assert.equal(ex.venue.id, 'gsu');
  assert.equal(ex.hour, 15);
  assert.equal(ex.before, 0.03);
  assert.equal(ex.after, 0.98);
  assert.equal(shortDate(ex.date), 'Fri, Oct 30');
  assert.equal(clockLabel(ex.startSec), '2:15 PM');
});

test('hour labels', () => {
  assert.deepEqual([0, 7, 12, 23].map(hourLabel), ['12 AM', '7 AM', '12 PM', '11 PM']);
  assert.equal(clockLabel(18 * 3600), '6 PM');
});
