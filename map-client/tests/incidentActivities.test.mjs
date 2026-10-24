import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { applyIncident } = await import('../src/sim/incidents.ts');
const { VenueLedger, purposeResolver } = await import('../src/sim/incidentActivities.ts');
const { Playback } = await import('../src/sim/playback.ts');
const DAY = 86400, H = 3600;
const WEEKDAY = 2;

const LIBRARY = { kind: 'library', fixed: false }, DINING = { kind: 'dining', fixed: false };
const CLASS = id => ({ kind: 'class', fixed: true, meetingId: id, courseCode: `CS ${id}` });
const HOME = { kind: 'home', fixed: false };

const places = {
  hall: { x: -71, kind: 'classroom' }, altdining: { x: -70.9992, kind: 'dining' }, altlib: { x: -70.999, kind: 'library' },
  home: { x: -71.002, kind: 'dorm' }, far: { x: -70.997, kind: 'classroom' },
};
const pos = id => [places[id].x, 42];
const metres = { 'hall>altdining': 80, 'hall>altlib': 100, 'hall>home': 200, 'altdining>home': 120, 'altlib>home': 150,
  'hall>far': 300, 'altlib>far': 200, 'altdining>far': 220, 'home>far': 500, 'home>altdining': 120 };

/** Agent spec: list of [location, start, end, purpose?]; walks between them use straight saved geometry. */
function fixture(people, { capacity = {}, extraStays = [] } = {}) {
  const locations = Object.entries(places).map(([id, p]) => ({ id, name: id, short: id, kind: p.kind, position: pos(id),
    capacity: capacity[id] ?? 100, building: id }));
  const walkRoutes = Object.fromEntries(Object.entries(metres).map(([key, m]) => {
    const [from, to] = key.split('>');
    return [key, { path: [pos(from), pos(to)], cumulative: [0, m] }];
  }));
  const agents = [], stays = [], trips = [];
  for (const [id, plan] of Object.entries(people)) {
    agents.push({ id, home: 'home', model: 0, walkSpeed: 1 });
    for (let i = 0; i < plan.length; i++) {
      const [location, start, end, purpose] = plan[i];
      stays.push({ agent: id, location, start, end, ...(purpose ? { purpose } : {}) });
      const next = plan[i + 1];
      if (next && next[0] !== location) trips.push({ agent: id, from: location, to: next[0], path: [pos(location), pos(next[0])], timestamps: [end, next[1]] });
    }
  }
  for (const [id, location] of extraStays) { agents.push({ id, home: 'home', model: 0, walkSpeed: 1 }); stays.push({ agent: id, location, start: 0, end: DAY }); }
  return { day: 'Wednesday', buildings: [], locations, agents, walkRoutes, trips, stays };
}
const hours = windows => ({ id: '', buildingCodes: [], meetings: [], evidence: [],
  hours: [{ date: null, weekday: WEEKDAY, windows, text: '', sourceUrl: '', qualifier: null }] });
function context(overrides = {}) {
  return { weekday: WEEKDAY, sourceData: { referenceWeekStart: '2026-09-07',
    locations: { altlib: hours([[7 * H, 24 * H]]), altdining: hours([[7 * H, 21 * H]]), ...overrides } } };
}
// Home → hall activity → home → optional later class at `far`.
const visit = (start, end, purpose, later) => [
  ['home', 0, start - 200, HOME], ['hall', start, end, purpose], ['home', end + 200, later ? later[0] - 500 : DAY, HOME],
  ...(later ? [['far', later[0], later[1], CLASS('later')], ['home', later[1] + 500, DAY, HOME]] : []),
];
const closure = { id: 'close', kind: 'building-closure', locationId: 'hall', start: 12 * H, duration: H };
const drill = { id: 'drill', kind: 'fire-drill', locationId: 'hall', start: 12 * H, duration: 600 };

