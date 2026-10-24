import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { RunContext } from '@openai/agents';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { BuildCache, chooseBundle, daysCachedFrom, loadCampusModel, PRIVATE_BUNDLE, PUBLIC_BUNDLE, type CampusModel } from '../src/campus';
import { askMeetings } from '../../map-client/src/insights';
import { createTools, mapOutput, newToolLog, resolvePlace } from '../src/tools';
import { askAgent, FALLBACK_ANSWER, rewordAnswer, unsupportedNumberCount, unsupportedNumbers } from '../src/agent';
import { clientKey, createApp, limiter } from '../src/app';
import type { AskContext } from '../../map-client/src/insights';
import type { Playback } from '../../map-client/src/sim/playback';
import type { CampusData, SourceMeeting } from '../../map-client/src/data/campusData';

// The real public bundle and simulation, Wednesday 12:30 on the Charles River campus. The day is
// built once for the whole suite; app tests use a fake CampusModel around it.
let campus: CampusModel;
let wednesday: Playback;
let ctx: AskContext;
before(async () => {
  campus = loadCampusModel({});
  wednesday = await campus.playback(2);
  ctx = { locations: campus.locations, walkRoutes: campus.walkRoutes, meetings: campus.meetings, occupancyAt: (t) => wednesday.occupancyAt(t), time: 12.5 * 3600, weekday: 2, campus: 'charles-river' };
});

async function call(name: string, args: object, c: AskContext = ctx) {
  const log = newToolLog();
  const t = createTools(c, log).find((x) => x.name === name)!;
  const out = await t.invoke(new RunContext(), JSON.stringify(args));
  return { out: (typeof out === 'string' ? (() => { try { return JSON.parse(out); } catch { return out; } })() : out) as any, log, map: mapOutput(log) };
}

// ---------------------------------------------------------------- data (B2, S6)

test('the private bundle is used only with FLOWCAST_ASK_PRIVATE_BUNDLE=1', () => {
  const exists = () => true;
  assert.deepEqual(chooseBundle({}, exists), { path: PUBLIC_BUNDLE, private: false });
  assert.deepEqual(chooseBundle({ FLOWCAST_ASK_PRIVATE_BUNDLE: 'true' }, exists), { path: PUBLIC_BUNDLE, private: false });
  assert.deepEqual(chooseBundle({ FLOWCAST_ASK_PRIVATE_BUNDLE: '1' }, exists), { path: PRIVATE_BUNDLE, private: true });
  assert.deepEqual(chooseBundle({ FLOWCAST_ASK_PRIVATE_BUNDLE: '1' }, () => false), { path: PUBLIC_BUNDLE, private: false });
  assert.equal(campus.privateBundle, false);
});

test('course meetings use the reference-week intervals the simulation uses', () => {
  const meeting = (id: string, extra: Partial<SourceMeeting>): SourceMeeting => ({
    id, courseCode: 'CAS CS 999', title: 'Course', section: id, roomCode: '101', roomCapacity: 30, notes: null,
    calendarRestricted: false, sharedKey: null, sourceUrl: '', intervals: [{ weekday: 0, startSec: 36000, endSec: 39000 }], ...extra,
  });
  const data = {
    referenceWeekStart: '2026-10-26', term: 'Fall 2026',
    locations: { cas: { meetings: [meeting('A1', {}), meeting('ENDED', { validTo: '2026-10-01' }), meeting('LATER', { validFrom: '2026-12-01' })] } },
  } as unknown as CampusData;
  const out = askMeetings(data);
  assert.deepEqual(out.map((m) => m.meeting.section), ['A1']);
  assert.deepEqual(out[0].meeting.intervals, [{ weekday: 0, startSec: 36000, endSec: 39000 }]);
  // The tools see only those meetings.
  const fixture = { ...ctx, meetings: askMeetings(data) };
  assert.equal(resolvePlace('CAS CS 999', fixture).hasOwnProperty('location'), true);
  const ended = { ...ctx, meetings: askMeetings({ ...data, locations: { cas: { meetings: [meeting('ENDED', { validTo: '2026-10-01' })] } } } as unknown as CampusData) };
  assert.match((resolvePlace('CAS CS 999', ended) as { error: string }).error, /No published meeting/);
});

// ---------------------------------------------------------------- tools

