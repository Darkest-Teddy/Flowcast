import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type pg from 'pg';
import { database, migrate } from '../src/dashboard/db';
import { dashboardRouter } from '../src/dashboard/router';
import { DashboardAuthError, type VerifiedUser } from '../src/dashboard/auth';
import { createCrowdThrottle, readCrowdReports, reportBucket } from '../src/dashboard/crowdReports';

const alice: VerifiedUser = { id: 'a11ce000-0000-4000-8000-000000000001', email: 'alice@example.test', name: 'Alice' };
const bob: VerifiedUser = { id: 'b0b00000-0000-4000-8000-000000000002', email: 'bob@example.test', name: 'Bob' };
const users = new Map([['alice', alice], ['bob', bob]]);
const verifyUser = async (token: string) => { const user = users.get(token); if (!user) throw new DashboardAuthError(401); return user; };
// Wednesday 28 Oct 2026, 12:40 in Boston (UTC-4).
const NOW = new Date('2026-10-28T16:40:00Z');
const place = (id: string, kind: string) => ({ id, name: id, short: id, kind, capacity: 100 });

/** A pool stand-in: answers the snapshot query and keeps the crowd table as a map, recording every write. */
function fakePool() {
  const table = new Map<string, number>();
  const writes: { sql: string; params: unknown[] }[] = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('dashboard_snapshots')) return { rows: [{ payload: { impact: { places: [place('marciano', 'dining'), place('mugar', 'library')] } } }] };
      if (sql.startsWith('INSERT INTO dashboard_crowd_reports')) {
        writes.push({ sql, params });
        const key = JSON.stringify(params.slice(0, 4)); table.set(key, (table.get(key) ?? 0) + 1); return { rows: [] };
      }
      if (sql.startsWith('SELECT location_id, hour, answer')) {
        const [since, until] = params as string[];
        const sums = new Map<string, number>();
        for (const [key, count] of table) {
          const [locationId, day, hour, answer] = JSON.parse(key);
          if (day < since || day > until) continue;
          const k = JSON.stringify([locationId, hour, answer]); sums.set(k, (sums.get(k) ?? 0) + count);
        }
        return { rows: [...sums].map(([k, count]) => { const [location_id, hour, answer] = JSON.parse(k); return { location_id, hour, answer, count }; }) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool: pool as unknown as pg.Pool, table, writes };
}

