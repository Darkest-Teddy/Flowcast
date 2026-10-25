import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { applyIncident, DISASTER_ASSUMPTIONS, DISASTER_LIMITATIONS, isDisasterKind } = await import('../src/sim/incidents.ts');
const { Playback } = await import('../src/sim/playback.ts');
const DAY = 86400;

// Buildings along a line at latitude 42 (0.001° longitude ≈ 82.7 m): A target, B ≈ 41 m, C ≈ 165 m, D ≈ 827 m.
const X = { a:-71, b:-70.9995, c:-70.998, d:-70.99, quad:-70.99965, home:-71.01 };
const square = (x, id) => ({ id, name:id, polygon:[[x-0.0001,41.9999],[x+0.0001,41.9999],[x+0.0001,42.0001],[x-0.0001,42.0001]], height:id==='A'?14:0 });
const loc = (id, building, kind = 'classroom') => ({ id, name:id, short:id, kind, position:[X[id],42], capacity:1000, building });
const CLASS = { kind:'class', fixed:true, meetingId:'m1', courseCode:'CS 101' };
function fixture({ crowd = 0, late = false } = {}) {
  const locations = [loc('a','A'), loc('b','B'), loc('c','C'), loc('d','D'), loc('quad','','outdoor'), loc('home','','residence')];
  const pos = id => locations.find(l => l.id === id).position;
  const route = (from, to, metres) => ({ path:[pos(from),pos(to)], cumulative:[0,metres] });
  const walkRoutes = {};
  for (const [from, to, m] of [['a','quad',20],['a','d',100],['b','d',90],['c','d',80],['quad','d',70],['d','a',100],['d','b',90],['d','c',80],['a','b',40]])
    walkRoutes[`${from}>${to}`] = route(from, to, m);
  const trip = (agent, from, to, start, end) => ({ agent, from, to, path:[pos(from),pos(to)], timestamps:[start,end] });
  const stay = (agent, location, start, end, purpose) => ({ agent, location, start, end, ...(purpose ? { purpose } : {}) });
  const agents = [], trips = [], stays = [];
  const add = (id, home = 'home') => agents.push({ id, home, model:0, walkSpeed:1 });
  // In A until a late departure home.
  for (let i = 0; i < 2 + crowd; i++) { const id = `inA${i}`; add(id); stays.push(stay(id,'a',0,20000), stay(id,'home',20050,DAY)); trips.push(trip(id,'a','home',20000,20050)); }
  // In B for a fixed class 900–5000, then home.
  add('classB'); stays.push(stay('classB','b',0,900), stay('classB','b',900,5000,CLASS), stay('classB','home',5050,DAY)); trips.push(trip('classB','b','home',5000,5050));
  // In C, outside the meteor radius but inside the earthquake radius.
  add('inC'); stays.push(stay('inC','c',0,20000), stay('inC','home',20050,DAY)); trips.push(trip('inC','c','home',20000,20050));
  // Scheduled departure from A during earthquake shaking (1030 < 1060).
  add('leaver'); stays.push(stay('leaver','a',0,1030), stay('leaver','home',1080,DAY)); trips.push(trip('leaver','a','home',1030,1080));
  // Arrival heading to B during the hazard.
  add('toB'); stays.push(stay('toB','home',0,1050), stay('toB','b',1100,DAY)); trips.push(trip('toB','home','b',1050,1100));
  // In flight from A to B at the start (an origin that is also inside the multi-building hazard).
  add('aToB'); stays.push(stay('aToB','a',0,990), stay('aToB','b',1030,DAY)); trips.push(trip('aToB','a','b',990,1030));
  // At the outdoor quad, inside the earthquake and meteor radius.
  add('onQuad'); stays.push(stay('onQuad','quad',0,DAY));
  add('inD'); stays.push(stay('inD','d',0,DAY));
  if (late) {
    // Visits A long after the requested end (2800): class 4100–6000, then B 6040–7000, then D.
    add('lateVisit'); stays.push(stay('lateVisit','d',0,4000), stay('lateVisit','a',4100,6000,CLASS), stay('lateVisit','b',6040,7000), stay('lateVisit','d',7090,DAY));
    trips.push(trip('lateVisit','d','a',4000,4100), trip('lateVisit','a','b',6000,6040), trip('lateVisit','b','d',7000,7090));
    // Lives in A: before the scenario a closure occupant would have walked back in at reopening.
    add('nightA'); stays.push(stay('nightA','a',0,DAY));
  }
  return { day:'Monday', buildings:['A','B','C','D'].map(id => square(X[id.toLowerCase()], id)), locations, agents, walkRoutes, trips, stays };
}
const freeze = value => { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
const at = (kind, extra = {}) => ({ id:`${kind}-1`, kind, locationId:'a', start:1000, duration:1800, ...extra });
const byAgent = day => {
  const map = new Map(day.agents.map(agent => [agent.id, []]));
  for (const stay of day.stays) map.get(stay.agent).push({ start:stay.start, end:stay.end, stay });
  for (const trip of day.trips) map.get(trip.agent).push({ start:trip.timestamps[0], end:trip.timestamps.at(-1), trip });
  for (const events of map.values()) events.sort((a, b) => a.start - b.start || (a.trip ? 1 : 0) - (b.trip ? 1 : 0));
  return map;
};
/** Complete, gap-free timelines; connected walks; one state per person at every boundary. */
function assertWellFormed(day) {
  for (const [id, events] of byAgent(day)) {
    let time = 0, endpoint;
    for (const e of events) {
      assert.ok(Math.abs(e.start - time) < 1e-7, `${id}: gap or overlap at ${time}`);
      time = e.end;
      if (e.trip) {
        if (endpoint && e.trip.from !== 'off-campus') assert.deepEqual(e.trip.path[0], endpoint, `${id}: disconnected walk`);
        endpoint = e.trip.path.at(-1);
      }
    }
    assert.ok(Math.abs(time - DAY) < 1e-7, `${id}: incomplete day`);
  }
}
function assertConserved(day, times) {
  const playback = new Playback(day);
  for (const time of times) {
    const pop = playback.populationAt(time);
    const inactive = new Set((day.casualties ?? []).filter(event => event.at <= time).map(event => event.agentId));
    const off = day.stays.filter(s => !inactive.has(s.agent) && s.location === 'off-campus' && s.start <= time && time < s.end).length;
    assert.equal(pop.indoors + pop.walking + (pop.outdoors ?? 0) + off + (pop.injured ?? 0) + (pop.fatalities ?? 0), day.agents.length, `population at ${time}`);
  }
}
/** Nobody stays at a hazard location during [start, endsAt) except an occupant before its exit.
 * Disasters: endsAt is midnight, so this covers the rest of the day. */
function assertNoEarlyReentry(result, start) {
  const blocked = new Set(result.hazard.affectedLocationIds), byId = new Map(result.participants.map(p => [p.agentId, p]));
  for (const s of result.day.stays) {
    if (!blocked.has(s.location) || s.end <= start || s.start >= result.endsAt - 1e-7) continue;
    const p = byId.get(s.agent);
    // Occupants stay until their exit; that stay may be split (activity, then waiting once it ends).
    assert.ok(p?.role === 'occupant' && s.end <= p.departAt + 1e-7, `${s.agent} at ${s.location} ${s.start}-${s.end}`);
  }
  for (const p of result.participants) {
    for (const id of [p.waitLocationId, p.relocationId]) if (id) assert.ok(!blocked.has(id), `${p.agentId} sent into the hazard at ${id}`);
    if (p.decision && ['wait', 'relocate'].includes(p.decision.action) && p.role === 'occupant') assert.ok(!blocked.has(p.decision.destinationId));
  }
}
/** Disasters: no walk into the zone starts after the scenario begins, except an arrival turning back at that moment. */
function assertNoZoneEntry(result, start) {
  const blocked = new Set(result.hazard.affectedLocationIds), byId = new Map(result.participants.map(p => [p.agentId, p]));
  for (const t of result.day.trips) if (blocked.has(t.to) && t.timestamps[0] >= start) {
    const p = byId.get(t.agent);
    assert.ok(p?.role === 'arrival' && Math.abs(t.timestamps[0] - p.departAt) < 1e-7, `${t.agent} walks into ${t.to} at ${t.timestamps[0]}`);
  }
}
const classStaysWithin = (original, result) => {
  const classes = new Map();
  for (const o of original.stays) if (o.purpose?.kind === 'class') {
    const list = classes.get(o.agent) ?? []; list.push(o); classes.set(o.agent, list);
  }
  for (const s of result.day.stays) if (s.purpose?.kind === 'class')
    assert.ok((classes.get(s.agent) ?? []).some(o => o.location === s.location && o.start <= s.start + 1e-7 && s.end <= o.end + 1e-7),
      `${s.agent}: class ${s.start}-${s.end} outside its published time`);
};

test('exported contract: disaster kinds, defaults, minima and limitations', () => {
  assert.ok(['fire', 'earthquake', 'meteor'].every(isDisasterKind));
  assert.ok(!isDisasterKind('fire-drill') && !isDisasterKind('building-closure'));
  assert.equal(DISASTER_ASSUMPTIONS.fire.defaultRadiusMetres, 0);
  assert.equal(DISASTER_ASSUMPTIONS.earthquake.defaultRadiusMetres, 250);
  assert.equal(DISASTER_ASSUMPTIONS.meteor.defaultRadiusMetres, 100);
  assert.ok(DISASTER_LIMITATIONS.length > 0 && DISASTER_LIMITATIONS.some(note => /casualt/i.test(note) && /uncalibrated/i.test(note)));
});

test('the three disasters are deterministic, immutable and behave differently', () => {
  const original = freeze(fixture()), saved = JSON.stringify(original);
  const results = Object.fromEntries(['fire', 'earthquake', 'meteor'].map(kind => [kind, applyIncident(original, at(kind))]));
  assert.equal(JSON.stringify(original), saved);
  for (const kind of Object.keys(results)) assert.deepEqual(applyIncident(original, at(kind)), results[kind]);
  const { fire, earthquake, meteor } = results;
  // Exact timing contract: active response until start + duration; closure until midnight.
  assert.deepEqual(fire.hazard, { radiusMetres:0, responseStartsAt:1000, activeUntil:2800, affectedLocationIds:['a'], affectedBuildingIds:['A'] });
  assert.deepEqual(meteor.hazard, { radiusMetres:100, responseStartsAt:1000, activeUntil:2800, affectedLocationIds:['a','b','quad'], affectedBuildingIds:['A','B'] });
  assert.deepEqual(earthquake.hazard, { radiusMetres:250, responseStartsAt:1060, activeUntil:2800, affectedLocationIds:['a','b','c','quad'], affectedBuildingIds:['A','B','C'] });
  for (const result of Object.values(results)) {
    assert.equal(result.assemblyLocation, null); assert.equal(result.requestedEndsAt, 2800); assert.equal(result.endsAt, DAY);
    assert.equal(result.hazard.activeUntil, result.requestedEndsAt); assert.ok(!('reopensAt' in result.hazard));
    assert.ok(result.participants.every(p => p.outcome === 'cancelled' || p.outcome === 'relocated'), 'no disaster visit resumes the same day');
    assertNoZoneEntry(result, 1000);
    assert.equal(result.day.locations, original.locations); assert.equal(result.day.agents, original.agents);
    assertWellFormed(result.day); assertNoEarlyReentry(result, 1000); classStaysWithin(original, result);
    assertConserved(result.day, [999, 1000, 1001, 1059, 1061, 1200, 2799, 2800, 2801, 5000, 20025]);
  }
  const ids = r => r.participants.map(p => p.agentId).sort();
  assert.ok(!ids(fire).includes('classB') && !ids(fire).includes('onQuad'));
  assert.ok(ids(meteor).includes('classB') && !ids(meteor).includes('inC'));
  assert.ok(ids(earthquake).includes('inC'));
  // Fire reacts faster than a drill (≤45 s vs ≤90 s); meteor faster still (≤30 s). Stairs: A is 14 m (4 floors × 8 s).
  const firstA = r => Math.min(...r.participants.filter(p => p.role === 'occupant' && p.agentId.startsWith('inA')).map(p => p.departAt));
  assert.ok(firstA(fire) - 1000 <= 45 + 3 * 8 + 1 && firstA(fire) - 1000 >= 10);
  assert.ok(meteor.participants.filter(p => p.role === 'occupant').every(p => p.departAt - 1000 <= 30 + 24 + 5));
  // Inside the radius, untouched outside it.
  const unchanged = (r, id) => JSON.stringify(byAgent(r.day).get(id)) === JSON.stringify(byAgent(original).get(id));
  assert.ok(unchanged(meteor, 'inC') && unchanged(fire, 'classB') && unchanged(earthquake, 'inD'));
});

test('occupants leave on their saved walk; those without one wait outside the zone until midnight', () => {
  const original = fixture();
  const fire = applyIncident(original, at('fire')), quake = applyIncident(original, at('earthquake'));
  for (const result of [fire, quake]) for (const p of result.participants.filter(p => p.agentId.startsWith('inA'))) {
    assert.equal(p.outcome, 'cancelled'); assert.equal(p.decision.action, 'leave'); assert.equal(p.decision.destinationId, 'home');
    assert.equal(p.waitLocationId, undefined);
    const home = result.day.trips.find(t => t.agent === p.agentId && t.to === 'home');
    assert.ok(Math.abs(home.timestamps[0] - p.departAt) < 1e-7, 'walks home at the exit slot, not at the requested end');
  }
  // Quad occupant has no saved walk out: waits at D for the rest of the day and never walks back.
  const quad = quake.participants.find(p => p.agentId === 'onQuad');
  assert.equal(quad.waitLocationId, 'd'); assert.equal(quad.decision.action, 'wait'); assert.equal(quad.resumedAt, DAY);
  assert.deepEqual(quake.day.trips.filter(t => t.agent === 'onQuad').map(t => `${t.from}>${t.to}`), ['quad>d']);
  assert.ok(quake.day.stays.some(s => s.agent === 'onQuad' && s.location === 'd' && s.end === DAY));
});

test('earthquake: nobody leaves during shaking, including a scheduled departure, then everyone exits', () => {
  const original = fixture(), result = applyIncident(original, at('earthquake'));
  const occupants = result.participants.filter(p => p.role === 'occupant');
  assert.ok(occupants.every(p => p.departAt >= 1060 + 15));
  const leaver = result.participants.find(p => p.agentId === 'leaver');
  assert.equal(leaver.outcome, 'cancelled');
  const walk = result.day.trips.find(t => t.agent === 'leaver' && t.from === 'a');
  assert.ok(walk.timestamps[0] >= 1075, `left at ${walk.timestamps[0]}`);
  assert.ok(!result.day.trips.some(t => t.timestamps[0] >= 1000 && t.timestamps[0] < 1060
    && occupants.some(p => p.agentId === t.agent)), 'an occupant walked during shaking');
  // Meteor has no shelter delay: the same scheduled departure happens as saved.
  const meteor = applyIncident(original, at('meteor'));
  assert.ok(meteor.participants.find(p => p.agentId === 'leaver').departAt <= 1030 + 1e-9);
});

test('exits are queued per building, not campus-wide', () => {
  const original = fixture({ crowd:300 }), result = applyIncident(original, at('earthquake'));
  const occupants = result.participants.filter(p => p.role === 'occupant');
  const inA = occupants.filter(p => p.agentId.startsWith('inA')).sort((a, b) => a.departAt - b.departAt);
  for (let i = 1; i < inA.length; i++) assert.ok(inA[i].departAt - inA[i - 1].departAt >= 0.5 - 1e-7);
  assert.ok(inA.at(-1).departAt >= 1060 + 302 * 0.5, 'A queue drains at 2 persons/second');
  // B and C clear on their own flows, well before A's queue would have reached them.
  for (const id of ['classB', 'inC', 'onQuad']) assert.ok(occupants.find(p => p.agentId === id).departAt <= 1060 + 90 + 1, id);
  // No return queue: buildings stay closed, so release is the exit itself.
  assert.ok(occupants.every(p => p.releaseAt === p.departAt));
  assertWellFormed(result.day); assertNoEarlyReentry(result, 1000); assertNoZoneEntry(result, 1000);
});

test('arrivals cancel the zone visit; a walk between two hazard buildings detours outside the zone', () => {
  const original = fixture(), result = applyIncident(original, at('meteor'));
  const toB = result.participants.find(p => p.agentId === 'toB');
  assert.equal(toB.role, 'arrival'); assert.equal(toB.outcome, 'cancelled'); assert.equal(toB.decision.action, 'cancel');
  // B was the rest of toB's day: it stays home until midnight instead of entering at the requested end.
  assert.ok(!result.day.trips.some(t => t.agent === 'toB'));
  assert.ok(result.day.stays.some(s => s.agent === 'toB' && s.location === 'home' && s.end === DAY));
  const aToB = result.participants.find(p => p.agentId === 'aToB');
  assert.equal(aToB.waitLocationId, 'd'); assert.equal(aToB.outcome, 'cancelled');
  const walks = result.day.trips.filter(t => t.agent === 'aToB').sort((x, y) => x.timestamps[0] - y.timestamps[0]);
  assert.deepEqual(walks.map(t => `${t.from}>${t.to}`), ['a>b', 'b>a', 'a>d']);
  assertWellFormed(result.day); assertNoEarlyReentry(result, 1000); assertNoZoneEntry(result, 1000);
});

test('a class in a damaged building is cancelled, never shifted or resumed', () => {
  const original = fixture(), result = applyIncident(original, at('meteor'));
  const classB = result.participants.find(p => p.agentId === 'classB');
  assert.equal(classB.decision.activity, 'class'); assert.equal(classB.decision.action, 'leave');
  assert.equal(classB.outcome, 'cancelled'); assert.equal(classB.decision.destinationId, 'home');
  const classes = result.day.stays.filter(s => s.agent === 'classB' && s.purpose?.kind === 'class');
  assert.ok(classes.every(s => s.end <= classB.departAt + 1e-7));
  assert.ok(!result.day.stays.some(s => s.agent === 'classB' && s.location === 'b' && s.end > classB.departAt + 1e-7));
  classStaysWithin(original, result);
});

test('regression: a visit after the requested end is still blocked, and the day ends complete', () => {
  const original = freeze(fixture({ late:true }));
  for (const kind of ['fire', 'earthquake', 'meteor']) {
    const result = applyIncident(original, at(kind));
    assert.equal(result.requestedEndsAt, 2800); assert.equal(result.endsAt, DAY);
    // lateVisit's 4000 walk to A starts 20 minutes after the requested end: still cancelled.
    const late = result.participants.find(p => p.agentId === 'lateVisit');
    assert.equal(late.role, 'arrival'); assert.equal(late.outcome, 'cancelled');
    const walks = result.day.trips.filter(t => t.agent === 'lateVisit').sort((x, y) => x.timestamps[0] - y.timestamps[0]);
    assert.ok(!walks.some(t => t.to === 'a'), `${kind}: lateVisit re-entered A`);
    assert.ok(!result.day.stays.some(s => s.agent === 'lateVisit' && s.location === 'a'));
    assert.ok(!result.day.stays.some(s => s.agent === 'lateVisit' && s.purpose?.kind === 'class'), 'the class is cancelled');
    if (kind === 'fire') {
      // Only A is closed: rejoins at B by the saved D>B walk, arriving at the original 6040, then continues.
      assert.deepEqual(walks.map(t => `${t.from}>${t.to}`), ['d>b', 'b>d']);
      assert.ok(Math.abs(walks[0].timestamps.at(-1) - 6040) < 1e-7 && walks[1].timestamps[0] === 7000);
    } else assert.deepEqual(walks.map(t => t.to), [], `${kind}: B is in the zone too, so lateVisit stays at D`);
    // nightA lives in A: waits outside until midnight, with no return walk at or after the requested end.
    const night = result.participants.find(p => p.agentId === 'nightA');
    assert.equal(night.role, 'occupant'); assert.equal(night.outcome, 'cancelled'); assert.equal(night.resumedAt, DAY);
    const nightWalks = result.day.trips.filter(t => t.agent === 'nightA');
    assert.equal(nightWalks.length, 1); assert.equal(nightWalks[0].to, night.waitLocationId);
    assert.ok(!result.day.trips.some(t => t.timestamps[0] >= 2800 && t.timestamps.at(-1) > DAY));
    assertWellFormed(result.day); assertNoEarlyReentry(result, 1000); assertNoZoneEntry(result, 1000);
    assertConserved(result.day, [2799, 2800, 2801, 4050, 6000, 6040, 7000, DAY - 1]);
  }
  // Late-day scenario: the closure (and every wait) still ends exactly at midnight, never past it.
  const result = applyIncident(original, at('fire', { start:DAY - 3600, duration:1800 }));
  assert.equal(result.hazard.activeUntil, DAY - 1800); assert.equal(result.endsAt, DAY);
  assert.ok(result.day.trips.every(t => t.timestamps.at(-1) <= DAY));
  assert.ok(!result.day.trips.some(t => t.agent === 'nightA' && t.from !== 'a'), 'no return walk before midnight');
  assertWellFormed(result.day); assertNoEarlyReentry(result, DAY - 3600); assertNoZoneEntry(result, DAY - 3600);
});

test('validation: radius, minimum duration, target kind and day bounds', () => {
  const day = fixture();
  assert.throws(() => applyIncident(day, at('fire', { radiusMetres:50 })), /radiusMetres/);
  assert.throws(() => applyIncident(day, at('building-closure', { radiusMetres:50 })), /radiusMetres/);
  assert.throws(() => applyIncident(day, at('earthquake', { radiusMetres:501 })), /radiusMetres/);
  assert.throws(() => applyIncident(day, at('meteor', { radiusMetres:-1 })), /radiusMetres/);
  assert.throws(() => applyIncident(day, at('meteor', { radiusMetres:Number.NaN })), /radiusMetres/);
  assert.throws(() => applyIncident(day, at('fire', { duration:1799 })), /at least 30 minutes/);
  assert.throws(() => applyIncident(day, at('earthquake', { duration:899 })), /at least 15 minutes/);
  assert.throws(() => applyIncident(day, at('meteor', { start:DAY - 1000 })), /within one day/);
  assert.throws(() => applyIncident(day, at('fire', { locationId:'quad' })), /indoor/);
  assert.doesNotThrow(() => applyIncident(day, at('earthquake', { duration:900 })));
  // Late-day scenarios either produce complete, well-formed days or reject; never a malformed day.
  let accepted = 0, rejected = 0;
  for (const kind of ['fire', 'earthquake', 'meteor']) for (const start of [DAY - 3600, DAY - 2400, DAY - 1800, DAY - 900]) {
    const duration = Math.max(DISASTER_ASSUMPTIONS[kind].minDurationSeconds, 900);
    if (start + duration > DAY) { assert.throws(() => applyIncident(day, at(kind, { start, duration })), /within one day/); continue; }
    try { const result = applyIncident(day, at(kind, { start, duration })); assertWellFormed(result.day); assertNoEarlyReentry(result, start); accepted++; }
    catch (error) { assert.match(error.message, /must fit within the day/); rejected++; }
  }
  assert.ok(accepted > 0, `accepted ${accepted}, rejected ${rejected}`);
  const outdoor = applyIncident(day, at('meteor', { locationId:'quad', radiusMetres:50 }));
  assert.deepEqual(outdoor.hazard.affectedBuildingIds, ['A', 'B']);
  assert.equal(applyIncident(day, at('earthquake', { radiusMetres:0 })).hazard.affectedBuildingIds.length, 1);
});

test('drill and closure results carry no hazard and are unchanged by the extension', () => {
  const day = fixture();
  for (const kind of ['fire-drill', 'building-closure']) {
    const result = applyIncident(day, at(kind, { duration:600 }));
    assert.ok(!('hazard' in result));
    assert.ok(result.participants.every(p => p.role !== 'occupant' || ['a'].includes(byAgent(day).get(p.agentId).find(e => e.stay && e.start <= 1000 && 1000 < e.end).stay.location)));
  }
});

test('real Wednesday transit day: CDS earthquake 250 m and meteor 100 m at noon for 2 hours', async () => {
  const { buildPopulation } = await import('../src/sim/population.ts');
  const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
  const T = await import('../src/sim/transitService.ts');
  const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));
  const source = read('campus-data');
  const service = T.createTransitService(T.mergeSchedules(read('transit-schedule'), read('shuttle-schedule')));
  const original = buildSourceDay(buildPopulation(read('demo-day'), source, read('population')), source, 2, service);
  assert.ok(original.transitRides.length > 1000);
  const saved = JSON.stringify([original.stays, original.trips, original.transitRides]);
  const start = 12 * 3600, duration = 2 * 3600;
  const summary = {};
  for (const [kind, extra] of [['earthquake', {}], ['meteor', {}], ['fire', {}]]) {
    const result = applyIncident(original, { id:`real-${kind}`, kind, locationId:'cds', start, duration, ...extra }, { sourceData:source, weekday:2 });
    const { hazard } = result;
    assert.ok(hazard.affectedLocationIds.includes('cds'));
    assert.ok(result.affectedAgents > 0);
    assert.equal(result.endsAt, DAY); assert.equal(hazard.activeUntil, start + duration);
    assertWellFormed(result.day); assertNoEarlyReentry(result, start); assertNoZoneEntry(result, start); classStaysWithin(original, result);
    assert.ok(result.participants.every(p => p.outcome === 'cancelled' || p.outcome === 'relocated'));
    const occupants = result.participants.filter(p => p.role === 'occupant');
    assert.ok(occupants.every(p => p.departAt >= hazard.responseStartsAt || byAgent(original).get(p.agentId).some(e => e.trip && e.start === p.departAt && e.start >= hazard.responseStartsAt)));
    for (const ride of result.day.transitRides) if (ride.cancelledAt !== undefined) assert.ok(ride.time >= start);
    // Changed people are exactly the participants.
    const before = byAgent(original), after = byAgent(result.day);
    const changed = new Set((result.casualties ?? []).map(event => event.agentId));
    for (const [id, events] of after) if (JSON.stringify(events) !== JSON.stringify(before.get(id))) changed.add(id);
    assert.equal(changed.size, result.affectedAgents);
    summary[kind] = { buildings:hazard.affectedBuildingIds.length, locations:hazard.affectedLocationIds.length, agents:result.affectedAgents,
      outcomes:result.participants.reduce((m, p) => (m[p.outcome] = (m[p.outcome] ?? 0) + 1, m), {}) };
  }
  assert.ok(summary.earthquake.buildings > summary.meteor.buildings && summary.meteor.buildings >= summary.fire.buildings);
  assert.ok(summary.earthquake.agents > summary.fire.agents);
  console.log(JSON.stringify(summary));
  assert.equal(JSON.stringify([original.stays, original.trips, original.transitRides]), saved);
});

