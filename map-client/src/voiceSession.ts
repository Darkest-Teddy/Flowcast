export type VoicePhase = 'connecting' | 'connected' | 'ending' | 'ended' | 'error';
export interface VoiceCaption {
  role: 'user' | 'assistant';
  text: string;
  start: number;
  end: number;
}

interface VoiceOptions {
  audio: HTMLAudioElement;
  onState: (phase: VoicePhase, message: string) => void;
  onCaptions: (captions: VoiceCaption[]) => void;
  onPlaybackBlocked: () => void;
  context: () => string;
  lookup: (question: string, signal: AbortSignal) => Promise<string>;
  fetch?: typeof fetch;
  microphone?: () => Promise<MediaStream>;
  peer?: () => RTCPeerConnection;
}

/** One explicitly started call. All microphone, network and timer ownership ends here. */
export class VoiceSession {
  private options: VoiceOptions;
  private controller = new AbortController();
  private peer?: RTCPeerConnection;
  private events?: RTCDataChannel;
  private microphone?: MediaStream;
  private ready = false;
  private closing = false;
  private disposed = false;
  private captions: VoiceCaption[] = [];
  private input = '';
  private delegations = new Set<string>();
  private queue: Promise<void> = Promise.resolve();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private connectTimer?: ReturnType<typeof setTimeout>;
  private previousContext = '';

  constructor(options: VoiceOptions) { this.options = options; }

  private later(fn: () => void, ms: number) {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
    return timer;
  }

  private send(event: object) {
    if (this.events?.readyState === 'open') this.events.send(JSON.stringify(event));
  }

  async start() {
    if (this.peer || this.disposed) return;
    this.options.onState('connecting', 'Connecting voice…');
    this.connectTimer = this.later(() => this.fail('Voice took too long to connect. Try again.'), 30_000);
    try {
      const peer = this.options.peer?.() ?? new RTCPeerConnection();
      this.peer = peer;
      peer.addEventListener('track', ({ track }) => {
        if (this.disposed) return;
        this.options.audio.srcObject = new MediaStream([track]);
        void this.options.audio.play().catch(() => {
          if (!this.disposed) this.options.onPlaybackBlocked();
        });
      });
      peer.addEventListener('connectionstatechange', () => {
        if (peer.connectionState === 'failed') this.fail('Voice connection lost. Start again to reconnect.');
        if (peer.connectionState === 'disconnected') {
          this.later(() => {
            if (peer.connectionState === 'disconnected') this.fail('Voice connection lost. Start again to reconnect.');
          }, 5_000);
        }
      });
      const stream = await (this.options.microphone?.() ?? navigator.mediaDevices.getUserMedia({ audio: true }));
      // Permission may resolve after Cancel or a route change.
      if (this.disposed) { stream.getTracks().forEach(track => track.stop()); return; }
      this.microphone = stream;
      for (const track of stream.getAudioTracks()) {
        peer.addTrack(track, stream);
        track.addEventListener('ended', () => this.fail('Microphone disconnected. Check it and start again.'));
      }
      const events = peer.createDataChannel('oai-events');
      this.events = events;
      events.addEventListener('message', ({ data }) => this.receive(data));
      events.addEventListener('close', () => {
        if (!this.disposed) this.fail('Voice disconnected. Start again to reconnect.');
      });
      const offer = await peer.createOffer();
      if (this.disposed) return;
      await peer.setLocalDescription(offer);
      if (peer.iceGatheringState !== 'complete') {
        await new Promise<void>((resolve, reject) => {
          const finish = () => {
            peer.removeEventListener('icegatheringstatechange', changed);
            this.controller.signal.removeEventListener('abort', aborted);
          };
          const changed = () => { if (peer.iceGatheringState === 'complete') { finish(); resolve(); } };
          const aborted = () => { finish(); reject(new Error('Cancelled')); };
          peer.addEventListener('icegatheringstatechange', changed);
          this.controller.signal.addEventListener('abort', aborted, { once: true });
          if (this.controller.signal.aborted) aborted(); else changed();
        });
      }
      if (this.disposed) return;
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error('Missing voice connection offer.');
      const response = await (this.options.fetch ?? fetch)('/api/voice/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sdp }), signal: this.controller.signal,
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        const message = response.status === 503 ? 'Voice is not configured. The server needs an OpenAI key with GPT-Live access.'
          : response.status === 429 ? 'Too many voice sessions. Try again in a minute.'
          : 'Could not connect to GPT-Live. Try again.';
        throw new Error(message);
      }
      if (typeof body?.sdp !== 'string' || !body.sdp) throw new Error('The voice server returned an invalid connection.');
      if (!this.disposed) await peer.setRemoteDescription({ type: 'answer', sdp: body.sdp });
    } catch (error) {
      if (this.disposed) return;
      const name = error instanceof Error ? error.name : '';
      this.fail(name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in browser settings, then try again.'
        : name === 'NotFoundError' ? 'No microphone found. Connect one and try again.'
        : name === 'NotReadableError' ? 'The microphone is unavailable. Check whether another app is using it.'
        : error instanceof Error ? error.message : 'Could not start voice. Try again.');
    }
  }

