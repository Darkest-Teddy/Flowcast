import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { academicPeriodFor, conditionsFor, conditionsKey, daylightFor, weatherKind } = await import('../src/sim/conditions.ts');
const { paramsFor, dayBehavior, validatePersonas, personaFor, cohortOf, SCALAR_NAMES } = await import('../src/sim/behavior.ts');
const { LEGACY_BEHAVIOR, freeTimeActivities, MODELED_OFF_CAMPUS_MEAL_SHARE, MODELED_ACTIVITY_SHOULDER_SHARE, HABIT_TRAITS, OFF_MAP_ACADEMIC_SHARE, HABITUAL_TIME_SHARE, FAVORITE_VENUE_WEIGHT } = await import('../src/sim/sourceDay.ts');
const { pearson, scoreDay, compareScores, sampleRoster, walkersPerMinute } = await import('../src/sim/validate.ts');
const { encodeDay, decodeDaySteps } = await import('../src/sim/dayCodec.ts');
const { drain } = await import('../src/sim/occupancyIndex.ts');
const { explain, effectText } = await import('../src/sim/explain.ts');
const { scenarioInput, baselineInput } = await import('../src/sim/scenarios.ts');
const { sittingSpot, alongRoute } = await import('../src/sim/outdoor.ts');

const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const campus = read('campus-data');
const behavior = read('behavior'), personas = read('personas'), scenarios = read('scenarios'), outdoor = read('outdoor');
const calendar = campus.academicCalendar;

test('academic periods follow the Registrar calendar', () => {
  const period = (date) => academicPeriodFor(date, calendar).period;
  assert.equal(period('2026-10-28'), 'classes');
  assert.equal(period('2026-10-31'), 'classes', 'weekends in term keep the term period');
  assert.equal(period('2026-10-12'), 'holiday');
  assert.equal(period('2026-11-26'), 'break');
  assert.equal(period('2026-12-12'), 'reading-period');
  assert.equal(period('2026-12-16'), 'finals');
  assert.equal(period('2026-08-30'), 'move-in');
  assert.equal(period('2027-01-05'), 'break');
  assert.equal(period('2027-04-19'), 'holiday', 'Patriots’ Day');
  assert.equal(period('2025-01-01'), 'unknown');
});

test('conditions are deterministic; the cache key ignores exact temperature within a band', () => {
  const a = conditionsFor({ date: '2026-10-28', weekday: 2, calendar, weather: { condition: 'rain', temperatureF: 51 } });
  const b = conditionsFor({ date: '2026-10-28', weekday: 2, calendar, weather: { condition: 'heavy-rain', temperatureF: 53 } });
  assert.deepEqual(a, conditionsFor({ date: '2026-10-28', weekday: 2, calendar, weather: { condition: 'rain', temperatureF: 51 } }));
  assert.equal(conditionsKey(a), conditionsKey(b));
  assert.notEqual(conditionsKey(a), conditionsKey(conditionsFor({ date: '2026-10-28', weekday: 2, calendar, weather: { condition: 'clear', temperatureF: 51 } })));
  assert.equal(weatherKind('clear', 95), 'heat');
  assert.equal(weatherKind('thunderstorm', 70), 'storm');
  const { sunrise, sunset } = daylightFor('2026-10-24');
  assert.ok(Math.abs(sunrise - (7 + 8 / 60)) < 0.1 && Math.abs(sunset - (17 + 49 / 60)) < 0.1, `${sunrise} ${sunset}`);
  assert.throws(() => conditionsFor({ date: '28/10/2026' }));
});