test('places resolve by id, name, short name and course code', () => {
  const get = (ref: string) => {
    const r = resolvePlace(ref, ctx);
    return 'error' in r ? r.error : r.location.id;
  };
  assert.equal(get('mugar'), 'mugar');
  assert.equal(get('Mugar Memorial Library'), 'mugar');
  assert.equal(get('GSU'), 'gsu');
  assert.equal(get('warren dining'), 'warren-dining');
  assert.ok(['cds', 'cas', 'epic'].includes(get('CAS CS 132')));
  assert.match(get('Hogwarts'), /No mapped place/);
});

test('ranking uses the simulation and records rows and a map selection from the same call', async () => {
  const { out, map, log } = await call('rank_places_by_crowd', { kind: 'dining', time: null, near: 'CAS' });
  assert.equal(out.day, 'Wednesday');
  assert.equal(out.time, '12:30 PM');
  const shares = out.places.filter((p: any) => p.percent !== null).map((p: any) => p.percent);
  assert.deepEqual(shares, [...shares].sort((a: number, b: number) => a - b));
  // Same numbers as the playback itself.
  const gsu = ctx.occupancyAt(ctx.time).find((o) => o.location.id === 'gsu')!;
  assert.equal(out.places.find((p: any) => p.id === 'gsu').students, gsu.count);
  assert.equal(map.rows.length, out.places.length);
  assert.equal(map.show?.select, out.places[0].id);
  assert.deepEqual(log.calls, ['rank_places_by_crowd']);
});

test('ranking names the least crowded place by exact share, matching the map selection', async () => {
  const { out, map } = await call('rank_places_by_crowd', { kind: 'dining', time: '18:00', near: null });
  const first = out.places[0];
  assert.equal(out.leastCrowded, first.name);
  assert.equal(map.show?.select, first.id);
  const share = (id: string) => {
    const o = ctx.occupancyAt(18 * 3600).find((x) => x.location.id === id)!;
    return o.count / o.location.capacity;
  };
  for (const p of out.places.slice(1).filter((p: any) => p.percent !== null)) assert.ok(share(first.id) <= share(p.id), p.id);
});

test('show and rows come from the last call with map output; an unmodeled top place selects nothing', async () => {
  const unmodeled: AskContext = { ...ctx, occupancyAt: (t) => ctx.occupancyAt(t).map((o) => (o.location.kind === 'dining' ? { ...o, modeled: false } : o)) };
  const log = newToolLog();
  const tools = createTools(unmodeled, log);
  const run = (name: string, args: object) => tools.find((t) => t.name === name)!.invoke(new RunContext(), JSON.stringify(args));
  await run('place_crowd_outlook', { place: 'Mugar', time: null });
  assert.equal(mapOutput(log).show?.select, 'mugar');
  await run('rank_places_by_crowd', { kind: 'dining', time: null, near: null });
  assert.equal(mapOutput(log).show, null);
  assert.ok(mapOutput(log).rows.length > 0);
  await run('walking_route', { from: 'CAS', to: 'Mugar' });
  assert.ok(mapOutput(log).show?.route);
  assert.deepEqual(mapOutput(log).rows, []); // not left over from the ranking
  await run('walking_route', { from: 'CAS', to: 'Hogwarts' }); // an error changes nothing on the map
  assert.ok(mapOutput(log).show?.route);
});

test('walking route between a place and a course gives meters, minutes and a path to draw', async () => {
  const { out, map } = await call('walking_route', { from: 'CAS', to: 'Mugar' });
  assert.equal(out.from, 'CAS');
  assert.ok(out.meters > 100 && out.meters < 1500, String(out.meters));
  assert.equal(out.minutes, Math.max(1, Math.round(out.meters / 1.4 / 60)));
  assert.ok((map.show?.route?.path.length ?? 0) >= 2);
  const bad = await call('walking_route', { from: 'CAS', to: 'Hogwarts' });
  assert.match(bad.out.error, /No mapped place/);
});

test('course lookup gives the next published meeting', async () => {
  const { out } = await call('find_course', { code: 'CAS CS 132' });
  assert.equal(out.courseCode, 'CAS CS 132');
  assert.ok(out.next.building && out.next.room && out.next.day);
  assert.ok(out.sectionsByBuilding.length >= 1);
});

test('a code naming two courses is ambiguous instead of mixing their sections', async () => {
  const { out, map } = await call('find_course', { code: 'BI 515' });
  assert.deepEqual([...out.ambiguous].sort(), ['CAS BI 515', 'WED BI 515']);
  assert.equal(map.show, null);
  const r = resolvePlace('BI 515', ctx) as { error: string };
  assert.match(r.error, /CAS BI 515/);
  assert.match(r.error, /WED BI 515/);
  const walk = await call('walking_route', { from: 'BI 515', to: 'Mugar' });
  assert.match(walk.out.error, /more than one course/);
  assert.equal((await call('find_course', { code: 'CAS BI 515' })).out.courseCode, 'CAS BI 515');
});