function assertConservation(day) {
  const playback = new Playback(day), times = new Set();
  for (const s of day.stays) for (const t of [s.start, s.end]) for (const o of [-0.001, 0, 0.001]) times.add(t + o);
  for (const t of day.trips) for (const x of t.timestamps) for (const o of [-0.001, 0, 0.001]) times.add(x + o);
  for (const time of times) {
    if (time < 0 || time >= DAY) continue;
    for (const agent of day.agents) {
      const n = day.stays.filter(s => s.agent === agent.id && s.start <= time && time < s.end).length
        + day.trips.filter(t => t.agent === agent.id && t.timestamps[0] <= time && time < t.timestamps.at(-1)).length;
      assert.equal(n, 1, `${agent.id} has ${n} states at ${time}`);
    }
    const pop = playback.populationAt(time);
    assert.equal(pop.indoors + pop.walking + (pop.outdoors ?? 0), day.agents.length);
  }
  for (const agent of day.agents) {
    const walks = day.trips.filter(t => t.agent === agent.id).sort((a, b) => a.timestamps[0] - b.timestamps[0]);
    for (let i = 1; i < walks.length; i++) {
      assert.equal(walks[i].from, walks[i - 1].to, `${agent.id} walk chain`);
      assert.deepEqual(walks[i].path[0], walks[i - 1].path.at(-1), `${agent.id} teleport`);
    }
  }
}
/** Class-purpose stays never start before or end after their published interval. */
function assertClassTimes(base, day) {
  for (const s of day.stays.filter(s => s.purpose?.kind === 'class')) {
    const source = base.stays.find(b => b.agent === s.agent && b.location === s.location && b.purpose?.meetingId === s.purpose.meetingId);
    assert.ok(source && s.start >= source.start - 1e-9 && s.end <= source.end + 1e-9, `${s.agent} class outside published time`);
  }
}
const stayAt = (day, agent, location) => day.stays.filter(s => s.agent === agent && s.location === location);
const person = (result, id) => result.participants.find(p => p.agentId === id);

test('same building: class waits, study and meal relocate, a mostly eaten meal leaves', () => {
  const base = fixture({
    reader: visit(11.5 * H, 14 * H, LIBRARY), student: visit(11.5 * H, 14 * H, CLASS('a')),
    diner: visit(11.67 * H, 12.67 * H, DINING), finisher: visit(11 * H, 12.17 * H, DINING),
  });
  const result = applyIncident(base, closure, context());
  const decision = id => person(result, id).decision;
  assert.equal(decision('student').activity, 'class'); assert.equal(decision('student').action, 'wait');
  assert.equal(person(result, 'student').outcome, 'interrupted');
  assert.deepEqual([decision('reader').action, decision('reader').destinationId], ['relocate', 'altlib']);
  assert.deepEqual([decision('diner').action, decision('diner').destinationId], ['relocate', 'altdining']);
  assert.equal(decision('finisher').action, 'leave'); assert.equal(decision('finisher').reason, 'meal mostly finished');
  for (const p of result.participants) {
    assert.ok(p.decision.at >= closure.start && typeof p.decision.reason === 'string');
    assert.ok(!/\d/.test(p.decision.reason), 'reasons are stable categories');
  }
  // Relocated activity stays carry purpose; travel uses saved geometry; never late home.
  const lib = stayAt(result.day, 'reader', 'altlib');
  assert.equal(lib.length, 1); assert.deepEqual(lib[0].purpose, LIBRARY);
  assert.ok(lib[0].start > person(result, 'reader').departAt);
  const toLib = result.day.trips.find(t => t.agent === 'reader' && t.to === 'altlib');
  assert.deepEqual(toLib.path, base.walkRoutes['hall>altlib'].path);
  const home = result.day.trips.find(t => t.agent === 'reader' && t.from === 'altlib');
  assert.deepEqual(home.path, base.walkRoutes['altlib>home'].path);
  assert.ok(home.timestamps.at(-1) <= 14 * H + 200 + 1e-9);
  assert.ok(!result.day.stays.some(s => s.agent === 'reader' && s.location === 'hall' && s.end > person(result, 'reader').departAt));
  assertConservation(result.day); assertClassTimes(base, result.day);
  assert.deepEqual(applyIncident(base, closure, context()), result, 'deterministic');
});

test('relocation never delays the next fixed class and keeps every class at its published time', () => {
  const base = fixture({ reader: visit(11.5 * H, 13.5 * H, LIBRARY, [14 * H, 15 * H]) });
  const result = applyIncident(base, closure, context());
  assert.equal(person(result, 'reader').decision.action, 'relocate');
  const cls = stayAt(result.day, 'reader', 'far').find(s => s.purpose?.kind === 'class');
  assert.deepEqual([cls.start, cls.end], [14 * H, 15 * H]);
  assertConservation(result.day); assertClassTimes(base, result.day);
});

