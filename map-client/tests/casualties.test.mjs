import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { applyIncident } = await import('../src/sim/incidents.ts');
const { computeCasualties, CASUALTY_ASSUMPTIONS, CASUALTY_LIMITATIONS } = await import('../src/sim/casualties.ts');
const { DISASTER_LIMITATIONS } = await import('../src/sim/disasters.ts');
const DAY = 86400;

// Buildings along latitude 42 (0.001° longitude ≈ 82.7 m): A target, B ≈ 41 m, C ≈ 165 m, D ≈ 827 m.
const X = { a:-71, b:-70.9995, c:-70.998, d:-70.99, quad:-70.99965, home:-71.01 };
const square = (x, id) => ({ id, name:id, polygon:[[x-0.0001,41.9999],[x+0.0001,41.9999],[x+0.0001,42.0001],[x-0.0001,42.0001]], height:id==='A'?14:0 });
const loc = (id, building, kind = 'classroom') => ({ id, name:id, short:id, kind, position:[X[id],42], capacity:1000, building });
const pos = id => [X[id], 42];
const trip = (agent, from, to, start, end, path = [pos(from), pos(to)]) => ({ agent, from, to, path, timestamps: path.length === 2 ? [start, end] : path.map((_, i) => start + (end - start) * i / (path.length - 1)) });
const stay = (agent, location, start, end) => ({ agent, location, start, end });
function fixture({ crowd = 0 } = {}) {
  const locations = [loc('a','A'), loc('b','B'), loc('c','C'), loc('d','D'), loc('quad','','outdoor'), loc('home','','residence')];
  const route = (from, to, metres) => ({ path:[pos(from),pos(to)], cumulative:[0,metres] });
  const walkRoutes = {};
  for (const [from, to, m] of [['a','quad',20],['a','d',100],['b','d',90],['c','d',80],['quad','d',70],['d','a',100],['d','b',90],['d','c',80],['a','b',40]])
    walkRoutes[`${from}>${to}`] = route(from, to, m);
  const agents = [], trips = [], stays = [];
  const add = id => agents.push({ id, home:'home', model:0, walkSpeed:1 });
  for (let i = 0; i < 4 + crowd; i++) { const id = `inA${i}`; add(id); stays.push(stay(id,'a',0,20000), stay(id,'home',20050,DAY)); trips.push(trip(id,'a','home',20000,20050)); }
  add('inB'); stays.push(stay('inB','b',0,20000), stay('inB','home',20050,DAY)); trips.push(trip('inB','b','home',20000,20050));
  add('onQuad'); stays.push(stay('onQuad','quad',0,DAY));
  add('inD'); stays.push(stay('inD','d',0,DAY));
  add('away'); stays.push(stay('away','off-campus',0,DAY));
  // Through-walker home → D whose straight path passes through A exactly at 1000 (the scenario start).
  add('walker'); stays.push(stay('walker','home',0,900), stay('walker','d',1100,DAY)); trips.push(trip('walker','home','d',900,1100));
  return { day:'Monday', buildings:['A','B','C','D'].map(id => square(X[id.toLowerCase()], id)), locations, agents, walkRoutes, trips, stays };
}
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
const incident = (kind, extra = {}) => ({ id:`${kind}-1`, kind, locationId:'a', start:1000, duration:1800, ...extra });
const ids = events => events.map(e => e.agentId);
const assertContract = (result, day) => {
  assert.equal(result.day.casualties, result.casualties);
  const seen = new Set();
  for (const [i, e] of result.casualties.entries()) {
    assert.ok(!seen.has(e.agentId)); seen.add(e.agentId);
    assert.ok(['injured', 'fatality'].includes(e.outcome) && ['fire', 'earthquake', 'meteor'].includes(e.cause));
    assert.ok(e.at >= 1000 && e.at < DAY && e.position.every(Number.isFinite));
    if (i) { const p = result.casualties[i - 1]; assert.ok(p.at < e.at || p.at === e.at && p.agentId < e.agentId); }
    assert.ok(day.agents.some(a => a.id === e.agentId));
  }
};

test('exported assumptions and limitations; disaster limitations say casualties are illustrative', () => {
  assert.ok(CASUALTY_ASSUMPTIONS.fire.growthPerSecond2 > 0);
  assert.ok(CASUALTY_LIMITATIONS.some(note => /not a clinical/i.test(note) && /uncalibrated/i.test(note)));
  assert.ok(DISASTER_LIMITATIONS.some(note => /casualt/i.test(note) && /illustrat/i.test(note) && /uncalibrated/i.test(note)));
});

test('drills and closures never produce casualties', () => {
  const day = freeze(fixture());
  for (const kind of ['fire-drill', 'building-closure']) {
    const result = applyIncident(day, incident(kind, { duration:600 }));
    assert.equal(result.casualties, undefined); assert.equal(result.day.casualties, undefined);
  }
});

