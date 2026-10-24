// Fire with an outdoor crowd (incident kind 'fire', outdoorCrowd): occupants leave by exits on the
// footprint edge, stand in loose crowds 30-80 m away off the road and clear of the trucks, then move
// on (next activity, home, transit, relocation, or shelter when home is the burning dorm).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { applyIncident, FIRE_CROWD_ASSUMPTIONS, FIRE_CROWD_LIMITATIONS } = await import('../src/sim/incidents.ts');
const { Playback } = await import('../src/sim/playback.ts');
const { crowdCharacters, crowdCount } = await import('../src/layers/fireCrowd.ts');
const DAY = 86400, H = 3600, WEEKDAY = 2;

// A street at latitude 42: the south sidewalk (y = 41.99975) runs past every door; a road 13 m further
// south; a loop around the north of A; a crosswalk 50 m east of A to building S across the road.
const KX = 111320 * Math.cos(42 * Math.PI / 180), KY = 111320;
const r6 = v => Math.round(v * 1e6) / 1e6;
const metres = (a, b) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos((a[1] + b[1]) / 2 * Math.PI / 180), (b[1] - a[1]) * KY);
const YS = 41.99975, YN = 42.00025, YR = 41.99962;
const X = { a: -71, b: -70.9975, gsu: -71.0025, mugar: -70.9965, home: -71.0035, gate: -71.0045, south: -70.9994 };
/** Sidewalk vertices every 0.0003° of longitude between x1 and x2, so routes share vertices exactly. */
const along = (x1, x2, y) => {
  const lo = Math.min(x1, x2), hi = Math.max(x1, x2), grid = [];
  for (let k = Math.ceil(lo / 0.0003 + 1e-6); k * 0.0003 < hi - 1e-7; k++) grid.push(r6(k * 0.0003));
  if (x2 < x1) grid.reverse();
  return [[r6(x1), y], ...grid.filter(x => x !== r6(x1) && x !== r6(x2)).map(x => [x, y]), [r6(x2), y]];
};
const route = path => { const cumulative = [0]; for (let i = 1; i < path.length; i++) cumulative.push(cumulative[i - 1] + metres(path[i - 1], path[i])); return { path, cumulative }; };
const door = id => [r6(X[id]), id === 'south' ? 41.9995 : YS];
const square = (id, x, y = 42, hx = 0.0001, hy = 0.0001, height = 0) => ({ id, name: id, height,
  polygon: [[x - hx, y - hy], [x + hx, y - hy], [x + hx, y + hy], [x - hx, y + hy]] });
