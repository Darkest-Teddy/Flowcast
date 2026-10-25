import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bostonDate, clubsFromBundle, forecastsFromBundle, locationsFromBundle, type EventBundle } from '../src/data/realData.ts';

const bundle: EventBundle = JSON.parse(readFileSync(new URL('../../map-client/public/data/event-impact.json', import.meta.url), 'utf8'));

test('locations retain the published bundle capacities and identifiers', () => {
  const locations = locationsFromBundle(bundle);
  assert.ok(locations.length > 0);
  for (const location of locations) {
    const source = bundle.places.find((p) => p.id === location.id)!;
    assert.equal(location.capacity, source.capacity);
    assert.equal(location.name, source.name);
  }
});

test('organizers come only from named event organizers, without invented memberships', () => {
  const clubs = clubsFromBundle(bundle);
  const organizers = new Set(bundle.events.map((e) => e.organizer?.trim()).filter(Boolean));
  assert.equal(clubs.length, organizers.size);
  for (const club of clubs) {
    assert.ok(organizers.has(club.name));
    assert.equal(club.members, null);
    assert.equal(club.verified, false);
    assert.equal(club.following, false);
  }
  assert.equal(clubsFromBundle(bundle, [clubs[0].id])[0].following, true);
});

test('Boston date is independent of host timezone and respects daylight saving changes', () => {
  assert.deepEqual(bostonDate(new Date('2026-10-25T02:30:00Z')), { day: '2026-10-24', weekday: 5, hour: 22 });
  assert.deepEqual(bostonDate(new Date('2026-11-02T04:30:00Z')), { day: '2026-11-01', weekday: 6, hour: 23 });
});

test('forecasts preserve actual bundle counts over capacity, date overrides, and provenance', () => {
  const days = [...new Set([bundle.referenceWeekStart, ...Object.keys(bundle.dates)])];
  let checked = 0;
  for (const day of days) {
    const at = new Date(`${day}T16:00:00Z`);
    const { weekday, hour } = bostonDate(at);
    const result = forecastsFromBundle(bundle, at, () => true);
    for (const row of result.hourly) {
      assert.equal(row.day, day);
      assert.ok(row.basis?.includes(bundle.referenceWeekStart));
      assert.ok(row.basis?.includes('Not live occupancy'));
      const counts = bundle.dates[day]?.occupancy[row.locationId] ?? bundle.baseline[String(weekday)][row.locationId];
      const capacity = bundle.places.find((p) => p.id === row.locationId)!.capacity;
      for (const h of row.hours) { assert.equal(h.share, counts[h.hour] / capacity); assert.ok(h.share > 0); checked++; }
    }
    for (const place of result.places) assert.equal(place.share, result.hourly.find((r) => r.locationId === place.locationId)!.hours.find((h) => h.hour === hour)!.share);
  }
  assert.ok(checked > 0);
});

test('unknown opening hours never produce quiet optional-visit recommendations', () => {
  const at = new Date('2026-10-24T16:00:00Z');
  const result = forecastsFromBundle(bundle, at, () => null);
  for (const row of result.hourly) {
    const place = bundle.places.find((p) => p.id === row.locationId)!;
    if (['library', 'dining', 'gym'].includes(place.kind)) {
      for (const h of row.hours) assert.ok(bundle.dates[row.day]?.gatherings.some((g) => g.locationId === row.locationId && g.startSec < (h.hour + 1) * 3600 && g.endSec > h.hour * 3600));
    }
  }
});
