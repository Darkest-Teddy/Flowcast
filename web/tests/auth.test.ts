import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAuthClient, safeReturnRoute } from '../src/auth/client.ts';
import type { createClient } from '@supabase/supabase-js';

function setup() {
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: {
    setItem: (k: string, v: string) => stored.set(k, v), getItem: (k: string) => stored.get(k) ?? null, removeItem: (k: string) => stored.delete(k),
  } } });
  let session: { access_token: string } | null = null;
  const calls: unknown[] = [];
  let exchanges = 0;
  let logoutError: Error | null = null;
  const sdk = { auth: {
    getSession: async () => ({ data: { session }, error: null }),
    signInWithOAuth: async (options: unknown) => { calls.push(options); return { error: null }; },
    exchangeCodeForSession: async (code: string) => { exchanges++; assert.equal(code, 'single-use'); return { error: null }; },
    signOut: async (options: unknown) => { calls.push(options); if (!logoutError) session = null; return { error: logoutError }; },
  } };
  let fetches = 0;
  const auth = createAuthClient(async (url) => {
    assert.equal(url, '/api/dashboard/auth/config'); fetches++;
    return Response.json({ url: 'https://project.supabase.co', publishableKey: 'sb_publishable_test' });
  }, ((url: string, key: string, options: unknown) => {
    calls.push({ url, key, options }); return sdk;
  }) as unknown as typeof createClient);
  return { auth, stored, calls, setSession: (value: typeof session) => { session = value; }, setLogoutError: () => { logoutError = new Error('offline'); }, fetches: () => fetches, exchanges: () => exchanges };
}

test('runtime config creates one persistent PKCE client with explicit callback handling', async () => {
  const s = setup();
  const [a, b] = await Promise.all([s.auth.getClient(), s.auth.getClient()]);
  assert.equal(a, b); assert.equal(s.fetches(), 1);
  assert.deepEqual(s.calls[0], { url: 'https://project.supabase.co', key: 'sb_publishable_test', options: { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } } });
});

test('Google OAuth uses the exact allowed callback, with no calendar scope or return path in its URL', async () => {
  const s = setup();
  await s.auth.signIn('/profile', 'http://127.0.0.1:5198');
  assert.deepEqual(s.calls[1], { provider: 'google', options: { redirectTo: 'http://127.0.0.1:5198/auth/callback' } });
  assert.equal(s.stored.get('flowcast.auth.return'), '/profile');
});

test('callback strips auth query before exchange, consumes return path and survives StrictMode re-entry', async () => {
  const s = setup(); s.stored.set('flowcast.auth.return', '/settings');
  let cleaned = 0;
  const first = s.auth.completeCallback('https://app.test/auth/callback?code=single-use&access_token=never-keep', () => { cleaned++; assert.equal(s.exchanges(), 0); });
  const second = s.auth.completeCallback('https://app.test/auth/callback', () => { cleaned++; });
  assert.equal(first, second);
  assert.deepEqual(await Promise.all([first, second]), ['/settings', '/settings']);
  assert.equal(cleaned, 1); assert.equal(s.exchanges(), 1); assert.equal(s.stored.size, 0);
});

test('OAuth errors and missing codes are cleaned and never exchanged or reflected verbatim', async () => {
  for (const query of ['?error=access_denied&error_description=secret', '#error=access_denied', '']) {
    const s = setup(); let cleaned = false;
    await assert.rejects(s.auth.completeCallback(`https://app.test/auth/callback${query}`, () => { cleaned = true; }), /cancelled or denied|missing its authorization code/);
    assert.equal(cleaned, true); assert.equal(s.exchanges(), 0);
  }
});

test('return routes reject external, encoded, backslash, query, fragment and auth paths', () => {
  for (const path of ['//evil.test', '/\\evil.test', 'https://evil.test', '/%2f%2fevil.test', '/auth/callback', '/signin', '/profile?access_token=secret', '/ask#secret', '/admin/../signin', null]) assert.equal(safeReturnRoute(path), '/');
  assert.equal(safeReturnRoute('/club/calendar'), '/club/calendar');
  assert.equal(safeReturnRoute('/checkin'), '/checkin');
  assert.equal(safeReturnRoute('/meetings'), '/meetings');
  assert.equal(safeReturnRoute('/clubs/organizer%3ADebate%2520Society%2520-%25201124'), '/clubs/organizer%3ADebate%2520Society%2520-%25201124');
  for (const path of ['/checkin/abc?code=secret', '/clubs/organizer%3A../signin', '/clubs/x/y']) assert.equal(safeReturnRoute(path), '/');
});

test('headers restore and refresh through the SDK; logout uses the SDK and removes access', async () => {
  const s = setup();
  await assert.rejects(s.auth.headers(), /Please sign in/);
  s.setSession({ access_token: 'restored' });
  assert.deepEqual(await s.auth.headers(), { Authorization: 'Bearer restored' });
  s.setSession({ access_token: 'refreshed' });
  assert.deepEqual(await s.auth.headers(), { Authorization: 'Bearer refreshed' });
  await s.auth.signOut();
  assert.deepEqual(s.calls.at(-1), { scope: 'local' });
  await assert.rejects(s.auth.headers(), /Please sign in/);
  s.setLogoutError(); await assert.rejects(s.auth.signOut(), /Sign-out could not finish/);
});

test('unavailable or malformed config gives an actionable error and can be retried', async () => {
  for (const response of [new Response('offline', { status: 503 }), Response.json({}), new Response('<html>')]) {
    let calls = 0;
    const auth = createAuthClient(async () => { calls++; return response.clone(); });
    await assert.rejects(auth.getClient(), /authentication configuration.*administrator/);
    await assert.rejects(auth.getClient(), /authentication configuration/);
    assert.equal(calls, 2);
  }
});

test('cancelled Google sign-in retains the requested study page through retry', async () => {
  const s = setup();
  await s.auth.signIn('/study', 'https://app.test');
  assert.equal(s.stored.get('flowcast.auth.return'), '/study');
  await assert.rejects(s.auth.completeCallback('https://app.test/auth/callback?error=access_denied', () => {}));
  assert.equal(s.stored.get('flowcast.auth.return'), '/study');
  await s.auth.signIn(s.stored.get('flowcast.auth.return'), 'https://app.test');
  assert.equal(await s.auth.completeCallback('https://app.test/auth/callback?code=single-use', () => {}), '/study');
  assert.equal(s.stored.has('flowcast.auth.return'), false);
});