test('behavior.json base values equal the day builder’s constants', () => {
  for (const name of SCALAR_NAMES) assert.equal(behavior.scalars[name].base, LEGACY_BEHAVIOR.scalars[name], name);
  assert.equal(behavior.scalars.offCampusMealShare.base, MODELED_OFF_CAMPUS_MEAL_SHARE);
  assert.equal(behavior.scalars.shoulderShare.base, MODELED_ACTIVITY_SHOULDER_SHARE);
  assert.equal(behavior.scalars.offMapAcademicShare.base, OFF_MAP_ACADEMIC_SHARE);
  assert.equal(behavior.scalars.habitualTimeShare.base, HABITUAL_TIME_SHARE);
  assert.equal(behavior.scalars.favoriteVenueWeight.base, FAVORITE_VENUE_WEIGHT);
  // The builder's own habits are the base; extra habit slots are dormant (no regulars).
  for (const [slot, trait] of Object.entries(HABIT_TRAITS)) assert.deepEqual({ share: behavior.habits[slot].share, high: behavior.habits[slot].high }, trait, slot);
  for (const [slot, habit] of Object.entries(behavior.habits)) if (!HABIT_TRAITS[slot]) assert.equal(habit.share, 0, slot);
  for (let weekday = 0; weekday < 7; weekday++) {
    const menu = behavior.activities.menus[behavior.activities.weekdayMenus[weekday]];
    const legacy = freeTimeActivities(weekday);
    for (const [index, activity] of legacy.entries()) {
      const row = menu[index];
      for (const field of ['kind', 'at', 'spread', 'minutes', 'probability']) assert.equal(row[field], activity[field], `${weekday}/${index}/${field}`);
      assert.deepEqual(row.shoulder, [...activity.shoulder]);
      assert.equal(row.id, LEGACY_BEHAVIOR.menus[weekday][index].id);
    }
    // Extra activities are appended (so earlier per-activity draws are unchanged) and dormant at base.
    for (const extra of menu.slice(legacy.length)) assert.equal(extra.probability, 0, extra.id);
  }
  for (const name of SCALAR_NAMES) for (const field of ['label', 'provenance']) assert.ok(behavior.scalars[name][field], `${name}.${field}`);
  for (const modifier of behavior.modifiers) assert.ok(['measured', 'published', 'assumption', 'fitted'].includes(modifier.provenance.kind), modifier.id);
});

test('modifiers compose in order (calibration first), respect windows and clamp to bounds', () => {
  const file = {
    schemaVersion: 1,
    scalars: Object.fromEntries(SCALAR_NAMES.map(name => [name, { base: LEGACY_BEHAVIOR.scalars[name], min: 0, max: name === 'classAttendance' ? 1 : 1000, unit: '', label: name, provenance: { kind: 'assumption', note: '' } }])),
    activities: { weekdayMenus: ['m', 'm', 'm', 'm', 'm', 'm', 'm'], menus: { m: [
      { id: 'lunch', label: 'lunch', kind: 'dining', at: 12, spread: 2, shoulder: [10, 16], minutes: 30, probability: 0.5, provenance: { kind: 'assumption', note: '' } },
      { id: 'study', label: 'study', kind: 'library', at: 19, spread: 2, shoulder: [18, 22], minutes: 60, probability: 0.4, provenance: { kind: 'assumption', note: '' } },
    ] } },
    modifiers: [
      { id: 'rain', label: 'Rain', group: 'conditions', when: { weather: ['rain'] }, effects: [
        { target: 'classAttendance', op: 'add', value: 0.5 },
        { target: 'activity.@library.probability', op: 'mul', value: 3 },
        { target: 'offCampusMealShare', op: 'mul', value: 0.5 }], provenance: { kind: 'assumption', note: '' } },
      { id: 'cal', label: 'Calibration', group: 'calibration', effects: [{ target: 'offCampusMealShare', op: 'set', value: 0.4 }], provenance: { kind: 'fitted', note: '' } },
      { id: 'noon', label: 'Midday', group: 'conditions', window: [11, 14], effects: [{ target: 'activity.*.minutes', op: 'mul', value: 2 }], provenance: { kind: 'assumption', note: '' } },
      { id: 'snow', label: 'Snow', group: 'conditions', when: { weather: ['snow'] }, effects: [{ target: 'classAttendance', op: 'set', value: 0 }], provenance: { kind: 'assumption', note: '' } },
    ],
  };
  const rain = conditionsFor({ date: '2026-10-28', weekday: 2, calendar, weather: { condition: 'rain', temperatureF: 50 } });
  const { params, active } = paramsFor(rain, { behavior: file }, LEGACY_BEHAVIOR);
  assert.equal(params.scalars.offCampusMealShare, 0.2, 'calibration set 0.4 first, then rain ×0.5');
  assert.equal(params.scalars.classAttendance, 1, '1 + 0.5 clamped to 1');
  assert.equal(params.menus[2][1].probability, 1, '0.4 × 3 clamped to 1');
  assert.equal(params.menus[2][0].minutes, 60, 'window 11–14 covers lunch');
  assert.equal(params.menus[2][1].minutes, 60, 'window 11–14 skips evening study');
  assert.deepEqual(active.map(row => row.id), ['cal', 'rain', 'noon']);
  assert.equal(effectText(active[1].changes[1]), 'library study: share who go +200%');
  const dry = paramsFor(conditionsFor({ date: '2026-10-28', weekday: 2, calendar, weather: { condition: 'clear', temperatureF: 60 } }), { behavior: file }, LEGACY_BEHAVIOR);
  assert.equal(dry.params.scalars.offCampusMealShare, 0.4);
  assert.throws(() => paramsFor(rain, { behavior: { ...file, modifiers: [{ ...file.modifiers[0], effects: [{ target: 'nonsense', op: 'mul', value: 2 }] }] } }, LEGACY_BEHAVIOR), /Unknown behaviour target/);
  // Without a behaviour file the parameters are exactly the builder's constants.
  const legacy = paramsFor(rain, undefined, LEGACY_BEHAVIOR);
  assert.deepEqual(legacy.params.scalars, LEGACY_BEHAVIOR.scalars);
  assert.equal(legacy.active.length, 0);
});

