// Camera moves on top of the Basemap: a slow orbit ("spin"), rotate/tilt steps, view presets and
// a looping tour of campus landmarks. Anything the user does to the map itself (drag, scroll,
// pinch, rotate, tilt) stops the spin and the tour; the app's own flyTo calls don't.
import type { Basemap, CameraMove, UserInteraction } from './basemap';

export type ViewPreset = 'top' | '3d' | 'street';

export interface Landmark {
  id: string;
  short: string;
  position: [number, number];
}

export interface CameraControllerState {
  spinning: boolean;
  touring: boolean;
  /** The preset last chosen, until the user tilts or moves the map. */
  preset: ViewPreset | null;
  /** Tour: the landmark being visited. */
  landmark: string | null;
}

const SPIN_DEG_PER_S = 5;
const SPIN_REDUCED_DEG_PER_S = 2;
const TOUR_DEG_PER_S = 3;
const TOUR_REDUCED_DEG_PER_S = 1.5;
/** Seconds to reach full orbit speed, so starting and resuming never jerk. */
const SPIN_RAMP_S = 1.2;
const ROTATE_STEP = 45;
/** Holding a rotate button: after its 45 degree step, the view keeps turning at this rate. */
const TURN_DEG_PER_S = 60;
const TURN_REDUCED_DEG_PER_S = 20;
const TILT_STEP = 10;
const STEP_MS = 650;
const PRESET_MS = 1600;
const TOUR_FLIGHT_MS = 3200;
const TOUR_DWELL_MS = 4000;
const TOUR_VIEW = { zoom: 17.4, pitch: 62 };

export const PRESETS: Record<ViewPreset, { label: string; pitch: number; zoom: (zoom: number) => number }> = {
  // Straight down; pulled back a little if coming from street level so the campus fits.
  top: { label: "Bird's-eye", pitch: 0, zoom: (z) => Math.min(z, 16.5) },
  // The app's default shot (basemap.ts DEFAULT_VIEW.pitch).
  '3d': { label: '3D', pitch: 58, zoom: (z) => Math.min(Math.max(z, 15), 17) },
  street: { label: 'Street level', pitch: 78, zoom: () => 18.5 },
};

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Spin on load unless the user prefers reduced motion or the URL says ?spin=0. */
export function shouldAutoSpin(): boolean {
  return !prefersReducedMotion() && new URLSearchParams(window.location.search).get('spin') !== '0';
}

// Recognisable stops first; then one of each kind, so a tour isn't five dorms.
const FAVOURITES = ['CDS', 'Mugar Library', 'GSU', 'Questrom', 'Agganis Arena', 'Warren Towers', 'StuVi', 'Med Library', 'SPH', 'Instructional Bldg', 'Fenway Center', 'Hawes'];
const MAX_TOUR_STOPS = 6;

/** A handful of a campus's locations (one per building), in an order that makes short hops. */
export function pickLandmarks(locations: (Landmark & { building?: string; kind?: string })[]): Landmark[] {
  const byBuilding = new Map<string, Landmark & { kind?: string }>();
  for (const l of locations) if (!byBuilding.has(l.building ?? l.id)) byBuilding.set(l.building ?? l.id, l);
  const pool = [...byBuilding.values()];
  const rank = (l: Landmark) => (FAVOURITES.includes(l.short) ? FAVOURITES.indexOf(l.short) : FAVOURITES.length);
  pool.sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  const chosen: typeof pool = [];
  const kinds = new Set<string | undefined>();
  for (const l of pool) {
    if (chosen.length >= MAX_TOUR_STOPS) break;
    if (rank(l) < FAVOURITES.length || !kinds.has(l.kind)) {
      chosen.push(l);
      kinds.add(l.kind);
    }
  }
  for (const l of pool) if (chosen.length < MAX_TOUR_STOPS && !chosen.includes(l)) chosen.push(l);

  // Greedy nearest neighbour from the east end (Kenmore on the Charles River Campus).
  const remaining = [...chosen].sort((a, b) => b.position[0] - a.position[0]);
  const route: Landmark[] = remaining.length ? [remaining.shift()!] : [];
  while (remaining.length) {
    const [x, y] = route[route.length - 1].position;
    let best = 0;
    remaining.forEach((l, i) => {
      const d = (l.position[0] - x) ** 2 + (l.position[1] - y) ** 2;
      const bd = (remaining[best].position[0] - x) ** 2 + (remaining[best].position[1] - y) ** 2;
      if (d < bd) best = i;
    });
    route.push(remaining.splice(best, 1)[0]);
  }
  return route.map(({ id, short, position }) => ({ id, short, position }));
}

