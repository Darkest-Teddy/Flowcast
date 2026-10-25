import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { database, migrate } from '../src/dashboard/db';
import { importSources, defaultDataDir } from '../src/dashboard/import';
import { dashboardRouter } from '../src/dashboard/router';
import { DashboardAuthError, type VerifiedUser } from '../src/dashboard/auth';
const users = new Map<string, VerifiedUser>();
const verifyUser = async (token: string) => { const user = users.get(token); if (!user) throw new DashboardAuthError(401); return user; };
async function serve(pool?: ReturnType<typeof database>) {
  const app = express(); app.use(express.json()); app.use('/api/dashboard', dashboardRouter(pool, { verifyUser }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
test('dashboard without database returns 503', async () => {
  const s = await serve();
  try { assert.equal((await fetch(`${s.origin}/api/dashboard/public`)).status, 503); } finally { await s.close(); }
});
test('PostgreSQL import, sessions, persistence, isolation, validation, export, deletion and failure', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  let pool = database(process.env.TEST_DATABASE_URL)!;
  let s: Awaited<ReturnType<typeof serve>> | undefined;
  let ended = false;
  const ids: string[] = [];
  try {
    await migrate(pool); await migrate(pool);
    const access = await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid IN ('dashboard_snapshots'::regclass, 'dashboard_current'::regclass, 'dashboard_guests'::regclass, 'dashboard_accounts'::regclass)");
    assert.equal(access.rows.length, 4);
    assert.ok(access.rows.every((row) => row.relrowsecurity));
    const grants = await pool.query(`SELECT a.privilege_type FROM pg_class c
      CROSS JOIN LATERAL aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
      LEFT JOIN pg_roles r ON r.oid=a.grantee
      WHERE c.oid='dashboard_accounts'::regclass AND (a.grantee=0 OR r.rolname IN ('anon','authenticated'))`);
    assert.equal(grants.rowCount, 0);
    const first = await importSources(pool); assert.equal((await importSources(pool)).hash, first.hash);
    const rows = await pool.query('SELECT sources,payload FROM dashboard_snapshots WHERE hash=$1', [first.hash]);
    assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].sources.length, 3);
    assert.ok(rows.rows[0].sources.every((v: { sha256: string; modifiedAt: string }) => v.sha256.length === 64 && v.modifiedAt));
    assert.equal(rows.rows[0].payload.agents, undefined);
    assert.equal(Object.keys(rows.rows[0].payload.geo.positions).length, first.locations);
    const demo = JSON.parse(await readFile(`${defaultDataDir}/demo-day.json`, 'utf8'));
    assert.equal(first.locations, demo.locations.length);
    for (const [key, route] of Object.entries(demo.walkRoutes) as [string, { cumulative: number[] }][]) {
      const meters = rows.rows[0].payload.geo.walkMeters[key.split('>').sort().join('>')];
      assert.ok(meters <= route.cumulative.at(-1)!);
      if (route.cumulative.at(-1) === 0) assert.equal(meters, 0);
    }
    s = await serve(pool);
    const call = (path: string, cookie = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${s!.origin}/api/dashboard${path}`, { method, headers: { Authorization: cookie ? `Bearer ${cookie}` : '', Origin: s!.origin, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const pub = await call('/public'); assert.equal(pub.status, 200); const data = await pub.json();
    assert.deepEqual(Object.keys(data).sort(), ['locations','geo','events','impact','hourly','places','clubs'].sort());
    assert.equal(data.events.length, rows.rows[0].payload.impact.events.length);
    const ca = 'device-a'; const cb = 'device-b';
    ids.push(randomUUID(), randomUUID());
    users.set(ca, { id: ids[0], email: 'alice@example.test', name: 'Verified Alice' });
    users.set('device-a-second', users.get(ca)!);
    users.set(cb, { id: ids[1], email: 'bob@example.test', name: '' });
    const guestId = randomUUID(); ids.push(guestId);
    await pool.query('INSERT INTO dashboard_guests(id,token_hash,profile,preferences) VALUES($1,$2,$3,$4)', [guestId, guestId, { name: 'Legacy' }, {}]);
    const legacyBefore = (await pool.query('SELECT * FROM dashboard_guests WHERE id=$1', [guestId])).rows;
    await migrate(pool);
    for (const [path, method, body] of [['/me', 'GET', undefined], ['/export', 'GET', undefined], ['/profile', 'PATCH', {}], ['/preferences', 'PATCH', {}], ['/following/x', 'PUT', { following: true }], ['/me', 'DELETE', undefined]] as const) {
      for (const token of ['', 'forged-token']) assert.equal((await call(path, token, method, body, { Cookie: `flowcast_guest=${'a'.repeat(64)}` })).status, 401);
    }
    assert.equal((await pool.query('SELECT 1 FROM dashboard_accounts WHERE id=ANY($1::uuid[])', [ids])).rowCount, 0);
    const a = await call('/me', ca); const ua = await a.json();
    const b = await call('/me', cb); const ub = await b.json();
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    assert.equal(ua.session.user.id, ids[0]); assert.equal(ub.session.user.id, ids[1]);
    assert.equal(ua.session.user.email, 'alice@example.test'); assert.equal(ua.profile.name, 'Verified Alice');
    assert.deepEqual(ua.session.roles, []); assert.equal(ua.session.officerOfClubId, null);
    assert.equal(a.headers.get('set-cookie'), null);
    assert.equal((await call('/profile', ca, 'PATCH', { name: 'Alice', homeLocationId: data.locations[0].id })).status, 200);
    for (const invalid of [{ roles: ['admin'] }, { homeLocationId: 'invalid' }, { lunchTime: '99:99' }, { avatarSwatch: -1 }, { name: 'x'.repeat(101) }]) assert.equal((await call('/profile', ca, 'PATCH', invalid)).status, 400);
    for (const headers of ([{ Origin: 'https://evil.example' }, { 'Sec-Fetch-Site': 'cross-site' }, { Origin: '' }] satisfies Record<string, string>[])) assert.equal((await call('/profile', ca, 'PATCH', { name: 'evil' }, Object.fromEntries(Object.entries(headers).filter((pair): pair is [string, string] => typeof pair[1] === 'string')))).status, 403);
    assert.equal((await call('/preferences', ca, 'PATCH', { packedRoute: true })).status, 200);
    assert.equal((await call('/preferences', ca, 'PATCH', { packedRoute: 'yes' })).status, 400);
    const club = data.clubs[0].id;
    for (let i = 0; i < 2; i++) assert.deepEqual(await (await call(`/following/${encodeURIComponent(club)}`, ca, 'PUT', { following: true })).json(), [club]);
    assert.equal((await call('/following/unknown', ca, 'PUT', { following: true })).status, 400);
    await s.close(); await pool.end(); pool = database(process.env.TEST_DATABASE_URL)!; s = await serve(pool);
    const restored = await (await call('/me', 'device-a-second')).json(); assert.equal(restored.profile.name, 'Alice'); assert.equal(restored.notificationPrefs.packedRoute, true); assert.deepEqual(restored.following, [club]);
    await Promise.all([
      call('/profile', ca, 'PATCH', { lunchTime: '12:30' }),
      call('/profile', ca, 'PATCH', { dinnerTime: '18:00' }),
    ]);
    const concurrent = await (await call('/me', ca)).json();
    assert.equal(concurrent.profile.lunchTime, '12:30'); assert.equal(concurrent.profile.dinnerTime, '18:00');
    const other = await (await call('/me', cb)).json(); assert.equal(other.profile.name, ''); assert.deepEqual(other.following, []);
    const exported = await (await call('/export', ca)).json(); assert.equal(exported.profile.name, 'Alice'); assert.deepEqual(exported.followedOrganizers, [club]); assert.equal(exported.token_hash, undefined); assert.deepEqual(exported.events, []);
    assert.equal((await call('/profile', ca, 'PATCH', { homeLocationId: null, studySpotId: null })).status, 200);
    const deleted = await call('/me', ca, 'DELETE'); assert.equal(deleted.status, 204); assert.equal(deleted.headers.get('set-cookie'), null);
    assert.equal((await pool.query('SELECT 1 FROM dashboard_accounts WHERE id=$1', [ids[0]])).rowCount, 0);
    assert.equal((await pool.query('SELECT 1 FROM dashboard_accounts WHERE id=$1', [ids[1]])).rowCount, 1);
    assert.deepEqual((await pool.query('SELECT * FROM dashboard_guests WHERE id=$1', [guestId])).rows, legacyBefore);
    const recreated = await (await call('/me', 'device-a-second')).json();
    assert.equal(recreated.session.user.id, ids[0]); assert.equal(recreated.profile.name, 'Verified Alice');
    assert.deepEqual(recreated.following, []);
    await pool.query('DELETE FROM dashboard_accounts WHERE id=ANY($1::uuid[])', [ids]);
    await pool.query('DELETE FROM dashboard_guests WHERE id=$1', [guestId]);
    await pool.end(); ended = true;
    for (const [path, method, body] of [['/public', 'GET', undefined], ['/profile', 'PATCH', { name: 'Lost' }], ['/preferences', 'PATCH', { packedRoute: false }], ['/me', 'DELETE', undefined]] as const) {
      const failed = await call(path, cb, method, body); assert.equal(failed.status, 503); assert.deepEqual(await failed.json(), { error: 'Dashboard data is unavailable. Please try again later.' });
    }
  } finally { await s?.close(); if (!ended) { await pool.query('DELETE FROM dashboard_accounts WHERE id=ANY($1::uuid[])', [ids]); await pool.query('DELETE FROM dashboard_guests WHERE id=ANY($1::uuid[])', [ids]); await pool.end(); } }
});
