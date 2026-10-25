import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const C = await import('../src/sim/campusRides.ts');
const T = await import('../src/sim/transitService.ts');
const { Playback } = await import('../src/sim/playback.ts');

// ---- the planner on a tiny published timetable: shuttle trips from S1 (by "west") to S2 (by "east")
const WED = 2;
const at = (x) => [-71.1 + x / 84000, 42.35];
const departures = Array.from({ length: 13 }, (_, k) => 8 * 3600 + k * 600); // 08:00–10:00 every 10 min
const schedule = { schemaVersion: 1, referenceWeekStart: '2026-10-26', dates: [], priorDate: '', feed: { start: '', end: '', version: '' }, sourceUrl: 'test',
  stops: { g1: { position: at(100), mapStopId: 'S1' }, g2: { position: at(1900), mapStopId: 'S2' }, g3: { position: at(3000), mapStopId: 'S3' } },
  trips: departures.map((time, k) => ({ id: `t${k}`, route: 'BU-1', direction: 0, weekdays: [WED],
    stops: [{ stop: 'g1', arrival: time - 30, departure: time }, { stop: 'g2', arrival: time + 300, departure: time + 330 }, { stop: 'g3', arrival: time + 420, departure: time + 420 }] })) };
const service = T.createTransitService(schedule);
const leg = (a, b) => ({ path: [at(a), at(b)], cumulative: [0, Math.abs(b - a)] });
const network = { stops: ['S1', 'S2'], stopPoint: (stop) => stop === 'S1' ? at(100) : at(1900),
  point: (location) => location === 'west' ? at(0) : location === 'east' ? at(2000) : undefined,
  fromStop: (stop, location) => ({ S1: { west: leg(100, 0) }, S2: { east: leg(1900, 2000) } })[stop]?.[location] };
const request = (overrides = {}) => ({ from: 'west', to: 'east', weekday: WED, speed: 1.4, earliest: 8.9 * 3600, walkDepart: 9 * 3600, walkSeconds: 2000 / 1.4,
  shareFactor: 1, rideDraw: 0.01, timingDraw: 0, marginDraw: 0.5, hasRoom: () => true, fits: () => true, ...overrides });

test('a ride uses one published trip, boarding before alighting, and arrives no later than the walk', () => {
  const rides = C.createCampusRides(service, network);
  const ride = rides.plan(request());
  assert.ok(ride, 'a 24-minute walk with a 5-minute shuttle becomes a ride');
  const trip = schedule.trips.find((row) => row.id === ride.trip);
  assert.equal(ride.departs, trip.stops[0].departure, 'boards at the published departure');
  assert.equal(ride.arrives, trip.stops[1].arrival, 'steps off at the published arrival');
  assert.equal(ride.walkOn, ride.arrives + T.ALIGHT_SECONDS);
  const r = request();
  assert.ok(ride.leave >= r.earliest - 1e-9 && ride.atStop <= ride.departs + 1e-9, 'leaves no earlier than allowed and is at the stop in time');
  assert.ok(ride.departs - ride.atStop <= C.CAMPUS_RIDE_STOP_MARGIN_SECONDS[1] + 1e-9, 'waits at most the modeled margin');
  assert.ok(ride.reach <= r.walkDepart + r.walkSeconds + 1e-9, 'never later than walking');
  assert.ok(ride.reach - ride.leave < r.walkSeconds, 'quicker door to door');
  assert.deepEqual(ride.option.access.path.at(-1), at(100));
  assert.deepEqual(ride.option.egress.path[0], at(1900));
  assert.deepEqual(C.createCampusRides(service, network).plan(request()), ride, 'deterministic');
  // Someone who doesn't time it sets off as they would have walking and takes the first departure that works.
  const untimed = rides.plan(request({ timingDraw: 0.9 }));
  assert.equal(untimed.leave, r.walkDepart);
  assert.equal(untimed.departs, Math.min(...departures.filter((time) => time >= untimed.atStop)));
  assert.ok(untimed.reach <= r.walkDepart + r.walkSeconds + 1e-9);
});

test('people walk short hops, when the draw says so, when nothing fits, and when no trip has room', () => {
  const rides = C.createCampusRides(service, network);
  assert.equal(rides.plan(request({ walkSeconds: 10 * 60 })), undefined, 'a 10-minute walk is walked');
  assert.equal(rides.plan(request({ rideDraw: 0.99 })), undefined);
  assert.equal(rides.plan(request({ fits: () => false })), undefined);
  assert.equal(rides.plan(request({ hasRoom: () => false })), undefined);
  assert.equal(rides.plan(request({ earliest: 11 * 3600, walkDepart: 11 * 3600 })), undefined, 'no published trip, no ride');
  const best = rides.plan(request());
  const next = rides.plan(request({ hasRoom: (trip) => trip !== best.trip }));
  assert.ok(next && next.trip !== best.trip && next.departs < best.departs, 'a full vehicle means an earlier one');
  const shortHop = { walkSeconds: 10 * 60, walkDepart: 9 * 3600 + 420, marginDraw: 0 };
  assert.equal(rides.plan(request(shortHop)), undefined);
  assert.ok(rides.plan(request({ ...shortHop, shareFactor: 1.4 })), 'in bad weather a 10-minute walk may be a ride');
  assert.equal(rides.plan(request({ shareFactor: 0 })), undefined, 'a zero factor means everyone walks');
});

