import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { createHostServer, backendConfig } from '../serve.mjs';

async function listen(t, server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, options = {}) {
  return (await site(t, options)).host;
}

/** A built-site stand-in: the two entry pages plus any extra files, and where they live. */
async function site(t, options = {}, files = {}) {
  const root = await mkdtemp(join(tmpdir(), 'flowcast-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'index.html'), 'dashboard entry');
  await writeFile(join(root, 'map.html'), 'map entry');
  for (const [path, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), body);
  }
  return { host: await listen(t, createHostServer({ root, ...options })), root };
}

/** fetch() decodes bodies on its own; this keeps the bytes and headers exactly as sent. */
function raw(url, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    request(url, { method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject).end();
  });
}

const mapData = JSON.stringify({ places: Array.from({ length: 400 }, (_, i) => ({ id: i, name: `Place ${i}`, open: i % 2 === 0 })) });
const staticFiles = {
  'data/places.json': mapData,
  'assets/index-abc123.js': `export const x = ${JSON.stringify('y'.repeat(4000))};`,
  'models/hall.glb': Buffer.alloc(4096, 7),
  'intro/sky.webp': Buffer.alloc(4096, 3),
  'intro/zoom-in.mp3': Buffer.alloc(2048, 1),
  'video/title.webm': Buffer.alloc(2048, 2),
  'site.webmanifest': '{"name":"Flowcast"}',
};

test('API forwards GET, POST, status, Host, Origin and cookies', async (t) => {
  const upstream = await listen(t, createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    res.writeHead(201, { 'Content-Type': 'application/json', 'Set-Cookie': ['session=abc; HttpOnly; SameSite=Lax', 'second=xyz; Path=/'] });
    res.end(JSON.stringify({ method: req.method, url: req.url, host: req.headers.host, origin: req.headers.origin, authorization: req.headers.authorization, cookie: req.headers.cookie, body }));
  }));
  const host = await fixture(t, { apiUrl: upstream });
  for (const path of ['/api/dashboard/auth/config', '/api/dashboard/me', '/api/dashboard/session?x=1', '/api/dashboard?x=1', '/api/ask', '/api/health']) {
    for (const method of ['GET', 'POST']) {
      const body = method === 'POST' ? JSON.stringify({ name: 'A student' }) : undefined;
      const response = await fetch(host + path, { method, headers: { Origin: host, Authorization: 'Bearer test-access-token', Cookie: 'session=abc', 'Content-Type': 'application/json' }, body });
      assert.equal(response.status, 201);
      assert.equal(response.headers.getSetCookie().length, 2);
      assert.deepEqual(await response.json(), { method, url: path, host: new URL(host).host, origin: host, authorization: 'Bearer test-access-token', cookie: 'session=abc', body: body || '' });
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

test('voice session POST forwards body, query and headers and preserves backend responses', async (t) => {
  const body = JSON.stringify({ sdp: 'voice session offer' });
  const apiUrl = await listen(t, createServer(async (req, res) => {
    let received = '';
    for await (const chunk of req) received += chunk;
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/voice/session?mode=live');
    assert.equal(req.headers.host, new URL(host).host);
    assert.equal(req.headers.origin, host);
    assert.equal(req.headers.authorization, 'Bearer test-access-token');
    assert.equal(req.headers.cookie, 'session=abc');
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(received, body);
    const status = Number(req.headers['x-test-status']);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(status === 200 ? { id: 'test-session', sdp: 'voice session answer' } : { error: 'Voice session rejected' }));
  }));
  const host = await fixture(t, { apiUrl });
  for (const status of [200, 403, 502]) {
    const response = await fetch(host + '/api/voice/session?mode=live', {
      method: 'POST', body,
      headers: { Origin: host, Authorization: 'Bearer test-access-token', Cookie: 'session=abc', 'Content-Type': 'application/json', 'X-Test-Status': String(status) },
    });
    assert.equal(response.status, status);
    assert.equal(response.headers.get('content-type'), 'application/json');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), status === 200 ? { id: 'test-session', sdp: 'voice session answer' } : { error: 'Voice session rejected' });
  }
});

