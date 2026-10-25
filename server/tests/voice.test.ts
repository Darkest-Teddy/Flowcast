import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp, type AppOptions } from '../src/app';
import type { CampusModel } from '../src/campus';
import { createVoice, VOICE_INSTRUCTIONS } from '../src/voice';

const offer = 'v=0\r\ns=offer\r\n';
const answer = { id: 'live_opaque-id', sdp: 'v=0\r\ns=answer\r\n' };

async function withApp(overrides: Partial<AppOptions>, check: (base: string) => Promise<void>) {
  const campus = { locations: [], privateBundle: false } as unknown as CampusModel;
  const app = createApp({ campus, keyConfigured: true, model: 'test', ask: async () => { throw new Error('unused'); }, voice: async () => answer, ...overrides });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  try { await check(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
}

const post = (base: string, body: unknown = { sdp: offer }, headers = {}) => fetch(`${base}/api/voice/session`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

test('voice accepts an SDP offer without auth or simulation readiness, exposes availability, and never caches', async () => {
  await withApp({ voice: async (sdp, signal) => { assert.equal(sdp, offer); assert.equal(signal.aborted, false); return answer; } }, async (base) => {
    const response = await post(base);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), answer);
    assert.equal((await (await fetch(`${base}/api/health`)).json()).voiceAvailable, true);
  });
});

test('voice validates input before calling upstream', async () => {
  let calls = 0;
  await withApp({ voice: async () => { calls++; return answer; } }, async (base) => {
    for (const body of [null, {}, { sdp: 3 }, { sdp: '' }, { sdp: ' \n' }, { sdp: 'a'.repeat(65_537) }, { sdp: offer, session: { model: 'other' } }]) {
      assert.equal((await post(base, body)).status, 400);
    }
    const malformed = await fetch(`${base}/api/voice/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal((await post(base, { sdp: 'a'.repeat(140_000) })).status, 413);
    assert.equal(calls, 0);
  });
});

test('voice is unavailable without a key or implementation', async () => {
  for (const options of [{ keyConfigured: false }, { voice: undefined }]) {
    await withApp(options, async (base) => {
      assert.equal((await post(base)).status, 503);
      assert.equal((await (await fetch(`${base}/api/health`)).json()).voiceAvailable, false);
    });
  }
});

test('voice enforces per-client and global request caps', async () => {
  await withApp({ perMinute: 1 }, async (base) => {
    assert.equal((await post(base)).status, 200);
    assert.equal((await post(base)).status, 429);
  });
  let calls = 0;
  await withApp({ perMinute: 10, perHour: 1, trustProxyHops: 1, voice: async () => { calls++; return answer; } }, async (base) => {
    assert.equal((await post(base, { sdp: offer }, { 'X-Forwarded-For': '192.0.2.1' })).status, 200);
    assert.equal((await post(base, { sdp: offer }, { 'X-Forwarded-For': '192.0.2.2' })).status, 429);
    assert.equal(calls, 1);
  });
});

test('voice shares Ask limits and bounds tracked clients', async () => {
  const campus = { locations: [{ campus: 'charles-river' }], ready: () => ({}) } as unknown as CampusModel;
  await withApp({ campus, perMinute: 1 }, async (base) => {
    assert.equal((await post(base)).status, 200);
    const response = await fetch(`${base}/api/ask`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'Where is Mugar?', weekday: 0, time: 3600, campus: 'charles-river' }),
    });
    assert.equal(response.status, 429);
  });
  await withApp({ maxClients: 1, trustProxyHops: 1 }, async (base) => {
    assert.equal((await post(base, { sdp: offer }, { 'X-Forwarded-For': '192.0.2.1' })).status, 200);
    assert.equal((await post(base, { sdp: offer }, { 'X-Forwarded-For': '192.0.2.2' })).status, 429);
  });
});

test('disconnecting the HTTP client aborts voice initialization', async () => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let cancelled!: () => void;
  const stopped = new Promise<void>((resolve) => { cancelled = resolve; });
  await withApp({ voice: (_sdp, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { cancelled(); reject(signal.reason); }, { once: true });
    started();
  }) }, async (base) => {
    const controller = new AbortController();
    const pending = fetch(`${base}/api/voice/session`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sdp: offer }), signal: controller.signal,
    }).catch(() => undefined);
    await running;
    controller.abort();
    await stopped;
    await pending;
  });
});

test('voice sanitizes failures and aborts timed-out upstream work', async () => {
  await withApp({ voice: async () => { throw new Error('secret-key SDP private payload'); } }, async (base) => {
    const response = await post(base);
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /secret|SDP|private/);
  });
  let aborted = false;
  await withApp({ timeoutMs: 10, voice: (_sdp, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
  }) }, async (base) => {
    const response = await post(base);
    assert.equal(response.status, 504);
    assert.equal(aborted, true);
  });
});

test('Live transport sends server-owned configuration and normalizes only documented fields', async () => {
  const signal = new AbortController().signal;
  for (const model of [undefined, 'test-voice-model']) {
    const request: typeof fetch = async (url, init) => {
      assert.equal(url, 'https://api.openai.com/v1/live/sessions');
      assert.equal(init?.method, 'POST');
      assert.equal(init?.redirect, 'error');
      assert.equal(init?.signal, signal);
      assert.deepEqual(init?.headers, { Authorization: 'Bearer test-key', 'Content-Type': 'application/json' });
      assert.deepEqual(JSON.parse(String(init?.body)), {
        session: { model: model ?? 'gpt-live-1', instructions: VOICE_INSTRUCTIONS, delegation: { type: 'client' }, store: false },
        transport: { type: 'webrtc', sdp: offer },
      });
      return Response.json({ session: { id: answer.id, secret: 'do-not-return' }, transport: { type: 'webrtc', sdp: answer.sdp }, extra: 'do-not-return' }, { status: 201 });
    };
    assert.deepEqual(await createVoice('test-key', model, request)(offer, signal), answer);
  }
});

test('Live transport rejects errors, invalid JSON and malformed upstream contracts without details', async () => {
  const responses = [
    () => new Response('test-key upstream details', { status: 401 }),
    () => new Response('busy', { status: 429 }),
    () => new Response('broken', { status: 500 }),
    () => new Response('not JSON'),
    ...[{}, answer, { session: { id: '' }, transport: { type: 'webrtc', sdp: answer.sdp } },
      { session: { id: answer.id }, transport: { type: 'websocket', sdp: answer.sdp } },
      { session: { id: answer.id }, transport: { type: 'webrtc', sdp: ' ' } }].map((body) => () => Response.json(body)),
    () => { throw new Error('test-key network details'); },
  ];
  for (const response of responses) {
    await assert.rejects(createVoice('test-key', undefined, async () => response())(offer, new AbortController().signal), { message: 'Voice session creation failed' });
  }
  await assert.rejects(createVoice('', undefined, async () => { assert.fail('must not fetch'); })(offer, new AbortController().signal), { message: 'Voice is not configured' });
});
