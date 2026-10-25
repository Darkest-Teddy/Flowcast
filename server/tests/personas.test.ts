/*
 * /api/personas: the phone writes, the display reads, and nobody edits a character they do not own.
 *
 * The memory store is exercised through the real router over a real socket, because the things worth
 * checking here are HTTP-shaped: the same-origin guard, the token header, the revision handshake the
 * display polls with. The Postgres store runs the same script against a real database when
 * TEST_DATABASE_URL is set, so the two backends cannot drift.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { database, migrate } from '../src/dashboard/db';
import { personasRouter } from '../src/personas/router';
import { memoryPersonaStore, pgPersonaStore, revisionOf, MAX_PERSONAS, type PersonaStore } from '../src/personas/store';
import { DEFAULT_APPEARANCE } from '../../map-client/src/persona/parts';

async function serve(store: PersonaStore, writesPerMinute = 500) {
  const app = express();
  app.use(express.json());
  app.use('/api/personas', personasRouter(store, { writesPerMinute }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

let seq = 0;
const freshId = () => `p-${(Date.now() + seq++).toString(36)}-aa${(seq % 10).toString(36)}x`;

const draft = (over: Record<string, unknown> = {}) => ({
  id: freshId(),
  name: 'Ada',
  bio: 'Second year',
  appearance: { ...DEFAULT_APPEARANCE },
  homeLocationId: 'warren',
  ...over,
});

/** The display's read: no Origin header needed, because a GET is not a write. */
const list = (origin: string, since?: string) => fetch(`${origin}/api/personas${since ? `?since=${since}` : ''}`);

