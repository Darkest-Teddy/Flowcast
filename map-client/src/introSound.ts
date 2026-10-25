// Sound for the intro's drop from the sky (App.tsx, INTRO_DROPS), in the spirit of GTA V's
// character switch: a whoosh as the clouds rush past, a whoosh and a low thump on each drop, and a
// longer swoosh for the swoop into the view. All synthesized (introSynth.ts) with the Web Audio API,
// so there are no audio files and nothing to license; this file starts and mutes them.
//
// Browsers only let a page make sound after a click or key press on it. Arriving from the landing
// page's "Open the map" usually counts in Chromium-based browsers, but not always: Brave can block
// it, and a map the landing page prerendered was loaded before the click. The audio starts as the
// loading screen appears; while the browser holds it back, the loading screen's speaker button
// says "Tap for sound" (soundState), and any press on the page wakes it for the drop.
// Off with reduced motion, and when muted (that same button, remembered here).

import { introBus, introMoments, type IntroBus } from './introSynth';

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
  else void audio()?.resume(); // the button press itself lets it start
}

/** 'off' (muted or reduced motion), 'blocked' (the browser is waiting for a press on the page), 'on', or 'starting'. */
export function soundState(): 'off' | 'blocked' | 'on' | 'starting' {
  if (quiet()) return 'off';
  if (!context) return 'starting';
  return context.state === 'running' ? 'on' : 'blocked';
}

const quiet = () => soundMuted() || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let context: AudioContext | null = null;
let bus: IntroBus | null = null;

/** The audio context, made on first use (once a prerendered page is shown: see introSound.prepare). */
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

/** Where the sounds go, made with the context. */
function output(): IntroBus | null {
  const ctx = audio();
  if (!ctx) return null;
  bus ??= introBus(ctx);
  return bus;
}

// Dev handle for checking from the console whether the browser let the intro's audio run.
if (import.meta.env.DEV) Object.assign(window, { __flowcastSound: { state: () => context?.state ?? 'not made', muted: soundMuted } });

/** The intro's sounds, one per moment of the drop. */
export const introSound = {
  /** Starts the audio as early as possible: as the loading screen shows (a prerendered page, once it's shown). */
  prepare: () => {
    if (!(document as Document & { prerendering?: boolean }).prerendering) return void audio();
    document.addEventListener('prerenderingchange', () => void audio(), { once: true });
  },
  /** The clouds rushing past, as the first drop starts. */
  clouds: (ms: number) => play((out) => introMoments.clouds(out, out.ctx.currentTime, ms)),
  /** One drop: air rushing up past the camera (unless the clouds' whoosh already is), then the landing. */
  drop: (ms: number, air = true) => play((out) => introMoments.drop(out, out.ctx.currentTime, ms, air)),
  /** The swoop into the view: up and over, then settling. */
  swoop: (ms: number) => play((out) => introMoments.swoop(out, out.ctx.currentTime, ms)),
};

function play(moment: (out: IntroBus) => void) {
  const out = output();
  if (out) moment(out);
}