test('closed, unknown-hours, restricted and full alternatives are rejected', () => {
  const people = { reader: visit(11.5 * H, 14 * H, LIBRARY) };
  const cases = [
    [fixture(people), context({ altlib: hours([[7 * H, 12.5 * H]]) }), 'alternatives closed or hours unknown'],
    [fixture(people), context({ altlib: undefined }), 'alternatives closed or hours unknown'],
    [fixture(people), context({ altlib: { ...hours([[0, DAY]]), hoursStatus: 'restricted' } }), 'alternatives closed or hours unknown'],
    [fixture(people, { capacity: { altlib: 1 }, extraStays: [['sitter', 'altlib']] }), context(), 'alternatives full'],
  ];
  for (const [base, ctx, why] of cases) {
    const result = applyIncident(base, closure, ctx), d = person(result, 'reader').decision;
    assert.equal(d.action, 'wait'); assert.ok(d.reason.endsWith(why), d.reason);
    assert.equal(stayAt(result.day, 'reader', 'altlib').filter(s => s.purpose?.kind === 'library').length, 0);
    assertConservation(result.day);
  }
  // Without context (no hours) nobody relocates.
  assert.equal(person(applyIncident(fixture(people), closure), 'reader').decision.action, 'wait');
});

test('capacity counts earlier relocations across the whole stay, not only arrival', () => {
  const base = fixture({ a: visit(11.5 * H, 14 * H, LIBRARY), b: visit(11.5 * H, 14 * H, LIBRARY) },
    { capacity: { altlib: 2 }, extraStays: [['sitter', 'altlib']] });
  const result = applyIncident(base, closure, context());
  assert.deepEqual(result.participants.map(p => p.decision.action).sort(), ['relocate', 'wait']);
  const ledger = new VenueLedger([{ agent: 'x', location: 'v', start: 0, end: 10 }]);
  ledger.reserve('v', 5, 20);
  assert.equal(ledger.peak('v', 12, 30), 1); assert.equal(ledger.peak('v', 0, 30), 2);
  assertConservation(result.day);
});

test('exact source intervals classify untagged stays; unknown stays keep generic behavior', () => {
  const untagged = fixture({ s: visit(11.5 * H, 14 * H), d: visit(11.5 * H, 14 * H), u: visit(11.5 * H, 14 * H) });
  untagged.sourceAssignments = [{ agentId: 's', locationId: 'hall', startSec: 11.5 * H, endSec: 14 * H, meetingId: 'm', courseCode: 'CS 1' }];
  untagged.sourceActivities = [{ agentId: 'd', locationId: 'hall', startSec: 11.5 * H, endSec: 14 * H, kind: 'library' },
    { agentId: 'u', locationId: 'hall', startSec: 11.5 * H, endSec: 13 * H, kind: 'library' }];
  const resolve = purposeResolver(untagged);
  assert.equal(resolve(untagged.stays.find(s => s.agent === 's' && s.location === 'hall')).kind, 'class');
  const result = applyIncident(untagged, closure, context());
  assert.deepEqual(['s', 'd', 'u'].map(id => person(result, id).decision.activity), ['class', 'library', 'unknown']);
  assert.deepEqual(['s', 'd', 'u'].map(id => person(result, id).decision.action), ['wait', 'relocate', 'wait']);
  assertConservation(result.day);
});

test('purpose metadata is preserved on unaffected, truncated and pre-incident stays; egress beyond a class is a wait', () => {
  const base = fixture({ student: visit(11.5 * H, 12 * H + 10, CLASS('short')), bystander: visit(9 * H, 10 * H, LIBRARY) });
  base.stays.find(s => s.agent === 'student' && s.location === 'home' && s.start > 0).start = 12 * H + 210;
  base.trips.find(t => t.agent === 'student' && t.from === 'hall').timestamps = [12 * H + 10, 12 * H + 210];
  for (const incident of [closure, drill]) {
    const result = applyIncident(base, incident, context()), p = person(result, 'student');
    // Drill reaction (at least 15 s) outlasts the class; the closure keeps the scheduled departure.
    if (incident === drill) assert.ok(p.departAt > 12 * H + 10, 'reaction outlasts the class');
    else assert.equal(p.departAt, 12 * H + 10);
    assert.deepEqual(result.day.stays.filter(s => s.agent === 'bystander'), base.stays.filter(s => s.agent === 'bystander'));
    assert.deepEqual(result.day.stays.find(s => s.agent === 'student' && s.start === 0).purpose, HOME);
    const inside = stayAt(result.day, 'student', 'hall').sort((a, b) => a.start - b.start);
    const classPart = inside.filter(s => s.purpose?.kind === 'class'), egress = inside.filter(s => s.purpose?.kind === 'wait');
    assert.deepEqual(classPart.map(s => [s.start, s.end]), [[11.5 * H, 12 * H], [12 * H, 12 * H + 10]]);
    assert.deepEqual(classPart[0].purpose, CLASS('short'));
    if (incident === drill) assert.deepEqual(egress.map(s => [s.start, s.end]), [[12 * H + 10, p.departAt]]);
    assert.equal(classPart.length + egress.length, inside.length);
    assertConservation(result.day); assertClassTimes(base, result.day);
  }
});