const ROAD = { a: [-71.006, YR], b: [-70.994, YR], halfWidth: 4 };
const TRUCK = [-70.999, YR];
function fixture({ residents = 12, classes = 30, commuters = 10, gsuCapacity = 8 } = {}) {
  const locations = [
    { id: 'a', name: 'Hall A', short: 'A', kind: 'classroom', position: [X.a, 42], capacity: 500, building: 'A' },
    { id: 'a-dorm', name: 'A Residence', short: 'A Res', kind: 'dorm', position: [X.a, 42], capacity: 500, building: 'A' },
    { id: 'b', name: 'B', short: 'B', kind: 'classroom', position: [X.b, 42], capacity: 500, building: 'B' },
    { id: 'gsu', name: 'GSU', short: 'GSU', kind: 'dining', position: [X.gsu, 42], capacity: gsuCapacity, building: 'G' },
    { id: 'mugar', name: 'Mugar', short: 'Mugar', kind: 'library', position: [X.mugar, 42], capacity: 500, building: 'M' },
    { id: 'home', name: 'Home', short: 'Home', kind: 'dorm', position: [X.home, 42], capacity: 500, building: 'HOME' },
    { id: 'south', name: 'S', short: 'S', kind: 'classroom', position: [X.south, 41.9993], capacity: 500, building: 'S' },
  ];
  const walkRoutes = {};
  const line = (from, to) => along(X[from], X[to], YS);
  for (const from of ['a', 'a-dorm', 'b', 'gsu', 'mugar', 'home']) for (const to of ['a', 'b', 'gsu', 'mugar', 'home']) {
    const f = from === 'a-dorm' ? 'a' : from;
    if (f !== to) walkRoutes[`${from}>${to}`] = route(line(f, to));
  }
  // B → home the long way, round the north of A: the network rings the building.
  walkRoutes['b>home'] = route([...along(X.b, -70.9994, YS), [-70.9994, YN], ...along(-70.9994, -71.0006, YN).slice(1), [-71.0006, YS], ...along(-71.0006, X.home, YS).slice(1)]);
  walkRoutes['a>south'] = route([...along(X.a, X.south, YS), [r6(X.south), YR], door('south')]);
  walkRoutes['south>a'] = route([...walkRoutes['a>south'].path].reverse());
  const gateway = route([...along(X.a, X.gate, YS)]);
  const agents = [], trips = [], stays = [];
  const add = (id, home) => agents.push({ id, home, model: agents.length % 12, walkSpeed: 1.4 });
  const walk = (agent, from, to, start, r) => { const end = start + r.cumulative.at(-1) / 1.4;
    trips.push({ agent, from, to, path: r.path, timestamps: r.cumulative.map(d => start + d / 1.4) }); return end; };
  const HOME = { kind: 'home', fixed: false }, CLASS = id => ({ kind: 'class', fixed: true, meetingId: id, courseCode: id });
  for (let i = 0; i < classes; i++) { // class in A, then a class in B, then home
    const id = `cls${i}`; add(id, 'home');
    stays.push({ agent: id, location: 'home', start: 0, end: 600, purpose: HOME });
    let t = walk(id, 'home', 'a', 600, walkRoutes['home>a']);
    stays.push({ agent: id, location: 'a', start: t, end: 900 }, { agent: id, location: 'a', start: 900, end: 2400, purpose: CLASS('A1') });
    t = walk(id, 'a', 'b', 2400, walkRoutes['a>b']);
    stays.push({ agent: id, location: 'b', start: t, end: 6000, purpose: CLASS('B1') });
    t = walk(id, 'b', 'home', 6000, walkRoutes['b>home']);
    stays.push({ agent: id, location: 'home', start: t, end: DAY, purpose: HOME });
  }
  for (let i = 0; i < residents; i++) { const id = `res${i}`; add(id, 'a-dorm'); stays.push({ agent: id, location: 'a-dorm', start: 0, end: DAY, purpose: HOME }); }
  for (let i = 0; i < commuters; i++) { // in from the gateway, a class in A, back out
    const id = `com${i}`; add(id, 'off-campus');
    stays.push({ agent: id, location: 'off-campus', start: 0, end: 300 });
    let t = walk(id, 'off-campus', 'a', 300, route([...gateway.path].reverse()));
    stays.push({ agent: id, location: 'a', start: t, end: 3000, purpose: CLASS('A2') });
    t = walk(id, 'a', 'off-campus', 3000, gateway);
    stays.push({ agent: id, location: 'off-campus', start: t, end: DAY });
  }
  // Heading for A while it burns: should turn back short of it.
  add('late', 'home'); stays.push({ agent: 'late', location: 'home', start: 0, end: 1100, purpose: HOME });
  let t = walk('late', 'home', 'a', 1100, walkRoutes['home>a']);
  stays.push({ agent: 'late', location: 'a', start: t, end: 4000, purpose: CLASS('A3') });
  t = walk('late', 'a', 'home', 4000, walkRoutes['a>home']);
  stays.push({ agent: 'late', location: 'home', start: t, end: DAY, purpose: HOME });
  // Elsewhere all day: untouched.
  add('far', 'home'); stays.push({ agent: 'far', location: 'mugar', start: 0, end: DAY });
  const buildings = [square('A', X.a, 42, 0.0002, 0.00015, 14), square('B', X.b), square('G', X.gsu), square('M', X.mugar), square('HOME', X.home), square('S', X.south, 41.9993)];
  return { day: 'Wednesday', buildings, locations, agents, walkRoutes, trips, stays };
}
const hours = windows => ({ id: '', buildingCodes: [], meetings: [], evidence: [], hours: [{ date: null, weekday: WEEKDAY, windows, text: '', sourceUrl: '', qualifier: null }] });
const context = (extra = {}) => ({ weekday: WEEKDAY, sourceData: { referenceWeekStart: '2026-09-07',
  locations: { gsu: hours([[7 * H, 24 * H]]), mugar: hours([[7 * H, 24 * H]]) } },
  fireScene: { roads: [ROAD], apparatus: [TRUCK] }, ...extra });
const fire = (extra = {}) => ({ id: 'fire-1', kind: 'fire', locationId: 'a', start: 1000, duration: 1800, outdoorCrowd: true, ...extra });
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };

const timelineOf = (day, agent) => [...day.stays.filter(s => s.agent === agent).map(s => ({ start: s.start, end: s.end, stay: s })),
  ...day.trips.filter(t => t.agent === agent).map(t => ({ start: t.timestamps[0], end: t.timestamps.at(-1), trip: t }))]
  .sort((a, b) => a.start - b.start || (a.trip ? 1 : 0) - (b.trip ? 1 : 0));
const insideRing = (p, ring) => { let r = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
  const a = ring[j], b = ring[i]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) r = !r; } return r; };
const toRing = (p, ring) => { if (insideRing(p, ring)) return 0; let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, toSegment(p, ring[j], ring[i])); return best; };
function toSegment(p, a, b) {
  const kx = 111320 * Math.cos(p[1] * Math.PI / 180), ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * KY, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * KY;
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy, t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
/** Gap-free days, connected walks (a walk starts where the last one ended), walking at the person's own speed. */
function assertWalkable(day, { exactSpeed = true } = {}) {
  const speed = new Map(day.agents.map(a => [a.id, a.walkSpeed ?? 1.4]));
  const all = new Map(day.agents.map(a => [a.id, []]));
  for (const s of day.stays) all.get(s.agent).push({ start: s.start, end: s.end, stay: s });
  for (const t of day.trips) all.get(t.agent).push({ start: t.timestamps[0], end: t.timestamps.at(-1), trip: t });
  for (const agent of day.agents) {
    let time = 0, endpoint, where;
    for (const e of all.get(agent.id).sort((a, b) => a.start - b.start || (a.trip ? 1 : 0) - (b.trip ? 1 : 0))) {
      assert.ok(Math.abs(e.start - time) < 1e-6, `${agent.id}: gap or overlap at ${time}`);
      time = e.end;
      if (e.trip) {
        if (endpoint && e.trip.from !== 'off-campus') assert.deepEqual(e.trip.path[0], endpoint, `${agent.id}: disconnected walk`);
        // The fixture has no co-located venues, so every walk starts where the person is.
        if (where && exactSpeed) assert.equal(e.trip.from, where, `${agent.id}: walk from ${e.trip.from} after being at ${where}`);
        endpoint = e.trip.path.at(-1); where = e.trip.to;
        for (let i = 1; i < e.trip.path.length; i++) {
          const dt = e.trip.timestamps[i] - e.trip.timestamps[i - 1], d = metres(e.trip.path[i - 1], e.trip.path[i]);
          assert.ok(dt >= 0 && (d < 0.05 || (exactSpeed ? Math.abs(d / dt - speed.get(agent.id)) < 0.05 * speed.get(agent.id) : d / dt > 0.3 && d / dt < 3)), `${agent.id}: walks at ${d / dt} m/s`);
        }
      } else where = e.stay.location;
    }
    assert.ok(Math.abs(time - DAY) < 1e-6, `${agent.id}: incomplete day`);
  }
}
function assertConserved(day, times) {
  const playback = new Playback(day);
  for (const time of times) {
    const pop = playback.populationAt(time);
    const inactive = new Set((day.casualties ?? []).filter(event => event.at <= time).map(event => event.agentId));
    const off = day.stays.filter(s => !inactive.has(s.agent) && s.location === 'off-campus' && s.start <= time && time < s.end).length;
    assert.equal(pop.indoors + pop.walking + pop.outdoors + off + (pop.injured ?? 0) + (pop.fatalities ?? 0), day.agents.length, `population at ${time}`);
  }
}

test('crowd mode is opt-in: a fire without it is unchanged', () => {
  const day = freeze(fixture());
  const plain = applyIncident(day, fire({ outdoorCrowd: undefined }), context());
  const off = applyIncident(day, fire({ outdoorCrowd: false }), context());
  assert.deepEqual(off, plain);
  assert.equal(plain.crowd, undefined);
  assert.equal(plain.day.locations, day.locations);
  assert.ok(FIRE_CROWD_LIMITATIONS.length >= 3);
});

test('deterministic and immutable; everyone conserved and walking physically', () => {
  const day = freeze(fixture()), saved = JSON.stringify(day);
  const result = applyIncident(day, fire(), context());
  assert.equal(JSON.stringify(day), saved);
  assert.deepEqual(applyIncident(day, fire(), context()), result);
  assert.ok(result.crowd.areas.length >= 1 && result.crowd.exits.length >= 2, `${result.crowd.areas.length} areas, ${result.crowd.exits.length} exits`);
  assert.equal(result.day.agents, day.agents);
  assertWalkable(result.day);
  const times = [999, 1000, 1030, 1100, 1200, 1500, 1800, 2100, 2400, 2800, 4000, 6500, DAY - 1];
  for (const t of result.day.trips) times.push(t.timestamps[0] + 0.001, t.timestamps.at(-1) - 0.001);
  assertConserved(result.day, times);
  assert.deepEqual(timelineOf(result.day, 'far'), timelineOf(day, 'far'));
});

test('nobody is inside the burning building after their exit, for the rest of the day; it shows 0 while people stand outside', () => {
  const result = applyIncident(fixture(), fire(), context());
  const zone = new Set(['a', 'a-dorm']), byId = new Map(result.participants.map(p => [p.agentId, p]));
  for (const s of result.day.stays) if (zone.has(s.location) && s.end > 1000) {
    const p = byId.get(s.agent);
    assert.ok(p?.role === 'occupant' && s.end <= p.departAt + 1e-7, `${s.agent} in A ${s.start}-${s.end}`);
  }
  const lastExit = Math.max(...result.participants.filter(p => p.role === 'occupant').map(p => p.departAt));
  const playback = new Playback(result.day);
  for (const t of [lastExit + 1, 1500, 2000, 5000]) {
    const inside = playback.occupancyAt(t).filter(o => zone.has(o.location.id)).reduce((n, o) => n + o.count, 0);
    assert.equal(inside, 0, `inside at ${t}`);
  }
  // Standing evacuees are outdoors, at crowd locations, never in a building.
  const t = lastExit + 30, pop = playback.populationAt(t), outside = playback.outdoorAt(t);
  assert.ok(outside.length > 0);
  assert.equal(pop.outdoors, outside.length);
  assert.equal(crowdCount(playback.occupancyAt(t), result.crowd), outside.length);
  assert.ok(outside.every(person => result.crowd.areas.some(area => area.id === person.to) && result.participants.find(p => p.agentId === person.id)?.role === 'occupant'));
});

test('exits are on the footprint edge; spots are 25-95 m out, outside every footprint, off the road and clear of the truck', () => {
  const day = fixture(), result = applyIncident(day, fire(), context());
  const A = day.buildings.find(b => b.id === 'A').polygon;
  for (const exit of result.crowd.exits) assert.ok(toRing(exit, A) < 0.05, `exit ${exit} is ${toRing(exit, A)} m from the edge`);
  const spots = Object.values(result.crowd.spots);
  assert.equal(spots.length, result.participants.filter(p => p.role === 'occupant').length);
  for (const { position } of spots) {
    const clearance = toRing(position, A);
    assert.ok(clearance >= 25 && clearance <= 95, `spot ${clearance} m from A`);
    for (const b of day.buildings) assert.ok(!insideRing(position, b.polygon) && toRing(position, b.polygon) >= 1.2, `spot in or against ${b.id}`);
    assert.ok(toSegment(position, ROAD.a, ROAD.b) >= ROAD.halfWidth + 0.5, 'spot on the road');
    assert.ok(metres(position, TRUCK) >= 18, 'spot next to the truck');
  }
  // Spread out: more than one area, people at distinct spots, facing roughly toward the building.
  const unique = new Set(spots.map(s => s.position.join(',')));
  assert.equal(unique.size, spots.length);
  // Each evacuee's walk out ends at their own spot and their crowd stay follows it.
  for (const p of result.participants.filter(p => p.role === 'occupant')) {
    const walk = result.day.trips.find(t => t.agent === p.agentId && t.to === p.crowdLocationId);
    assert.deepEqual(walk.path.at(-1), result.crowd.spots[p.agentId].position);
    assert.ok(Math.abs(walk.timestamps.at(-1) - p.assemblyAt) < 1e-6);
    assert.ok(result.day.stays.some(s => s.agent === p.agentId && s.location === p.crowdLocationId && Math.abs(s.start - p.assemblyAt) < 1e-6 && Math.abs(s.end - p.releaseAt) < 1e-6));
    assert.ok(p.releaseAt - 1000 >= FIRE_CROWD_ASSUMPTIONS.lingerMinSeconds - 1e-6 && p.releaseAt >= p.assemblyAt + FIRE_CROWD_ASSUMPTIONS.minimumOutsideSeconds - 1e-6);
  }
});

test('after the crowd: next class, home, campus exit; arrivals turn back short of the fire', () => {
  const result = applyIncident(fixture(), fire(), context());
  const by = id => result.participants.find(p => p.agentId === id);
  // Class in B next: walks there from the crowd and is in B for the class.
  for (let i = 0; i < 30; i++) {
    const p = by(`cls${i}`);
    assert.equal(p.dispersal, 'next-activity'); assert.equal(p.decision.destinationId, 'b');
    assert.ok(result.day.stays.some(s => s.agent === p.agentId && s.location === 'b' && s.purpose?.kind === 'class' && s.end === 6000));
    assert.ok(result.day.stays.some(s => s.agent === p.agentId && s.location === 'home' && s.end === DAY));
  }
  // Commuters with nothing else on campus leave by their gateway once they leave the crowd.
  for (let i = 0; i < 10; i++) {
    const p = by(`com${i}`);
    assert.equal(p.dispersal, 'home'); assert.equal(p.decision.destinationId, 'off-campus');
    const out = result.day.trips.find(t => t.agent === p.agentId && t.to === 'off-campus');
    assert.ok(Math.abs(out.timestamps[0] - p.releaseAt) < 1e-6 && out.timestamps.at(-1) < 3000);
  }
  // Heading for A during the fire: turns back about 70 m from it and goes home instead; never reaches A.
  const late = by('late'), A = fixture().buildings.find(b => b.id === 'A').polygon;
  assert.equal(late.role, 'arrival'); assert.equal(late.dispersal, 'home');
  const approach = result.day.trips.find(t => t.agent === 'late' && t.to === 'a');
  assert.ok(Math.abs(toRing(approach.path.at(-1), A) - FIRE_CROWD_ASSUMPTIONS.turnBackMetres) < 3, `turned ${toRing(approach.path.at(-1), A)} m out`);
  assert.ok(!result.day.stays.some(s => s.agent === 'late' && s.location === 'a'));
  assert.ok(result.day.stays.some(s => s.agent === 'late' && s.location === 'home' && s.end === DAY));
  // Every evacuee eventually reaches where they were going: their last stay is home, off campus or a shelter.
  for (const p of result.participants) {
    const last = timelineOf(result.day, p.agentId).at(-1).stay;
    assert.ok(['home', 'off-campus', 'gsu', 'mugar'].includes(last.location) && last.end === DAY, `${p.agentId} ends at ${last.location}`);
  }
});

test('dorm fire: residents shelter at open venues with room until midnight', () => {
  const result = applyIncident(fixture({ classes: 0, commuters: 0, residents: 12, gsuCapacity: 8 }), fire({ start: 21 * H, duration: 1800 }), context());
  const residents = result.participants.filter(p => p.agentId.startsWith('res'));
  assert.equal(residents.length, 12);
  for (const p of residents) {
    assert.equal(p.dispersal, 'shelter'); assert.match(p.decision.reason, /home is the burning building/);
    assert.ok(['gsu', 'mugar'].includes(p.shelterId));
    const shelter = result.day.stays.find(s => s.agent === p.agentId && s.location === p.shelterId);
    assert.equal(shelter.end, DAY);
  }
  // GSU takes 8 (its modeled capacity); the rest go on to Mugar.
  assert.equal(residents.filter(p => p.shelterId === 'gsu').length, 8);
  assert.equal(residents.filter(p => p.shelterId === 'mugar').length, 4);
  assertWalkable(result.day);
  assertConserved(result.day, [21 * H + 1, 21 * H + 300, 21 * H + 900, 22 * H, DAY - 1]);
  // Nothing open: the nearest venue with room opens as an emergency shelter.
  const closed = applyIncident(fixture({ classes: 0, commuters: 0, residents: 3 }), fire({ start: 21 * H, duration: 1800 }),
    context({ sourceData: { referenceWeekStart: '2026-09-07', locations: {} } }));
  for (const p of closed.participants.filter(p => p.agentId.startsWith('res'))) assert.match(p.decision.reason, /emergency shelter/);
});

test('crowd characters reuse one object per person and stand at their spots', () => {
  const result = applyIncident(fixture(), fire(), context());
  const playback = new Playback(result.day);
  const t = Math.max(...result.participants.filter(p => p.role === 'occupant').map(p => p.departAt)) + 60;
  const first = crowdCharacters(playback.outdoorAt(t), result.crowd), again = crowdCharacters(playback.outdoorAt(t + 1), result.crowd);
  assert.ok(first.length > 0);
  for (const person of first) assert.deepEqual(person.position.slice(0, 2), result.crowd.spots[person.id].position);
  for (const person of again) { const same = first.find(p => p.id === person.id); if (same) assert.equal(person, same); }
  assert.deepEqual(crowdCharacters(playback.outdoorAt(t), null), []);
});

test('real Wednesday: CAS at 11:00 and a Warren Towers dorm fire at 21:30', async () => {
  const { buildPopulation } = await import('../src/sim/population.ts');
  const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
  const T = await import('../src/sim/transitService.ts');
  const F = await import('../src/sim/fireResponse.ts');
  const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));
  const source = read('campus-data');
  const service = T.createTransitService(T.mergeSchedules(read('transit-schedule'), read('shuttle-schedule')));
  const original = buildSourceDay(buildPopulation(read('demo-day'), source, read('population')), source, 2, service);
  const net = F.parseFireNetwork(read('fire-response'));
  const saved = JSON.stringify([original.stays, original.trips, original.transitRides]);
  const summary = {};
  for (const [locationId, start] of [['cas', 11 * H], ['warren', 21.5 * H]]) {
    const target = original.locations.find(l => l.id === locationId);
    const roads = F.roadsNear(net, target.position, 600);
    const spec = { id: `crowd-${locationId}`, kind: 'fire', locationId, start, duration: 2 * H, outdoorCrowd: true };
    const ctx = { sourceData: source, weekday: 2, transit: service, fireScene: { roads } };
    const result = applyIncident(original, spec, ctx);
    assert.ok(result.crowd && result.crowd.areas.length >= 2, `${locationId}: ${result.crowd?.areas.length} areas`);
    assertWalkable(result.day, { exactSpeed: false });
    const zone = new Set(result.hazard.affectedLocationIds), byId = new Map(result.participants.map(p => [p.agentId, p]));
    for (const s of result.day.stays) if (zone.has(s.location) && s.end > start) assert.ok(byId.get(s.agent)?.role === 'occupant' && s.end <= byId.get(s.agent).departAt + 1e-7);
    const polygons = original.buildings.filter(b => b.id === target.building).map(b => b.polygon);
    for (const { position } of Object.values(result.crowd.spots)) {
      const clearance = Math.min(...polygons.map(ring => toRing(position, ring)));
      assert.ok(clearance >= 25 && clearance <= 95, `${locationId}: spot ${clearance} m out`);
      assert.ok(original.buildings.every(b => !insideRing(position, b.polygon)), `${locationId}: spot inside a footprint`);
      assert.ok(roads.every(r => toSegment(position, r.a, r.b) >= r.halfWidth + 0.5 - 1e-6), `${locationId}: spot on a road`);
    }
    const times = [start - 1, start + 60, start + 300, start + 600, start + 900, start + 1500, start + 3600, DAY - 1];
    assertConserved(result.day, times);
    for (const p of result.participants) if (p.role === 'occupant') assert.ok(p.dispersal, `${p.agentId}: no dispersal`);
    assert.ok(result.participants.some(p => p.role === 'arrival' && p.dispersal), 'arrivals during the fire turn back and move on');
    assert.deepEqual(applyIncident(original, spec, ctx).participants, result.participants);
    const count = list => list.reduce((m, p) => (m[p.dispersal] = (m[p.dispersal] ?? 0) + 1, m), {});
    summary[locationId] = { occupants: count(result.participants.filter(p => p.role === 'occupant')), arrivals: count(result.participants.filter(p => p.role === 'arrival')),
      areas: result.crowd.areas.length, exits: result.crowd.exits.length };
    if (locationId === 'cas') {
      assert.ok(summary.cas.occupants['next-activity'] > 0 && summary.cas.occupants.home > 0 && summary.cas.occupants.transit > 0, JSON.stringify(summary.cas));
      // Re-matched rides board a published departure after the person reaches the stop.
      for (const ride of result.day.transitRides) if (ride.kind === 'board' && ride.cancelledAt === undefined) assert.ok(ride.waitStart <= ride.time && ride.time - ride.waitStart <= T.MAX_STOP_WAIT_SECONDS + 1e-6);
    } else {
      const sheltered = result.participants.filter(p => p.dispersal === 'shelter');
      assert.ok(sheltered.length > 100, `${sheltered.length} sheltered`);
      assert.ok(sheltered.every(p => p.shelterId && !zone.has(p.shelterId)));
    }
  }
  console.log(JSON.stringify(summary));
  assert.equal(JSON.stringify([original.stays, original.trips, original.transitRides]), saved);
});