  private receive(raw: unknown) {
    if (this.disposed || typeof raw !== 'string') return;
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (!event || typeof event !== 'object') return;
    if (event.type === 'session.closed') {
      this.dispose();
      this.options.onState('ended', 'Voice ended.');
      return;
    }
    if (this.closing) return;
    if (event.type === 'session.started') {
      this.ready = true;
      clearTimeout(this.connectTimer);
      this.options.onState('connected', 'Voice connected');
      this.updateContext();
      this.later(() => this.stop(), 10 * 60_000);
    } else if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      if (typeof event.delta !== 'string' || !Number.isFinite(event.start_ms) || !Number.isFinite(event.end_ms)) return;
      const role = event.type === 'session.input_transcript.delta' ? 'user' : 'assistant';
      if (role === 'user') this.input = (this.input + event.delta).slice(-4_000);
      const last = this.captions.at(-1);
      if (last?.role === role && event.start_ms >= last.end && event.start_ms - last.end < 2_000) {
        last.text = (last.text + event.delta).slice(-4_000);
        last.end = event.end_ms;
      } else this.captions.push({ role, text: event.delta, start: event.start_ms, end: event.end_ms });
      this.captions = this.captions.slice(-30);
      this.options.onCaptions(this.captions.map(caption => ({ ...caption })));
    } else if (event.type === 'session.delegation.created' && event.delegation?.target === 'client') {
      const id = event.delegation.id;
      if (typeof id !== 'string' || this.delegations.has(id)) return;
      this.delegations.add(id);
      const question = this.input.trim();
      this.input = '';
      this.queue = this.queue.then(async () => {
        if (this.disposed || this.closing) return;
        let answer = 'Ask the user to repeat their campus question in one short sentence.';
        if (question && question.length <= 300) {
          try { answer = await this.options.lookup(question, this.controller.signal); }
          catch { answer = 'Campus lookup failed. Tell the user and ask them to try again. Do not guess.'; }
        }
        if (this.disposed || this.closing) return;
        // Append events accept at most 500 tokens. Small UTF-8 chunks also bound non-English results.
        const chunks = answer.match(/.{1,160}(?:\s|$)|.{1,160}/gs) ?? [];
        for (const content of chunks) this.send({ type: 'session.commentary.append', delegation_id: id, content });
      });
    } else if (event.type === 'error' || event.type === 'session.error') {
      this.fail('The voice service reported an error. Ended the session; please try again.');
    }
  }

  updateContext() {
    if (!this.ready || this.disposed || this.closing) return;
    const content = this.options.context().slice(0, 400);
    if (content === this.previousContext) return;
    this.previousContext = content;
    this.send({ type: 'session.thinking.append', delegation_id: null, content });
  }

  mute(muted: boolean) {
    this.microphone?.getAudioTracks().forEach(track => { track.enabled = !muted; });
  }

  stop() {
    if (this.disposed || this.closing) return;
    this.closing = true;
    this.controller.abort();
    this.mute(true);
    if (this.ready && this.events?.readyState === 'open') {
      this.options.onState('ending', 'Ending voice…');
      this.send({ type: 'session.close' });
      this.later(() => {
        this.dispose();
        this.options.onState('ended', 'Disconnected. The voice service did not confirm finalization.');
      }, 5_000);
    } else {
      this.dispose();
      this.options.onState('ended', 'Voice cancelled.');
    }
  }

  private fail(message: string) {
    if (this.disposed) return;
    this.dispose();
    this.options.onState('error', message);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.ready && !this.closing) this.send({ type: 'session.close' });
    this.controller.abort();
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.microphone?.getTracks().forEach(track => track.stop());
    this.events?.close();
    this.peer?.close();
    this.options.audio.pause();
    this.options.audio.srcObject = null;
  }
}
