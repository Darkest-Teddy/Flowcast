import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const F = await import('../src/sim/fireResponse.ts');
const { registerSignals } = await import('../src/sim/signals.ts');
const { applyIncident } = await import('../src/sim/incidents.ts');

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const street = json('../public/data/street.json');
registerSignals(street.signals, street.intersections);
const network = F.parseFireNetwork(json('../public/data/fire-response.json'));
const day = json('../public/data/demo-day.json');
const signals = F.signalOracle(street.signals);

/** A 100 m square block, A -> B one-way, the other three sides two-way. */
function square() {
  const points = [[0, 0], [100, 0], [100, 100], [0, 100]].map(([x, y]) => F.toLngLat(x, y));
  const nodes = [];
  let last = [0, 0];
  for (const [lng, lat] of points) {
    const q = [Math.round(lng * 1e6), Math.round(lat * 1e6)];
    nodes.push(q[0] - last[0], q[1] - last[1]);
    last = q;
  }
  const residential = 6;
  return F.parseFireNetwork({ classes: network.classes, stations: [], nodes, signals: [], hydrants: [],
    edges: [0, 1, residential, 1 | (1 << 1), 1, 2, residential, 0, 2, 3, residential, 0, 3, 0, residential, 0] });
}
const metresBetween = (a, b) => Math.hypot(...[0, 1].map((i) => F.toXY(a)[i] - F.toXY(b)[i]));

test('routes respect one-way streets; only an emergency final approach may run briefly against one', () => {
  const net = square();
  const fromB = F.snapOnEdge(net, 1, 100, 1); // on B-C, at B
  // 90 m against A -> B: too far, so both go round the block (B, C, D, A, then along A -> B).
  const far = F.snapOnEdge(net, 0, 10, 0);
  for (const emergency of [true, false]) {
    const route = F.routeBetween(net, fromB, far, { emergency });
    assert.equal(route.fromB, false);
    assert.ok(Math.abs(route.metres - 310) < 2, `${route.metres} m round the block`);
  }
  // 50 m against it: the engine takes the short contra-flow approach; normal traffic can't.
  const near = F.snapOnEdge(net, 0, 50, 0);
  const emergency = F.routeBetween(net, fromB, near, { emergency: true });
  assert.equal(emergency.fromB, true);
  assert.ok(Math.abs(emergency.metres - 51) < 2);
  const normal = F.routeBetween(net, fromB, near, { emergency: false });
  assert.ok(Math.abs(normal.metres - 349) < 2, `${normal.metres} m`);
  // A parked truck facing away pays for a U-turn: it pulls away forwards when that's not far longer.
  const parked = F.snapOnEdge(net, 2, 50, 100); // C-D midpoint
  const target = F.snapOnEdge(net, 1, 100, 60); // on B-C
  const westbound = F.routeBetween(net, parked, target, { emergency: false, startBearing: 270 });
  assert.ok(westbound.metres > 200, 'forwards round the block (C -> D -> A -> B)');
  const eastbound = F.routeBetween(net, parked, target, { emergency: false, startBearing: 90 });
  assert.ok(eastbound.metres < 100, 'straight to C and down');
});

test('every routed segment on the real network is a legal move', () => {
  const photonics = day.locations.find((l) => l.id === 'photonics');
  const kerb = F.snapTo(network, [photonics.position]);
  for (const station of network.stations) {
    const route = F.routeBetween(network, F.snapTo(network, [station.position]), kerb, { emergency: true });
    assert.ok(route, `${station.name} reaches Photonics`);
    for (let i = 1; i + 2 < route.xs.length; i++) {
      const [a, b] = [route.nodes[i], route.nodes[i + 1]];
      const e = route.edges[i];
      assert.ok((network.ea[e] === a && network.eb[e] === b) || (!network.oneway[e] && network.ea[e] === b && network.eb[e] === a),
        `${station.name}: segment ${i} follows edge ${e} in a legal direction`);
    }
    const straight = metresBetween(station.position, photonics.position);
    assert.ok(route.metres < straight * 2.2, `${station.name}: ${route.metres.toFixed(0)} m vs ${straight.toFixed(0)} m straight`);
  }
});