test('meteor occupants run on saved routes, then resume fixed schedules at normal speed', () => {
  const base = fixture(), original = structuredClone(base);
  const result = applyIncident(base, at('meteor'));
  const p = result.participants.find(p => p.agentId === 'onQuad');
  const escape = result.day.trips.find(t => t.agent === p.agentId);
  assert.deepEqual(escape.path, base.walkRoutes['quad>d'].path);
  assert.ok(Math.abs(escape.timestamps.at(-1) - p.departAt - 70 / 2.4) < 1e-7);
  assert.deepEqual(base, original);
  assert.deepEqual(result, applyIncident(base, at('meteor')));
  assertWellFormed(result.day);
  assertNoEarlyReentry(result, 1000);
  assertConserved(result.day, [999, 1000, p.departAt + 1, 3000, 86399]);
  assert.deepEqual(result.day.stays.filter(s => s.agent === 'inD'), base.stays.filter(s => s.agent === 'inD'));
});

test('nearby outdoor through-walkers flee continuously away from impact and keep later appointments', () => {
  const base = fixture();
  const left = [-71.002, 42], near = [-70.9995, 42], right = [-70.996, 42];
  for (const [id, x] of [['west', left[0]], ['east', right[0]]]) base.locations.push({ ...loc('d', ''), id, position: [x, 42], kind: 'outdoor' });
  for (const [id, path] of [['outward', [left, near, right]], ['inward', [right, near, left]]]) {
    const from = id === 'outward' ? 'west' : 'east', to = id === 'outward' ? 'east' : 'west';
    base.agents.push({ id, home: from, model: 0, walkSpeed: 1.4 });
    base.trips.push({ agent: id, from, to, path, timestamps: [900, 1000, 1200] });
    base.stays.push({ agent: id, location: from, start: 0, end: 900 }, { agent: id, location: to, start: 1200, end: DAY });
  }
  const result = applyIncident(base, at('meteor'));
  for (const id of ['outward', 'inward']) {
    const trips = result.day.trips.filter(t => t.agent === id);
    const before = trips[0], flee = trips[1];
    assert.deepEqual(before.path.at(-1), near);
    assert.deepEqual(flee.path[0], near);
    assert.equal(before.timestamps.at(-1), 1000);
    assert.equal(flee.timestamps[0], 1000);
    assert.equal(flee.to, 'east');
    assert.ok(flee.path.every(p => p[0] >= near[0]));
    const metres = (right[0] - near[0]) * 111320 * Math.cos(42 * Math.PI / 180);
    assert.ok(Math.abs((flee.timestamps.at(-1) - 1000) - metres / (1.4 * 2.4)) < 0.5);
  }
  assert.equal(result.day.stays.find(s => s.agent === 'outward' && s.location === 'east').end, DAY);
  assertWellFormed(result.day);
  assert.deepEqual(result, applyIncident(base, at('meteor')));
  assertConserved(result.day, [950, 999.99, 1000, 1050, 1200, 86399]);
});