test('outdoor visits are limited to daylight', () => {
  const december = conditionsFor({ date: '2026-12-16', weekday: 2, calendar, weather: { condition: 'clear', temperatureF: 40 } });
  const { params, active } = paramsFor(december, { behavior }, LEGACY_BEHAVIOR);
  const lawn = params.menus[2].find(row => row.id === 'river-lawn');
  assert.ok(lawn.shoulder[1] + lawn.minutes / 60 <= december.daylight.sunset + 0.26, JSON.stringify(lawn));
  assert.ok(active.some(row => row.id === 'daylight'));
});

test('persona shares sum to 1 per cohort, assignment is stable, and personas modulate the builder’s habits', () => {
  validatePersonas(personas);
  for (const [cohort, shares] of Object.entries(personas.cohorts)) assert.ok(Math.abs(Object.values(shares).reduce((a, b) => a + b, 0) - 1) < 1e-9, cohort);
  assert.throws(() => validatePersonas({ ...personas, cohorts: { x: { typical: 0.5 } } }), /sum to 0.5/);
  assert.throws(() => validatePersonas({ ...personas, cohorts: { x: { ghost: 1 } } }), /unknown persona/);
  const agents = Array.from({ length: 20000 }, (_, i) => ({ id: `undergraduate:full-time:${i}`, studentLevel: 'undergraduate', residency: 'resident', home: 'warren' }));
  assert.equal(cohortOf(agents[0]), 'undergraduate-resident');
  const counts = {};
  for (const agent of agents) { const persona = personaFor(agent, personas); counts[persona] = (counts[persona] ?? 0) + 1; }
  for (const [id, share] of Object.entries(personas.cohorts['undergraduate-resident'])) assert.ok(Math.abs(counts[id] / agents.length - share) < 0.015, `${id}: ${counts[id]}`);
  assert.equal(personaFor(agents[7], personas), personaFor({ ...agents[7] }, personas));
  // Personas set how likely their students are to be habit regulars (no second trait system); the
  // cohort's share of regulars stays at the day's value, so calibrated averages don't move.
  const conditions = conditionsFor({ date: '2026-10-28', weekday: 2, calendar, weather: { condition: 'clear', temperatureF: 60 } });
  const day = dayBehavior(conditions, { behavior, personas }, LEGACY_BEHAVIOR);
  for (const slot of ['gym', 'library', 'breakfast', 'off-campus-outing']) {
    const mean = agents.reduce((sum, agent) => sum + day.paramsOf(agent).habits[slot].share, 0) / agents.length;
    assert.ok(Math.abs(mean - day.params.habits[slot].share) < 0.015, `${slot}: ${mean} vs ${day.params.habits[slot].share}`);
  }
  const gymRegular = agents.find(agent => personaFor(agent, personas) === 'gym-regular');
  const typical = agents.find(agent => personaFor(agent, personas) === 'typical');
  assert.ok(day.paramsOf(gymRegular).habits.gym.share > 0.9 && day.paramsOf(typical).habits.gym.share < day.params.habits.gym.share);
  assert.equal(personaFor(agents[0], undefined), undefined, 'no persona file: today’s behaviour');
});