test('time parameters must be HH:MM, in the strict schema and at run time', async () => {
  const ok = await call('place_crowd_outlook', { place: 'Mugar', time: '18:00' });
  assert.equal(ok.out.time, '6:00 PM');
  const bad = await call('place_crowd_outlook', { place: 'Mugar', time: '6pm' });
  // Strict mode keeps the model to the pattern; a stray value is rejected before the tool runs.
  assert.match(JSON.stringify(bad.out), /error/i);
  assert.equal(bad.out.time, undefined);
  const late = await call('place_crowd_outlook', { place: 'Mugar', time: '25:00' });
  assert.match(late.out.error, /HH:MM/);
  for (const name of ['rank_places_by_crowd', 'place_crowd_outlook']) {
    const t = createTools(ctx, newToolLog()).find((x) => x.name === name) as any;
    assert.equal(t.strict, true);
    assert.equal(t.parameters.properties.time.anyOf[0].pattern, '^\\d{2}:\\d{2}$');
  }
});

// ---------------------------------------------------------------- the agent, with a scripted model

test('parallel tool calls: the answer carries show and rows of the last call', async () => {
  const model = new ScriptedModel([
    [functionCall('rank_places_by_crowd', { kind: 'library', time: null, near: null }, { callId: 'a' }), functionCall('walking_route', { from: 'CAS', to: 'Mugar' }, { callId: 'b' })],
    [assistantMessage('Done.')],
  ]);
  const r = await askAgent('q', ctx, undefined, model);
  assert.deepEqual(r.calls, ['rank_places_by_crowd', 'walking_route']);
  assert.ok(r.show?.route);
  assert.deepEqual(r.rows, []);
  assert.equal(r.answer, 'Done.');
});

test('an empty answer or the turn limit gives the friendly fallback with what was collected', async () => {
  const empty = await askAgent('q', ctx, undefined, new ScriptedModel([[functionCall('place_crowd_outlook', { place: 'Mugar', time: null }, { callId: 'a' })], [assistantMessage('')]]));
  assert.equal(empty.answer, FALLBACK_ANSWER);
  assert.equal(empty.show?.select, 'mugar');
  assert.deepEqual(empty.calls, ['place_crowd_outlook']);
  const loop = Array.from({ length: 8 }, (_, i) => [functionCall('find_places', { kind: 'library', nameContains: null }, { callId: `c${i}` })]);
  const looped = await askAgent('q', ctx, undefined, new ScriptedModel(loop));
  assert.equal(looped.answer, FALLBACK_ANSWER);
  assert.ok(looped.calls.length >= 5);
});

test('answers are reworded away from predictions and live counts; unsupported numbers are counted, not blocked', async () => {
  assert.equal(rewordAnswer('Our prediction: Mugar is quiet. Predicted 40%.'), 'Our projection: Mugar is quiet. Projected 40%.');
  assert.equal(rewordAnswer('The live count is 12.'), 'The simulated count is 12.');
  assert.equal(rewordAnswer('This is accurate.'), null);
  assert.equal(rewordAnswer('It is unpredictable.'), null);
  const accurate = await askAgent('q', ctx, undefined, new ScriptedModel([[assistantMessage('Very accurate: 12 people.')]]));
  assert.equal(accurate.answer, FALLBACK_ANSWER);
  assert.deepEqual(unsupportedNumbers('Mugar is 41% full, 1,200 seats, 5 minutes at 12:30 PM', ['{"percent":41,"capacity":1200}', '12:30 PM']), ['5']);
  const before = unsupportedNumberCount();
  const r = await askAgent('q', ctx, undefined, new ScriptedModel([[assistantMessage('About 77777 students.')]]));
  assert.equal(r.answer, 'About 77777 students.');
  assert.equal(unsupportedNumberCount(), before + 1);
});

// ---------------------------------------------------------------- the day cache (S3)