/** The phone's write: a same-origin POST, exactly as the browser would send it. */
function post(origin: string, body: unknown) {
  return fetch(`${origin}/api/personas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Host: new URL(origin).host },
    body: JSON.stringify(body),
  });
}

function del(origin: string, id: string, token: string) {
  return fetch(`${origin}/api/personas/${id}`, {
    method: 'DELETE',
    headers: { Origin: origin, 'X-Persona-Token': token },
  });
}

test('revisionOf changes with every kind of edit and is order-independent', () => {
  const a = { id: 'p-a-1', updatedAt: 10 };
  const b = { id: 'p-b-2', updatedAt: 20 };
  assert.equal(revisionOf([]), 'empty');
  assert.equal(revisionOf([a, b]), revisionOf([b, a]));
  // An insert, an in-place edit and a delete must each move the revision, or the display never polls
  // its way to the truth.
  assert.notEqual(revisionOf([a]), revisionOf([a, b]));
  assert.notEqual(revisionOf([a]), revisionOf([{ ...a, updatedAt: 11 }]));
  assert.notEqual(revisionOf([a, b]), revisionOf([b]));
});

test('a phone adds a character, the display sees it, and only that phone can change it', async () => {
  const s = await serve(memoryPersonaStore());
  try {
    const empty = await (await list(s.origin)).json();
    assert.deepEqual(empty.personas, []);
    assert.equal(empty.durable, false, 'the memory store must admit it is not durable');

    const mine = draft();
    const created = await post(s.origin, mine);
    assert.equal(created.status, 201);
    const { persona, token } = await created.json();
    assert.equal(persona.name, 'Ada');
    assert.equal(persona.id, mine.id, 'the phone chooses the id, so its local record stays valid');
    assert.ok(typeof persona.joinedAt === 'number' && persona.joinedAt > 0, 'the server stamps joinedAt');
    assert.match(token, /^[a-f0-9]{64}$/);

    // The display's read: the character is there, and no secret came with it.
    const seen = await (await list(s.origin)).json();
    assert.equal(seen.personas.length, 1);
    assert.equal(seen.personas[0].name, 'Ada');
    assert.equal('token' in seen.personas[0], false, 'the edit token must never reach the display');
    assert.equal('tokenHash' in seen.personas[0], false);

    // Polling with the revision already held costs nothing and sends no list.
    const unchanged = await (await list(s.origin, seen.revision)).json();
    assert.equal(unchanged.unchanged, true);
    assert.equal(unchanged.personas, undefined);

    // The owner edits in place: one character on the display, not two.
    const edited = await post(s.origin, { ...mine, name: 'Ada L', token });
    assert.equal(edited.status, 201);
    const after = await (await list(s.origin)).json();
    assert.equal(after.personas.length, 1);
    assert.equal(after.personas[0].name, 'Ada L');
    assert.notEqual(after.revision, seen.revision, 'an edit must move the revision');

    // Somebody else holding the id but not the token cannot touch it.
    const stranger = await post(s.origin, { ...mine, name: 'Not Ada' });
    assert.equal(stranger.status, 409);
    assert.equal((await stranger.json()).reason, 'conflict');
    const wrongToken = await post(s.origin, { ...mine, name: 'Not Ada', token: 'f'.repeat(64) });
    assert.equal(wrongToken.status, 409);
    assert.equal((await (await list(s.origin)).json()).personas[0].name, 'Ada L', 'and must not have changed it');

    // Nor delete it.
    assert.equal((await del(s.origin, mine.id, 'f'.repeat(64))).status, 204, 'a wrong token looks like a missing row');
    assert.equal((await (await list(s.origin)).json()).personas.length, 1, 'but deletes nothing');

    // The owner can.
    assert.equal((await del(s.origin, mine.id, token)).status, 204);
    assert.deepEqual((await (await list(s.origin)).json()).personas, []);
  } finally {
    await s.close();
  }
});

test('writes must be same-origin and well-formed', async () => {
  const s = await serve(memoryPersonaStore());
  try {
    const body = draft();
    // No Origin at all, a foreign Origin, and a cross-site fetch are all refused: a persona is
    // written with no login, so the origin check is the only thing standing in the way.
    const bare = await fetch(`${s.origin}/api/personas`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(bare.status, 403);
    const foreign = await fetch(`${s.origin}/api/personas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify(body),
    });
    assert.equal(foreign.status, 403);
    const crossSite = await fetch(`${s.origin}/api/personas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: s.origin, 'Sec-Fetch-Site': 'cross-site' },
      body: JSON.stringify(body),
    });
    assert.equal(crossSite.status, 403);

    for (const bad of [
      { ...draft(), id: 'not-a-persona-id' },
      { ...draft(), name: '' },
      { ...draft(), name: 'x'.repeat(41) },
      { ...draft(), homeLocationId: 'mars' },
      { ...draft(), appearance: { ...DEFAULT_APPEARANCE, hat: 'hat-sombrero' } },
      { ...draft(), appearance: { ...DEFAULT_APPEARANCE, topColor: 'chartreuse' } },
      // An unknown field is refused rather than stored: the appearance is a closed catalog.
      { ...draft(), appearance: { ...DEFAULT_APPEARANCE, cape: 'cape-red' } },
      { id: freshId(), name: 'No appearance' },
    ]) {
      assert.equal((await post(s.origin, bad)).status, 400, `should have refused ${JSON.stringify(bad).slice(0, 60)}`);
    }
    assert.deepEqual((await (await list(s.origin)).json()).personas, [], 'nothing refused may have been stored');

    // The name is trimmed server-side, not just on the phone.
    const spaced = await post(s.origin, draft({ name: '  Bo  ' }));
    assert.equal((await spaced.json()).persona.name, 'Bo');
  } finally {
    await s.close();
  }
});

test('the display is capped, and a full map still lets you edit your own character', async () => {
  const s = await serve(memoryPersonaStore());
  try {
    const first = await (await post(s.origin, draft({ name: 'First' }))).json();
    for (let i = 1; i < MAX_PERSONAS; i++) assert.equal((await post(s.origin, draft({ name: `P${i}` }))).status, 201);
    const full = await post(s.origin, draft({ name: 'One too many' }));
    assert.equal(full.status, 409);
    assert.equal((await full.json()).reason, 'full');

    const seen = await (await list(s.origin)).json();
    assert.equal(seen.personas.length, MAX_PERSONAS);
    assert.equal(seen.max, MAX_PERSONAS);

    // Being full must not lock the people already on it out of their own character.
    const edit = await post(s.origin, { id: first.persona.id, name: 'First, renamed', bio: '', appearance: { ...DEFAULT_APPEARANCE }, homeLocationId: 'cas', token: first.token });
    assert.equal(edit.status, 201);
    assert.equal((await edit.json()).persona.name, 'First, renamed');
  } finally {
    await s.close();
  }
});

test('a character expires rather than living on a display forever', async () => {
  // The store takes its clock as an argument precisely so this is testable without waiting a day.
  let now = 1_700_000_000_000;
  const store = memoryPersonaStore(() => now);
  const s = await serve(store);
  try {
    const { token } = await (await post(s.origin, draft())).json();
    assert.equal((await (await list(s.origin)).json()).personas.length, 1);
    now += 23 * 3_600_000;
    assert.equal((await (await list(s.origin)).json()).personas.length, 1, 'still there within the day');
    now += 2 * 3_600_000;
    assert.deepEqual((await (await list(s.origin)).json()).personas, [], 'gone after it');
    assert.ok(token);
  } finally {
    await s.close();
  }
});

test('rate limiting stops a script filling the display', async () => {
  const s = await serve(memoryPersonaStore(), 3);
  try {
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(s.origin, draft())).status);
    assert.deepEqual(statuses, [201, 201, 201, 429, 429, 429]);
    // A refused write stores nothing.
    assert.equal((await (await list(s.origin)).json()).personas.length, 3);
    // Reads are never limited: the display polls every few seconds all day.
    for (let i = 0; i < 8; i++) assert.equal((await list(s.origin)).status, 200);
  } finally {
    await s.close();
  }
});

/* The same script against Postgres, so the two stores cannot drift apart. */
test('PostgreSQL store behaves like the memory store', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const pool = database(process.env.TEST_DATABASE_URL)!;
  let s: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    await migrate(pool);
    await pool.query('DELETE FROM map_personas');
    const secured = await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid = 'map_personas'::regclass");
    assert.equal(secured.rows[0].relrowsecurity, true);

    s = await serve(pgPersonaStore(pool));
    const info = await (await list(s.origin)).json();
    assert.equal(info.durable, true);

    const mine = draft();
    const { persona, token } = await (await post(s.origin, mine)).json();
    assert.equal(persona.id, mine.id);
    const seen = await (await list(s.origin)).json();
    assert.equal(seen.personas.length, 1);
    assert.equal('token' in seen.personas[0], false);
    assert.equal((await (await list(s.origin, seen.revision)).json()).unchanged, true);

    // An edit keeps the row and its joined_at, so the character does not jump the queue.
    const edited = await (await post(s.origin, { ...mine, name: 'Ada L', token })).json();
    assert.equal(edited.persona.joinedAt, persona.joinedAt);
    assert.equal((await (await list(s.origin)).json()).personas.length, 1);
    assert.notEqual((await (await list(s.origin)).json()).revision, seen.revision);

    assert.equal((await post(s.origin, { ...mine, name: 'Not Ada' })).status, 409);
    assert.equal((await del(s.origin, mine.id, 'f'.repeat(64))).status, 204);
    assert.equal((await (await list(s.origin)).json()).personas.length, 1);

    // An expired row is neither listed nor holding its id.
    await pool.query('UPDATE map_personas SET expires_at = now() - interval \'1 hour\' WHERE id=$1', [mine.id]);
    assert.deepEqual((await (await list(s.origin)).json()).personas, []);
    const reused = await post(s.origin, { ...mine, name: 'Someone else' });
    assert.equal(reused.status, 201, 'an expired id is free again');

    const retoken = (await reused.json()).token;
    assert.equal((await del(s.origin, mine.id, retoken)).status, 204);
    assert.deepEqual((await (await list(s.origin)).json()).personas, []);
  } finally {
    await s?.close();
    await pool.end();
  }
});
