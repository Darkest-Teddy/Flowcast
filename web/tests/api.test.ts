import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardClient } from '../src/data/realData.ts';

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test('public reads deduplicate concurrent loads, then refresh projections on subsequent loads', async () => {
  const pending = deferred<Response>();
  let calls = 0;
  const client = createDashboardClient(async (url, init) => {
    assert.equal(url, '/api/dashboard/public');
    assert.equal(init?.credentials, 'same-origin');
    assert.equal(init?.cache, 'no-store');
    calls++;
    return calls === 1 ? pending.promise : json({ places: [{ at: 'next hour/date' }] });
  });
  const first = client.getPublic();
  const second = client.getPublic();
  assert.equal(calls, 1);
  pending.resolve(json({ places: [] }));
  assert.deepEqual(await first, await second);
  assert.deepEqual((await client.getPublic()).places, [{ at: 'next hour/date' }]);
  assert.equal(calls, 2);
});

test('account reads deduplicate and retry after PostgreSQL errors', async () => {
  let calls = 0;
  const client = createDashboardClient(async () => ++calls === 1
    ? json({ error: 'PostgreSQL unavailable' }, 503) : json({ profile: { name: 'Saved' } }));
  const results = await Promise.allSettled([client.getMe(), client.getMe(), client.getMe()]);
  assert.equal(calls, 1);
  for (const result of results) {
    assert.equal(result.status, 'rejected');
    if (result.status === 'rejected') assert.match(result.reason.message, /503.*PostgreSQL unavailable/);
  }
  assert.equal((await client.getMe()).profile.name, 'Saved');
  assert.equal(calls, 2);
});

test('public failures retry; malformed JSON and proxy HTML propagate errors', async () => {
  for (const response of [json({ message: 'Database offline' }, 500), new Response('<html>proxy error</html>', { status: 502 }), new Response('{', { status: 200 })]) {
    let calls = 0;
    const client = createDashboardClient(async () => ++calls === 1 ? response : json({ places: [] }));
    await assert.rejects(client.getPublic(), /Dashboard request failed/);
    assert.deepEqual((await client.getPublic()).places, []);
    assert.equal(calls, 2);
  }
});

test('each mutation blocks fresh account reads and detaches pre-mutation requests', async () => {
  for (const [path, method, body] of [
    ['/profile', 'PATCH', { name: 'Updated' }],
    ['/preferences', 'PATCH', { packedRoute: true }],
    ['/following/organizer%3ATest', 'PUT', { following: true }],
    ['/me', 'DELETE', undefined],
  ] as const) {
    const oldRead = deferred<Response>();
    const write = deferred<Response>();
    let reads = 0;
    const client = createDashboardClient(async (url, init) => {
      if (init?.method === 'GET') return ++reads === 1 ? oldRead.promise : json({ session: { user: { name: 'Fresh' } } });
      assert.equal(url, `/api/dashboard${path}`);
      assert.equal(init?.method, method);
      assert.equal(init?.body, body === undefined ? undefined : JSON.stringify(body));
      assert.equal(init?.credentials, 'same-origin');
      return write.promise;
    });
    const stale = client.getMe();
    await Promise.resolve();
    const mutation = client.mutate(path, method, body);
    const refresh = client.getMe();
    await Promise.resolve();
    assert.equal(reads, 1);
    write.resolve(method === 'DELETE' ? new Response(null, { status: 204 }) : json(body));
    await mutation;
    assert.equal((await refresh).session.user.name, 'Fresh');
    oldRead.resolve(json({ session: { user: { name: 'Stale' } } }));
    await stale;
    assert.equal((await client.getMe()).session.user.name, 'Fresh');
  }
});

test('failed mutations propagate but do not poison later reads or writes', async () => {
  let writes = 0;
  const client = createDashboardClient(async (_url, init) => init?.method === 'GET'
    ? json({ following: [] }) : ++writes === 1 ? json({ error: { message: 'Write failed' } }, 500) : json({ name: 'Saved' }));
  await assert.rejects(client.mutate('/profile', 'PATCH', { name: 'Failed' }), /Write failed/);
  assert.deepEqual((await client.getMe()).following, []);
  assert.deepEqual(await client.mutate('/profile', 'PATCH', { name: 'Saved' }), { name: 'Saved' });
});

test('export returns actual server data and preserves server errors', async () => {
  const client = createDashboardClient(async (url) => {
    assert.equal(url, '/api/dashboard/export');
    return json({ profile: { name: 'Postgres profile' }, following: ['saved-id'] });
  });
  assert.deepEqual(await client.request('/export'), { profile: { name: 'Postgres profile' }, following: ['saved-id'] });
});

test('private requests use the latest bearer while public requests never acquire one', async () => {
  let token = 'first';
  let authCalls = 0;
  const seen: Array<[string, string | null]> = [];
  const client = createDashboardClient(async (url, init) => {
    seen.push([String(url), new Headers(init?.headers).get('Authorization')]);
    return json({});
  }, async () => { authCalls++; return { Authorization: `Bearer ${token}` }; });
  await client.getPublic();
  await client.getMe();
  token = 'refreshed';
  await client.request('/export');
  assert.equal(authCalls, 2);
  assert.deepEqual(seen, [['/api/dashboard/public', null], ['/api/dashboard/me', 'Bearer first'], ['/api/dashboard/export', 'Bearer refreshed']]);
});

test('account reset rejects old reads and queued mutations before they can acquire the next user token', async () => {
  const oldRead = deferred<Response>();
  const oldWrite = deferred<Response>();
  let token = 'A';
  const calls: Array<[string, string | null]> = [];
  const client = createDashboardClient(async (url, init) => {
    calls.push([String(url), new Headers(init?.headers).get('Authorization')]);
    if (token === 'A') return init?.method === 'GET' ? oldRead.promise : oldWrite.promise;
    return json({ profile: { name: 'B' } });
  }, async () => ({ Authorization: `Bearer ${token}` }));
  const read = client.getMe();
  await new Promise((r) => setImmediate(r));
  const write = client.mutate('/profile', 'PATCH', { name: 'A' });
  const queued = client.mutate('/preferences', 'PATCH', { packedRoute: true });
  const rejected = [read, write, queued].map((p) => assert.rejects(p, /Account changed/));
  await new Promise((r) => setImmediate(r));
  client.reset();
  token = 'B';
  assert.equal((await client.getMe()).profile.name, 'B');
  oldRead.resolve(json({ profile: { name: 'A' } }));
  oldWrite.resolve(json({}));
  await Promise.all(rejected);
  assert.deepEqual(calls, [['/api/dashboard/me', 'Bearer A'], ['/api/dashboard/profile', 'Bearer A'], ['/api/dashboard/me', 'Bearer B']]);
});

test('an account switch while acquiring a token prevents the request entirely', async () => {
  const token = deferred<Record<string, string>>();
  let calls = 0;
  const client = createDashboardClient(async () => { calls++; return json({}); }, () => token.promise);
  const result = client.request('/export');
  client.reset();
  token.resolve({ Authorization: 'Bearer B' });
  await assert.rejects(result, /Account changed/);
  assert.equal(calls, 0);
});
