import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { buildPopulation } from '../src/sim/population.ts';

const population = JSON.parse(readFileSync(new URL('../public/data/population.json', import.meta.url)));
const source = JSON.parse(readFileSync(new URL('../public/data/campus-data.json', import.meta.url)));
const base = JSON.parse(readFileSync(new URL('../public/data/demo-day.json', import.meta.url)));

test('published roster conserves population while only sourced beds create mapped residents', () => {
  const result = buildPopulation(base, source, population);
  assert.equal(result.agents.length, 36977);
  assert.equal(new Set(result.agents.map(a => a.id)).size, 36977);
  assert.equal(result.agents.filter(a => a.studentLevel === 'undergraduate').length, 18289);
  assert.equal(result.agents.filter(a => a.residency === 'resident').length, 10048);
  assert.equal(result.populationSummary.mappedResidents, 3613);
  assert.equal(result.populationSummary.residentsOutsideMap, 6435);
  const occupancy = {};
  for (const agent of result.agents) if (agent.home !== 'off-campus') occupancy[agent.home] = (occupancy[agent.home] ?? 0) + 1;
  assert.deepEqual(occupancy, population.residentialCapacities);
  assert.equal(result.locations.find(l => l.id === 'warren').name, 'Warren Towers (Tower A)');
  assert.equal(result.locations.find(l => l.id === 'warren').capacity, 600);
  assert.equal(result.trips.length, 0);
  assert.deepEqual(result.agents, buildPopulation(base, source, population).agents);
});

test('invalid totals and housing estimates cannot silently truncate the roster', () => {
  assert.throws(() => buildPopulation(base, source, {...population, students: {...population.students, total: 1}}));
  assert.throws(() => buildPopulation(base, source, {...population, housing: {estimatedUndergraduateResidents: 99999}}));
  assert.throws(() => buildPopulation(base, source, {...population, residentialCapacities: {warren: NaN}}));
});