async function serve(pool: pg.Pool | undefined, throttle = createCrowdThrottle()) {
  const app = express(); app.use(express.json());
  app.use('/api/dashboard', dashboardRouter(pool, { verifyUser, crowdThrottle: throttle, now: () => NOW }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token = '', method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/api/dashboard${path}`, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { call, close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

test('reports are rounded to a Boston date and hour; future and stale times are refused', () => {
  assert.deepEqual(reportBucket(new Date('2026-10-28T16:10:00Z'), NOW), { day: '2026-10-28', hour: 12 });
  // 00:30 UTC on the 29th is still the 28th, 8 PM, in Boston.
  assert.deepEqual(reportBucket(new Date('2026-10-29T00:30:00Z'), new Date('2026-10-29T01:00:00Z')), { day: '2026-10-28', hour: 20 });
  assert.equal(reportBucket(new Date(NOW.getTime() + 10 * 60_000), NOW), null);
  assert.equal(reportBucket(new Date(NOW.getTime() - 8 * 3600_000), NOW), null);
  assert.equal(reportBucket(new Date('not a date'), NOW), null);
});

test('throttle: one report per place per hour, a cap per hour, keys never contain the account id', () => {
  let clock = 0;
  const throttle = createCrowdThrottle({ maxPerWindow: 3, now: () => clock });
  assert.equal(throttle.take(alice.id, 'marciano'), true);
  assert.equal(throttle.take(alice.id, 'marciano'), false);
  assert.equal(throttle.take(bob.id, 'marciano'), true, 'other accounts are not affected');
  assert.equal(throttle.take(alice.id, 'mugar'), true);
  assert.equal(throttle.take(alice.id, 'gsu'), true);
  assert.equal(throttle.take(alice.id, 'fitrec'), false, 'hourly cap');
  for (const key of throttle.inspect()) { assert.ok(!key.includes(alice.id) && !key.includes(bob.id) && !key.includes('marciano')); assert.match(key, /^[A-Za-z0-9_-]{43}$/); }
  clock = 3600_000;
  assert.equal(throttle.take(alice.id, 'marciano'), true, 'expires after an hour');
  assert.equal(throttle.inspect().length, 2, 'expired keys are pruned');
});

test('POST stores only an aggregate count: place, Boston date, hour and answer', async () => {
  const { pool, table, writes } = fakePool();
  const s = await serve(pool);
  try {
    const sent = await s.call('/crowd-reports', 'alice', 'POST', { locationId: 'marciano', answer: 'packed', at: '2026-10-28T16:10:27.123Z' });
    assert.equal(sent.status, 204);
    assert.equal((await s.call('/crowd-reports', 'bob', 'POST', { locationId: 'marciano', answer: 'packed' })).status, 204);
    assert.deepEqual([...table], [[JSON.stringify(['marciano', '2026-10-28', 12, 'packed']), 2]]);
    for (const { sql, params } of writes) {
      assert.deepEqual(params, ['marciano', '2026-10-28', 12, 'packed']);
      const text = sql + JSON.stringify(params);
      for (const secret of [alice.id, bob.id, alice.email, 'alice', '16:10', '12:40']) assert.ok(!text.includes(secret), `write must not include ${secret}`);
      assert.doesNotMatch(sql, /user|account|session|created|now\(\)/i);
    }
  } finally { await s.close(); }
});

test('POST validation, authentication, same-origin and per-place throttle', async () => {
  const { pool, table } = fakePool();
  const s = await serve(pool);
  try {
    assert.equal((await s.call('/crowd-reports', '', 'POST', { locationId: 'marciano', answer: 'ok' })).status, 401);
    assert.equal((await s.call('/crowd-reports', 'forged', 'POST', { locationId: 'marciano', answer: 'ok' })).status, 401);
    assert.equal((await s.call('/crowd-reports', 'alice', 'POST', { locationId: 'marciano', answer: 'ok' }, { Origin: 'https://evil.example' })).status, 403);
    for (const invalid of [{}, { locationId: 'marciano' }, { locationId: 'marciano', answer: 'empty' }, { locationId: 'marciano', answer: 'skip' },
      { locationId: 'marciano', answer: 'ok', userId: alice.id }, { locationId: 'nowhere', answer: 'ok' }, { locationId: 'x'.repeat(161), answer: 'ok' },
      { locationId: 'marciano', answer: 'ok', at: 'yesterday' }, { locationId: 'marciano', answer: 'ok', at: '2026-10-28T20:00:00Z' },
      { locationId: 'marciano', answer: 'ok', at: '2026-10-27T12:00:00Z' }]) {
      assert.equal((await s.call('/crowd-reports', 'alice', 'POST', invalid)).status, 400, JSON.stringify(invalid));
    }
    assert.equal(table.size, 0);
    assert.equal((await s.call('/crowd-reports', 'alice', 'POST', { locationId: 'marciano', answer: 'ok' })).status, 204);
    const again = await s.call('/crowd-reports', 'alice', 'POST', { locationId: 'marciano', answer: 'quiet' });
    assert.equal(again.status, 429); assert.match((await again.json()).error, /already reported/);
    assert.equal((await s.call('/crowd-reports', 'alice', 'POST', { locationId: 'mugar', answer: 'quiet' })).status, 204);
    assert.equal([...table.values()].reduce((a, b) => a + b, 0), 2);
  } finally { await s.close(); }
});

test('GET is public, sums the recent window per place and hour, and hides small buckets', async () => {
  const { pool, table } = fakePool();
  const put = (locationId: string, day: string, hour: number, answer: string, count: number) => table.set(JSON.stringify([locationId, day, hour, answer]), count);
  put('marciano', '2026-10-28', 12, 'packed', 4); put('marciano', '2026-10-27', 12, 'packed', 3); put('marciano', '2026-10-26', 12, 'ok', 1);
  put('marciano', '2026-10-28', 15, 'quiet', 2); put('marciano', '2026-10-15', 12, 'quiet', 50);
  put('mugar', '2026-10-28', 10, 'quiet', 2);
  const s = await serve(pool);
  try {
    const response = await s.call('/crowd-reports');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json();
    assert.equal(body.label, 'student reports'); assert.equal(body.since, '2026-10-22'); assert.equal(body.days, 7); assert.equal(body.minReports, 3);
    assert.deepEqual(body.places, [{ locationId: 'marciano', quiet: 2, ok: 1, packed: 7, total: 10, hours: [{ hour: 12, quiet: 0, ok: 1, packed: 7, total: 8 }] }]);
    assert.equal((await (await s.call('/crowd-reports?days=14')).json()).places[0].quiet, 52);
    for (const bad of ['?days=0', '?days=15', '?days=x', '?user=1']) assert.equal((await s.call(`/crowd-reports${bad}`)).status, 400);
  } finally { await s.close(); }
  const offline = await serve(undefined);
  try { assert.equal((await offline.call('/crowd-reports')).status, 503); } finally { await offline.close(); }
});

test('PostgreSQL: crowd table has no identifying columns, is locked down, and aggregates', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const pool = database(process.env.TEST_DATABASE_URL)!;
  const location = `test-${randomUUID()}`;
  try {
    await migrate(pool); await migrate(pool);
    const columns = await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='dashboard_crowd_reports' ORDER BY ordinal_position");
    assert.deepEqual(columns.rows.map((r) => r.column_name), ['location_id', 'day', 'hour', 'answer', 'count']);
    assert.equal((await pool.query("SELECT relrowsecurity FROM pg_class WHERE oid='dashboard_crowd_reports'::regclass")).rows[0].relrowsecurity, true);
    const { addCrowdReport } = await import('../src/dashboard/crowdReports');
    for (let i = 0; i < 3; i++) await addCrowdReport(pool, location, { day: '2026-10-28', hour: 12 }, 'packed');
    await addCrowdReport(pool, location, { day: '2026-10-27', hour: 12 }, 'quiet');
    const rows = await pool.query('SELECT day::text, hour, answer, count FROM dashboard_crowd_reports WHERE location_id=$1 ORDER BY day', [location]);
    assert.deepEqual(rows.rows, [{ day: '2026-10-27', hour: 12, answer: 'quiet', count: 1 }, { day: '2026-10-28', hour: 12, answer: 'packed', count: 3 }]);
    const summary = await readCrowdReports(pool, NOW);
    assert.deepEqual(summary.places.find((p) => p.locationId === location), { locationId: location, quiet: 1, ok: 0, packed: 3, total: 4, hours: [{ hour: 12, quiet: 1, ok: 0, packed: 3, total: 4 }] });
    await assert.rejects(pool.query("INSERT INTO dashboard_crowd_reports VALUES($1,'2026-10-28',24,'ok',1)", [location]));
    await assert.rejects(pool.query("INSERT INTO dashboard_crowd_reports VALUES($1,'2026-10-28',1,'maybe',1)", [location]));
  } finally { await pool.query('DELETE FROM dashboard_crowd_reports WHERE location_id=$1', [location]); await pool.end(); }
});