test('drill: everyone musters first; too little time left cancels the rest, enough time resumes', () => {
  const base = fixture({ shortLib: visit(11 * H, 12.3 * H, LIBRARY), shortClass: visit(11.5 * H, 12.33 * H, CLASS('c')),
    shortMeal: visit(11.8 * H, 12.35 * H, DINING), longLib: visit(11 * H, 14 * H, LIBRARY) });
  const result = applyIncident(base, drill, context());
  for (const p of result.participants) {
    assert.equal(p.outcome, 'evacuated'); assert.ok(p.assemblyAt > p.departAt);
    assert.ok(result.day.stays.some(s => s.agent === p.agentId && s.location === result.assemblyLocation.id && s.start === p.assemblyAt));
    assert.equal(p.decision.at, p.releaseAt); assert.ok(p.decision.action !== 'relocate');
  }
  for (const id of ['shortLib', 'shortClass', 'shortMeal']) {
    const p = person(result, id);
    assert.equal(p.decision.action, 'cancel', id); assert.equal(p.releaseAt, result.endsAt, `${id} not queued`);
    // The cancelled activity is not replayed after release; the saved walk home leaves right after return.
    assert.ok(!stayAt(result.day, id, 'hall').some(s => s.end > p.departAt + 1e-9), `${id} replayed`);
    const home = result.day.trips.find(t => t.agent === id && t.from === 'hall' && t.to === 'home');
    const back = result.day.trips.find(t => t.agent === id && t.to === 'hall' && t.from === result.assemblyLocation.id);
    assert.equal(home.timestamps[0], back.timestamps.at(-1)); assert.equal(back.timestamps[0], result.endsAt);
    assert.ok(home.timestamps[0] < base.trips.find(t => t.agent === id && t.from === 'hall').timestamps[0]);
  }
  const long = person(result, 'longLib');
  assert.equal(long.decision.action, 'resume'); assert.ok(long.releaseAt > result.endsAt - 1e-9);
  assert.ok(stayAt(result.day, 'longLib', 'hall').some(s => s.start >= long.releaseAt && s.end === 14 * H && s.purpose?.kind === 'library'));
  assertConservation(result.day); assertClassTimes(base, result.day);
});

test('drill: a mostly eaten long meal is finished after muster even with ample time left', () => {
  // 11:00–13:00 dining, drill at 12:00: 50% eaten resumes; 11:00–12:30 (67% eaten) leaves after release.
  const base = fixture({ half: visit(11 * H, 13 * H, DINING), most: visit(10.6 * H, 12.6 * H, DINING) });
  const result = applyIncident(base, drill, context());
  const most = person(result, 'most'), half = person(result, 'half');
  assert.ok(12.6 * H - result.endsAt > 900, 'more than 15 minutes would remain');
  assert.deepEqual([most.decision.action, most.decision.reason], ['cancel', 'meal mostly finished']);
  assert.ok(most.assemblyAt > most.departAt && most.decision.at === most.releaseAt);
  assert.ok(!stayAt(result.day, 'most', 'hall').some(s => s.end > most.departAt + 1e-9));
  assert.equal(half.decision.action, 'resume');
  assertConservation(result.day);
});

test('closure arrival not yet walking moves its meal to an open alternative', () => {
  const base = fixture({ late: visit(12.25 * H, 13.5 * H, DINING), clsArrival: visit(12.25 * H, 13.5 * H, CLASS('z')) });
  const result = applyIncident(base, closure, context());
  const late = person(result, 'late');
  assert.deepEqual([late.role, late.outcome, late.decision.action, late.decision.destinationId], ['arrival', 'relocated', 'relocate', 'altdining']);
  const pre = base.stays.find(s => s.agent === 'late' && s.start === 0);
  const toAlt = result.day.trips.find(t => t.agent === 'late' && t.to === 'altdining');
  assert.equal(toAlt.timestamps[0], pre.end); assert.deepEqual(toAlt.path[0], pos('home'));
  assert.ok(!stayAt(result.day, 'late', 'hall').length);
  assert.equal(person(result, 'clsArrival').decision.action, 'wait');
  assertConservation(result.day); assertClassTimes(base, result.day);
});
