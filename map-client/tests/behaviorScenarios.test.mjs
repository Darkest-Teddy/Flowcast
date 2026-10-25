import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { conditionsFor } = await import('../src/sim/conditions.ts');
const { dateForWeekday } = await import('../src/data/campusData.ts');
const { sampleRoster, scoreDay } = await import('../src/sim/validate.ts');
const { compareDays } = await import('../src/sim/compare.ts');
const { createTransitService, mergeSchedules } = await import('../src/sim/transitService.ts');
const { applyIncident } = await import('../src/sim/incidents.ts');

const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const data = read('campus-data');
const full = buildPopulation(read('demo-day'), data, read('population'));
const model = { behavior: read('behavior'), personas: read('personas'), outdoor: read('outdoor') };
const transit = createTransitService(mergeSchedules(read('transit-schedule'), read('shuttle-schedule')));
/** As the map builds days: published transit rides and that date's campus events, plus the conditions engine. */
const build = (base, source, weekday, conditions, withModel = true) => buildSourceDay(base, source, weekday, transit,
  { eventDate: dateForWeekday(source, weekday), ...(conditions ? { conditions, ...(withModel ? { model } : {}) } : {}) });
const conditions = (weekday, weather, extra = {}) => conditionsFor({ date: dateForWeekday(data, weekday), weekday, calendar: data.academicCalendar, weather, ...extra });

/** Every student's day is covered end to end by stays and walks, with no overlaps. */
function complete(day) {
  const parts = new Map(day.agents.map(agent => [agent.id, []]));
  for (const stay of day.stays) parts.get(stay.agent).push([stay.start, stay.end]);
  for (const trip of day.trips) parts.get(trip.agent).push([trip.timestamps[0], trip.timestamps.at(-1)]);
  for (const [id, list] of parts) {
    list.sort((a, b) => a[0] - b[0]);
    let end = 0;
    for (const [start, finish] of list) { assert.ok(Math.abs(start - end) < 1e-6, `${id}: gap/overlap at ${end}`); end = finish; }
    assert.equal(end, 86400, `${id} ends at midnight`);
  }
}
const personHours = (day, test) => day.stays.reduce((sum, stay) => sum + (test(stay.location) ? (stay.end - stay.start) / 3600 : 0), 0);

test('with no behaviour model, conditions leave the full-roster day exactly as it is without conditions', () => {
  const weekday = 2;
  const plain = build(full, data, weekday);
  const conditioned = build(full, data, weekday, conditions(weekday, { condition: 'rain', temperatureF: 40 }, { scenario: 'any' }), false);
  assert.notEqual(conditioned, plain, 'built through the conditioned path, not the cache');
  assert.equal(conditioned.trips.length, plain.trips.length);
  assert.deepEqual(conditioned.trips, plain.trips);
  assert.deepEqual(conditioned.stays, plain.stays);
  assert.deepEqual(conditioned.sourceAssignments, plain.sourceAssignments);
  assert.deepEqual(conditioned.sourceActivities, plain.sourceActivities);
  assert.deepEqual(conditioned.transitRides, plain.transitRides);
  assert.deepEqual(conditioned.gatherings, plain.gatherings);
  assert.equal(build(full, data, weekday), plain, 'the unconditioned day stays cached and unchanged');
});

const sample = sampleRoster(full, data, 8);
const sampleConditions = (weekday, weather, extra) => conditions(weekday, weather, extra);

test('rain moves time into libraries and out of the river and outings, without changing who exists', () => {
  const weekday = 5; // Saturday: outings, river time and study all on the menu
  const dry = build(sample.base, sample.data, weekday, sampleConditions(weekday, { condition: 'clear', temperatureF: 75 }));
  const wet = build(sample.base, sample.data, weekday, sampleConditions(weekday, { condition: 'rain', temperatureF: 75 }));
  for (const day of [dry, wet]) { assert.equal(day.agents.length, sample.base.agents.length); complete(day); }
  const library = (day) => personHours(day, id => sample.base.locations.find(l => l.id === id)?.kind === 'library');
  const river = (day) => personHours(day, id => id.startsWith('outdoor:'));
  const outings = (day) => day.sourceActivities.filter(row => row.kind === 'off-campus-outing').length;
  assert.ok(library(wet) > library(dry) * 1.03, `library ${library(dry).toFixed(0)} → ${library(wet).toFixed(0)} h`);
  // Weekends are mostly off campus or indoors, so river time is modest even when dry.
  assert.ok(river(dry) > 15 && river(wet) < river(dry) * 0.2, `river ${river(dry).toFixed(0)} → ${river(wet).toFixed(0)} h`);
  assert.ok(outings(wet) < outings(dry), `outings ${outings(dry)} → ${outings(wet)}`);
  const comparison = compareDays(dry, wet, sample.base, { 'outdoor:bu-beach': 'BU Beach' });
  assert.equal(comparison.hours.length, 24);
  assert.ok(comparison.totals.find(row => row.id === 'library').scenario > comparison.totals.find(row => row.id === 'library').baseline);
});

