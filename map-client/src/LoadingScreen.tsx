import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import './loading.css';

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
  ready: boolean;
}

export function createLoadProgress() {
  let state: LoadState = { done: 0, total: 0, pending: [], error: null, ready: false };
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
      set({ done: 0, total: 0, pending: [], error: null, ready: false });
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
    finish: () => set({ ready: true }),
  };
}

export type LoadProgress = ReturnType<typeof createLoadProgress>;

// ---- The isometric campus vignette -------------------------------------------------------------

const S = 13; // px per ground unit
// Origin of the SVG's coordinate system inside the 320×240 scene (agents' CSS paths use it too).
const OX = 160;
const OY = 70;
const iso = (x: number, y: number, z = 0): [number, number] => [(x - y) * 0.866 * S, (x + y) * 0.5 * S - z * S];
const pts = (...p: [number, number][]) => p.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

// [x, y, width, depth, height, busy] on a 10×10 ground plate split by streets at 3.5 and 6.5.
type Block = [x: number, y: number, w: number, d: number, h: number, busy: boolean];
const BUILDINGS = ([
  [0.7, 0.7, 2.1, 1.8, 2.2, false],
  [4.2, 0.8, 1.6, 1.6, 3.6, true],
  [7.2, 0.7, 2.1, 2.0, 1.6, false],
  [0.8, 4.2, 1.8, 1.6, 1.4, false],
  [4.3, 4.2, 1.4, 1.5, 4.6, true],
  [7.3, 4.1, 1.8, 1.8, 2.6, true],
  [0.7, 7.2, 2.1, 2.0, 3.0, false],
  [4.2, 7.3, 1.6, 1.8, 1.8, true],
  [7.2, 7.2, 2.1, 2.0, 2.2, false],
] as Block[]).sort((a, b) => a[0] + a[1] - (b[0] + b[1])); // back to front

const STREETS: [[number, number], [number, number]][] = [
  [[3.5, 0], [3.5, 10]],
  [[6.5, 0], [6.5, 10]],
  [[0, 3.5], [10, 3.5]],
  [[0, 6.5], [10, 6.5]],
];

// Walking routes along the streets (ground coordinates); each carries a few students.
const ROUTES: { via: [number, number][]; seconds: number; walkers: number }[] = [
  { via: [[3.5, 0], [3.5, 10]], seconds: 6, walkers: 3 },
  { via: [[0, 6.5], [10, 6.5]], seconds: 7, walkers: 4 },
  { via: [[6.5, 10], [6.5, 3.5], [10, 3.5]], seconds: 6.5, walkers: 3 },
  { via: [[0, 3.5], [3.5, 3.5], [3.5, 6.5], [6.5, 6.5], [6.5, 10]], seconds: 8, walkers: 3 },
  { via: [[10, 6.5], [6.5, 6.5], [6.5, 0]], seconds: 5.5, walkers: 2 },
  { via: [[10, 10.1], [0, 10.1]], seconds: 9, walkers: 3 }, // the Esplanade
];

function routePath(via: [number, number][]) {
  return via.map(([x, y], i) => {
    const [sx, sy] = iso(x, y);
    return `${i ? 'L' : 'M'}${(sx + OX).toFixed(1)} ${(sy + OY).toFixed(1)}`;
  }).join(' ');
}

// The Charles: a band past the plate's southwest edge, with wavy banks.
function riverEdge(y: number, phase: number) {
  const edge: [number, number][] = [];
  for (let x = -1.5; x <= 11.5; x += 0.5) edge.push(iso(x, y + Math.sin(x * 0.9 + phase) * 0.18));
  return edge;
}
const NEAR_BANK = riverEdge(10.6, 0);
const FAR_BANK = riverEdge(12.8, 1.4);
const RIVER = pts(...NEAR_BANK, ...FAR_BANK.reverse());
const CURRENTS = [11.2, 11.8, 12.3].map((y, i) => riverEdge(y, i * 0.8).map(([x, sy]) => `${x.toFixed(1)},${sy.toFixed(1)}`).join(' '));

function Building({ b, index }: { b: Block; index: number }) {
  const [x0, y0, w, d, h, busy] = b;
  const x1 = x0 + w;
  const y1 = y0 + d;
  const top = pts(iso(x0, y0, h), iso(x1, y0, h), iso(x1, y1, h), iso(x0, y1, h));
  const [cx, cy] = iso(x0 + w / 2, y0 + d / 2, h);
  return (
    <g className={`ld-bld${busy ? ' busy' : ''}`} style={{ '--i': index } as CSSProperties}>
      <polygon className="ld-face-l" points={pts(iso(x0, y1), iso(x1, y1), iso(x1, y1, h), iso(x0, y1, h))} />
      <polygon className="ld-face-r" points={pts(iso(x1, y0), iso(x1, y1), iso(x1, y1, h), iso(x1, y0, h))} />
      <polygon className="ld-top" points={top} />
      {busy && (
        <>
          <polygon className="ld-heat" points={top} />
          <ellipse className="ld-ping" cx={cx} cy={cy} rx={w * 0.866 * S * 0.9} ry={w * 0.5 * S * 0.9} />
        </>
      )}
    </g>
  );
}

