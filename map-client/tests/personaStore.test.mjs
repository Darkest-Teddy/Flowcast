/*
 * persona/store.ts: the display's polling half and the phone's writing half.
 *
 * Both halves are tested against a stub `fetch`, because the whole point of the file is what it does
 * when the network answers slowly, answers "nothing changed", or does not answer at all -- a display
 * in a lobby and a phone on campus wifi will hit all three.
 *
 * The browser globals are stubbed before the module is imported: store.ts reads localStorage at
 * import time to seed the display's mirror.
 */

import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });

/* ---------------------------------------------------------------------------
 * A browser, as far as store.ts is concerned
 * ------------------------------------------------------------------------- */

function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    get size() { return map.size; },
  };
}

const store = makeStorage();
const listeners = new Map();
globalThis.localStorage = store;
globalThis.window = {
  localStorage: store,
  dispatchEvent: () => true,
  addEventListener: () => {},
  removeEventListener: () => {},
};
globalThis.document = {
  visibilityState: 'visible',
  addEventListener: (type, fn) => void listeners.set(type, fn),
  removeEventListener: (type) => void listeners.delete(type),
};

/** The last request each call made, so a test can assert on method, body and headers. */
let calls = [];
/** A queue of responses; a function is called with the request for a dynamic answer. */
let replies = [];

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : undefined });
  const next = replies.shift();
  if (next === undefined) throw new Error(`unexpected fetch: ${url}`);
  const resolved = typeof next === 'function' ? next(calls.at(-1)) : next;
  if (resolved instanceof Error) throw resolved;
  const { status = 200, body = {} } = resolved;
  return { ok: status >= 200 && status < 300, status, json: async () => body };
};

const {
  readPersonas,
  refreshPersonas,
  subscribePersonas,
  personasAreDurable,
  personasLoaded,
  readMyPersona,
  saveMyPersona,
  removeMyPersona,
  forgetMyPersona,
  MAX_PERSONAS,
} = await import('../src/persona/store.ts');

const { DEFAULT_APPEARANCE } = await import('../src/persona/parts.ts');

const person = (id, name, joinedAt = 1000) => ({ id, name, bio: '', appearance: { ...DEFAULT_APPEARANCE }, homeLocationId: 'warren', joinedAt });
const draft = (name = 'Ada') => ({ name, bio: 'hi', appearance: { ...DEFAULT_APPEARANCE }, homeLocationId: 'cas' });

function reset() {
  calls = [];
  replies = [];
  for (const key of ['flowcast.personas.v1', 'flowcast.persona.mine.v2', 'flowcast.persona.mine.v1']) store.removeItem(key);
  forgetMyPersona();
}

/* ---------------------------------------------------------------------------
 * The display
 * ------------------------------------------------------------------------- */

test('the display takes the list from the server and keeps a mirror of it', async () => {
  reset();
  replies = [{ body: { revision: 'r1', personas: [person('p-a-1', 'Ada', 2000), person('p-b-2', 'Bo', 1000)], durable: true, unchanged: false } }];
  await refreshPersonas();

  assert.equal(calls[0].url, '/api/personas', 'the first poll sends no revision');
  // Oldest first, whatever order the server used: the map draws them in join order.
  assert.deepEqual(readPersonas().map((p) => p.name), ['Bo', 'Ada']);
  assert.equal(personasAreDurable(), true);
  assert.equal(personasLoaded(), true);
  // Mirrored, so a display that restarts during an outage still has people on it.
  assert.equal(JSON.parse(store.getItem('flowcast.personas.v1')).length, 2);
});

test('polling sends the revision it holds and a quiet answer changes nothing', async () => {
  reset();
  replies = [{ body: { revision: 'r1', personas: [person('p-a-1', 'Ada')], durable: true, unchanged: false } }];
  await refreshPersonas();
  const before = readPersonas();

  let notified = 0;
  replies = [{ body: { revision: 'r1', unchanged: true, durable: true } }];
  const stop = subscribePersonas(() => notified++);
  // subscribePersonas polls immediately; let that settle.
  await new Promise((r) => setImmediate(r));
  stop();

  assert.match(calls.at(-1).url, /\?since=r1$/, 'the poll must carry the revision it already has');
  assert.equal(readPersonas(), before, 'an unchanged answer must not replace the list');
  assert.equal(notified, 0, 'nor wake the map up to redraw');
});