test('only the exact voice session POST route reaches the backend', async (t) => {
  let requests = 0;
  const apiUrl = await listen(t, createServer((_req, res) => {
    requests++;
    res.end();
  }));
  const host = await fixture(t, { apiUrl });
  for (const [method, path] of [
    ['GET', '/api/voice/session'], ['PUT', '/api/voice/session'],
    ['POST', '/api/voice'], ['POST', '/api/voice/session/'],
    ['POST', '/api/voice/session/extra'], ['POST', '/api/voice/sessions'],
  ]) {
    const response = await fetch(host + path, { method });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'API route not found' });
  }
  assert.equal(requests, 0);
});

test('API failures are sanitized JSON and unknown routes never reach SPA', async (t) => {
  const stopped = createServer();
  await new Promise((resolve) => stopped.listen(0, '127.0.0.1', resolve));
  const unavailable = `http://127.0.0.1:${stopped.address().port}`;
  await new Promise((resolve) => stopped.close(resolve));
  for (const apiUrl of ['', unavailable, 'not a URL', 'http://user:secret@localhost']) {
    const host = await fixture(t, { apiUrl });
    for (const path of ['/api/dashboard/session', '/api/voice/session']) {
      const response = await fetch(host + path, { method: 'POST', body: '{}' });
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'API unavailable' });
    }
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
  for (const path of ['/api/dashboard/session', '/api/voice/session']) {
    const response = await fetch(host + path, { method: 'POST', body: '{}' });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: 'API unavailable' });
  }
});