test('day builds are deduped, failed builds retried, and the cache is LRU-bounded', async () => {
  const builds: number[] = [];
  let fail = true;
  const cache = new BuildCache<number, string>((d) => {
    builds.push(d);
    if (d === 9 && fail) { fail = false; throw new Error('boom'); }
    return `day ${d}`;
  }, 2);
  const [a, b] = await Promise.all([cache.get(1), cache.get(1)]);
  assert.equal(a, 'day 1');
  assert.equal(b, 'day 1');
  assert.deepEqual(builds, [1]);
  await assert.rejects(cache.get(9), /boom/);
  assert.equal(cache.isBuilding(9), false);
  assert.equal(await cache.get(9), 'day 9');
  assert.deepEqual(builds, [1, 9, 9]);
  cache.ready(1); // 1 is now more recent than 9
  await cache.get(3);
  assert.equal(cache.ready(9), undefined);
  assert.equal(cache.ready(1), 'day 1');
  assert.equal(cache.ready(3), 'day 3');
  assert.equal(daysCachedFrom({}), 7);
  assert.equal(daysCachedFrom({ FLOWCAST_ASK_DAYS_CACHED: '3' }), 3);
  assert.equal(daysCachedFrom({ FLOWCAST_ASK_DAYS_CACHED: 'x' }), 7);
});

// ---------------------------------------------------------------- the endpoint

