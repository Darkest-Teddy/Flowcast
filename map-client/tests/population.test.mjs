import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { buildPopulation } = await import('../src/sim/population.ts');

const population = JSON.parse(readFileSync(new URL('../public/data/population.json', import.meta.url)));
const source = JSON.parse(readFileSync(new URL('../public/data/campus-data.json', import.meta.url)));
const base = JSON.parse(readFileSync(new URL('../public/data/demo-day.json', import.meta.url)));

test('published roster conserves population with separate sourced and estimated housing', () => {
  const result = buildPopulation(base, source, population);
  assert.equal(result.agents.length, 36977);
  assert.equal(new Set(result.agents.map(a => a.id)).size, 36977);
  assert.equal(result.agents.filter(a => a.studentLevel === 'undergraduate').length, 18289);
  assert.equal(result.agents.filter(a => a.residency === 'resident' && a.studentLevel === 'undergraduate').length, 10048);
  assert.equal(result.populationSummary.mappedResidents, 6906);
  assert.equal(result.populationSummary.residentsOutsideMap, 3319);
  const occupancy = {};
  for (const agent of result.agents) if (population.residentialCapacities[agent.home]) occupancy[agent.home] = (occupancy[agent.home] ?? 0) + 1;
  assert.deepEqual(occupancy, population.residentialCapacities);
  assert.equal(result.locations.find(l => l.id === 'warren').name, 'Warren Towers (Tower A)');
  assert.equal(result.locations.find(l => l.id === 'warren').capacity, 600);
  assert.equal(result.locations.find(l => l.id === 'kilachand').capacity, 198);
  assert.equal(result.agents.filter(a => a.campus === 'fenway' && a.residency === 'resident').length, 595);
  assert.equal(result.agents.filter(a => a.campus === 'fenway' && a.home === 'off-campus' && a.residency === 'resident').length, 134);
  assert.equal(result.agents.filter(a => a.home === 'kilachand').length, 0);
  assert.equal(result.locations.find(l => l.id === 'kilachand').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'claflin').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'fenway-fitness').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'agganis').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'kilachand').capacityBasis, 'deduplicated_classroom_seats');
  assert.equal(result.populationSummary.estimatedGraduateResidents, 177);
  assert.equal(result.agents.filter(a => a.home === 'bumc-residence').length, 177);
  assert.ok(result.agents.filter(a => a.home === 'bumc-residence').every(a => a.studentLevel === 'graduate'));
  assert.equal(result.locations.filter(l => l.estimatedHousingProfile || l.estimatedProfile).length, 21);
  assert.ok(result.locations.every(l => l.activityModeled));
  assert.equal(result.locations.find(l => l.id === 'agganis').capacity, 1500);
  assert.equal(result.locations.find(l => l.id === 'agganis').estimatedProfile.capacity, 120);
  assert.equal(result.trips.length, 0);
  assert.deepEqual(result.agents, buildPopulation(base, source, population).agents);
});

test('invalid totals and housing estimates cannot silently truncate the roster', () => {
  assert.throws(() => buildPopulation(base, source, {...population, students: {...population.students, total: 1}}));
  assert.throws(() => buildPopulation(base, source, {...population, housing: {estimatedUndergraduateResidents: 99999}}));
  assert.throws(() => buildPopulation(base, source, {...population, residentialCapacities: {warren: NaN}}));
  assert.throws(() => buildPopulation(base, source, {...population, campusResidentMinimums: [{campus: 'fenway', students: 99999}]}));
});
