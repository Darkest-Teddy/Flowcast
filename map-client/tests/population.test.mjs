import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { buildPopulation, campusOfferingWeights, RESIDENCE_OCCUPANCY, walkSpeedFor } = await import('../src/sim/population.ts');

const population = JSON.parse(readFileSync(new URL('../public/data/population.json', import.meta.url)));
const source = JSON.parse(readFileSync(new URL('../public/data/campus-data.json', import.meta.url)));
const base = JSON.parse(readFileSync(new URL('../public/data/demo-day.json', import.meta.url)));

test('published roster conserves population with separate sourced and estimated housing', () => {
  const result = buildPopulation(base, source, population);
  assert.equal(result.agents.length, 36977);
  assert.equal(new Set(result.agents.map(a => a.id)).size, 36977);
  assert.equal(result.agents.filter(a => a.studentLevel === 'undergraduate').length, 18289);
  assert.equal(result.agents.filter(a => a.residency === 'resident' && a.studentLevel === 'undergraduate').length, 10048);
  assert.equal(result.populationSummary.mappedResidents, 7257);
  assert.equal(result.populationSummary.residentsOutsideMap, 2968);
  // Sourced halls are lived in at RESIDENCE_OCCUPANCY of their published beds, never over.
  const occupancy = {};
  for (const agent of result.agents) if (population.residentialCapacities[agent.home]) occupancy[agent.home] = (occupancy[agent.home] ?? 0) + 1;
  assert.deepEqual(occupancy, Object.fromEntries(Object.entries(population.residentialCapacities).map(([id, beds]) => [id, Math.round(beds * RESIDENCE_OCCUPANCY)])));
  assert.equal(RESIDENCE_OCCUPANCY, 0.96);
  // Kilachand, beds plus classrooms, is shown as a residence: against its 550 beds.
  assert.equal(result.locations.find(l => l.id === 'kilachand').residentialBeds, 550);
  // Hawes has no published use, so nobody is sent there; it is still shown (as 0), not "not modeled".
  assert.equal(result.locations.find(l => l.id === 'hawes').estimatedProfile, undefined);
  assert.equal(result.locations.find(l => l.id === 'hawes').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'warren').name, 'Warren Towers (Tower A)');
  assert.equal(result.locations.find(l => l.id === 'warren').capacity, 600);
  assert.equal(result.locations.find(l => l.id === 'kilachand').capacity, 748);
  assert.equal(result.agents.filter(a => a.campus === 'fenway' && a.residency === 'resident').length, 595);
  assert.equal(result.agents.filter(a => a.campus === 'fenway' && a.academicCampus === 'charles-river').length, 595);
  assert.equal(result.agents.filter(a => a.campus === 'fenway' && a.home === 'off-campus' && a.residency === 'resident').length, 134);
  assert.equal(result.agents.filter(a => a.home === 'kilachand').length, 495);
  assert.equal(result.locations.find(l => l.id === 'kilachand').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'claflin').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'fenway-fitness').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'agganis').activityModeled, true);
  assert.equal(result.locations.find(l => l.id === 'kilachand').capacityBasis, 'residential_beds_plus_classroom_seats');
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

test('each student has a stable personal walking speed from a realistic distribution', () => {
  const roster = buildPopulation(base, source, population);
  const speeds = roster.agents.map(agent => agent.walkSpeed);
  assert.ok(roster.agents.every(agent => agent.walkSpeed === walkSpeedFor(agent.id)), 'a hash of the id, stable across builds');
  assert.ok(speeds.every(speed => speed >= 1.1 && speed <= 1.6));
  const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
  const sd = Math.sqrt(speeds.reduce((sum, speed) => sum + (speed - mean) ** 2, 0) / speeds.length);
  assert.ok(mean > 1.35 && mean < 1.39, `mean ${mean}`);
  assert.ok(sd > 0.08 && sd < 0.12, `sd ${sd}`);
  const slow = speeds.filter(speed => speed < 1.2).length / speeds.length, fast = speeds.filter(speed => speed > 1.5).length / speeds.length;
  assert.ok(slow > 0.02 && slow < 0.1 && fast > 0.02 && fast < 0.15, `tails ${slow} ${fast}`);
});

test('invalid totals and housing estimates cannot silently truncate the roster', () => {
  assert.throws(() => buildPopulation(base, source, {...population, students: {...population.students, total: 1}}));
  assert.throws(() => buildPopulation(base, source, {...population, housing: {estimatedUndergraduateResidents: 99999}}));
  assert.throws(() => buildPopulation(base, source, {...population, residentialCapacities: {warren: NaN}}));
  assert.throws(() => buildPopulation(base, source, {...population, campusResidentMinimums: [{campus: 'fenway', students: 99999}]}));
});


test('campus weights count eligible weekly sections once across rows and cross-listings', () => {
  const meeting = (courseCode, section, seats, sharedKey = null) => ({courseCode, section, roomCapacity: seats, sharedKey, calendarRestricted: false});
  const base = {campuses: [{id:'charles-river'}, {id:'medical'}], locations: [{id:'crc',campus:'charles-river'}, {id:'med',campus:'medical'}]};
  const data = {locations: {
    crc: {id:'crc',meetings:[meeting('CAS MA 123','A1',100),meeting('CAS CS 500','A1',50,'shared'),meeting('GRS CS 700','B1',50,'shared')]},
    med: {id:'med',meetings:[meeting('MED MD 101','A1',40),meeting('GMS AN 700','A1',20)]}
  }};
  const expected = {'charles-river':{undergraduate:150,graduate:50},medical:{undergraduate:0,graduate:60}};
  assert.deepEqual(campusOfferingWeights(base,data),expected);
  data.locations.crc.meetings.push({...data.locations.crc.meetings[0]}, {...data.locations.crc.meetings[1]}, meeting('PDP FT 100','A1',9999));
  data.locations.med.meetings.push({...data.locations.med.meetings[0]});
  assert.deepEqual(campusOfferingWeights(base,data),expected);
});

test('campus weights omit sections outside the reference week but retain boundary-day meetings', () => {
  const base = {campuses:[{id:'charles-river'}], locations:[{id:'crc',campus:'charles-river'}]};
  const meeting = (courseCode, extra) => ({courseCode, section:'A1', roomCapacity:40, calendarRestricted:false,
    intervals:[{weekday:0,startSec:32400,endSec:36000}], ...extra});
  const data = {referenceWeekStart:'2026-10-19', locations:{crc:{id:'crc',meetings:[
    meeting('CAS MA 123',{validTo:'2026-10-18'}),
    meeting('CAS MA 124',{validFrom:'2026-10-20'}),
    meeting('CAS MA 125',{validFrom:'2026-10-19',validTo:'2026-10-19'}),
  ]}}};
  assert.deepEqual(campusOfferingWeights(base,data),{'charles-river':{undergraduate:40,graduate:0}});
});

test('primary-campus model keeps undergraduate roster outside medical and is insensitive to duplicated rows', () => {
  const result = buildPopulation(base, source, population);
  assert.equal(result.agents.filter(a => a.studentLevel === 'undergraduate' && a.campus === 'medical').length,0);
  const duplicated = structuredClone(source);
  for (const location of Object.values(duplicated.locations)) location.meetings.push(...structuredClone(location.meetings));
  assert.deepEqual(buildPopulation(base,duplicated,population).agents,result.agents);
  assert.equal(result.agents.filter(a => a.campus === 'fenway' && a.residency === 'resident').length,595);
});