test('the conditions engine raises the ride factor in rain, snow, storms and cold, and leaves dry days at 1', async () => {
  const { paramsFor } = await import('../src/sim/behavior.ts');
  const { conditionsFor } = await import('../src/sim/conditions.ts');
  const { LEGACY_BEHAVIOR } = await import('../src/sim/sourceDay.ts');
  const behavior = JSON.parse(readFileSync(new URL('../public/data/behavior.json', import.meta.url)));
  const factor = (weather) => paramsFor(conditionsFor({ date: '2026-10-28', weekday: 2, weather }), { behavior }, LEGACY_BEHAVIOR).params.scalars.campusRideFactor;
  assert.equal(LEGACY_BEHAVIOR.scalars.campusRideFactor, 1);
  assert.equal(factor({ condition: 'clear', temperatureF: 62 }), 1);
  assert.ok(factor({ condition: 'rain', temperatureF: 50 }) > 1);
  assert.ok(factor({ condition: 'clear', temperatureF: 20 }) > 1);
});

test('students aboard count a campus ride only between its two stops', () => {
  const ride = { trip: 'x', route: 'Green-B', direction: 0, position: at(0) };
  const pb = new Playback({ day: 'Wednesday', buildings: [], locations: [], agents: [{ id: 'a', home: 'h', model: 0 }, { id: 'b', home: 'off-campus', model: 0 }], trips: [],
    transitRides: [{ ...ride, agent: 'a', kind: 'board', stop: 'S1', time: 100, waitStart: 40, alightsAt: 300 },
      { ...ride, agent: 'a', kind: 'alight', stop: 'S2', time: 300, boardedAt: 100 },
      { ...ride, agent: 'b', kind: 'alight', stop: 'S2', time: 300 }] });
  assert.deepEqual([50, 150, 299, 300, 400].map((t) => pb.studentsAboard('x', t)), [1, 2, 2, 0, 0]);
  assert.deepEqual(pb.waitingAt(60).map((rider) => rider.id), ['a'], 'the campus rider waits at the stop');
});

// ---- the bundled data: a full-roster Wednesday with the published MBTA and BU Shuttle timetable
const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const source = read('campus-data');
const published = T.mergeSchedules(read('transit-schedule'), read('shuttle-schedule'));
const base = buildPopulation(read('demo-day'), source, read('population'));
const day = buildSourceDay(base, source, WED, T.createTransitService(published));
const agents = new Map(base.agents.map((agent) => [agent.id, agent]));
const near = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540) <= 1;
const boards = day.transitRides.filter((ride) => ride.alightsAt !== undefined);
const alights = day.transitRides.filter((ride) => ride.boardedAt !== undefined);
const tripsOf = new Map();
for (const trip of day.trips) tripsOf.set(trip.agent, [...(tripsOf.get(trip.agent) ?? []), trip]);

test('students ride between campus stops on published trips, boarding and alighting the same trip', () => {
  assert.equal(day.sourceStats.campusRides, boards.length);
  assert.ok(boards.length > 300, `${boards.length} campus rides`);
  assert.equal(alights.length, boards.length);
  assert.equal(day.sourceStats.campusRiders, new Set(boards.map((ride) => ride.agent)).size);
  const tripsById = new Map(published.trips.map((trip) => [trip.id, trip]));
  for (const board of boards) {
    const alight = alights.find((ride) => ride.agent === board.agent && ride.trip === board.trip && ride.boardedAt === board.time);
    assert.ok(alight && alight.time === board.alightsAt && alight.time > board.time && alight.stop !== board.stop);
    assert.equal(alight.route, board.route); assert.equal(alight.direction, board.direction);
    const trip = tripsById.get(board.trip), calls = trip.stops.map((call) => ({ ...call, map: published.stops[call.stop]?.mapStopId }));
    const on = calls.findIndex((call, index) => call.map === board.stop && call.departure === board.time && index < calls.length - 1);
    const off = calls.findIndex((call, index) => index > on && call.map === alight.stop && call.arrival === alight.time);
    assert.ok(on >= 0 && off > on, `${board.trip}: boards at a published departure and alights later on the same trip`);
    assert.ok(trip.weekdays.includes(WED));
    assert.notEqual(agents.get(board.agent).role, 'staff', 'employees walk');
  }
  assert.ok(boards.some((ride) => ride.route.startsWith('BU-')) && boards.some((ride) => ride.route.startsWith('Green-')), 'BU Shuttle and Green Line both carry campus riders');
});