export class CameraController {
  readonly reducedMotion = prefersReducedMotion();
  private state: CameraControllerState = { spinning: false, touring: false, preset: null, landmark: null };
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private frame = 0;
  private lastFrame = 0;
  private ramp = 0; // 0..1 towards full orbit speed
  private held = false; // a pointer is down on the map
  private turnDir = 0; // a rotate button held down: -1 left, 1 right
  private autoStartTimer = 0;
  // The target of a rotate/tilt step still animating, so repeated presses add up.
  private pending: { bearing?: number; pitch?: number; until: number } | null = null;

  private landmarks: Landmark[] = [];
  private landmarksKey = '';
  private tourIndex = 0;
  private tourPhase: 'fly' | 'dwell' = 'fly';
  private flightIssued = false;
  private dwellLeft = 0;

  constructor(private readonly map: Basemap) {
    this.unsubscribe = map.onUserInteraction((kind) => this.onUser(kind));
  }

  // --- for React (useSyncExternalStore) ---
  getState = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  dispose() {
    cancelAnimationFrame(this.frame);
    clearTimeout(this.autoStartTimer);
    this.unsubscribe();
    this.listeners.clear();
  }

  // --- spin ---
  setSpinning(on: boolean) {
    clearTimeout(this.autoStartTimer);
    this.update({ spinning: on });
  }
  toggleSpin() {
    this.setSpinning(!this.state.spinning);
  }
  /** Starts spinning after a short delay, unless the user gets to the map first. */
  autoStart(delayMs = 1500) {
    clearTimeout(this.autoStartTimer);
    this.autoStartTimer = window.setTimeout(() => this.update({ spinning: true }), delayMs);
  }

  // --- steps and presets (each one ends a tour; a spin carries on afterwards) ---
  rotateBy(delta: number) {
    this.endTour();
    const bearing = this.pendingValue('bearing') + delta;
    this.step({ bearing, duration: STEP_MS, easing: easeInOut });
  }
  rotateLeft() {
    this.rotateBy(-ROTATE_STEP);
  }
  rotateRight() {
    this.rotateBy(ROTATE_STEP);
  }
  /** A rotate button held (-1 left, 1 right) or let go (0): keep turning, smoothly, until it is. */
  holdTurn(dir: -1 | 0 | 1) {
    if (dir) this.endTour();
    this.turnDir = dir;
    this.sync();
  }
  tiltBy(delta: number) {
    this.endTour();
    const pitch = clamp(this.pendingValue('pitch') + delta, 0, this.map.maxPitch);
    this.step({ pitch, duration: STEP_MS, easing: easeInOut });
    this.update({ preset: null });
  }
  /** Toward the horizon. */
  tiltUp() {
    this.tiltBy(TILT_STEP);
  }
  /** Toward straight down. */
  tiltDown() {
    this.tiltBy(-TILT_STEP);
  }
  northUp() {
    this.endTour();
    this.step({ bearing: 0, duration: 900, easing: easeInOut });
    this.update({ spinning: false });
  }
  applyPreset(preset: ViewPreset) {
    this.endTour();
    const { pitch, zoom } = PRESETS[preset];
    this.pending = null;
    this.map.easeTo({ pitch: Math.min(pitch, this.map.maxPitch), zoom: zoom(this.map.getCamera().zoom), duration: PRESET_MS, easing: easeInOut });
    this.update({ preset });
  }

  // --- tour ---
  setLandmarks(landmarks: Landmark[]) {
    const key = landmarks.map((l) => l.id).join('|');
    if (key === this.landmarksKey) return;
    this.landmarksKey = key;
    this.landmarks = landmarks;
    // A campus switch mid-tour: carry on with the new campus once the app's flight lands.
    this.tourIndex = 0;
    this.tourPhase = 'fly';
    this.flightIssued = false;
  }
  get hasLandmarks() {
    return this.landmarks.length > 0;
  }
  toggleTour() {
    if (this.state.touring) return this.endTour();
    if (!this.landmarks.length) return;
    clearTimeout(this.autoStartTimer);
    this.tourIndex = this.nearestLandmark();
    this.tourPhase = 'fly';
    this.flightIssued = false;
    this.update({ touring: true, preset: null });
  }

  // --- internals ---
  private endTour() {
    clearTimeout(this.autoStartTimer);
    if (this.state.touring) this.update({ touring: false, landmark: null });
  }

  private onUser(kind: UserInteraction) {
    clearTimeout(this.autoStartTimer);
    if (kind === 'press') this.held = true;
    else if (kind === 'release') this.held = false;
    else {
      this.held = false;
      this.pending = null;
      if (this.state.spinning || this.state.touring || this.state.preset) {
        this.update({ spinning: false, touring: false, landmark: null, preset: null });
      }
    }
  }

