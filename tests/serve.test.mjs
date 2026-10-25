import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHostServer, backendConfig } from '../serve.mjs';

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flowcast-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), 'dashboard entry');
  await writeFile(join(root, 'map.html'), 'map entry');
  return listen(t, createHostServer({ root, ...options }));
}

test('API forwards GET, POST, status, Host, Origin and cookies', async (t) => {
  const upstream = await listen(t, createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': ['session=abc; HttpOnly; SameSite=Lax', 'second=xyz; Path=/'] });
    res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin, cookie: req.headers.cookie, body }));
  }));
  const host = await fixture(t, { apiUrl: upstream });
  for (const path of ['/api/dashboard/session?x=1', '/api/dashboard?x=1', '/api/ask', '/api/health']) {
    for (const method of ['GET', 'POST']) {
      const body = method === 'POST' ? JSON.stringify({ name: 'A student' }) : undefined;
      const response = await fetch(host + path, { method, headers: { Origin: host, Cookie: 'session=abc', 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 201);
      assert.equal(response.headers.getSetCookie().length, 2);
      assert.deepEqual(await response.json(), { method, url: path, host: new URL(host).host, origin: host, cookie: 'session=abc', body: body || '' });
    }
  }
});

test('backend rejection status and response body are preserved', async (t) => {
  const apiUrl = await listen(t, createServer((_req, res) => {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Origin rejected' }));
  }));
  const host = await fixture(t, { apiUrl });
  const response = await fetch(host + '/api/dashboard/session', { method: 'POST', body: '{}' });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Origin rejected' });
});

test('API failures are sanitized JSON and unknown routes never reach SPA', async (t) => {
  const stopped = createServer();
  await new Promise((resolve) => stopped.listen(0, '127.0.0.1', resolve));
  const unavailable = `http://127.0.0.1:${stopped.address().port}`;
  await new Promise((resolve) => stopped.close(resolve));
  for (const apiUrl of ['', unavailable, 'not a URL', 'http://user:secret@localhost']) {
    const host = await fixture(t, { apiUrl });
    const response = await fetch(host + '/api/dashboard/session', { method: 'POST', body: '{}' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'API unavailable' });
  }
  const host = await fixture(t);
  for (const path of ['/api', '/api/unknown', '/api/asking', '/api/dashboard-other', '/api/health/extra']) {
    const response = await fetch(host + path);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'API route not found' });
  }
});

test('upstream has an absolute deadline even while it is silent', async (t) => {
  const apiUrl = await listen(t, createServer(() => {}));
  const host = await fixture(t, { apiUrl, timeoutMs: 40 });
  const response = await fetch(host + '/api/dashboard/session');
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'API unavailable' });
});

test('static map, dashboard fallback, missing assets and HEAD retain their behavior', async (t) => {
  const host = await fixture(t);
  for (const path of ['/map', '/map/', '/map?at=12:15']) assert.equal(await (await fetch(host + path)).text(), 'map entry');
  assert.equal(await (await fetch(host + '/schedule')).text(), 'dashboard entry');
  assert.equal((await fetch(host + '/missing.js')).status, 404);
  assert.equal((await fetch(host + '/schedule', { method: 'POST' })).status, 405);
  assert.equal(await (await fetch(host + '/map', { method: 'HEAD' })).text(), '');
});

test('local backend inherits secrets only in process env and external backend wins', () => {
  const env = { DATABASE_URL: 'postgres://private', PORT: '8080', HOST: '0.0.0.0' };
  const local = backendConfig(env);
  assert.equal(local.apiUrl, 'http://127.0.0.1:8787');
  assert.deepEqual(local.env, { ...env, HOST: '127.0.0.1', PORT: '8787' });
  assert.equal(backendConfig({ ...env, PORT: '8787' }).env.PORT, '8788');
  assert.deepEqual(backendConfig({ ...env, FLOWCAST_API_URL: 'https://api.example' }), { apiUrl: 'https://api.example' });
  assert.deepEqual(backendConfig({}), { apiUrl: '' });
});
