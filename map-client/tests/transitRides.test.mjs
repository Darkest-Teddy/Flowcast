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
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { Playback } = await import('../src/sim/playback.ts');
const T = await import('../src/sim/transitService.ts');
const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));

const source = read('campus-data');
const schedule = read('transit-schedule');
const base = buildPopulation(read('demo-day'), source, read('population'));
const service = T.createTransitService(schedule);
const WEDNESDAY = 2;
const day = buildSourceDay(base, source, WEDNESDAY, service);
const agents = new Map(base.agents.map((agent) => [agent.id, agent]));
const near = (a, b) => Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540) <= 1;

test('every ride is a published trip calling at that stop at its published time', () => {
  assert.ok(day.transitRides.length > 1000);
  const calls = new Map();
  for (const trip of schedule.trips) {
    if (!trip.weekdays.includes(WEDNESDAY)) continue;
    for (const call of trip.stops) {
      const stop = schedule.stops[call.stop]?.mapStopId;
      if (stop) calls.set(`${trip.id}|${stop}`, { trip, call });
    }
  }
  for (const ride of day.transitRides) {
    const hit = calls.get(`${ride.trip}|${ride.stop}`);
    assert.ok(hit, `${ride.trip} calls at ${ride.stop}`);
    assert.equal(hit.trip.route, ride.route);
    assert.equal(hit.trip.direction, ride.direction);
    assert.equal(ride.time, ride.kind === 'alight' ? hit.call.arrival : hit.call.departure);
    assert.equal(agents.get(ride.agent).residency, 'commuter');
  }
});

test('riders walk on only after stepping off and wait at most 30 minutes to leave', () => {
  const tripsByAgent = new Map();
  for (const trip of day.trips) tripsByAgent.set(trip.agent, [...(tripsByAgent.get(trip.agent) ?? []), trip]);
  for (const ride of day.transitRides) {
    const walks = tripsByAgent.get(ride.agent);
    if (ride.kind === 'alight') {
      const walk = walks.find((trip) => trip.from === 'off-campus' && Math.abs(trip.timestamps[0] - (ride.time + T.ALIGHT_SECONDS)) < 1e-6);
      assert.ok(walk && near(walk.path[0], ride.position), 'the walk starts at the stop as the rider steps off');
    } else {
      const wait = ride.time - ride.waitStart;
      assert.ok(wait >= 0 && wait <= T.MAX_STOP_WAIT_SECONDS);
      const walk = walks.find((trip) => trip.to === 'off-campus' && Math.abs(trip.timestamps.at(-1) - ride.waitStart) < 1e-6);
      assert.ok(walk && near(walk.path.at(-1), ride.position), 'the wait starts where the walk to the stop ends');
    }
  }
});

test('ridership follows the cited commuter share and never overfills a vehicle', () => {
  const visiting = new Set(day.trips.filter((trip) => trip.from === 'off-campus' && agents.get(trip.agent).residency === 'commuter').map((trip) => trip.agent));
  const riders = new Set(day.transitRides.map((ride) => ride.agent));
  assert.equal(day.sourceStats.transitCommuters, riders.size);
  const share = riders.size / visiting.size;
  assert.ok(Math.abs(share - T.TRANSIT_COMMUTER_SHARE) < 0.03, `rider share ${share}`);
  const load = new Map();
  for (const ride of day.transitRides) load.set(ride.trip, (load.get(ride.trip) ?? 0) + 1);
  for (const ride of day.transitRides) assert.ok(load.get(ride.trip) <= T.VEHICLE_PEAK_MAX_LOAD[T.routeKind(ride.route)]);
  assert.ok(day.sourceStats.transitUnmatchedLegs <= 0.01 * day.transitRides.length * 2, 'almost every rider leg fits a published trip');
  const playback = new Playback(day);
  const busiest = [...load].sort((a, b) => b[1] - a[1])[0][0];
  const rides = day.transitRides.filter((ride) => ride.trip === busiest);
  const first = Math.min(...rides.map((ride) => ride.time)) - 1;
  assert.equal(playback.studentsAboard(busiest, first), rides.filter((ride) => ride.kind === 'alight').length);
});

test('people reach Green Line platforms only by train, and every timeline stays continuous', () => {
  const stationPoints = Object.entries(base.stopRoutes).filter(([key]) => key.startsWith('place-')).map(([, route]) => route.path[0]);
  const riders = new Set(day.transitRides.map((ride) => ride.agent));
  for (const trip of day.trips) {
    if (trip.from !== 'off-campus' || riders.has(trip.agent)) continue;
    assert.ok(!stationPoints.some((point) => near(point, trip.path[0])), 'non-riders walk in from street stops');
  }
  const timelines = new Map(day.agents.map((agent) => [agent.id, []]));
  for (const stay of day.stays) timelines.get(stay.agent).push([stay.start, stay.end]);
  for (const trip of day.trips) timelines.get(trip.agent).push([trip.timestamps[0], trip.timestamps.at(-1)]);
  for (const intervals of timelines.values()) {
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let end = 0;
    for (const [start, stop] of intervals) { assert.ok(Math.abs(start - end) < 1e-7); end = stop; }
    assert.equal(end, 86400);
  }
  const waiting = new Playback(day).waitingAt(17 * 3600);
  assert.ok(waiting.length > 0 && waiting.every((rider) => rider.boardsAt > 17 * 3600));
});

test('without a timetable the planner is unchanged and nobody rides', () => {
  const walkOnly = buildSourceDay(base, source, WEDNESDAY);
  assert.equal(walkOnly.transitRides.length, 0);
  assert.equal(walkOnly.sourceStats.transitCommuters, 0);
});
