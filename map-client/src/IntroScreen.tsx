import { useState, useSyncExternalStore } from 'react';
import type { LightPreset } from './map/basemap';
import { INTRO_KEY, introSources } from './intro';
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
  /** The live map has taken over from the still (App.tsx): only the progress line stays. */
  lifted: boolean;
  ready: boolean;
}

export function createLoadProgress() {
  let state: LoadState = { done: 0, total: 0, pending: [], error: null, lifted: false, ready: false };
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
      set({ done: 0, total: 0, pending: [], error: null, lifted: false, ready: false });
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
    lift: () => set({ lifted: true }),
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

/** The still's current zoom from its slow push-in, so the live map can take over at exactly that framing. */
export function introScale(): number {
  const still = document.querySelector('.intro-still');
  if (!still) return 1;
  const transform = getComputedStyle(still).transform;
  return transform === 'none' ? 1 : new DOMMatrixReadOnly(transform).a;
}

/**
 * Startup overlay: a still of the map at the intro camera, pushing in slowly while the base map
 * loads underneath, and a slim progress line. Once the live map has taken over at the same framing
 * (`lifted`: no fade, it's the same picture) only the line stays, over the view from the sky that
 * the camera rises to (App.tsx, INTRO_RISE), until everything is in.
 */
export function IntroScreen({ progress, preset }: { progress: LoadProgress; preset: LightPreset }) {
  const state = useSyncExternalStore(progress.subscribe, progress.get);
  const [still] = useState(() => stillFor(preset));
  // The bar eases between real counts; start it slightly filled so it never sits empty.
  const fraction = state.ready ? 1 : state.total ? 0.04 + 0.92 * (state.done / state.total) : 0.04;

  if (state.ready && !state.error) return null;
  const step = state.pending[0] ?? (state.total ? 'Placing students' : 'Starting up');

  return (
    <div className={`loader intro${state.error ? ' intro-failed' : ''}`} aria-busy={!state.error}>
      {/* The page's static copy (map.html) shows the same still before this mounts; drop it once ours is up. */}
      {!state.lifted && <img
        className="intro-still"
        {...still}
        sizes="100vw"
        alt=""
        decoding="sync"
        onLoad={() => document.getElementById('intro-static')?.remove()}
        ref={(img) => { if (img?.complete) document.getElementById('intro-static')?.remove(); }}
      />}
      {state.error ? (
        <div className="intro-error" role="alert">
          <p>Could not start the map: {state.error}</p>
          <button type="button" onClick={() => window.location.reload()}>Try again</button>
        </div>
      ) : (
        <div className="intro-progress">
          <p className="intro-step" aria-live="polite">{step}…</p>
          <div className="intro-bar" role="progressbar" aria-label="Loading the map" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
            <span style={{ transform: `scaleX(${fraction})` }} />
          </div>
        </div>
      )}
    </div>
  );
}