test('campus riders wait at the stop, walk on from where they step off, and are never late for class', () => {
  const stays = new Map();
  for (const stay of day.stays) stays.set(stay.agent, [...(stays.get(stay.agent) ?? []), stay]);
  const waiting = new Playback(day);
  for (const board of boards) {
    const alight = alights.find((ride) => ride.agent === board.agent && ride.boardedAt === board.time && ride.trip === board.trip);
    const wait = board.time - board.waitStart;
    assert.ok(wait >= 0 && wait <= C.CAMPUS_RIDE_MAX_WAIT_SECONDS + 1e-6, `wait ${wait}`);
    const walks = tripsOf.get(board.agent);
    const access = walks.find((trip) => trip.to === 'off-campus' && Math.abs(trip.timestamps.at(-1) - board.waitStart) < 1e-6);
    const egress = walks.find((trip) => trip.from === 'off-campus' && Math.abs(trip.timestamps[0] - alight.time - T.ALIGHT_SECONDS) < 1e-6);
    assert.ok(access && near(access.path.at(-1), board.position) && access.from !== 'off-campus', 'walks from a campus place to the stop');
    assert.ok(egress && near(egress.path[0], alight.position) && egress.to !== 'off-campus', 'walks on to a campus place');
    assert.ok(stays.get(board.agent).some((stay) => stay.location === 'off-campus' && Math.abs(stay.start - board.waitStart) < 1e-6
      && Math.abs(stay.end - alight.time - T.ALIGHT_SECONDS) < 1e-6), 'off the map from the stop until stepping off');
    const middle = (board.waitStart + board.time) / 2;
    if (board.time > board.waitStart) assert.ok(waiting.waitingAt(middle).some((rider) => rider.id === board.agent && rider.stop === board.stop));
  }
  // Present for every class from its start: riding never makes anyone late.
  const riders = new Set(boards.map((ride) => ride.agent));
  for (const assignment of day.sourceAssignments) {
    if (!riders.has(assignment.agentId)) continue;
    assert.ok(stays.get(assignment.agentId).some((stay) => stay.location === assignment.locationId && stay.purpose?.kind === 'class'
      && stay.start === assignment.startSec), `${assignment.agentId} is in class at ${assignment.startSec}`);
  }
});

test('friends walking to and from a shared meal keep walking together', () => {
  const egressEnds = new Set(alights.map((ride) => `${ride.agent}|${ride.time + T.ALIGHT_SECONDS}`));
  const accessEnds = new Set(boards.map((ride) => `${ride.agent}|${Math.round(ride.waitStart * 1000)}`));
  let checked = 0;
  for (const meal of day.sourceActivities) {
    if (meal.kind !== 'dining' || !(meal.groupSize > 1)) continue;
    const walks = tripsOf.get(meal.agentId) ?? [];
    const into = walks.filter((trip) => trip.to === meal.locationId && trip.timestamps.at(-1) <= meal.startSec + 1e-6).sort((a, b) => b.timestamps[0] - a.timestamps[0])[0];
    const out = walks.filter((trip) => trip.from === meal.locationId && trip.timestamps[0] >= meal.endSec - 1e-6).sort((a, b) => a.timestamps[0] - b.timestamps[0])[0];
    if (into) assert.ok(!(into.from === 'off-campus' && egressEnds.has(`${meal.agentId}|${into.timestamps[0]}`)), 'nobody rides to a group meal');
    if (out) assert.ok(!(out.to === 'off-campus' && accessEnds.has(`${meal.agentId}|${Math.round(out.timestamps.at(-1) * 1000)}`)), 'nobody rides away from one');
    checked++;
  }
  assert.ok(checked > 1000, `${checked} group meals`);
});

test('campus rides are deterministic and keep every vehicle within its load', () => {
  // A fresh timetable object means a fresh service and a fresh weekly plan.
  const again = buildSourceDay(base, source, WED, T.createTransitService(T.mergeSchedules(read('transit-schedule'), read('shuttle-schedule'))));
  assert.notEqual(again, day);
  assert.deepEqual(again.transitRides.filter((ride) => ride.alightsAt !== undefined || ride.boardedAt !== undefined),
    day.transitRides.filter((ride) => ride.alightsAt !== undefined || ride.boardedAt !== undefined));
  const load = new Map();
  for (const ride of day.transitRides) load.set(ride.trip, (load.get(ride.trip) ?? 0) + 1);
  for (const ride of day.transitRides) assert.ok(load.get(ride.trip) <= T.VEHICLE_PEAK_MAX_LOAD[T.routeKind(ride.route)]);
});
