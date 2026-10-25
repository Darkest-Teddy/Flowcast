import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findStudySpots, studyOpenAt, studyWalkMinutes } from '../src/lib/studyFinder.ts';
import { studySpots } from '../src/data/studySpots.ts';
import type { StudyFinderInput, StudyHours } from '../src/lib/studyFinder.ts';

const now = Date.parse('2026-10-25T16:00:00Z'); // Sunday noon Boston
const hours: StudyHours = { date: '2026-10-25', windows: [[36000, 82800]], sourceUrl: 'https://www.bu.edu/', qualifier: null };
const base: StudyFinderInput = {
  spots: [{ id: 'room', name: 'Room', area: 'Floor 1', locationId: 'study', amenities: { quiet: true, outlets: true }, notes: '', sourceUrl: '', checkedAt: '', hoursUrl: '' }],
  locations: ['home', 'study', 'class'].map(id => ({ id, name: id, short: id, kind: 'library', capacity: 100 })),
  geo: { positions: {}, walkMeters: { 'home>study': 840, 'class>study': 420 } },
  hours: { study: { hours: [hours] } }, forecasts: [],
  schedule: [{ id: 'lecture', title: 'Lecture', locationId: 'class', start: '2026-10-25T17:00:00Z', end: '2026-10-25T18:00:00Z', source: 'calendar' }],
  scheduleKnown: true, now, from: 'home', minutes: 60, amenities: [], openOnly: false, lateOnly: false, fitsOnly: false, maxWalk: null, sort: 'time',
};
const find = (overrides: Partial<StudyFinderInput> = {}) => findStudySpots({ ...base, ...overrides });

