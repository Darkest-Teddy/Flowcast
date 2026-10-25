// The committed landing-scenarios.json (scripts/build-landing-scenarios.mjs) that the public landing
// page reads: its shape, and that every number is a usable, non-negative figure. Rebuilding it
// runs the full simulation (~20 s), so this checks the file rather than regenerating it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const file = read('landing-scenarios');
const drill = file.fireDrill;
const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
const count = (value) => Number.isInteger(value) && value >= 0;
const shareOf = (value) => Number.isFinite(value) && value >= 0;

test('landing scenarios: header names the generator and the model run', () => {
  assert.equal(file.schemaVersion, 1);
  assert.ok(!Number.isNaN(Date.parse(file.generatedAt)));
  assert.equal(file.generatedBy, 'map-client/scripts/build-landing-scenarios.mjs');
  assert.equal(typeof file.model, 'string');
  assert.ok(file.model.length > 0);
});

test('landing scenarios: fire drill is a dated Tuesday drill measured after the alarm', () => {
  assert.equal(drill.kind, 'fire-drill');
  assert.match(drill.date, /^\d{4}-\d{2}-\d{2}$/);
  // Monday=0: the date really is a Tuesday.
  assert.equal(drill.weekday, 1);
  assert.equal(new Date(`${drill.date}T12:00:00Z`).getUTCDay(), 2);
  for (const key of ['alarmAt', 'measuredAt', 'reopensAt']) assert.match(drill[key], clock, key);
  assert.ok(drill.measuredAt > drill.alarmAt);
  assert.ok(count(drill.durationMinutes) && drill.durationMinutes > 0);
  assert.ok(count(drill.measuredAfterMinutes) && drill.measuredAfterMinutes > 0);
  for (const key of ['evacuated', 'affectedPeople']) assert.ok(count(drill[key]), key);
  for (const value of Object.values(drill.outcomes)) assert.ok(count(value));
  assert.ok(count(drill.assembly.count));
});

test('landing scenarios: places carry finite, non-negative shares of their map capacity', () => {
  const { building, places } = drill;
  for (const key of ['id', 'name', 'short']) assert.equal(typeof building[key], 'string');
  assert.ok(places.length >= 1 && places.length <= 5);
  assert.equal(places[0].id, building.id, 'the drilled building comes first');
  assert.equal(new Set(places.map((place) => place.id)).size, places.length);
  // Same ids and capacities as the dashboard's event-impact places, so labels and percentages agree.
  const known = new Map(read('event-impact').places.map((place) => [place.id, place]));
  for (const place of places) {
    for (const key of ['id', 'name', 'short']) assert.equal(typeof place[key], 'string', `${place.id} ${key}`);
    assert.ok(Number.isFinite(place.capacity) && place.capacity > 0, place.id);
    assert.ok(count(place.beforeCount) && count(place.afterCount), place.id);
    assert.ok(shareOf(place.before) && shareOf(place.after), place.id);
    assert.ok(Math.abs(place.before - place.beforeCount / place.capacity) < 1e-4, place.id);
    assert.ok(Math.abs(place.after - place.afterCount / place.capacity) < 1e-4, place.id);
    assert.equal(known.get(place.id)?.capacity, place.capacity, `${place.id} matches event-impact.json`);
  }
  assert.ok(places[0].after < places[0].before, 'the drill empties the building');
});