test('scenarios override conditions and pair with an ordinary-day baseline', () => {
  const ids = scenarios.scenarios.map(row => row.id);
  for (const id of ['baseline', 'rainy-exam-week', 'snow-day', 'finals-week', 'heatwave', 'hockey-game', 'move-in-day', 'marathon-monday']) assert.ok(ids.includes(id), id);
  const shown = { date: '2026-10-28', weekday: 2, weather: { condition: 'clear', temperatureF: 60 } };
  const rainy = conditionsFor({ ...scenarioInput(shown, scenarios.scenarios.find(row => row.id === 'rainy-exam-week')), calendar });
  assert.equal(rainy.period, 'finals'); assert.equal(rainy.weather.kind, 'rain'); assert.equal(rainy.scenario, 'rainy-exam-week');
  const marathon = conditionsFor({ ...scenarioInput(shown, scenarios.scenarios.find(row => row.id === 'marathon-monday')), calendar });
  assert.equal(marathon.weekday, 0); assert.equal(marathon.period, 'holiday');
  const hockey = conditionsFor({ ...scenarioInput(shown, scenarios.scenarios.find(row => row.id === 'hockey-game')), calendar });
  assert.equal(hockey.events[0].locationId, 'agganis');
  const baseline = conditionsFor({ ...baselineInput(rainy, scenarios, '2026-10-28'), calendar });
  assert.equal(baseline.period, 'classes'); assert.equal(baseline.weekday, 2); assert.equal(baseline.events.length, 0);
});

test('validator scores: correlation, sanity checks and acceptance rule', () => {
  assert.equal(pearson([1, 2, 3, 4], [2, 4, 6, 8]), 1);
  assert.ok(Math.abs(pearson([1, 2, 3, 4], [4, 3, 2, 1]) + 1) < 1e-12);
  const base = { day: 'Wednesday', buildings: [], locations: [{ id: 'gsu', name: 'GSU', short: 'GSU', kind: 'dining', position: [-71.1, 42.35], capacity: 100, building: 'gsu' }],
    agents: [{ id: 'a', home: 'off-campus', model: 0 }, { id: 'b', home: 'off-campus', model: 0 }], trips: [] };
  const trip = (agent, start, end) => ({ agent, from: 'off-campus', to: 'gsu', path: [[-71.1, 42.35], [-71.101, 42.35]], timestamps: [start, end] });
  const quiet = { ...base, trips: [trip('a', 12 * 3600, 12 * 3600 + 300)], stays: [{ agent: 'a', location: 'gsu', start: 12 * 3600, end: 13 * 3600 }], sourceActivities: [], sourceAssignments: [], sourceStats: {} };
  const night = { ...quiet, trips: [...quiet.trips, trip('b', 3 * 3600 - 60, 3 * 3600 + 600)] };
  const data = { ...campus, signals: [] };
  const metric = (day, id) => scoreDay({ label: 'x', day, base, data, weekday: 2, kind: 'sanity' }).metrics.find(row => row.id === id);
  assert.equal(walkersPerMinute(night)[180], 1);
  assert.equal(metric(quiet, 'walkers-3am').loss, 0);
  assert.ok(metric(night, 'walkers-3am').loss > 0, 'half the peak walking at 3 am is penalised');
  const score = (loss) => [{ day: 'd', loss, metrics: [{ id: 'm', loss }, { id: 'n', loss: 0.5 }] }];
  assert.equal(compareScores(score(1), score(0.5)).accept, true);
  assert.equal(compareScores(score(0.5), score(1)).accept, false);
  const worse = compareScores([{ day: 'd', loss: 1, metrics: [{ id: 'm', loss: 0.5 }, { id: 'n', loss: 0.5 }] }], [{ day: 'd', loss: 0.8, metrics: [{ id: 'm', loss: 0.2 }, { id: 'n', loss: 0.6 }] }]);
  assert.equal(worse.accept, false, 'a lower total cannot hide one metric getting worse');
  assert.match(worse.worse[0], /d\/n/);
  const sampled = sampleRoster({ ...base, agents: Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, home: 'off-campus', model: 0 })) }, { ...campus, locations: {} }, 4);
  assert.equal(sampled.base.agents.length, 10); assert.equal(sampled.scale, 0.25); assert.equal(sampled.base.locations[0].capacity, 25);
});