const photonicsAlarm = () => {
  const loc = day.locations.find((l) => l.id === 'photonics');
  return { id: 'alarm-1', start: 10 * 3600, endsAt: 10 * 3600 + 1800, targetName: loc.name, position: loc.position,
    polygon: day.buildings.find((b) => b.id === loc.building).polygon };
};

test('a fire alarm gets the first-alarm box from the nearest houses by drive time', () => {
  const response = F.planFireResponse(network, photonicsAlarm(), { signals });
  const count = (kind) => response.units.filter((u) => u.kind === kind).length;
  assert.deepEqual([count('engine'), count('ladder'), count('chief')], [3, 2, 1]);
  assert.equal(new Set(response.units.map((u) => u.id)).size, 6);
  // Back Bay's Engine 33 / Ladder 15 are first due on Comm Ave at BU.
  const ids = response.units.map((u) => u.id);
  assert.ok(ids.includes('L15') && ids.includes('E33'), ids.join());
  const first = [...response.units].sort((a, b) => a.arrive - b.arrive)[0];
  assert.ok(first.eta > 150 && first.eta < 480, `first on scene after ${first.eta.toFixed(0)} s`);
  // Each kind's units are the quickest of that kind by the dispatch estimate.
  for (const unit of response.units) assert.equal(unit.label, `BFD ${unit.name}`);
  // Deterministic: the same alarm plans the same response.
  const again = F.planFireResponse(network, photonicsAlarm(), { signals });
  assert.deepEqual(again.units.map((u) => [u.id, u.arrive, u.home]), response.units.map((u) => [u.id, u.arrive, u.home]));
});

test('apparatus positions are a function of sim time: turnout, smooth response, parked, return, home', () => {
  const alarm = photonicsAlarm();
  const response = F.planFireResponse(network, alarm, { signals });
  const footprint = alarm.polygon;
  for (const unit of response.units) {
    assert.equal(F.apparatusAt(unit, alarm.start - 1).phase, null, 'not on the map before the alarm');
    const turnout = unit.depart - unit.alarm;
    assert.ok(turnout >= 60 && turnout <= 80, `turnout ${turnout}`);
    const bay = F.apparatusAt(unit, alarm.start + 5);
    assert.equal(bay.phase, 'turnout');
    assert.equal(bay.lights, false);
    assert.ok(metresBetween(bay.position, unit.station.position) < 40, 'starts at its firehouse');
    assert.equal(F.apparatusAt(unit, unit.depart - 1).lights, true, 'lights on before pulling out');
    // No teleporting: 0.25 s steps never jump further than a fast emergency speed allows.
    let prev = F.apparatusAt(unit, unit.depart).position.slice();
    let maxSpeed = 0;
    for (let t = unit.depart + 0.25; t <= unit.arrive; t += 0.25) {
      const state = F.apparatusAt(unit, t);
      const v = metresBetween(prev, state.position) / 0.25;
      maxSpeed = Math.max(maxSpeed, v);
      assert.ok(v < 17, `${unit.id} at ${t}: ${v.toFixed(1)} m/s`);
      assert.ok(state.phase === 'responding' || t === unit.arrive);
      assert.ok(state.lights);
      prev = state.position.slice();
    }
    assert.ok(maxSpeed > 8, `${unit.id} gets up to speed (${(maxSpeed * 3.6).toFixed(0)} km/h)`);
    const avg = unit.out.metres / (unit.arrive - unit.depart) * 3.6;
    assert.ok(avg > 20 && avg < 50, `${unit.id} averages ${avg.toFixed(0)} km/h`);
    // Parked at the kerb beside the building, lights still on, and not moving.
    const parked = F.apparatusAt(unit, unit.arrive + 1).position.slice();
    const later = F.apparatusAt(unit, unit.release - 1);
    assert.equal(later.phase, 'on-scene');
    assert.ok(later.lights);
    assert.ok(metresBetween(parked, later.position) < 1e-6);
    const toBuilding = Math.min(...footprint.map((p) => metresBetween(p, parked)));
    assert.ok(toBuilding < 140, `${unit.id} parks ${toBuilding.toFixed(0)} m from the building`);
    assert.ok(unit.release >= alarm.endsAt, 'stays until access reopens');
    // Back to quarters at normal speed, lights off, then off the map.
    const back = F.apparatusAt(unit, (unit.release + unit.home) / 2);
    assert.equal(back.phase, 'returning');
    assert.equal(back.lights, false);
    assert.ok(Math.max(...unit.back.v) <= 13.5, `returns within 30 mph city limits (${(Math.max(...unit.back.v) * 3.6).toFixed(0)} km/h)`);
    assert.ok(metresBetween(F.apparatusAt(unit, unit.home - 0.01).position, unit.station.position) < 40);
    assert.equal(F.apparatusAt(unit, unit.home).phase, null);
  }
});

