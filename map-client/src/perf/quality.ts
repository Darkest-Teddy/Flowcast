// Render quality: Quality, Speed and Auto (the perf monitor's "Performance" switch).
//
// What limits this app is the number of WebGL calls per frame, not shader work: Chrome runs every
// call through one GPU-process thread (~2 us each), and Mapbox Standard alone makes ~10,000 a frame
// with shadows and 3D trees on. So the steps below drop the features that cost the most calls, and
// never the resolution, which costs little once MSAA is off on high-density screens.
//
// - Quality: everything (shadows, 3D trees, footpaths, lit windows) at the screen's pixel ratio.
// - Auto (default): starts where it last settled on this machine and steps one level at a time:
//   0 everything, 1 no shadows, 2 no footpaths, 3 no 3D trees and walkers only near the view
//   (still at the screen's pixel ratio, lit windows kept). Down when the 1% low stays under
//   45 FPS, back up with headroom.
// - Speed: level 3 plus pixel ratio 1, no MSAA and no lit windows, for weak laptops.
//
// MSAA: 4x multisampling at a 2x pixel ratio is 16 samples per CSS pixel and doubled this app's
// GPU time per frame, while the pixel density already smooths the edges. It's on below 1.75x only.
//
// The pixel ratio is capped by overriding window.devicePixelRatio before the map is created:
// Mapbox GL v3 has no pixelRatio option and reads it live, and in interleaved mode deck.gl draws
// into Mapbox's canvas. CSS and the HTML panels are unaffected. It's set once, at load.

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

function levelSettings(level: number, speedMode = mode === 'speed'): QualitySettings {
  // Only Speed mode lowers the resolution (and only from the next load); Auto keeps it.
  const pixelRatio = speedMode ? 1 : nativeDpr();
  switch (speedMode ? SPEED_LEVEL : level) {
    case 0:
      return { level: 0, pixelRatio, particles: 1, litWindows: true, walkerRadius: null, mapShadows: true, map3dObjects: true, mapPedestrianRoads: true };
    case 1:
      return { level: 1, pixelRatio, particles: 1, litWindows: true, walkerRadius: null, mapShadows: false, map3dObjects: true, mapPedestrianRoads: true };
    case 2:
      return { level: 2, pixelRatio, particles: 0.6, litWindows: true, walkerRadius: null, mapShadows: false, map3dObjects: true, mapPedestrianRoads: false };
    default:
      // Lit windows stay: they're two draws, and most of the night view.
      return { level: SPEED_LEVEL, pixelRatio, particles: 0.35, litWindows: !speedMode, walkerRadius: 1200, mapShadows: false, map3dObjects: false, mapPedestrianRoads: false };
  }
}
export const SPEED_LEVEL = 3;

const STORAGE_KEY = 'flowcast.quality';
// Where Auto last settled on this machine, so the next load starts there instead of at the top.
const AUTO_LEVEL_KEY = 'flowcast.autoLevel';

function storedAutoLevel(): number {
  try {
    const level = Number(localStorage.getItem(AUTO_LEVEL_KEY));
    return Number.isInteger(level) && level >= 0 && level <= 3 ? level : 0;
  } catch {
    return 0;
  }
}
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
let settings: QualitySettings = levelSettings(mode === 'auto' ? storedAutoLevel() : 0);
let appliers: ((s: QualitySettings) => void)[] = [];

// Cap window.devicePixelRatio (see the header). Installed once, before the map is created.
const dprParam = Number(new URLSearchParams(window.location.search).get('dpr'));
let dprCap = dprParam > 0 ? dprParam : settings.pixelRatio;
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
  if (mode === 'auto') {
    try {
      localStorage.setItem(AUTO_LEVEL_KEY, String(next.level));
    } catch {
      // storage blocked: start from the top next time
    }
  }
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
  /** 4x MSAA on the map's canvas (only settable when the map is created). */
  get msaa() {
    const q = new URLSearchParams(window.location.search).get('msaa');
    return q === null ? mode !== 'speed' && dprCap < 1.75 : q !== '0';
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
    apply(levelSettings(next === 'auto' ? storedAutoLevel() : 0, next === 'speed'));
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