test('finals and a snow day change timelines through the calendar and the weather, not counts', () => {
  const weekday = 2;
  const normal = build(sample.base, sample.data, weekday, sampleConditions(weekday, { condition: 'clear', temperatureF: 60 }));
  const finals = build(sample.base, sample.data, weekday, conditionsFor({ date: '2026-12-16', weekday, calendar: data.academicCalendar, weather: { condition: 'clear', temperatureF: 40 } }));
  const snow = build(sample.base, sample.data, weekday, sampleConditions(weekday, { condition: 'snow', temperatureF: 25 }));
  for (const day of [normal, finals, snow]) { assert.equal(day.agents.length, sample.base.agents.length); complete(day); }
  assert.ok(finals.sourceAssignments.length < normal.sourceAssignments.length * 0.45, 'most class meetings give way to exams');
  const walkMinutes = (day) => day.trips.reduce((sum, trip) => sum + trip.timestamps.at(-1) - trip.timestamps[0], 0) / Math.max(1, day.trips.length);
  assert.ok(walkMinutes(snow) > walkMinutes(normal) * 1.05, 'walking is slower in snow');
  // Each person walks at their own speed, which the day's agents carry (slower for everyone in snow).
  const meanSpeed = (day) => day.agents.reduce((sum, agent) => sum + agent.walkSpeed, 0) / day.agents.length;
  assert.ok(meanSpeed(normal) > 1.3 && meanSpeed(normal) < 1.4 && meanSpeed(snow) < meanSpeed(normal) * 0.9, `${meanSpeed(normal)} → ${meanSpeed(snow)} m/s`);
  for (const day of [normal, snow]) {
    const speeds = new Map(day.agents.map(agent => [agent.id, agent.walkSpeed]));
    // Walks to and from a shared meal go at the group's pace instead (sim/groups.ts).
    const groupLegs = new Set(day.sourceActivities.filter(a => a.group).map(a => `${a.agentId}|${a.locationId}`));
    let checked = 0;
    for (const trip of day.trips) {
      const route = sample.base.walkRoutes[`${trip.from}>${trip.to}`];
      if (!route || trip.path !== route.path) continue;
      if (groupLegs.has(`${trip.agent}|${trip.to}`) || groupLegs.has(`${trip.agent}|${trip.from}`)) continue;
      assert.ok(Math.abs((trip.timestamps.at(-1) - trip.timestamps[0]) * speeds.get(trip.agent) - route.cumulative.at(-1)) < 1e-6, `${trip.agent} at their own speed`);
      checked++;
    }
    assert.ok(checked > 1000);
    assert.ok(new Set(speeds.values()).size > day.agents.length / 2, 'speeds vary person to person');
  }
  for (const location of sample.base.locations) assert.equal(normal.locations.find(row => row.id === location.id).capacity, location.capacity, 'capacities never change');
});

test('the conditions engine meets the validator’s sanity targets on a sampled Wednesday', () => {
  const weekday = 2;
  const day = build(sample.base, sample.data, weekday, sampleConditions(weekday, { condition: 'clear', temperatureF: 62 }));
  const score = scoreDay({ label: 'Wednesday', day, base: sample.base, data: sample.data, weekday, scale: sample.scale, kind: 'normal' });
  const metric = (id) => score.metrics.find(row => row.id === id);
  assert.equal(metric('walkers-3am').loss, 0);
  assert.equal(metric('outdoor-3am').loss, 0);
  assert.equal(metric('dining-peak-at-meal').loss, 0, `dining peaks at ${metric('dining-peak-at-meal').value}h`);
  assert.ok(metric('fitrec-hourly-r').value > 0.8);
  assert.ok(metric('fitrec-daily-ratio').loss < 0.4, `FitRec ratio ${metric('fitrec-daily-ratio').value}`);
});

test('a scenario event joins the day’s campus events as one more gathering, and incidents still run on a conditioned day', () => {
  const weekday = 5;
  const hockey = { id: 'hockey-agganis', label: 'Hockey at Agganis', locationId: 'agganis', start: 68400, end: 77400, expectedStudents: 250, capacity: 6000 };
  const on = (date) => buildSourceDay(sample.base, sample.data, weekday, transit, { eventDate: date, model,
    conditions: conditionsFor({ date, weekday, calendar: data.academicCalendar, weather: { condition: 'clear', temperatureF: 70 }, events: [hockey], scenario: 'hockey-game' }) });
  // Oct 31 has a published show at Agganis at 8 PM: the published event keeps the venue (no double count).
  assert.ok(!on('2026-10-31').gatherings.some(g => g.eventId === 'hockey-agganis'));
  const day = on('2026-11-07');
  const game = day.gatherings.find(g => g.eventId === 'hockey-agganis');
  assert.ok(game && game.attendees > 60 && game.attendees <= 250, `${game?.attendees} at the game (students free for the whole game)`);
  assert.equal(game.capacity, 6000, 'event seats, not the arena’s everyday capacity');
  assert.ok(day.gatherings.every(g => g.eventId === 'hockey-agganis' || g.capacity <= 6000));
  complete(day);
  assert.ok(day.stays.some(stay => stay.location.startsWith('outdoor:')), 'river time on a 70°F Saturday');
  const target = sample.base.locations.find(location => location.id === 'mugar');
  const result = applyIncident(day, { id: 'drill', kind: 'fire-drill', locationId: target.id, start: 14 * 3600, duration: 1800 }, { sourceData: sample.data, weekday });
  assert.equal(result.day.agents.length, day.agents.length);
});
