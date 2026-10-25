// A meteor can be aimed at Fenway Park, off the simulated campus: open ground to the incident model.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { FENWAY_PARK, withLandmarkTarget } = await import('../src/sim/landmarks.ts');
const { applyIncident } = await import('../src/sim/incidents.ts');
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { expandDay, Playback } = await import('../src/sim/playback.ts');
const { dateForWeekday } = await import('../src/data/campusData.ts');
const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));

test('a meteor at Fenway Park hits campus buildings only within its radius', () => {
  const data = read('campus-data');
  const day = buildSourceDay(buildPopulation(expandDay(read('demo-day')), data, read('population')), data, 2, undefined, { eventDate: dateForWeekday(data, 2) });
  const target = withLandmarkTarget(day, 'fenway-park');
  assert.equal(withLandmarkTarget(target, 'fenway-park'), target, 'added once');
  assert.equal(withLandmarkTarget(day, 'nowhere'), day);
  assert.ok(!day.locations.some((l) => l.id === 'fenway-park'), 'the shown day is not changed');
  const meteor = (radiusMetres) => applyIncident(target, { id: `m${radiusMetres}`, kind: 'meteor', locationId: FENWAY_PARK.id, start: 14 * 3600, duration: 1800, radiusMetres });
  const small = meteor(250), large = meteor(500);
  assert.deepEqual(small.hazard.affectedBuildingIds, [], 'the nearest campus building is ~290 m away');
  assert.ok(large.hazard.affectedBuildingIds.length > 0, 'a 500 m strike reaches Kenmore');
  assert.equal(large.day.agents.length, day.agents.length);
  new Playback(large.day); // plays
});