test('meteor escape preserves a partial approach and declines paths that turn toward impact', async () => {
  const { meteorEscape } = await import('../src/sim/meteorFlee.ts');
  const center = [-71, 42];
  const trip = { agent: 'walker', from: 'west', to: 'east', path: [[-70.9999, 42], [-70.998, 42]], timestamps: [900, 1100] };
  const escape = meteorEscape(trip, 950, center, 100, new Set());
  assert.ok(escape);
  assert.deepEqual(escape.route.path[0], escape.approach.path.at(-1));
  assert.equal(escape.approach.cumulative.at(-1), 50);
  assert.equal(meteorEscape(trip, 950, center, 1, new Set()), undefined);
  assert.equal(meteorEscape(trip, 950, center, 100, new Set(['east'])), undefined);
  const bend = { ...trip, path: [[-70.9995, 42], [-71, 42], [-70.998, 42]], timestamps: [900, 1000, 1100] };
  assert.equal(meteorEscape(bend, 900, center, 100, new Set()), undefined);
});

test('meteor running ends at escape destination without accelerating subsequent schedule trips', () => {
  const base = fixture();
  base.stays.find(s => s.agent === 'leaver' && s.location === 'home').end = 2000;
  base.trips.push({ agent: 'leaver', from: 'home', to: 'd', path: [[X.home, 42], [X.d, 42]], timestamps: [2000, 2200] });
  base.stays.push({ agent: 'leaver', location: 'd', start: 2200, end: DAY });
  const result = applyIncident(base, at('meteor'));
  const walks = result.day.trips.filter(t => t.agent === 'leaver');
  assert.ok(Math.abs(walks[0].timestamps.at(-1) - walks[0].timestamps[0] - 50 / 2.4) < 1e-7);
  assert.deepEqual(walks[1], base.trips.at(-1));
  assertWellFormed(result.day);
});