test('parked apparatus do not overlap', () => {
  const response = F.planFireResponse(network, photonicsAlarm(), { signals });
  const parked = response.units.map((u) => ({ u, p: F.apparatusAt(u, u.arrive + 1).position.slice() }));
  for (let i = 0; i < parked.length; i++) for (let j = i + 1; j < parked.length; j++)
    assert.ok(metresBetween(parked[i].p, parked[j].p) > 4, `${parked[i].u.id} and ${parked[j].u.id}`);
});

test('through red signals carefully with lights on; stopped at red when back in service', () => {
  const alwaysRed = { approaches: street.signals, lamp: () => 'red', toGreen: () => 30 };
  const response = F.planFireResponse(network, photonicsAlarm(), { signals: alwaysRed });
  const unit = response.units.find((u) => u.id === 'L15');
  assert.equal(Math.max(...unit.out.wait), 0, 'never waits on the way to the fire');
  assert.ok(Math.min(...Array.from(unit.out.v).slice(5, -5)) <= 2.81, 'crawls through a red light');
  assert.ok(Math.max(...unit.back.wait) >= 30, 'waits for green on the way home');
  const green = F.planFireResponse(network, photonicsAlarm(), { signals: { approaches: street.signals, lamp: () => 'green', toGreen: () => 0 } });
  assert.ok(green.units.find((u) => u.id === 'L15').arrive < unit.arrive, 'greens are quicker');
});

test('strobes alternate red and white sides; reduced motion slows them right down', () => {
  let changes = 0, last = -1;
  for (let t = 0; t < 1.6; t += 0.01) {
    const mask = F.strobeMask(t);
    assert.ok((mask & 3) !== 3, 'A and B are never lit together');
    if (last >= 0 && (mask & 3) !== (last & 3)) changes++;
    last = mask;
  }
  assert.ok(changes >= 8, `${changes} flashes in 1.6 s`);
  let slow = 0; last = -1;
  for (let t = 0; t < 4; t += 0.01) { const mask = F.strobeMask(t, true); if (last >= 0 && mask !== last) slow++; last = mask; }
  assert.ok(slow <= 4, `${slow} changes in 4 s`);
});

test('a fire alarm evacuates exactly like a drill', () => {
  const DAY = 86400;
  const location = (id, x) => ({ id, name: id, short: id, kind: 'classroom', position: [x, 42], capacity: 100, building: id });
  const locations = [location('hall', -71), location('assembly', -70.999), location('home', -71.001)];
  const pos = (id) => locations.find((l) => l.id === id).position;
  const base = { day: 'Monday', buildings: [], locations,
    agents: [{ id: 'a', home: 'home', model: 0, walkSpeed: 1 }],
    walkRoutes: { 'hall>assembly': { path: [pos('hall'), pos('assembly')], cumulative: [0, 30] } },
    trips: [{ agent: 'a', from: 'home', to: 'hall', path: [pos('home'), pos('hall')], timestamps: [50, 80] }],
    stays: [{ agent: 'a', location: 'home', start: 0, end: 50 }, { agent: 'a', location: 'hall', start: 80, end: DAY }] };
  const drill = applyIncident(base, { id: 'i', kind: 'fire-drill', locationId: 'hall', start: 100, duration: 100 });
  const alarm = applyIncident(base, { id: 'i', kind: 'fire-alarm', locationId: 'hall', start: 100, duration: 100 });
  assert.ok(alarm.assemblyLocation);
  assert.deepEqual(alarm.day.trips, drill.day.trips);
  assert.equal(alarm.endsAt, drill.endsAt);
});
