// Sound for the intro's drop from the sky (App.tsx, INTRO_DROPS), in the spirit of GTA V's
// character switch: a whoosh as the clouds rush past, a whoosh and a low thump on each drop, and a
// longer swoosh for the swoop into the view. All made here with the Web Audio API (filtered noise
// and a falling sine), so there are no audio files and nothing to license.
//
// Browsers only let a page make sound after a click or key press on it. Arriving from the landing
// page's "Open the map" usually counts in Chromium-based browsers; where it doesn't, the context
// stays suspended and the first press on the map wakes it for whatever is left of the intro.
// Off with reduced motion, and when muted (the intro's speaker button, remembered here).

const MUTE_KEY = 'flowcast.sound';

export function soundMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === 'off';
  } catch {
    return false;
  }
}

export function setSoundMuted(muted: boolean) {
  try {
    if (muted) localStorage.setItem(MUTE_KEY, 'off');
    else localStorage.removeItem(MUTE_KEY);
  } catch {
    // storage blocked: muted for this visit only
  }
  if (muted) void context?.suspend();
}

const quiet = () => soundMuted() || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let context: AudioContext | null = null;
let noise: AudioBuffer | null = null;

/** The audio context, made on first use (a prerendered page can't make one before it's shown). */
function audio(): AudioContext | null {
  if (quiet() || typeof AudioContext === 'undefined') return null;
  if (!context) {
    context = new AudioContext();
    const wake = () => {
      if (!quiet()) void context?.resume();
    };
    window.addEventListener('pointerdown', wake, { once: true });
    window.addEventListener('keydown', wake, { once: true });
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

/** Two seconds of white noise, shared by every whoosh. */
function noiseBuffer(ctx: AudioContext): AudioBuffer {
  if (!noise) {
    noise = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noise;
}

/**
 * Air rushing by: noise through a band-pass whose centre sweeps through `hz` (two or more points,
 * spread evenly over the sound), swelling in and dying away, panned across from `pan` to `-pan`.
 */
function whoosh(ms: number, hz: number[], { gain = 0.3, pan = 0.5 } = {}) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const end = now + ms / 1000;
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx);
  source.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 0.9;
  band.frequency.setValueAtTime(hz[0], now);
  hz.slice(1).forEach((f, i) => band.frequency.exponentialRampToValueAtTime(f, now + ((end - now) * (i + 1)) / (hz.length - 1)));
  const level = ctx.createGain();
  level.gain.setValueAtTime(0.0001, now);
  level.gain.exponentialRampToValueAtTime(gain, now + (end - now) * 0.45);
  level.gain.exponentialRampToValueAtTime(0.0001, end);
  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(pan, now);
  panner.pan.linearRampToValueAtTime(-pan, end);
  source.connect(band).connect(level).connect(panner).connect(ctx.destination);
  source.start(now);
  source.stop(end + 0.05);
}

/** A low landing thump: a sine falling fast from ~110 Hz, with a short dull knock on top. */
function thump(gain = 0.55) {
  const ctx = audio();
  if (!ctx) return;
  const now = ctx.currentTime;
  const body = ctx.createOscillator();
  body.type = 'sine';
  body.frequency.setValueAtTime(110, now);
  body.frequency.exponentialRampToValueAtTime(38, now + 0.32);
  const bodyLevel = ctx.createGain();
  bodyLevel.gain.setValueAtTime(gain, now);
  bodyLevel.gain.exponentialRampToValueAtTime(0.0001, now + 0.45);
  body.connect(bodyLevel).connect(ctx.destination);
  body.start(now);
  body.stop(now + 0.5);
  const knock = ctx.createBufferSource();
  knock.buffer = noiseBuffer(ctx);
  const dull = ctx.createBiquadFilter();
  dull.type = 'lowpass';
  dull.frequency.value = 900;
  const knockLevel = ctx.createGain();
  knockLevel.gain.setValueAtTime(gain * 0.5, now);
  knockLevel.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  knock.connect(dull).connect(knockLevel).connect(ctx.destination);
  knock.start(now);
  knock.stop(now + 0.1);
}

/** The intro's sounds, one per moment of the drop. */
export const introSound = {
  /** Wakes the audio as early as possible (the drop's first sound shouldn't wait for it). */
  prepare: () => void audio(),
  /** The clouds rushing past, as the first drop starts. */
  clouds: (ms: number) => whoosh(ms, [2600, 500], { gain: 0.32, pan: 0.6 }),
  /** One drop: air rushing up past the camera (unless the clouds' whoosh already is), then the landing. */
  drop: (ms: number, air = true) => {
    if (air) whoosh(ms, [1400, 260], { gain: 0.28, pan: 0.3 });
    window.setTimeout(() => thump(), ms * 0.85);
  },
  /** The swoop into the view: up and over, then settling. */
  swoop: (ms: number) => whoosh(ms, [380, 2000, 520], { gain: 0.36, pan: 0.7 }),
};