test('static map, dashboard fallback, missing assets and HEAD retain their behavior', async (t) => {
  const host = await fixture(t);
  for (const path of ['/map', '/map/', '/map?at=12:15']) assert.equal(await (await fetch(host + path)).text(), 'map entry');
  assert.equal(await (await fetch(host + '/schedule')).text(), 'dashboard entry');
  assert.equal(await (await fetch(host + '/auth/callback?code=test-code')).text(), 'dashboard entry');
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

test('cache policy by kind: fingerprinted assets pinned, HTML and data revalidated, media cached briefly', async (t) => {
  const { host } = await site(t, {}, staticFiles);
  const media = 'public, max-age=3600, stale-while-revalidate=604800';
  for (const [path, cacheControl] of [
    ['/assets/index-abc123.js', 'public, max-age=31536000, immutable'],
    ['/', 'no-cache'], ['/map', 'no-cache'], ['/schedule', 'no-cache'], ['/data/places.json', 'no-cache'],
    ['/models/hall.glb', media], ['/intro/sky.webp', media], ['/intro/zoom-in.mp3', media],
    ['/video/title.webm', media], ['/site.webmanifest', media],
  ]) {
    const response = await raw(host + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['cache-control'], cacheControl, path);
    assert.match(response.headers.etag, /^W\/"[0-9a-f]+-[0-9a-f]+"$/, path);
    assert.ok(response.headers['last-modified'], path);
  }
  assert.equal((await raw(host + '/intro/zoom-in.mp3')).headers['content-type'], 'audio/mpeg');
});

test('matching validators get a body-less 304, changed files a fresh 200', async (t) => {
  const { host, root } = await site(t, {}, staticFiles);
  for (const path of ['/data/places.json', '/models/hall.glb', '/map', '/assets/index-abc123.js']) {
    const first = await raw(host + path);
    const again = await raw(host + path, { 'If-None-Match': first.headers.etag });
    assert.equal(again.status, 304, path);
    assert.equal(again.body.length, 0, path);
    assert.equal(again.headers.etag, first.headers.etag, path);
    assert.equal(again.headers['cache-control'], first.headers['cache-control'], path);
    assert.equal((await raw(host + path, { 'If-None-Match': `"other", ${first.headers.etag}` })).status, 304, path);
    assert.equal((await raw(host + path, { 'If-None-Match': first.headers.etag }, 'HEAD')).status, 304, path);
    assert.equal((await raw(host + path, { 'If-Modified-Since': first.headers['last-modified'] })).status, 304, path);
    assert.equal((await raw(host + path, { 'If-None-Match': '"stale"' })).status, 200, path);
  }
  const before = (await raw(host + '/data/places.json')).headers.etag;
  const later = new Date(Date.now() + 60_000);
  await writeFile(join(root, 'data/places.json'), mapData.replace('Place 0', 'Place zero'));
  await utimes(join(root, 'data/places.json'), later, later);
  const changed = await raw(host + '/data/places.json', { 'If-None-Match': before });
  assert.equal(changed.status, 200);
  assert.notEqual(changed.headers.etag, before);
  assert.match(changed.body.toString(), /Place zero/);
  assert.equal((await raw(host + '/data/places.json', { 'If-Modified-Since': new Date(0).toUTCString() })).status, 200);
});

test('text is served brotli or gzip by Accept-Encoding, with its own ETag and Vary', async (t) => {
  const { host } = await site(t, {}, staticFiles);
  const plain = await raw(host + '/data/places.json');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers.vary, 'Accept-Encoding');
  assert.equal(plain.body.toString(), mapData);
  assert.equal(Number(plain.headers['content-length']), Buffer.byteLength(mapData));

  for (const [acceptEncoding, encoding, decode, suffix] of [
    ['gzip, deflate, br, zstd', 'br', brotliDecompressSync, '-br"'],
    ['gzip, br;q=0', 'gzip', gunzipSync, '-gz"'],
    ['gzip', 'gzip', gunzipSync, '-gz"'],
  ]) {
    for (let i = 0; i < 2; i++) { // second pass is served from the in-memory compressed copy
      const response = await raw(host + '/data/places.json', { 'Accept-Encoding': acceptEncoding });
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-encoding'], encoding);
      assert.equal(response.headers.vary, 'Accept-Encoding');
      assert.equal(response.headers['cache-control'], 'no-cache');
      assert.ok(response.headers.etag.endsWith(suffix));
      assert.equal(Number(response.headers['content-length']), response.body.length);
      assert.ok(response.body.length < Buffer.byteLength(mapData) / 3);
      assert.equal(decode(response.body).toString(), mapData);
      assert.equal((await raw(host + '/data/places.json', { 'Accept-Encoding': acceptEncoding, 'If-None-Match': response.headers.etag })).status, 304);
    }
  }
  const br = await raw(host + '/data/places.json', { 'Accept-Encoding': 'br' });
  // A tag for one encoding never validates another.
  assert.equal((await raw(host + '/data/places.json', { 'Accept-Encoding': 'gzip', 'If-None-Match': br.headers.etag })).status, 200);
  assert.equal((await raw(host + '/data/places.json', { 'If-None-Match': br.headers.etag })).status, 200);

  const head = await raw(host + '/data/places.json', { 'Accept-Encoding': 'br' }, 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(head.headers['content-encoding'], 'br');
  assert.equal(head.headers['content-length'], br.headers['content-length']);

  const js = await raw(host + '/assets/index-abc123.js', { 'Accept-Encoding': 'br' });
  assert.equal(js.headers['content-encoding'], 'br');
  assert.equal(js.headers['cache-control'], 'public, max-age=31536000, immutable');
});

test('images, models, audio, video and tiny text are never compressed', async (t) => {
  const { host } = await site(t, {}, staticFiles);
  for (const path of ['/models/hall.glb', '/intro/sky.webp', '/intro/zoom-in.mp3', '/video/title.webm', '/site.webmanifest', '/map']) {
    const response = await raw(host + path, { 'Accept-Encoding': 'gzip, deflate, br' });
    assert.equal(response.status, 200, path);
    assert.equal(response.headers['content-encoding'], undefined, path);
    assert.doesNotMatch(response.headers.etag, /-(br|gz)"$/, path);
    assert.equal(Number(response.headers['content-length']), response.body.length, path);
  }
  assert.equal((await raw(host + '/models/hall.glb')).headers.vary, undefined);
});