test('meteor: exposed occupants and through-walker are harmed; safe, distant and off-map people are not', () => {
  const day = freeze(fixture()), saved = JSON.stringify(day);
  const result = applyIncident(day, incident('meteor'));
  assert.equal(JSON.stringify(day), saved, 'baseline unchanged');
  assertContract(result, day);
  const harmed = new Set(ids(result.casualties));
  // Inner-zone indoor harm is 0.3 × severity 1 + 0.7 × full collapse = 1, so A occupants and anyone inside A at impact certainly cross.
  for (let i = 0; i < 4; i++) assert.ok(harmed.has(`inA${i}`), `inA${i}`);
  assert.ok(harmed.has('walker'), 'walker crossing the impact point is exposed');
  for (const id of ['inD', 'away']) assert.ok(!harmed.has(id), id);
  const walker = result.casualties.find(e => e.agentId === 'walker');
  assert.equal(walker.buildingId, 'A');
  // Event position is the walker's interpolated position at the event time, not a location centroid.
  const t = walker.at, f = (t - 900) / 200;
  assert.ok(Math.abs(walker.position[0] - (X.home + (X.d - X.home) * f)) < 1e-9 && Math.abs(walker.position[1] - 42) < 1e-12);
  for (const e of result.casualties.filter(e => e.agentId.startsWith('inA'))) { assert.deepEqual(e.position, pos('a')); assert.equal(e.buildingId, 'A'); }
  // Casualty-only through-walker counts once in affectedAgents, without invented planning metadata.
  assert.ok(!result.participants.some(p => p.agentId === 'walker'));
  assert.equal(result.affectedAgents, new Set([...result.participants.map(p => p.agentId), ...harmed]).size);
  // Underlying schedules stay the planned paths: the walker's trip is untouched (playback stops it at the event).
  assert.deepEqual(result.day.trips.filter(tr => tr.agent === 'walker'), day.trips.filter(tr => tr.agent === 'walker'));
});

test('earthquake: indoor harm at building collapse; indoor locations in unaffected buildings are sheltered', () => {
  const day = freeze(fixture({ crowd:40 }));
  const result = applyIncident(day, incident('earthquake'));
  assertContract(result, day);
  assert.ok(result.casualties.length > 0);
  assert.ok(!ids(result.casualties).includes('inD') && !ids(result.casualties).includes('away'));
  for (const e of result.casualties) assert.ok(e.at <= 1000 + 60, 'harm only during shaking');
  // Directly: B inside the radius but excluded from the damaged set is not treated as open ground.
  const sheltered = computeCasualties(day, { kind:'earthquake', start:1000, activeUntil:2800, target:day.locations[0], radiusMetres:250,
    affectedLocationIds:['a'], affectedBuildingIds:['A'] });
  assert.ok(!ids(sheltered).includes('inB'));
});

test('deterministic, independent of input order and incident id', () => {
  const day = fixture({ crowd:30 });
  const base = applyIncident(freeze(structuredClone(day)), incident('earthquake'));
  const reversed = { ...day, agents:[...day.agents].reverse(), stays:[...day.stays].reverse(), trips:[...day.trips].reverse(), locations:[...day.locations].reverse() };
  const again = applyIncident(freeze(reversed), incident('earthquake', { id:'other-id' }));
  assert.deepEqual(again.casualties, base.casualties);
  assert.deepEqual(applyIncident(freeze(structuredClone(day)), incident('earthquake')).casualties, base.casualties);
  // The casualty pass itself never sees an incident id: same timeline, same events.
  const scenario = { kind:'meteor', start:1000, activeUntil:2800, target:day.locations[0], radiusMetres:100, affectedLocationIds:['a','b','quad'], affectedBuildingIds:['A','B'] };
  assert.deepEqual(computeCasualties(freeze(reversed), scenario), computeCasualties(freeze(structuredClone(day)), scenario));
});

// A minimal transformed day for direct fire checks.
function fireDay(extra) {
  const day = fixture();
  return { ...day, agents:[...day.agents, ...extra.agents], stays:[...day.stays, ...extra.stays], trips:[...day.trips, ...extra.trips] };
}
const fireScenario = day => ({ kind:'fire', start:1000, activeUntil:2800, target:day.locations[0], radiusMetres:0, affectedLocationIds:['a'], affectedBuildingIds:['A'] });

