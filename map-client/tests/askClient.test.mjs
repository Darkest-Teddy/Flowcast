import assert from 'node:assert/strict';
import { test } from 'node:test';

const { parseAskResponse, parseHealth, askAgent, askAgentWithRetry, agentConfigured } = await import('../src/askClient.ts');

const answer = {
  answer: ' Pardee Library is the least crowded library right now: 12% (quiet). ',
  model: 'gpt-6-luna',
  show: { route: { path: [[-71.1, 42.35], [-71.099, 42.349]], estimate: false }, select: 'pardee', points: [[-71.099, 42.349], 'bad'] },
  rows: [
    { id: 'pardee', name: 'Pardee Library', percent: 12, level: 'Quiet', students: 30, modeled: true, open: true, walkMinutes: 4 },
    { id: 'mugar', name: 'Mugar Memorial Library', percent: null, level: null, students: 0, modeled: true, open: false, walkMinutes: null },
    { name: 'no id' },
  ],
  calls: ['rank_places_by_crowd', 7],
};

test('a 200 answer is trimmed and validated: bad rows and points are dropped', () => {
  const r = parseAskResponse(200, answer);
  assert.equal(r.ok, true);
  assert.equal(r.value.answer, 'Pardee Library is the least crowded library right now: 12% (quiet).');
  assert.deepEqual(r.value.rows.map((x) => x.id), ['pardee', 'mugar']);
  assert.equal(r.value.rows[1].open, false);
  assert.equal(r.value.show.select, 'pardee');
  assert.deepEqual(r.value.show.points, [[-71.099, 42.349]]);
  assert.equal(r.value.show.route.estimate, false);
  assert.deepEqual(r.value.calls, ['rank_places_by_crowd']);
});

test('a 200 without show or rows still answers; one without text is unavailable', () => {
  const r = parseAskResponse(200, { answer: 'Hi', model: 'm', show: null, rows: [], calls: [] });
  assert.equal(r.ok, true);
  assert.equal(r.value.show, null);
  assert.deepEqual(parseAskResponse(200, { answer: '' }).error.kind, 'unavailable');
  assert.deepEqual(parseAskResponse(200, null).error.kind, 'unavailable');
});

test('a route with fewer than two points is not drawn', () => {
  const r = parseAskResponse(200, { ...answer, show: { route: { path: [[1, 2]] }, select: null, points: [] } });
  assert.equal(r.value.show.route, null);
});

test('errors map to kinds, keeping the server message and Retry-After', () => {
  const warming = parseAskResponse(503, { error: 'Warming up the simulation for Tuesday, try again in a few seconds.', retryAfter: 10 }, '10');
  assert.deepEqual(warming.error, { kind: 'warming', message: 'Warming up the simulation for Tuesday, try again in a few seconds.', retryAfter: 10 });
  assert.equal(parseAskResponse(503, null, '7').error.retryAfter, 7);
  assert.equal(parseAskResponse(503, { error: 'x' }, '999').error.retryAfter, 30); // capped
  assert.equal(parseAskResponse(503, { error: 'Ask is not configured on this server (no OpenAI key).' }).error.kind, 'notConfigured');
  assert.equal(parseAskResponse(503, null).error.kind, 'unavailable');
  assert.equal(parseAskResponse(429, { error: 'Too many questions.' }).error.kind, 'rateLimited');
  assert.equal(parseAskResponse(400, { error: 'Send …' }).error.kind, 'badRequest');
  assert.equal(parseAskResponse(413, null).error.kind, 'badRequest');
  assert.equal(parseAskResponse(504, null).error.kind, 'timeout');
  assert.equal(parseAskResponse(502, null).error.kind, 'unavailable');
  assert.equal(parseAskResponse(500, null).error.kind, 'unavailable'); // dev proxy with no server behind it
  assert.equal(parseAskResponse(404, '<html>').error.kind, 'unavailable'); // a static host without the server
});

test('health says configured only for the Ask server with a key', () => {
  assert.deepEqual(parseHealth({ ok: true, model: 'gpt-6-luna', keyConfigured: true, privateBundle: false }), { keyConfigured: true, model: 'gpt-6-luna' });
  assert.equal(parseHealth({ ok: true, keyConfigured: false }).keyConfigured, false);
  assert.equal(parseHealth('<html>'), null);
});

const response = (status, body, headers = {}) => ({
  status,
  headers: { get: (k) => headers[k] ?? null },
  json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
});

test('askAgent posts the request as JSON and parses the reply', async () => {
  let sent;
  const r = await askAgent({ question: 'least crowded library', weekday: 0, time: 36000, campus: 'charles-river' }, undefined, {
    fetchImpl: async (url, init) => { sent = { url, init }; return response(200, answer); },
  });
  assert.equal(sent.url, '/api/ask');
  assert.equal(sent.init.method, 'POST');
  assert.deepEqual(JSON.parse(sent.init.body), { question: 'least crowded library', weekday: 0, time: 36000, campus: 'charles-river' });
  assert.equal(r.ok, true);
});

const hang = (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));

test('askAgent reports network failure, timeout and a caller abort distinctly', async () => {
  const req = { question: 'q', weekday: 0, time: 0, campus: 'charles-river' };
  assert.equal((await askAgent(req, undefined, { fetchImpl: async () => { throw new TypeError('fetch failed'); } })).error.kind, 'network');
  assert.equal((await askAgent(req, undefined, { fetchImpl: hang, timeoutMs: 20 })).error.kind, 'timeout');
  const controller = new AbortController();
  const pending = askAgent(req, controller.signal, { fetchImpl: hang });
  controller.abort();
  assert.equal((await pending).error.kind, 'aborted');
  assert.equal((await askAgent(req, undefined, { fetchImpl: async () => response(502, 'not json {') })).error.kind, 'unavailable');
});

test('a timeout while the answer body is read is a timeout, not an unreadable answer', async () => {
  const req = { question: 'q', weekday: 0, time: 0, campus: 'charles-river' };
  const slowBody = async (_url, init) => ({
    status: 200,
    headers: { get: () => null },
    json: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
  });
  assert.equal((await askAgent(req, undefined, { fetchImpl: slowBody, timeoutMs: 20 })).error.kind, 'timeout');
});

test('a warming day is asked once more after Retry-After, then given up', async () => {
  const req = { question: 'q', weekday: 1, time: 0, campus: 'charles-river' };
  const warm = () => response(503, { error: 'Warming up', retryAfter: 3 }, { 'Retry-After': '3' });
  let calls = 0;
  const waits = [];
  const warned = [];
  const ok = await askAgentWithRetry(req, undefined, {
    fetchImpl: async () => (++calls === 1 ? warm() : response(200, answer)),
    sleep: async (ms) => { waits.push(ms); return true; },
    onWarming: (s) => warned.push(s),
  });
  assert.equal(ok.ok, true);
  assert.deepEqual([calls, waits, warned], [2, [3000], [3]]);

  calls = 0;
  const still = await askAgentWithRetry(req, undefined, { fetchImpl: async () => { calls++; return warm(); }, sleep: async () => true });
  assert.equal(still.error.kind, 'warming');
  assert.equal(calls, 2);
});

test('agentConfigured is false only when health says there is no key', async () => {
  assert.equal(await agentConfigured(async () => ({ ok: true, json: async () => ({ ok: true, keyConfigured: false }) }), 1e12), false);
  assert.equal(await agentConfigured(async () => { throw new Error('down'); }, 2e12), true);
  assert.equal(await agentConfigured(async () => ({ ok: true, json: async () => ({ ok: true, keyConfigured: true }) }), 3e12), true);
});