test('study time subtracts both walks and class buffer; short sessions do not fit', () => {
  assert.equal(find()[0].usable, 40);
  assert.equal(find()[0].leaveAt, now + 50 * 60000);
  assert.equal(find({ fitsOnly: true }).length, 0);
  assert.equal(find({ minutes: 30, fitsOnly: true }).length, 1);
});
test('unknown amenities never match and all selected amenities must match', () => {
  assert.equal(find({ amenities: ['food'] }).length, 0);
  assert.equal(find({ amenities: ['quiet', 'outlets'] }).length, 1);
  assert.equal(find({ amenities: ['quiet', 'group'] }).length, 0);
});
test('missing routes, unknown origin, and unmapped next class never receive usable time', () => {
  assert.equal(find({ from: '' })[0].usable, null);
  assert.equal(find({ geo: { positions: {}, walkMeters: {} } })[0].usable, null);
  assert.equal(find({ schedule: [{ ...base.schedule[0], locationId: 'unknown' }] })[0].usable, null);
  assert.equal(find({ from: '', maxWalk: 10 }).length, 0);
});
test('zero-length saved routes are valid, negative or nonfinite routes are not', () => {
  assert.equal(studyWalkMinutes({ positions: {}, walkMeters: { 'home>study': 0 } }, base.locations, 'home', 'study'), 0);
  for (const value of [-1, NaN, Infinity]) assert.equal(studyWalkMinutes({ positions: {}, walkMeters: { 'home>study': value } }, base.locations, 'home', 'study'), null);
  assert.equal(studyWalkMinutes(base.geo, base.locations, 'study', 'study'), 0);
});
test('current classes block study; a failed schedule cannot look like a free day', () => {
  assert.equal(find({ now: now + 60 * 60000 })[0].usable, 0);
  assert.equal(find({ scheduleKnown: false, schedule: [] })[0].usable, null);
  assert.equal(find({ schedule: [] })[0].usable, 60);
});
test('closing time clips usable time; exact closing is not open', () => {
  const source = { hours: [{ ...hours, windows: [[36000, 45000]] as [number, number][] }] };
  assert.equal(find({ hours: { study: source } })[0].usable, 20);
  assert.equal(studyOpenAt(source, Date.parse('2026-10-25T16:30:00Z')), false);
});
test('expired dates and unverified undated hours are unknown, never carried forward', () => {
  for (const h of [{ ...hours, date: '2026-10-18' }, { ...hours, date: null }]) {
    assert.equal(find({ hours: { study: { hours: [h] } } })[0].usable, null);
    assert.equal(find({ hours: { study: { hours: [h] } }, openOnly: true }).length, 0);
  }
});
test('explicit closures override weekly hours; weekly validity bounds apply', () => {
  const weekly = { ...hours, date: null, weekday: 6, validFrom: '2026-10-01', validTo: '2026-10-31' };
  assert.equal(studyOpenAt({ hours: [weekly] }, now), true);
  assert.equal(studyOpenAt({ hours: [weekly, { ...hours, windows: [] }] }, now), false);
  assert.equal(studyOpenAt({ hours: [{ ...weekly, validTo: '2026-10-24' }] }, now), null);
});
test('overnight carry covers previous published window, including DST fallback', () => {
  const overnight = { hours: [{ ...hours, date: '2026-10-31', windows: [[72000, 93600]] as [number, number][] }] };
  assert.equal(studyOpenAt(overnight, Date.parse('2026-11-01T05:30:00Z')), true);
  assert.equal(studyOpenAt(overnight, Date.parse('2026-11-01T06:30:00Z')), true);
  assert.equal(studyOpenAt(overnight, Date.parse('2026-11-01T07:00:00Z')), null);
});
test('late filter uses published 10 PM status, not a crowd forecast', () => {
  assert.equal(find({ lateOnly: true }).length, 1);
  assert.equal(find({ lateOnly: true, hours: {} }).length, 0);
  assert.equal(find({ lateOnly: true, hours: { study: { hours: [{ ...hours, windows: [[36000, 72000]] }] } } }).length, 0);
});
test('forecast must match arrival date and hour; missing coverage stays unknown', () => {
  const forecast = { locationId: 'study', day: '2026-10-25', hours: [{ hour: 12, share: 0.4 }] };
  assert.equal(find({ forecasts: [forecast] })[0].crowd, 0.4);
  assert.equal(find({ forecasts: [{ ...forecast, day: '2026-10-24' }] })[0].crowd, null);
  assert.equal(find({ forecasts: [{ ...forecast, hours: [{ hour: 13, share: 0.4 }] }] })[0].crowd, null);
});
test('strict walk filtering and missing crowd sorted after known coverage', () => {
  assert.equal(find({ maxWalk: 5 }).length, 0);
  const other = { ...base.spots[0], id: 'other', name: 'A missing forecast', locationId: 'home' };
  const result = find({ spots: [other, ...base.spots], sort: 'crowd', forecasts: [{ locationId: 'study', day: '2026-10-25', hours: [{ hour: 12, share: 0.7 }] }] });
  assert.equal(result[0].spot.id, 'room');
});
test('catalog uses distinct IDs, mapped buildings, and attributable official sources', () => {
  const bundle = JSON.parse(readFileSync(new URL('../../map-client/public/data/event-impact.json', import.meta.url), 'utf8'));
  assert.equal(new Set(studySpots.map(s => s.id)).size, studySpots.length);
  for (const spot of studySpots) {
    assert.ok(bundle.places.some((p: { id: string }) => p.id === spot.locationId));
    assert.equal(new URL(spot.sourceUrl).hostname, 'www.bu.edu');
    assert.match(spot.checkedAt, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('published room booking limits cap a session even on a free day', () => {
  const result = find({ schedule: [], minutes: 180, spots: [{ ...base.spots[0], maxSessionMinutes: 120 }] });
  assert.equal(result[0].usable, 120);
  assert.equal(find({ schedule: [], minutes: 180, spots: [{ ...base.spots[0], maxSessionMinutes: 120 }], fitsOnly: true }).length, 0);
});

test('open-at-arrival filter requires a known journey, not merely open now', () => {
  assert.equal(find({ from: '', openOnly: true }).length, 0);
  assert.equal(find({ geo: { positions: {}, walkMeters: {} }, openOnly: true }).length, 0);
});
test('an unmapped class on a later day does not suppress a session today', () => {
  const nextDay = { ...base.schedule[0], locationId: '', start: '2026-10-26T17:00:00Z', end: '2026-10-26T18:00:00Z' };
  assert.equal(find({ schedule: [nextDay] })[0].usable, 60);
  assert.equal(find({ schedule: [nextDay] })[0].next, undefined);
});
