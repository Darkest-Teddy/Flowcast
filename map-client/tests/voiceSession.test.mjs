import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VoiceSession } from '../src/voiceSession.ts';

class Channel extends EventTarget {
  readyState = 'open';
  sent = [];
  send(value) { this.sent.push(JSON.parse(value)); }
  close() { this.readyState = 'closed'; this.dispatchEvent(new Event('close')); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
}
class Peer extends EventTarget {
  channel = new Channel();
  iceGatheringState = 'complete';
  connectionState = 'new';
  tracks = [];
  addTrack(track) { this.tracks.push(track); }
  createDataChannel(label) { assert.equal(label, 'oai-events'); return this.channel; }
  async createOffer() { return { type: 'offer', sdp: 'offer' }; }
  async setLocalDescription(offer) { this.localDescription = offer; }
  async setRemoteDescription(answer) { this.remoteDescription = answer; }
  close() { this.connectionState = 'closed'; }
}
function fixture(t, overrides = {}) {
  const peer = new Peer();
  const track = Object.assign(new EventTarget(), { enabled: true, stopped: false, stop() { this.stopped = true; } });
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  const audio = { srcObject: null, paused: false, pause() { this.paused = true; }, async play() {} };
  const states = [], captions = [], lookups = [], requests = [];
  const call = new VoiceSession({
    audio, peer: () => peer, microphone: async () => stream,
    onState: (...state) => states.push(state), onCaptions: value => captions.push(value),
    onPlaybackBlocked: () => {}, context: () => 'Map: Monday 12:00, Charles River. Modeled crowds.',
    lookup: async (question, signal) => { lookups.push({ question, signal }); return 'Mugar is modeled at 20% capacity.'; },
    fetch: async (url, options) => { requests.push({ url, options }); return Response.json({ id: 'live_1', sdp: 'answer' }); },
    ...overrides,
  });
  t.after(() => call.dispose());
  const receive = value => peer.channel.receive(value);
  const transcript = text => receive({ type: 'session.input_transcript.delta', delta: text, start_ms: 0, end_ms: 100 });
  const delegate = id => receive({ type: 'session.delegation.created', delegation: { id, target: 'client' } });
  return { call, peer, track, stream, audio, states, captions, lookups, requests, receive, transcript, delegate };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('negotiates through the app server and waits for session.started', async t => {
  const f = fixture(t);
  await f.call.start();
  assert.equal(f.requests[0].url, '/api/voice/session');
  assert.deepEqual(JSON.parse(f.requests[0].options.body), { sdp: 'offer' });
  assert.deepEqual(f.peer.remoteDescription, { type: 'answer', sdp: 'answer' });
  assert.equal(f.states.at(-1)[0], 'connecting');
  assert.deepEqual(f.peer.channel.sent, []);
  f.receive({ type: 'session.started' });
  assert.equal(f.states.at(-1)[0], 'connected');
  assert.equal(f.peer.channel.sent[0].type, 'session.thinking.append');
  f.call.updateContext();
  assert.equal(f.peer.channel.sent.length, 1, 'unchanged UI context is not repeated');
});

test('permission rejection is actionable and releases the peer', async t => {
  const f = fixture(t, { microphone: async () => { throw new DOMException('denied', 'NotAllowedError'); } });
  await f.call.start();
  assert.match(f.states.at(-1)[1], /Microphone access was denied/);
  assert.equal(f.peer.connectionState, 'closed');
  assert.equal(f.requests.length, 0);
});

test('cancelling while microphone permission is pending stops late tracks and creates no paid session', async t => {
  let resolve;
  const f = fixture(t, { microphone: () => new Promise(r => { resolve = r; }) });
  const start = f.call.start();
  f.call.stop();
  resolve(f.stream);
  await start;
  assert.equal(f.track.stopped, true);
  assert.equal(f.requests.length, 0);
  assert.equal(f.peer.connectionState, 'closed');
});

test('mute disables microphone tracks, graceful stop keeps transport until session.closed', async t => {
  const f = fixture(t);
  await f.call.start(); f.receive({ type: 'session.started' });
  f.call.mute(true); assert.equal(f.track.enabled, false);
  f.call.mute(false); assert.equal(f.track.enabled, true);
  f.call.stop();
  assert.equal(f.track.enabled, false);
  assert.equal(f.peer.channel.sent.at(-1).type, 'session.close');
  assert.equal(f.peer.channel.readyState, 'open');
  assert.equal(f.states.at(-1)[0], 'ending');
  f.receive({ type: 'session.closed' });
  assert.equal(f.states.at(-1)[0], 'ended');
  assert.equal(f.track.stopped, true);
  assert.equal(f.peer.connectionState, 'closed');
  assert.equal(f.audio.paused, true);
});

test('delegation uses collected speech, returns the result to the matching ID, and deduplicates requests', async t => {
  const f = fixture(t);
  await f.call.start(); f.receive({ type: 'session.started' });
  f.transcript('How busy is ');
  f.receive({ type: 'session.input_transcript.delta', delta: 'Mugar?', start_ms: 100, end_ms: 200 });
  f.delegate('d1'); f.delegate('d1');
  await tick();
  assert.deepEqual(f.lookups.map(x => x.question), ['How busy is Mugar?']);
  assert.equal(f.captions.at(-1)[0].text, 'How busy is Mugar?');
  const reply = f.peer.channel.sent.at(-1);
  assert.equal(reply.type, 'session.commentary.append');
  assert.equal(reply.delegation_id, 'd1');
  assert.match(reply.content, /modeled/);
  f.delegate('d2'); await tick();
  assert.equal(f.lookups.length, 1, 'old speech is not submitted again');
  assert.match(f.peer.channel.sent.at(-1).content, /repeat/);
});

test('stop aborts pending campus lookup and suppresses late results', async t => {
  let resolve, signal;
  const f = fixture(t, { lookup: (_question, s) => { signal = s; return new Promise(r => { resolve = r; }); } });
  await f.call.start(); f.receive({ type: 'session.started' });
  f.transcript('Where is Mugar?'); f.delegate('d1'); await tick();
  f.call.stop();
  assert.equal(signal.aborted, true);
  resolve('Late answer'); await tick();
  assert.equal(f.peer.channel.sent.some(e => e.type === 'session.commentary.append'), false);
});

test('failed negotiation and upstream errors release microphone and return a safe error', async t => {
  for (const status of [429, 502, 503]) {
    const f = fixture(t, { fetch: async () => Response.json({ error: 'sensitive upstream body' }, { status }) });
    await f.call.start();
    assert.equal(f.states.at(-1)[0], 'error');
    assert.doesNotMatch(f.states.at(-1)[1], /sensitive/);
    assert.equal(f.track.stopped, true);
    assert.equal(f.peer.connectionState, 'closed');
  }
});

test('connection failure and navigation disposal release microphone and abort requests', async t => {
  const f = fixture(t);
  await f.call.start(); f.receive({ type: 'session.started' });
  f.peer.connectionState = 'failed';
  f.peer.dispatchEvent(new Event('connectionstatechange'));
  assert.equal(f.states.at(-1)[0], 'error');
  assert.equal(f.track.stopped, true);
  assert.equal(f.requests[0].options.signal.aborted, true);
  const g = fixture(t);
  await g.call.start(); g.receive({ type: 'session.started' });
  g.call.dispose();
  assert.equal(g.peer.channel.sent.at(-1).type, 'session.close');
  assert.equal(g.track.stopped, true);
});

test('cancel during ICE gathering releases the microphone without posting an offer', async t => {
  const f = fixture(t);
  f.peer.iceGatheringState = 'gathering';
  const pending = f.call.start();
  await tick();
  f.call.stop();
  await pending;
  assert.equal(f.track.stopped, true);
  assert.equal(f.requests.length, 0);
});

test('long multilingual lookup results are preserved in bounded context appends', async t => {
  const answer = '図書館への徒歩ルート。 '.repeat(100);
  const f = fixture(t, { lookup: async () => answer });
  await f.call.start(); f.receive({ type: 'session.started' });
  f.transcript('Where is the library?'); f.delegate('d1'); await tick();
  const chunks = f.peer.channel.sent.filter(e => e.type === 'session.commentary.append');
  assert.equal(chunks.map(c => c.content).join(''), answer);
  assert.ok(chunks.every(c => Buffer.byteLength(c.content, 'utf8') < 500));
});

function audioFixture(t, failure) {
  const contexts = [];
  const descriptors = ['AudioContext', 'MediaStream'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  globalThis.MediaStream = class {
    constructor(tracks) { this.tracks = tracks; }
    getTracks() { return this.tracks; }
    getAudioTracks() { return this.tracks; }
  };
  globalThis.AudioContext = class {
    state = failure === 'resume' ? 'suspended' : 'running';
    nodes = [];
    closed = 0;
    constructor() {
      if (failure === 'constructor') throw new Error('Audio unavailable');
      contexts.push(this);
    }
    resume() { return Promise.reject(new Error('Resume blocked')); }
    close() { this.closed++; this.state = 'closed'; return Promise.resolve(); }
    createMediaStreamSource(stream) {
      const node = { stream, connections: [], disconnected: false,
        connect(target) { this.connections.push(target); },
        disconnect() { this.disconnected = true; },
      };
      this.nodes.push(node);
      return node;
    }
    createAnalyser() {
      if (failure === 'analyser') throw new Error('Analysis unavailable');
      const node = { fftSize: 0, value: 0.25, disconnected: false,
        getFloatTimeDomainData(samples) {
          if (failure === 'sample') throw new Error('Sampling failed');
          samples.fill(this.value);
        },
        disconnect() { this.disconnected = true; },
      };
      this.nodes.push(node);
      return node;
    }
  };
  t.mock.timers.enable({ apis: ['setInterval'] });
  const levels = [];
  const f = fixture(t, { onAudioLevel: value => {
    if (failure === 'callback') throw new Error('UI failed');
    levels.push(value);
  } });
  function remote() {
    const track = Object.assign(new EventTarget(), {
      enabled: true, muted: false, readyState: 'live', stopped: false,
      stop() { this.stopped = true; this.readyState = 'ended'; },
    });
    const event = new Event('track');
    Object.defineProperty(event, 'track', { value: track });
    f.peer.dispatchEvent(event);
    return track;
  }
  return { ...f, contexts, levels, remote };
}

test('samples actual microphone and remote amplitudes at 20fps without speaker loopback', async t => {
  const f = audioFixture(t);
  await f.call.start();
  const remote = f.remote();
  const context = f.contexts[0];
  const [inputSource, inputAnalyser, outputSource, outputAnalyser] = context.nodes;
  assert.deepEqual(inputSource.connections, [inputAnalyser]);
  assert.deepEqual(outputSource.connections, [outputAnalyser]);
  assert.equal(inputSource.stream, f.stream);
  assert.equal(outputSource.stream, f.audio.srcObject);
  outputAnalyser.value = 0.5;
  t.mock.timers.tick(49);
  assert.equal(f.levels.length, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(f.levels.at(-1), { input: 0.25, output: 0.5 });
  f.call.mute(true);
  outputAnalyser.value = 2;
  t.mock.timers.tick(50);
  assert.deepEqual(f.levels.at(-1), { input: 0, output: 1 });
  f.call.mute(false);
  inputAnalyser.value = 0;
  remote.readyState = 'ended';
  t.mock.timers.tick(50);
  assert.deepEqual(f.levels.at(-1), { input: 0, output: 0 });
  inputAnalyser.value = NaN;
  t.mock.timers.tick(50);
  assert.deepEqual(f.levels.at(-1), { input: 0, output: 0 });
  f.call.dispose();
  assert.equal(context.closed, 1);
  assert.ok(context.nodes.every(node => node.disconnected));
  assert.equal(remote.stopped, true);
  const count = f.levels.length;
  t.mock.timers.tick(500);
  assert.equal(f.levels.length, count);
  f.call.dispose();
  assert.equal(context.closed, 1);
});

test('replacing remote audio disconnects old analysis and disposal stops late tracks', async t => {
  const f = audioFixture(t);
  await f.call.start();
  const first = f.remote();
  const context = f.contexts[0];
  const oldNodes = context.nodes.slice(2);
  const second = f.remote();
  assert.equal(first.stopped, true);
  assert.ok(oldNodes.every(node => node.disconnected));
  assert.equal(f.contexts.length, 1);
  f.call.dispose();
  assert.equal(second.stopped, true);
  const count = context.nodes.length;
  assert.equal(f.remote().stopped, true);
  assert.equal(context.nodes.length, count);
  assert.equal(f.audio.srcObject, null);
});

for (const ending of ['cancel', 'failure', 'unmount', 'graceful']) {
  test(`${ending} releases audio analysis and suppresses future samples`, async t => {
    const f = audioFixture(t);
    await f.call.start();
    if (ending === 'graceful') f.receive({ type: 'session.started' });
    if (ending === 'failure') f.receive({ type: 'session.error' });
    else if (ending === 'unmount') f.call.dispose();
    else f.call.stop();
    const context = f.contexts[0];
    assert.equal(context.closed, 1);
    assert.ok(context.nodes.every(node => node.disconnected));
    assert.deepEqual(f.levels.at(-1), { input: 0, output: 0 });
    const count = f.levels.length;
    f.remote();
    t.mock.timers.tick(100);
    assert.equal(f.levels.length, count);
    assert.equal(f.contexts.length, 1);
  });
}

for (const failure of ['constructor', 'analyser', 'resume', 'sample', 'callback']) {
  test(`visualization ${failure} failure does not fail voice`, async t => {
    const f = audioFixture(t, failure);
    await f.call.start();
    f.receive({ type: 'session.started' });
    t.mock.timers.tick(50);
    await tick();
    assert.equal(f.states.at(-1)[0], 'connected');
    assert.equal(f.track.stopped, false);
    assert.equal(f.peer.channel.readyState, 'open');
    for (const context of f.contexts) {
      assert.equal(context.closed, 1);
      assert.ok(context.nodes.every(node => node.disconnected));
    }
  });
}

test('optional callback works without AudioContext and absent callback creates no context', async t => {
  const f = audioFixture(t);
  const g = fixture(t);
  await g.call.start();
  assert.equal(f.contexts.length, 0);
  delete globalThis.AudioContext;
  await f.call.start();
  f.receive({ type: 'session.started' });
  assert.equal(f.states.at(-1)[0], 'connected');
  f.call.dispose();
  assert.deepEqual(f.levels.at(-1), { input: 0, output: 0 });
});