/** The real locations and Wednesday's playback; other days build when asked, with a fake builder. */
function fakeCampus(builder: (weekday: number) => Playback | Promise<Playback> = () => wednesday): CampusModel & { builds: number[] } {
  const builds: number[] = [];
  const cache = new BuildCache<number, Playback>((d) => { builds.push(d); return builder(d); }, 7);
  return {
    locations: campus.locations, walkRoutes: campus.walkRoutes, meetings: campus.meetings,
    ready: (d) => (d === 2 ? wednesday : cache.ready(d)),
    playback: (d) => (d === 2 ? Promise.resolve(wednesday) : cache.get(d)),
    privateBundle: false, daysCached: 7, builds,
  };
}
/** A promise the test resolves when it wants a fake build to finish. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}
const answer = { answer: 'ok', model: 'test', show: null, rows: [], calls: [] };

async function serve(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => server.close() };
}
const send = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => send(url, JSON.stringify(body), headers);
const valid = { question: 'least crowded library', weekday: 2, time: 45000, campus: 'charles-river' };

test('the endpoint validates input and campus, passes the shown day and time, and rate-limits', async () => {
  const seen: AskContext[] = [];
  const app = createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', perMinute: 2, ask: async (_q, c) => { seen.push(c); return answer; } });
  const s = await serve(app);
  try {
    assert.equal((await post(s.url, { ...valid, weekday: 9 })).status, 400);
    assert.equal((await post(s.url, { ...valid, question: 'x'.repeat(301) })).status, 400);
    assert.equal((await post(s.url, { ...valid, campus: '../etc' })).status, 400);
    const unknown = await post(s.url, { ...valid, campus: 'mars' });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /charles-river/);
    const ok = await post(s.url, valid);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).answer, 'ok');
    assert.equal(seen[0].weekday, 2);
    assert.equal(seen[0].time, 45000);
    assert.equal(typeof seen[0].occupancyAt(45000)[0].count, 'number');
    assert.equal((await post(s.url, { ...valid, campus: 'medical' })).status, 200);
    assert.equal((await post(s.url, valid)).status, 429);
    const health = await (await fetch(`${s.url}/api/health`)).json();
    assert.equal(health.privateBundle, false);
    assert.equal('campusBundle' in health, false);
  } finally { s.close(); }
});

test('malformed and oversized bodies get a short JSON error, and only the error type is logged', async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const s = await serve(createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', ask: async () => answer }));
  try {
    const bad = await send(s.url, '{"question": "secret-body-text", ');
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type') ?? '', /json/);
    const badText = await bad.text();
    assert.deepEqual(Object.keys(JSON.parse(badText)), ['error']);
    assert.doesNotMatch(badText, /secret-body-text|\/Users|node_modules|at /);
    const big = await post(s.url, { ...valid, question: 'y'.repeat(5000) });
    assert.equal(big.status, 413);
    assert.deepEqual(Object.keys(await big.json()), ['error']);
  } finally { s.close(); console.error = original; }
  assert.deepEqual(logged, ['request failed: entity.parse.failed', 'request failed: entity.too.large']);
});

test('the limiter evicts expired keys, caps how many it tracks, and keys IPv6 by /64', () => {
  const hit = limiter(1, 1000, 2);
  assert.equal(hit('a', 0), true);
  assert.equal(hit('a', 10), false);
  assert.equal(hit('b', 10), true);
  assert.equal(hit('c', 20), false); // full: a new key is refused
  assert.equal(hit('a', 1100), true); // both windows expired: swept, a new window
  assert.equal(hit.size(), 1);
  assert.equal(hit('c', 1101), true);
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:0db8:0001:0002:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('::ffff:10.0.0.7'), '10.0.0.7');
  assert.equal(clientKey('10.0.0.7'), '10.0.0.7');
  assert.equal(clientKey(undefined), 'unknown');
});

test('behind a trusted proxy each forwarded client gets its own limit', async () => {
  const s = await serve(createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', perMinute: 1, trustProxyHops: 1, ask: async () => answer }));
  try {
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '203.0.113.1' })).status, 200);
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '203.0.113.2' })).status, 200);
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '203.0.113.1' })).status, 429);
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '2001:db8:1:2::9' })).status, 200);
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '2001:db8:1:2::10' })).status, 429);
  } finally { s.close(); }
});

test('a day that is not built yet answers 503 warming up, builds once in the background, then answers', async () => {
  const g = gate();
  const fake = fakeCampus(async () => { await g.opened; return wednesday; });
  let asked = 0;
  const s = await serve(createApp({ campus: fake, keyConfigured: true, model: 'test', retryAfterSec: 3, ask: async () => { asked++; return answer; } }));
  try {
    const friday = { ...valid, weekday: 4 };
    const [r1, r2] = await Promise.all([post(s.url, friday), post(s.url, friday)]);
    assert.equal(r1.status, 503);
    assert.equal(r1.headers.get('retry-after'), '3');
    assert.deepEqual(await r1.json(), { error: 'Warming up the simulation for Friday, try again in a few seconds.', retryAfter: 3 });
    assert.equal(r2.status, 503);
    assert.equal((await post(s.url, friday)).status, 503);
    assert.equal(asked, 0);
    g.open();
    await fake.playback(4);
    assert.deepEqual(fake.builds, [4]);
    assert.equal((await post(s.url, friday)).status, 200);
    assert.equal(asked, 1);
  } finally { s.close(); }
});

test('a failed day build is dropped so the next request starts it again', async () => {
  let attempt = gate();
  let failing = true;
  const fake = fakeCampus(async () => { await attempt.opened; if (failing) throw new Error('no data'); return wednesday; });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const s = await serve(createApp({ campus: fake, keyConfigured: true, model: 'test', ask: async () => answer }));
  try {
    assert.equal((await post(s.url, { ...valid, weekday: 6 })).status, 503);
    const first = fake.playback(6); // joins the build the request started
    attempt.open();
    await assert.rejects(first, /no data/);
    attempt = gate();
    failing = false;
    assert.equal((await post(s.url, { ...valid, weekday: 6 })).status, 503); // starts a new build
    attempt.open();
    await fake.playback(6);
    assert.equal((await post(s.url, { ...valid, weekday: 6 })).status, 200);
    assert.deepEqual(fake.builds, [6, 6]);
  } finally { s.close(); console.error = original; }
  assert.ok(errors.some((e) => /couldn't simulate Sunday/.test(e)));
});

test('a client that disconnects aborts the model run', async () => {
  let resolveAborted: (reason: unknown) => void;
  const aborted = new Promise((r) => { resolveAborted = r; });
  let started: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const s = await serve(createApp({
    campus: fakeCampus(), keyConfigured: true, model: 'test', timeoutMs: 60_000,
    ask: (_q, _c, signal) => new Promise((_, reject) => {
      started();
      signal.addEventListener('abort', () => { resolveAborted(signal.reason); reject(signal.reason); });
    }),
  }));
  const original = console.error;
  console.error = () => {};
  try {
    const client = new AbortController();
    const req = fetch(`${s.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid), signal: client.signal }).catch(() => 'aborted');
    await running;
    client.abort();
    assert.equal(await req, 'aborted');
    const reason = await Promise.race([aborted, new Promise((r) => setTimeout(() => r('not aborted'), 2000))]);
    assert.notEqual(reason, 'not aborted');
    assert.notEqual((reason as Error).name, 'TimeoutError');
  } finally { s.close(); console.error = original; }
});

test('without a key the endpoint says so; model failures become 502 without leaking details', async () => {
  const noKey = await serve(createApp({ campus: fakeCampus(), keyConfigured: false, model: 'test', ask: async () => { throw new Error('unreachable'); } }));
  try {
    const r = await post(noKey.url, valid);
    assert.equal(r.status, 503);
    assert.equal((await (await fetch(`${noKey.url}/api/health`)).json()).keyConfigured, false);
  } finally { noKey.close(); }
  const original = console.error;
  console.error = () => {};
  const failing = await serve(createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', ask: async () => { throw new Error('secret upstream detail sk-123'); } }));
  try {
    const r = await post(failing.url, valid);
    assert.equal(r.status, 502);
    assert.doesNotMatch(await r.text(), /secret|sk-/);
  } finally { failing.close(); console.error = original; }
});