  private pendingValue(key: 'bearing' | 'pitch'): number {
    const p = this.pending;
    if (p && p[key] !== undefined && performance.now() < p.until && this.map.isEasing()) return p[key]!;
    return this.map.getCamera()[key];
  }

  private step(move: CameraMove) {
    const prev = this.pending && performance.now() < this.pending.until ? this.pending : null;
    this.pending = { bearing: move.bearing ?? prev?.bearing, pitch: move.pitch ?? prev?.pitch, until: performance.now() + (move.duration ?? 0) };
    // Keep the other axis heading for its pending target too, else this step would cancel it.
    this.map.easeTo({ ...move, bearing: this.pending.bearing, pitch: this.pending.pitch });
  }

  private nearestLandmark(): number {
    const [x, y] = this.map.getCamera().center;
    let best = 0;
    this.landmarks.forEach((l, i) => {
      const d = (l.position[0] - x) ** 2 + (l.position[1] - y) ** 2;
      const b = this.landmarks[best];
      if (d < (b.position[0] - x) ** 2 + (b.position[1] - y) ** 2) best = i;
    });
    return best;
  }

  private update(patch: Partial<CameraControllerState>) {
    const next = { ...this.state, ...patch };
    if ((Object.keys(patch) as (keyof CameraControllerState)[]).every((k) => next[k] === this.state[k])) return;
    this.state = next;
    for (const l of this.listeners) l();
    this.sync();
  }

  /** Runs the frame loop while anything turns the camera continuously. */
  private sync() {
    const active = this.state.spinning || this.state.touring || this.turnDir !== 0;
    if (active && !this.frame) {
      this.lastFrame = 0;
      this.ramp = 0;
      this.frame = requestAnimationFrame(this.tick);
    } else if (!active && this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
  }

  private tick = (now: number) => {
    const dt = this.lastFrame ? Math.min(now - this.lastFrame, 50) / 1000 : 0;
    this.lastFrame = now;
    const easing = this.map.isEasing();
    const { spinning, touring } = this.state;

    if (touring) this.tourStep(dt, easing);

    // Never fight a move in progress (the app's campus flyTo, a preset, a step, a tour flight)
    // or a finger on the map: jumpTo would cancel either. Resume with the ramp afterwards.
    const orbiting = this.turnDir !== 0 || spinning || (touring && this.tourPhase === 'dwell');
    if (orbiting && !this.held && !this.map.isEasing()) {
      this.ramp = Math.min(1, this.ramp + dt / SPIN_RAMP_S);
      const k = this.ramp * this.ramp * (3 - 2 * this.ramp);
      const speed = this.turnDir
        ? this.turnDir * (this.reducedMotion ? TURN_REDUCED_DEG_PER_S : TURN_DEG_PER_S)
        : spinning
        ? this.reducedMotion ? SPIN_REDUCED_DEG_PER_S : SPIN_DEG_PER_S
        : this.reducedMotion ? TOUR_REDUCED_DEG_PER_S : TOUR_DEG_PER_S;
      // Bearing rotates about the map centre, which with VIEW_PADDING is the visual centre of
      // the uncovered area, so the campus turns in place rather than swinging behind the panel.
      if (dt > 0) this.map.jumpTo({ bearing: this.map.getCamera().bearing + speed * k * dt });
    } else {
      this.ramp = 0;
    }
    this.frame = requestAnimationFrame(this.tick);
  };

  private tourStep(dt: number, easing: boolean) {
    if (!this.landmarks.length || this.held) return;
    if (this.tourPhase === 'fly') {
      if (!this.flightIssued) {
        if (easing) return; // let the app's own flight land first
        const stop = this.landmarks[this.tourIndex % this.landmarks.length];
        this.flightIssued = true;
        this.map.easeTo({
          fly: true,
          center: stop.position,
          zoom: TOUR_VIEW.zoom,
          pitch: Math.min(TOUR_VIEW.pitch, this.map.maxPitch),
          bearing: this.map.getCamera().bearing + 25,
          duration: TOUR_FLIGHT_MS,
        });
        this.update({ landmark: stop.short });
      } else if (!easing) {
        this.tourPhase = 'dwell';
        this.dwellLeft = TOUR_DWELL_MS;
      }
    } else if (!easing) {
      this.dwellLeft -= dt * 1000;
      if (this.dwellLeft <= 0) {
        this.tourIndex = (this.tourIndex + 1) % this.landmarks.length;
        this.tourPhase = 'fly';
        this.flightIssued = false;
      }
    }
  }
}