test('a failed poll keeps the characters already on the display', async () => {
  reset();
  replies = [{ body: { revision: 'r1', personas: [person('p-a-1', 'Ada')], durable: true, unchanged: false } }];
  await refreshPersonas();

  // A network error, a 500 and a nonsense body: none of them may empty the map.
  replies = [new Error('offline'), { status: 500, body: {} }, { body: { revision: 'r2', personas: 'not an array' } }];
  for (let i = 0; i < 3; i++) await refreshPersonas();
  assert.deepEqual(readPersonas().map((p) => p.name), ['Ada']);
});

test('a removed character leaves the display, and a junk record does not take the others down', async () => {
  reset();
  replies = [{ body: { revision: 'r1', personas: [person('p-a-1', 'Ada'), person('p-b-2', 'Bo')], durable: true, unchanged: false } }];
  await refreshPersonas();

  replies = [{ body: { revision: 'r2', personas: [person('p-b-2', 'Bo'), { id: 'p-c-3' }, { name: 'no id' }, null], durable: false, unchanged: false } }];
  await refreshPersonas();
  assert.deepEqual(readPersonas().map((p) => p.name), ['Bo'], 'Ada is gone, the unusable records are dropped');
  assert.equal(personasAreDurable(), false, 'and the display knows the server is holding them in memory');
});

test('a character with a missing appearance field is still drawable', async () => {
  reset();
  replies = [{ body: { revision: 'r1', personas: [{ id: 'p-a-1', name: 'Ada', joinedAt: 1, appearance: { hair: 'hair-bun' } }], durable: true, unchanged: false } }];
  await refreshPersonas();
  const [only] = readPersonas();
  assert.equal(only.appearance.hair, 'hair-bun', 'what it did say is kept');
  assert.equal(only.appearance.skin, DEFAULT_APPEARANCE.skin, 'what it did not is defaulted');
  assert.equal(only.homeLocationId, 'warren');
});

test('the poll stops when the last watcher leaves', async () => {
  reset();
  replies = [{ body: { revision: 'r1', personas: [], durable: true, unchanged: false } }];
  const stop = subscribePersonas(() => {});
  await new Promise((r) => setImmediate(r));
  const after = calls.length;
  stop();
  // Nothing else is queued, so any further poll would throw "unexpected fetch".
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, after);
});

/* ---------------------------------------------------------------------------
 * The phone
 * ------------------------------------------------------------------------- */

test('the phone posts its character and keeps the token that owns it', async () => {
  reset();
  replies = [(req) => ({ status: 201, body: { persona: { ...person(req.body.id, 'Ada'), bio: 'hi', homeLocationId: 'cas' }, token: 'a'.repeat(64) } })];
  const result = await saveMyPersona(draft());

  assert.equal(result.ok, true);
  assert.equal(calls[0].method, 'POST');
  assert.match(calls[0].body.id, /^p-[a-z0-9]+-[a-z0-9]+$/, 'the phone invents the id');
  assert.equal(calls[0].body.token, undefined, 'and holds no token on a first write');

  const mine = readMyPersona();
  assert.equal(mine.persona.name, 'Ada');
  assert.equal(mine.token, 'a'.repeat(64));
  assert.equal(mine.persona.id, calls[0].body.id);
});

test('editing reuses the id and the token, so one character changes instead of two appearing', async () => {
  reset();
  replies = [(req) => ({ status: 201, body: { persona: person(req.body.id, 'Ada'), token: 'a'.repeat(64) } })];
  await saveMyPersona(draft());
  const id = readMyPersona().persona.id;

  replies = [(req) => ({ status: 201, body: { persona: person(req.body.id, 'Ada L'), token: 'a'.repeat(64) } })];
  const edited = await saveMyPersona(draft('Ada L'));

  assert.equal(edited.ok, true);
  assert.equal(calls.at(-1).body.id, id, 'the same id');
  assert.equal(calls.at(-1).body.token, 'a'.repeat(64), 'proved by the same token');
  assert.equal(readMyPersona().persona.name, 'Ada L');
});

