import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bestTimesForPlace, weekBestTimes, weekFrom } from '../../map-client/src/bestTimes.ts';
import type { EventImpactData } from '../src/data/types.ts';

const bundle: EventImpactData = JSON.parse(readFileSync(new URL('../../map-client/public/data/event-impact.json', import.meta.url), 'utf8'));
const week = weekFrom('2026-10-25');
// FitRec open 6 AM–11 PM weekdays, 8 AM–10 PM weekends (a fixture, not the published hours); Wednesday unknown.
const open = (day: { weekday: number }, s: number) => (day.weekday === 2 ? null : day.weekday >= 5 ? s >= 8 * 3600 && s < 22 * 3600 : s >= 6 * 3600 && s < 23 * 3600);

test('best times over the next seven days rank only open, modeled hours from the bundle', () => {
  const fitrec = bundle.places.find((p) => p.id === 'fitrec')!;
  const r = bestTimesForPlace({ impact: bundle, placeId: 'fitrec', capacity: fitrec.capacity, days: week, open });
  assert.equal(r.measure, 'share');
  assert.ok(r.hours.length > 0);
  for (const h of r.hours) {
    assert.ok(open(h, h.hour * 3600) && open(h, h.hour * 3600 + 3599), `${h.date} ${h.hour}`);
    const counts = bundle.dates[h.date]?.occupancy.fitrec ?? bundle.baseline[String(h.weekday)].fitrec;
    assert.equal(h.students, Math.round(counts[h.hour]));
    assert.ok(h.students > 0);
  }
  assert.deepEqual(r.daysWithoutHours.map((d) => d.weekday), [2]);
  assert.ok(r.quietest[0].share! <= r.busiest[0].share!);
  assert.equal(new Set(r.busiest.map((h) => h.date)).size, r.busiest.length);
});

test('the dashboard week leaves out places with nothing ranked and states its basis', () => {
  const places = bundle.places.filter((p) => ['fitrec', 'mugar', 'cas'].includes(p.id));
  const weeks = weekBestTimes(bundle, places, week, (id, day, s) => (id === 'cas' ? null : open(day, s)));
  assert.deepEqual(weeks.map((w) => w.locationId).sort(), ['fitrec', 'mugar']);
  for (const w of weeks) {
    assert.equal(w.byDay.length, 7);
    assert.match(w.basis, /^Model-derived/);
    assert.match(w.basis, /2026-10-25 to 2026-10-31/);
    assert.ok(w.daysWithoutHours.includes(week.find((d) => d.weekday === 2)!.date));
  }
});