function Campus() {
  return (
    <div className="ld-scene" aria-hidden="true">
      <svg width="320" height="240" viewBox={`${-OX} ${-OY} 320 240`}>
        <defs>
          <linearGradient id="ld-water" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#173a5e" />
            <stop offset="1" stopColor="#0d2034" />
          </linearGradient>
          <radialGradient id="ld-plate" cx="0.5" cy="0.5" r="0.6">
            <stop offset="0" stopColor="#1b2232" />
            <stop offset="1" stopColor="#11151f" />
          </radialGradient>
        </defs>
        <polygon className="ld-river" points={RIVER} fill="url(#ld-water)" />
        {CURRENTS.map((p, i) => <polyline key={i} className="ld-current" points={p} style={{ '--i': i } as CSSProperties} />)}
        <polygon className="ld-plate" points={pts(iso(0, 0), iso(10, 0), iso(10, 10), iso(0, 10))} fill="url(#ld-plate)" />
        {STREETS.map(([a, b], i) => {
          const [x1, y1] = iso(...a);
          const [x2, y2] = iso(...b);
          return <line key={i} className="ld-street" x1={x1} y1={y1} x2={x2} y2={y2} style={{ '--i': i } as CSSProperties} />;
        })}
        {BUILDINGS.map((b, i) => <Building key={i} b={b} index={i} />)}
      </svg>
      <div className="ld-walkers">
      {ROUTES.flatMap((route, r) =>
        Array.from({ length: route.walkers }, (_, k) => (
          <span
            key={`${r}-${k}`}
            className={`ld-agent${(r + k) % 4 === 0 ? ' warm' : ''}`}
            style={{
              offsetPath: `path('${routePath(route.via)}')`,
              animationDuration: `${route.seconds}s`,
              // Negative delays start everyone mid-walk, spread along the route.
              animationDelay: `${(-route.seconds * k) / route.walkers - r * 0.37}s`,
            }}
          />
        )),
      )}
      </div>
    </div>
  );
}

// ---- The screen ---------------------------------------------------------------------------------

/** Full-screen startup overlay; fades into the map once `progress` reports ready, then unmounts. */
export function LoadingScreen({ progress }: { progress: LoadProgress }) {
  const state = useSyncExternalStore(progress.subscribe, progress.get);
  const [gone, setGone] = useState(false);
  // The bar eases between real counts; start it slightly filled so it never sits empty.
  const fraction = state.ready ? 1 : state.total ? 0.04 + 0.92 * (state.done / state.total) : 0.04;

  useEffect(() => {
    if (!state.ready) return;
    // Matches the .ld-out transition (shorter when motion is reduced); then drop the overlay entirely.
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = setTimeout(() => setGone(true), reduce ? 250 : 1100);
    return () => clearTimeout(timer);
  }, [state.ready]);

  if (gone) return null;
  const step = state.ready ? 'Ready' : state.pending[0] ?? (state.total ? 'Placing students' : 'Starting up');

  return (
    <div className={`loader${state.ready ? ' ld-out' : ''}${state.error ? ' ld-failed' : ''}`} aria-busy={!state.ready && !state.error}>
      <div className="ld-grid" aria-hidden="true" />
      <div className="ld-glow" aria-hidden="true" />
      <div className="ld-stage">
        <Campus />
        <div className="ld-brand">
          <svg className="ld-mark" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" />
            <path d="M6 22c5-10 9 2 14-6s6-4 6-4" pathLength={1} />
          </svg>
          <h1>Flowcast</h1>
        </div>
        <p className="ld-tagline">Boston University · campus crowd forecast</p>
        {state.error ? (
          <div className="ld-error" role="alert">
            <p>Could not start the map: {state.error}</p>
            <button type="button" onClick={() => window.location.reload()}>Try again</button>
          </div>
        ) : (
          <>
            <div className="ld-bar" role="progressbar" aria-label="Loading the campus" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fraction * 100)}>
              <span style={{ transform: `scaleX(${fraction})` }} />
            </div>
            <p className="ld-step" aria-live="polite">
              <span key={step} className="ld-step-text">{step}{state.ready ? '' : '…'}</span>
              {state.total > 0 && <span className="ld-count">{state.done}/{state.total}</span>}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
