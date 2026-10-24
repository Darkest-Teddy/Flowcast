// Render quality: Quality, Speed and Auto (the perf monitor's "Performance" switch).
//
// - Quality: everything, at the screen's full pixel ratio. What the map always looked like.
// - Speed: a fixed low setting for weaker laptops (pixel ratio 1, fewer rain/snow particles, no lit
//   windows, walkers only near the view, and Mapbox without shadows, trees or footpaths).
// - Auto (default): Quality until the 1% low drops under 45 FPS, then one step down at a time
//   towards Speed; back up a step when there's headroom again. (Everything but the pixel ratio,
//   which only changes on a reload.)
//
// The pixel ratio is the big GPU lever: at 2x a 1920x1080 window renders 3840x2160 (with 4x MSAA)
// every frame. Mapbox GL v3 has no pixelRatio option and reads window.devicePixelRatio live, and
// in interleaved mode deck.gl draws into Mapbox's canvas (MapboxOverlay drops useDevicePixels),
// so the one way to cap both is to cap window.devicePixelRatio before the map is created. CSS and
// the HTML panels are unaffected: the browser lays out with the real ratio. It's set once, at load.

export type QualityMode = 'auto' | 'quality' | 'speed';

export interface QualitySettings {
  /** 0 = full quality ... SPEED_LEVEL = Speed. */
  level: number;
  pixelRatio: number;
  /** Rain and snow particle count, as a share of normal. */
  particles: number;
  litWindows: boolean;
  /** Draw walkers only within this many metres of the view centre (null: all). */
  walkerRadius: number | null;
  /** Mapbox Standard's shadows, 3D trees/objects and footpaths. */
  mapShadows: boolean;
  map3dObjects: boolean;
  mapPedestrianRoads: boolean;
}

const nativeDpr = (() => {
  const own = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio');
  const proto = Object.getOwnPropertyDescriptor(Window.prototype, 'devicePixelRatio');
  const getter = own?.get ?? proto?.get;
  return () => (getter ? (getter.call(window) as number) : 1) || 1;
})();

function levelSettings(level: number): QualitySettings {
  const dpr = nativeDpr();
  switch (level) {
    case 0:
      return { level, pixelRatio: dpr, particles: 1, litWindows: true, walkerRadius: null, mapShadows: true, map3dObjects: true, mapPedestrianRoads: true };
    case 1:
      return { level, pixelRatio: Math.min(dpr, 1.5), particles: 1, litWindows: true, walkerRadius: null, mapShadows: true, map3dObjects: true, mapPedestrianRoads: true };
    case 2:
      return { level, pixelRatio: Math.min(dpr, 1.25), particles: 0.6, litWindows: true, walkerRadius: null, mapShadows: false, map3dObjects: true, mapPedestrianRoads: true };
    default:
      return { level: SPEED_LEVEL, pixelRatio: 1, particles: 0.35, litWindows: false, walkerRadius: 1200, mapShadows: false, map3dObjects: false, mapPedestrianRoads: false };
  }
}
export const SPEED_LEVEL = 3;

const STORAGE_KEY = 'flowcast.quality';
const MODES: QualityMode[] = ['auto', 'quality', 'speed'];

function initialMode(): QualityMode {
  const fromUrl = new URLSearchParams(window.location.search).get('quality');
  if (MODES.includes(fromUrl as QualityMode)) return fromUrl as QualityMode;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (MODES.includes(stored as QualityMode)) return stored as QualityMode;
  } catch {
    // storage blocked: default
  }
  return 'auto';
}

type Listener = () => void;
const listeners = new Set<Listener>();
let mode: QualityMode = initialMode();
let settings: QualitySettings = levelSettings(mode === 'speed' ? SPEED_LEVEL : 0);
let appliers: ((s: QualitySettings) => void)[] = [];

// Cap window.devicePixelRatio (see the header). Installed once, before the map is created.
let dprCap = settings.pixelRatio;
Object.defineProperty(window, 'devicePixelRatio', {
  configurable: true,
  get: () => Math.min(nativeDpr(), dprCap),
});

function emit() {
  for (const l of listeners) l();
}