test('the day codec round-trips trips and stays exactly enough to play back', () => {
  const base = { day: 'Wednesday', buildings: [], locations: [{ id: 'gsu', name: 'GSU', short: 'GSU', kind: 'dining', position: [-71.1, 42.35], capacity: 100, building: 'gsu' }],
    agents: [{ id: 'a', home: 'off-campus', model: 1 }, { id: 'b', home: 'off-campus', model: 2 }], trips: [] };
  const path = [[-71.1, 42.35], [-71.1005, 42.3502], [-71.101, 42.35]];
  const day = { ...base, locations: [{ ...base.locations[0], activityModeled: false }], trips: [
    { agent: 'a', from: 'off-campus', to: 'gsu', path, timestamps: [100, 150, 200] },
    { agent: 'b', from: 'off-campus', to: 'outdoor:bu-beach', path, timestamps: [300, 400, 500] }],
    stays: [{ agent: 'a', location: 'gsu', start: 200, end: 900 }, { agent: 'b', location: 'outdoor:bu-beach', start: 500, end: 800 }] };
  const decoded = drain(decodeDaySteps(encodeDay(day, base, 'k'), base, 1));
  assert.equal(decoded.trips[0].path, decoded.trips[1].path, 'shared paths stay shared');
  for (const [i, trip] of day.trips.entries()) {
    assert.deepEqual({ ...decoded.trips[i], timestamps: undefined }, { ...trip, timestamps: undefined });
    trip.timestamps.forEach((time, k) => assert.ok(Math.abs(decoded.trips[i].timestamps[k] - time) < 1e-9));
  }
  assert.deepEqual(decoded.stays, day.stays);
  assert.equal(decoded.locations[0].activityModeled, false);
  assert.throws(() => drain(decodeDaySteps(encodeDay(day, base, 'k'), { ...base, agents: base.agents.slice(1) })), /different roster/);
});

test('the explanation is plain text from fixed templates', () => {
  const conditions = conditionsFor({ date: '2026-10-28', weekday: 2, calendar, weather: { condition: 'rain', temperatureF: 50, source: 'live' } });
  const day = dayBehavior(conditions, { behavior, personas }, LEGACY_BEHAVIOR);
  const info = { key: day.key, conditions, active: day.active, personaMix: [{ id: 'typical', label: 'Typical', students: 30 }, { id: 'night-owl', label: 'Night owl', students: 10 }],
    students: 40, validation: { totalLoss: 2, unconditionedLoss: 5 }, buildMs: 1234, visits: { 'library visits': 12 }, outdoorPeak: { count: 3, hour: 15 } };
  const text = explain(info);
  assert.equal(text.headline, 'Wednesday 2026-10-28: classes in session, rain, 50°F.');
  const rain = text.modifiers.find(row => row.id === 'rain');
  assert.ok(rain.effects.includes('library study: share who go +12%'), rain.effects.join(' | '));
  assert.match(rain.source, /^assumption: /);
  assert.ok(text.personas[0].startsWith('Typical: 30 students (75%)'));
  assert.deepEqual(explain(info), text, 'deterministic');
});

test('outdoor spots sit on the Boston bank, reached through connectors from campus locations', () => {
  const river = read('river').polygons.map(row => row.polygon);
  const bostonSide = ([lon, lat]) => river.every(polygon => {
    const crossings = [];
    for (let i = 0; i < polygon.length; i++) {
      const [x1, y1] = polygon[i], [x2, y2] = polygon[(i + 1) % polygon.length];
      if ((x1 - lon) * (x2 - lon) <= 0 && x1 !== x2) crossings.push(y1 + (lon - x1) / (x2 - x1) * (y2 - y1));
    }
    return !crossings.length || lat < Math.min(...crossings) + 0.00005;
  });
  const day = read('demo-day');
  for (const spot of outdoor.spots) {
    for (const point of spot.polygon ?? spot.loop.path) assert.ok(bostonSide(point), `${spot.id} ${point}`);
    assert.ok(spot.connectors.length > 0);
    for (const connector of spot.connectors) {
      assert.deepEqual(connector.path.at(-1), spot.entry);
      const route = Object.entries(day.walkRoutes).find(([key]) => key.startsWith(`${connector.location}>`))[1];
      assert.deepEqual(connector.path[0], route.path[0], 'starts at the location’s saved walk endpoint');
      for (const point of connector.path) assert.ok(bostonSide(point), `${spot.id} via ${connector.location}`);
    }
  }
  const beach = outdoor.spots.find(spot => spot.id === 'outdoor:bu-beach');
  assert.deepEqual(sittingSpot(beach, 'x'), sittingSpot(beach, 'x'));
  const loop = outdoor.spots.find(spot => spot.kind === 'loop').loop;
  const length = loop.cumulative.at(-1);
  assert.deepEqual(alongRoute(loop, 10).position, alongRoute(loop, 10 + length).position, 'loops wrap');
});
