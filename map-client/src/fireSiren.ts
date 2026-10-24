// Optional siren for responding fire apparatus. Off by default (and only ever started from the
// toggle, a user gesture, as browsers require): a synthesized American "wail", a tone sweeping
// between ~650 and ~1500 Hz every few seconds, quieter the further the nearest responding
// apparatus is from the middle of the view. No audio file to load.

export class FireSiren {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private level = 0;

  /** Call from the toggle's click handler, so the audio context may start. */
  enable() {
    if (this.context) { void this.context.resume(); return; }
    const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    const context = new Context();
    const tone = context.createOscillator();
    tone.type = 'sawtooth';
    tone.frequency.value = 1075;
    // The wail: a slow sine sweeping the pitch up and down.
    const sweep = context.createOscillator();
    sweep.frequency.value = 0.22;
    const depth = context.createGain();
    depth.gain.value = 425;
    sweep.connect(depth).connect(tone.frequency);
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2400;
    const gain = context.createGain();
    gain.gain.value = 0;
    tone.connect(filter).connect(gain).connect(context.destination);
    tone.start();
    sweep.start();
    this.context = context;
    this.gain = gain;
  }

  disable() {
    this.set(0);
    void this.context?.suspend();
  }

  /** Volume 0..1, eased so it never clicks. Cheap to call every frame. */
  set(level: number) {
    if (!this.gain || !this.context || Math.abs(level - this.level) < 0.01) return;
    this.level = level;
    this.gain.gain.setTargetAtTime(level * 0.12, this.context.currentTime, 0.15);
  }

  /** Loudness for an apparatus `metres` from the view centre (silent past ~1.5 km). */
  static levelAt(metres: number | null): number {
    return metres === null ? 0 : Math.max(0, Math.min(1, 1 - metres / 1500)) ** 1.5;
  }
}