function apply(next: QualitySettings) {
  // The pixel ratio stays what it was at load: changing it under a running map resized Mapbox's
  // canvas but not deck.gl's view of it, so every model drew at the old scale, out of register
  // with the streets (buildings floating). A new mode's ratio applies after a reload, like MSAA.
  settings = next;
  for (const a of appliers) a(next);
  emit();
}

export const quality = {
  get mode() {
    return mode;
  },
  get settings() {
    return settings;
  },
  /** The pixel ratio actually in use (fixed at load; settings.pixelRatio is the wanted one). */
  get pixelRatio() {
    return dprCap;
  },
  /** For useSyncExternalStore. */
  subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  setMode(next: QualityMode) {
    mode = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage blocked: this session only
    }
    auto.reset();
    apply(levelSettings(next === 'speed' ? SPEED_LEVEL : 0));
  },
  /** Called with the settings now and whenever they change (e.g. the basemap's own switches). */
  onChange(applier: (s: QualitySettings) => void) {
    appliers.push(applier);
    applier(settings);
    return () => {
      appliers = appliers.filter((a) => a !== applier);
    };
  },
  /** Feed every frame (rAF timestamp) so Auto can watch the frame times. */
  frame(now: number) {
    auto.frame(now);
  },
};

// ---------------------------------------------------------------------------------------------
// Auto: watch the 1% low and step the level.
// ---------------------------------------------------------------------------------------------

const LOW_TARGET = 45; // FPS: step down when the 1% low stays under this
const HEADROOM_LOW = 55; // FPS: step back up when the 1% low stays above this...
const HEADROOM_AVG = 57; // ...and the average is near the display's rate
// Judged over back-to-back 2.5 s windows, and only two bad windows in a row step down, so a
// single hitch (a tile burst, a GC) never costs resolution.
const WINDOW_MS = 2500;
const SETTLE_MS = 3000; // after any change, before judging again (resizes and tile reloads hitch)
const RAISE_AFTER_MS = 8000; // headroom needed this long before stepping back up
const STARTUP_MS = 6000; // tiles and models still loading

function createAuto() {
  let deltas: number[] = [];
  let last = 0;
  let started = 0;
  let windowStart = 0;
  let lastChange = 0;
  let lowStreak = 0;
  let headroomSince = 0;
  let raiseBlockedUntil = 0;
  let lastRaise = 0;

  function onePercentLow() {
    const sorted = [...deltas].sort((a, b) => b - a);
    const worst = sorted.slice(0, Math.max(1, Math.ceil(sorted.length * 0.01)));
    return 1000 / (worst.reduce((a, b) => a + b, 0) / worst.length);
  }

  return {
    reset() {
      deltas = [];
      lowStreak = 0;
      headroomSince = 0;
      lastChange = windowStart = performance.now();
    },
    frame(now: number) {
      if (!started) started = windowStart = now;
      const dt = last ? now - last : 0;
      last = now;
      // A background tab or a debugger pause is not a slow frame.
      if (dt > 0 && dt < 1000) deltas.push(dt);
      if (now - windowStart < WINDOW_MS) return;
      const judge = mode === 'auto' && now - started >= STARTUP_MS && now - lastChange >= SETTLE_MS && deltas.length >= 30;
      const low = judge ? onePercentLow() : 0;
      const avg = judge ? 1000 / (deltas.reduce((a, b) => a + b, 0) / deltas.length) : 0;
      deltas = [];
      windowStart = now;
      if (!judge) return;
      const level = settings.level;
      lowStreak = low < LOW_TARGET ? lowStreak + 1 : 0;
      if (lowStreak >= 2 && level < SPEED_LEVEL) {
        // Stepped up and straight back down: don't try going up again for a while.
        if (now - lastRaise < 15000) raiseBlockedUntil = now + 60000;
        lowStreak = 0;
        headroomSince = 0;
        lastChange = now;
        apply(levelSettings(level + 1));
        return;
      }
      if (low >= HEADROOM_LOW && avg >= HEADROOM_AVG && level > 0 && now >= raiseBlockedUntil) {
        headroomSince ||= now;
        if (now - headroomSince >= RAISE_AFTER_MS) {
          headroomSince = 0;
          lastChange = now;
          lastRaise = now;
          apply(levelSettings(level - 1));
        }
      } else {
        headroomSince = 0;
      }
    },
  };
}
const auto = createAuto();

