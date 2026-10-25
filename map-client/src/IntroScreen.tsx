import { useEffect, useState, useSyncExternalStore } from 'react';
import type { LightPreset } from './map/basemap';
import { INTRO_KEY, introSources } from './intro';
import { introSound, setSoundMuted, soundOn } from './introSound';
import { IntroTips } from './IntroTips';
import './intro.css';

/**
 * Startup progress, kept outside React state so each finished download re-renders only the
 * loading screen, not the whole App.
 */
export interface LoadState {
  done: number;
  total: number;
  /** What's still downloading, in the order it was started. */
  pending: string[];
  error: string | null;
  /**
   * Past the downloads: the work in hand (building the day, starting the simulation, lining up the
   * view), where the bar should get to by its end, and roughly how long it takes. The bar eases
   * there over that time on the compositor, so it keeps moving while the work blocks the page.
   */
  stage: { label: string; to: number; ms: number } | null;
  ready: boolean;
}

/** The share of the bar the downloads fill; the stages after them fill the rest. */
const DOWNLOADS_SHARE = 0.3;

export function createLoadProgress() {
  let state: LoadState = { done: 0, total: 0, pending: [], error: null, stage: null, ready: false };
  let epoch = 0; // bumped by reset(), so downloads from a discarded start (StrictMode's first mount) don't count
  const listeners = new Set<() => void>();
  const set = (next: Partial<LoadState>) => {
    state = { ...state, ...next };
    listeners.forEach((l) => l());
  };
  return {
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    get: () => state,
    reset: () => {
      epoch++;
      set({ done: 0, total: 0, pending: [], error: null, stage: null, ready: false });
    },
    /** Counts a startup download; its label shows while it's the oldest one still pending. */
    track<T>(label: string, promise: Promise<T>): Promise<T> {
      const started = epoch;
      set({ total: state.total + 1, pending: [...state.pending, label] });
      const settle = () => {
        if (started !== epoch) return;
        const index = state.pending.indexOf(label);
        set({ done: state.done + 1, pending: state.pending.filter((_, i) => i !== index) });
      };
      promise.then(settle, settle);
      return promise;
    },
    fail: (error: string) => set({ error }),
    stage: (label: string, to: number, ms: number) => set({ stage: { label, to, ms } }),
    finish: () => set({ ready: true }),
  };
}

export type LoadProgress = ReturnType<typeof createLoadProgress>;

/**
 * The still the intro shows: the one the landing page handed over (same file, already decoded), or
 * the one for the preset the map opens in. Read once; a later reload picks by the clock again.
 */
function stillFor(preset: LightPreset): { src: string; srcSet?: string } {
  try {
    const handed = sessionStorage.getItem(INTRO_KEY);
    sessionStorage.removeItem(INTRO_KEY);
    if (handed && /^\/intro\/[a-z]+-\d+\.webp$/.test(handed)) return { src: handed };
  } catch {
    // storage blocked: pick by preset
  }
  return introSources(preset);
}

/**
 * Startup overlay: the intro still (the view from the sky, under the app's IntroSky haze and
 * clouds) while the map loads underneath at the same camera, and a slim progress line over the
 * clouds. When `progress` reports ready the app has the live map lined up with the still, so the
 * overlay simply goes (no fade: it's the same picture) and the camera drops in (App.tsx).
 */
export function IntroScreen({ progress, preset }: { progress: LoadProgress; preset: LightPreset }) {
  const state = useSyncExternalStore(progress.subscribe, progress.get);
  const [still] = useState(() => stillFor(preset));
  // The speaker button: the intro's sound on or off (on by default).
  const [sound, setSound] = useState(soundOn);
  useEffect(() => {
    introSound.prepare();
  }, []);
  // Downloads fill the first part of the bar by count (slightly filled from the start, so it never
  // sits empty); each stage after them eases on to its mark over its expected time.
  const fraction = state.ready ? 1 : state.stage ? state.stage.to : 0.02 + (DOWNLOADS_SHARE - 0.02) * (state.total ? state.done / state.total : 0);
  const easeMs = state.stage && !state.ready ? state.stage.ms : 600;

  if (state.ready && !state.error) return null;
  const step = state.stage?.label ?? state.pending[0] ?? 'Starting up';

  return (
    <div className={`loader intro${state.error ? ' intro-failed' : ''}`} aria-busy={!state.error}>
      {/* The page's static copy (map.html) shows the same still before this mounts; drop it once ours is up. */}
      <img
        className="intro-still"
        {...still}
        sizes="100vw"
        alt=""
        decoding="sync"
        onLoad={() => document.getElementById('intro-static')?.remove()}
        ref={(img) => { if (img?.complete) document.getElementById('intro-static')?.remove(); }}
      />
      {state.error ? (
        <div className="intro-error" role="alert">
          <p>Could not start the map: {state.error}</p>
          <button type="button" onClick={() => window.location.reload()}>Try again</button>
        </div>
      ) : (
        <>
        <button
          type="button"
          className="intro-sound"
          aria-pressed={sound}
          aria-label="Intro sound"
          title={sound ? 'Turn the intro sound off' : 'Turn the intro sound on'}
          onClick={() => { setSoundMuted(sound); setSound(soundOn()); }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" />
            {sound ? <path d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11" /> : <path d="M16 9.5l5 5m0-5l-5 5" />}
          </svg>
        </button>
        <IntroTips />
        <div className="intro-progress">
          <p className="intro-step" aria-live="polite">{step}…</p>
          <div className="intro-bar" role="progressbar" aria-label="Loading the map" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <span style={{ transform: `scaleX(${fraction})`, transitionDuration: `${easeMs}ms` }} />
          </div>
        </div>
        </>
      )}
    </div>
  );
}
