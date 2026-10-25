import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { authConfig, createUserVerifier, DashboardAuthError } from '../src/dashboard/auth';
import { dashboardRouter } from '../src/dashboard/router';

const config = { url: 'https://example.supabase.co', publishableKey: 'sb_publishable_test' };
const id = 'a11ce000-0000-4000-8000-000000000001';
const key = (role: string) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.signature`;
const status = (code: number) => (error: unknown) => error instanceof DashboardAuthError && error.status === code;

test('config publishes only publishable/anon keys; invalid or privileged configuration fails closed', () => {
  assert.deepEqual(authConfig({ SUPABASE_URL: config.url, SUPABASE_PUBLISHABLE_KEY: config.publishableKey }), config);
  assert.equal(authConfig({ SUPABASE_URL: config.url, SUPABASE_ANON_KEY: key('anon') }).publishableKey, key('anon'));
  for (const secret of ['sb_secret_private', key('service_role'), key('authenticated'), 'garbage', '']) {
    assert.throws(() => authConfig({ SUPABASE_URL: config.url, SUPABASE_PUBLISHABLE_KEY: secret }), status(503));
  }
  assert.throws(() => authConfig({ SUPABASE_URL: config.url, SUPABASE_PUBLISHABLE_KEY: key('service_role'), SUPABASE_ANON_KEY: key('anon') }), status(503));
  for (const url of ['', 'https://user:password@example.com', 'http://remote.example', `${config.url}/auth`, `${config.url}?secret=x`]) {
    assert.throws(() => authConfig({ SUPABASE_URL: url, SUPABASE_PUBLISHABLE_KEY: config.publishableKey }), status(503));
  }
});

test('verifier calls configured Auth server and derives identity only from its response', async () => {
  const forged = `header.${Buffer.from(JSON.stringify({ sub: 'attacker', role: 'admin' })).toString('base64url')}.fake`;
  const verify = createUserVerifier(() => config, async (url, init) => {
    assert.equal(url, `${config.url}/auth/v1/user`);
    assert.equal(init?.method, 'GET'); assert.equal(init?.redirect, 'error');
    assert.deepEqual(init?.headers, { apikey: config.publishableKey, Authorization: `Bearer ${forged}` });
    assert.ok(init?.signal instanceof AbortSignal);
    return Response.json({ id, email: 'verified@example.test', role: 'admin', user_metadata: { full_name: ' Display Name ', email: 'untrusted@example.test', roles: ['admin'] } });
  });
  assert.deepEqual(await verify(forged), { id, email: 'verified@example.test', name: 'Display Name' });
  for (const code of [401, 403, 429, 500, 503]) {
    await assert.rejects(createUserVerifier(() => config, async () => new Response(null, { status: code }))(forged), status(code === 401 || code === 403 ? 401 : 503));
  }
  for (const response of [Response.json({ id: 'not-a-uuid' }), new Response('broken json'), Response.json({})]) {
    await assert.rejects(createUserVerifier(() => config, async () => response)('token'), status(503));
  }
  await assert.rejects(createUserVerifier(() => config, async () => { throw new TypeError('network unavailable'); })('token'), status(503));
});

test('public config precedes database gate; private routes reject missing/invalid tokens and auth outages', async () => {
  for (const unavailable of [false, true]) {
    const app = express(); app.use(express.json());
    app.use('/api/dashboard', dashboardRouter(undefined, {
      authConfig: () => { if (unavailable) throw new DashboardAuthError(503); return config; },
      verifyUser: createUserVerifier(() => config, async () => {
        if (unavailable) throw new Error('network');
        return new Response(null, { status: 401 });
      }),
    }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const response = await fetch(`${origin}/api/dashboard/auth/config`);
      assert.equal(response.status, unavailable ? 503 : 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      if (!unavailable) assert.deepEqual(await response.json(), config);
      assert.equal((await fetch(`${origin}/api/dashboard/me`)).status, 401);
      assert.equal((await fetch(`${origin}/api/dashboard/me`, { headers: { Authorization: 'Bearer forged' } })).status, unavailable ? 503 : 401);
    } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  }
});
