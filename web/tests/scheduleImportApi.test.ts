import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

test('schedule API uses authenticated persisted state and guards imports across account changes', async (t) => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    root: fileURLToPath(new URL('..', import.meta.url)),
    resolve: { alias: { '@map': fileURLToPath(new URL('../../map-client/src', import.meta.url)) } },
    server: { middlewareMode: true, watch: null },
  });
  t.after(() => server.close());
  const { api, resetAccountData } = await server.ssrLoadModule('/src/data/api.ts');
  const { auth } = await server.ssrLoadModule('/src/auth/client.ts');
  auth.headers = async () => ({ Authorization: 'Bearer test-account' });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const item = { id: 'lecture', title: 'Lecture', source: 'calendar', locationId: '', locationText: 'CAS 211', start: '2026-10-26T14:00:00Z', end: '2026-10-26T15:00:00Z' };
  const empty = { items: [], fileName: null, importedAt: null, windowStart: null, windowEnd: null };
  let state = { ...empty, items: [item], fileName: 'classes.ics', importedAt: item.start, windowStart: item.start, windowEnd: item.end };
  const calls: Array<[string, string, unknown]> = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-account');
    assert.equal(init?.credentials, 'same-origin');
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push([String(url), init?.method ?? 'GET', body]);
    if (init?.method === 'POST') return Response.json({ items: [item], fileName: body.fileName, warnings: [], windowStart: item.start, windowEnd: item.end });
    if (init?.method === 'PUT') state = { ...state, ...body };
    return Response.json(init?.method === 'DELETE' ? empty : state);
  };
  assert.deepEqual(await api.getSchedule(), [item]);
  assert.equal((await api.getScheduleImport()).fileName, 'classes.ics');
  const preview = await api.previewSchedule('next.ics', 'BEGIN:VCALENDAR');
  assert.equal(preview.items[0].locationText, 'CAS 211');
  assert.equal(state.fileName, 'classes.ics', 'preview must not save');
  assert.deepEqual((await api.importSchedule('next.ics', [item])).items, [item]);
  assert.deepEqual(await api.clearSchedule(), empty);
  assert.deepEqual(calls.map(([url, method]) => [url, method]), [
    ['/api/dashboard/schedule', 'GET'], ['/api/dashboard/schedule', 'GET'],
    ['/api/dashboard/schedule/preview', 'POST'], ['/api/dashboard/schedule', 'PUT'], ['/api/dashboard/schedule', 'DELETE'],
  ]);
  assert.deepEqual(calls[2][2], { fileName: 'next.ics', content: 'BEGIN:VCALENDAR' });
  assert.deepEqual(calls[3][2], { fileName: 'next.ics', items: [item] });

  let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const pending = api.previewSchedule('private.ics', 'private');
  await new Promise((resolve) => setImmediate(resolve));
  resetAccountData();
  finish(Response.json(preview));
  await assert.rejects(pending, /Account changed/);

  const before = calls.length;
  const queued = api.importSchedule('old-account.ics', [item]);
  resetAccountData();
  await assert.rejects(queued, /Account changed/);
  assert.equal(calls.length, before);
});