test('an id collision is retried once with a new id and never shown to the student', async () => {
  reset();
  replies = [
    { status: 409, body: { reason: 'conflict' } },
    (req) => ({ status: 201, body: { persona: person(req.body.id, 'Ada'), token: 'b'.repeat(64) } }),
  ];
  const result = await saveMyPersona(draft());

  assert.equal(result.ok, true);
  assert.equal(calls.length, 2);
  assert.notEqual(calls[1].body.id, calls[0].body.id, 'the retry must use a different id');
  assert.equal(readMyPersona().token, 'b'.repeat(64));
});

test('a save that did not reach the server is reported, not pretended', async () => {
  reset();
  // Offline, a server error, a refused character and a full map each come back as themselves.
  for (const [reply, reason] of [
    [new Error('offline'), 'offline'],
    [{ status: 500, body: {} }, 'offline'],
    [{ status: 400, body: { error: 'no' } }, 'rejected'],
    [{ status: 403, body: { error: 'no' } }, 'rejected'],
    [{ status: 409, body: { reason: 'full' } }, 'full'],
  ]) {
    replies = [reply];
    const result = await saveMyPersona(draft());
    assert.equal(result.ok, false, `expected ${reason} to fail`);
    assert.equal(result.reason, reason);
    assert.equal(readMyPersona(), null, 'and nothing may be stored as if it had worked');
  }
});

test('removing waits for the server, and keeps the character on a failure', async () => {
  reset();
  replies = [(req) => ({ status: 201, body: { persona: person(req.body.id, 'Ada'), token: 'a'.repeat(64) } })];
  await saveMyPersona(draft());
  const id = readMyPersona().persona.id;

  replies = [new Error('offline')];
  assert.equal(await removeMyPersona(), false);
  assert.equal(readMyPersona().persona.id, id, 'still ours: the display still has it');

  replies = [{ status: 204, body: {} }];
  assert.equal(await removeMyPersona(), true);
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(calls.at(-1).headers['X-Persona-Token'], 'a'.repeat(64));
  assert.match(calls.at(-1).url, new RegExp(`/api/personas/${id}$`));
  assert.equal(readMyPersona(), null);
});

test('removing with nothing to remove asks the server nothing', async () => {
  reset();
  assert.equal(await removeMyPersona(), true);
  assert.equal(calls.length, 0);
});

test('a character built before the server existed is adopted rather than orphaned', async () => {
  reset();
  // The old world: an id under the v1 key, the record itself in the list mirror.
  store.setItem('flowcast.personas.v1', JSON.stringify([person('p-old-1', 'Ada', 500)]));
  store.setItem('flowcast.persona.mine.v1', JSON.stringify('p-old-1'));

  const mine = readMyPersona();
  assert.equal(mine.persona.name, 'Ada', 'the phone still recognises its own character');
  assert.equal(mine.token, undefined, 'but has no token for it, because the server never issued one');

  // Saving re-posts it under the same id; the server has no row for it, so it issues a token.
  replies = [(req) => ({ status: 201, body: { persona: person(req.body.id, 'Ada'), token: 'c'.repeat(64) } })];
  const result = await saveMyPersona(draft('Ada'));
  assert.equal(result.ok, true);
  assert.equal(calls[0].body.id, 'p-old-1');
  assert.equal(readMyPersona().token, 'c'.repeat(64));

  // And removing one that was never on the server just forgets it, without a doomed request.
  reset();
  store.setItem('flowcast.personas.v1', JSON.stringify([person('p-old-2', 'Bo', 500)]));
  store.setItem('flowcast.persona.mine.v1', JSON.stringify('p-old-2'));
  assert.equal(await removeMyPersona(), true);
  assert.equal(calls.length, 0);
  assert.equal(readMyPersona(), null);
});

test('the client cap matches the server cap', async () => {
  const { MAX_PERSONAS: serverMax } = await import('../../server/src/personas/store.ts');
  assert.equal(MAX_PERSONAS, serverMax, 'store.ts mirrors the server; they must not drift');
});