test('fire: leaving quickly protects; staying inside is harmed; harm stops when the active fire ends', () => {
  const agents = [], stays = [], trips = [];
  for (let i = 0; i < 50; i++) {
    const id = `quick${i}`; agents.push({ id, home:'home', model:0 });
    stays.push(stay(id,'a',0,1010), stay(id,'home',1060,DAY)); trips.push(trip(id,'a','home',1010,1060));
  }
  agents.push({ id:'stuck', home:'home', model:0 }); stays.push(stay('stuck','a',0,1700), stay('stuck','home',1750,DAY)); trips.push(trip('stuck','a','home',1700,1750));
  // Sparse two-vertex walk crossing the whole footprint (both vertices outside it), slowly, during the fire.
  const across = [[X.a - 0.0002, 42], [X.a + 0.0002, 42]];
  agents.push({ id:'slowCross', home:'home', model:0 }); stays.push(stay('slowCross','quad',0,1000), stay('slowCross','quad',2400,DAY));
  trips.push(trip('slowCross','quad','quad',1000,2400, across));
  // The same crossing after the active fire has ended.
  agents.push({ id:'lateCross', home:'home', model:0 }); stays.push(stay('lateCross','quad',0,3000), stay('lateCross','quad',4400,DAY));
  trips.push(trip('lateCross','quad','quad',3000,4400, across));
  // Inside the burning building only after activeUntil.
  agents.push({ id:'lateStay', home:'home', model:0 }); stays.push(stay('lateStay','home',0,2850), stay('lateStay','a',2900,DAY)); trips.push(trip('lateStay','home','a',2850,2900));
  const day = freeze(fireDay({ agents, stays, trips }));
  const events = computeCasualties(day, fireScenario(day));
  const harmed = new Set(ids(events));
  assert.ok(harmed.has('stuck'), 'still inside at 700 s');
  assert.ok(harmed.has('slowCross'), 'sparse crossing is sampled');
  const cross = events.find(e => e.agentId === 'slowCross');
  assert.equal(cross.buildingId, 'A'); assert.ok(Math.abs(cross.position[0] - X.a) <= 0.0001 + 1e-12, 'event inside the footprint');
  assert.equal([...harmed].filter(id => id.startsWith('quick')).length, 0, '10 s inside scores ≈ 3e-4');
  for (const id of ['lateCross', 'lateStay', 'inB', 'onQuad', 'walker']) assert.ok(!harmed.has(id), id);
  // A quick walk through the footprint late in the fire scores almost nothing (dwell, not fire age).
  const brief = computeCasualties(freeze(fireDay({ agents:Array.from({ length:50 }, (_, i) => ({ id:`brief${i}`, home:'home', model:0 })),
    stays:Array.from({ length:50 }, (_, i) => [stay(`brief${i}`,'quad',0,2500), stay(`brief${i}`,'quad',2520,DAY)]).flat(),
    trips:Array.from({ length:50 }, (_, i) => trip(`brief${i}`,'quad','quad',2500,2520, across)) })), fireScenario(day));
  assert.equal(brief.filter(e => e.agentId.startsWith('brief')).length, 0);
  for (const e of events) assert.ok(e.at >= 1000 && e.at < 2800 && e.cause === 'fire');
  // Monotone in exposure: staying longer never removes an event, and never makes it earlier.
  const longer = computeCasualties(freeze(fireDay({ agents:[{ id:'stuck', home:'home', model:0 }], stays:[stay('stuck','a',0,2000), stay('stuck','home',2050,DAY)], trips:[trip('stuck','a','home',2000,2050)] })), fireScenario(day));
  assert.equal(longer.find(e => e.agentId === 'stuck').at, events.find(e => e.agentId === 'stuck').at);
});

test('fire through applyIncident: occupants exit, events only for exposure inside A', () => {
  const day = freeze(fixture({ crowd:60 }));
  const result = applyIncident(day, incident('fire'));
  assertContract(result, day);
  for (const e of result.casualties) assert.ok(e.agentId.startsWith('inA') || e.agentId === 'walker');
});

test('real Wednesday: casualties for each disaster are valid, deterministic and in the zone', async () => {
  const { buildPopulation } = await import('../src/sim/population.ts');
  const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
  const { Playback } = await import('../src/sim/playback.ts');
  const T = await import('../src/sim/transitService.ts');
  const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));
  const source = read('campus-data');
  const service = T.createTransitService(T.mergeSchedules(read('transit-schedule'), read('shuttle-schedule')));
  const original = buildSourceDay(buildPopulation(read('demo-day'), source, read('population')), source, 2, service);
  const saved = JSON.stringify([original.stays, original.trips]);
  const summary = {};
  for (const kind of ['fire', 'earthquake', 'meteor']) {
    const spec = { id:`real-${kind}`, kind, locationId:'cds', start:12 * 3600, duration:2 * 3600 };
    const result = applyIncident(original, spec, { sourceData:source, weekday:2 });
    assertContract(result, original);
    const target = original.locations.find(l => l.id === 'cds');
    const ky = 111320, kx = ky * Math.cos(target.position[1] * Math.PI / 180);
    for (const e of result.casualties) {
      assert.ok(e.at < result.hazard.activeUntil);
      if (!e.buildingId) assert.ok(Math.hypot((e.position[0] - target.position[0]) * kx, (e.position[1] - target.position[1]) * ky) <= result.hazard.radiusMetres + 1e-6);
      else assert.ok(result.hazard.affectedBuildingIds.includes(e.buildingId));
    }
    // Same scenario, same events (the response timeline itself depends on the incident id, so reuse it).
    assert.deepEqual(applyIncident(original, spec, { sourceData:source, weekday:2 }).casualties, result.casualties);
    if (kind === 'fire') for (const e of result.casualties) assert.ok(e.at - spec.start < 900, 'fire harm comes from time inside, not fire age');
    new Playback(result.day); // playback accepts the events
    summary[kind] = result.casualties.length;
  }
  assert.equal(JSON.stringify([original.stays, original.trips]), saved);
  assert.ok(summary.earthquake > 0 && summary.meteor > 0, JSON.stringify(summary));
});
