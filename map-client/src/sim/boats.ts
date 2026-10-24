// Sailing dinghies on the Charles River basin, driven by the app's simulation clock.
//
// Each boat gets a whole day's course planned up front: a list of straight legs (tack, tack,
// tack... up the river against the wind, then gybing back down) inside the water polygon, with
// the corners rounded so the heading swings smoothly through each tack or gybe. Position at
// time t is then a binary search plus a little interpolation, so Live, fast-forward and
// scrubbing the timeline all agree, and the boats keep their real speed (2-3 m/s) relative to
// walkers and trains.
//
// Sailing model: close-hauled legs are 40-50 degrees off the wind, downwind legs are broad
// reaches 40-50 degrees off dead downwind. A leg ends after a random length, or before the boat
// would come within SHORE_CLEARANCE metres of the bank; the next leg is on the other tack (a
// tack upwind, a gybe downwind). Each boat beats up to its own windward limit and then runs back
// down to its own leeward limit. The boats heel to leeward and bob gently.

/** public/data/river.json (data-pipeline/fetch_river.py): separate stretches of open water. */
export interface RiverData {
  name: string;
  polygons: { name: string; polygon: [number, number][]; holes?: [number, number][][] }[]; // [lng, lat], rings not closed
  bbox: [number, number, number, number]; // west, south, east, north
}

/** Boats are out between these times (seconds since midnight). */
export const SAILING_START = 9 * 3600;
export const SAILING_END = 19.5 * 3600;
/** Boats never come closer than this to the bank (metres). */
export const SHORE_CLEARANCE = 25;
/** Prevailing westerly: the direction the wind blows FROM (compass degrees). */
export const DEFAULT_WIND_FROM = 270;

// BU Sailing Pavilion, on the Boston bank by the BU Bridge: basin boats launch near here.
const LAUNCH: [number, number] = [-71.1078, 42.3522];
const LAUNCH_RADIUS = 260; // metres
// Every UPSTREAM_EVERY-th boat sails the stretch above the BU Bridge instead (polygons[1]):
// the bridges, the low railway one especially, keep the two fleets apart.
const UPSTREAM_EVERY = 5;
const GROW_SECONDS = 25; // boats appear / leave by scaling over this many sim seconds

const CELL = 3; // metres; grid used to test legs quickly
// Extra clearance in the planner: covers the sampling step along a leg and the rounded corners,
// so every drawn position is at least SHORE_CLEARANCE from the bank.
const PLAN_PAD = 4;
const SAMPLE_STEP = 2;
const CORNER_RADIUS = 6; // metres; a tack or gybe takes about 2 * radius / speed seconds
const MIN_LEG = 14;
const WAKE_SECONDS = 9;
const WAKE_STEP = 1.5;

type XY = [number, number];

export interface Leg {
  t0: number;
  x: number; // start point (local metres)
  y: number;
  dx: number; // unit direction
  dy: number;
  length: number;
  speed: number;
  r0: number; // corner radius at the start / end
  r1: number;
}

export interface BoatPlan {
  id: string;
  variant: number; // hull colour, 0..VARIANTS-1
  start: number;
  end: number;
  phase: number; // for bobbing and gusts
  legs: Leg[];
}

export interface BoatState {
  sailboat: true; // tooltip marker
  id: string;
  variant: number;
  trim: 'close' | 'run';
  position: [number, number, number];
  heading: number; // compass degrees
  heel: number; // degrees; positive = heeling to port
  rock: number; // degrees of fore-aft pitch (bobbing)
  side: 1 | -1; // 1 = boom out to port (starboard tack), -1 = mirrored
  grow: number; // 0..1 while launching / leaving
  wake: [number, number][];
  wakeTimes: number[]; // seconds before now (negative), one per wake point
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const RAD = Math.PI / 180;
const wrap180 = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** A local metric frame (x east, y north) around the river. */
export class Frame {
  readonly kx: number;
  readonly ky = 110_540;
  constructor(readonly lng0: number, readonly lat0: number) {
    this.kx = 111_320 * Math.cos(lat0 * RAD);
  }
  toXY([lng, lat]: readonly number[]): XY {
    return [(lng - this.lng0) * this.kx, (lat - this.lat0) * this.ky];
  }
  toLngLat(x: number, y: number): [number, number] {
    return [this.lng0 + x / this.kx, this.lat0 + y / this.ky];
  }
}

function segmentDistance(p: XY, a: XY, b: XY): number {
  const vx = b[0] - a[0];
  const vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2)) : 0;
  return Math.hypot(p[0] - a[0] - vx * t, p[1] - a[1] - vy * t);
}

function inRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The water: exact point-in-polygon and distance-to-bank, plus a fast grid of safe cells. */
export class Water {
  readonly frame: Frame;
  readonly rings: XY[][]; // every outer ring and hole (even-odd: inside = in the water)
  readonly zones: XY[][]; // the outer ring of each stretch of water
  private readonly x0: number;
  private readonly y0: number;
  private readonly nx: number;
  private readonly ny: number;
  private readonly safe: Uint8Array;

  constructor(river: RiverData, clearance = SHORE_CLEARANCE + PLAN_PAD) {
    const [w, s, e, n] = river.bbox;
    this.frame = new Frame((w + e) / 2, (s + n) / 2);
    const toXY = (ring: [number, number][]) => ring.map((p) => this.frame.toXY(p));
    this.zones = river.polygons.map((z) => toXY(z.polygon));
    this.rings = river.polygons.flatMap((z) => [z.polygon, ...(z.holes ?? [])]).map(toXY);
    const [x0, y0] = this.frame.toXY([w, s]);
    const [x1, y1] = this.frame.toXY([e, n]);
    this.x0 = x0;
    this.y0 = y0;
    this.nx = Math.ceil((x1 - x0) / CELL) + 1;
    this.ny = Math.ceil((y1 - y0) / CELL) + 1;
    this.safe = new Uint8Array(this.nx * this.ny);
    // A cell is safe when its centre is in the water and far enough from the bank that every
    // point of the cell is (distance is 1-Lipschitz, so allow half the cell's diagonal).
    const margin = clearance + CELL * Math.SQRT1_2;
    // Scanline fill: per row, the water spans between edge crossings (even-odd), shrunk by the
    // margin; only those cells need the exact distance test.
    for (let j = 0; j < this.ny; j++) {
      const y = y0 + (j + 0.5) * CELL;
      const xs: number[] = [];
      for (const ring of this.rings) {
        for (let k = 0, m = ring.length - 1; k < ring.length; m = k++) {
          const [xa, ya] = ring[k];
          const [xb, yb] = ring[m];
          if (ya > y !== yb > y) xs.push(xa + ((y - ya) * (xb - xa)) / (yb - ya));
        }
      }
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const i0 = Math.max(0, Math.ceil((xs[k] + margin - x0) / CELL - 0.5));
        const i1 = Math.min(this.nx - 1, Math.floor((xs[k + 1] - margin - x0) / CELL - 0.5));
        for (let i = i0; i <= i1; i++) {
          if (this.shoreDistance([x0 + (i + 0.5) * CELL, y], margin) >= margin) this.safe[j * this.nx + i] = 1;
        }
      }
    }
  }

  contains(p: XY): boolean {
    let inside = false;
    for (const ring of this.rings) if (inRing(p, ring)) inside = !inside;
    return inside;
  }

  /** Distance to the nearest bank (stops early once below `stopBelow`). */
  shoreDistance(p: XY, stopBelow = 0): number {
    let best = Infinity;
    for (const ring of this.rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        best = Math.min(best, segmentDistance(p, ring[j], ring[i]));
        if (best < stopBelow) return best;
      }
    }
    return best;
  }

  isSafe(x: number, y: number): boolean {
    const i = Math.floor((x - this.x0) / CELL);
    const j = Math.floor((y - this.y0) / CELL);
    return i >= 0 && j >= 0 && i < this.nx && j < this.ny && this.safe[j * this.nx + i] === 1;
  }

  /** How far a boat can sail from (x, y) along (dx, dy), up to `limit` metres. */
  run(x: number, y: number, dx: number, dy: number, limit: number): number {
    let s = 0;
    while (s + SAMPLE_STEP <= limit && this.isSafe(x + dx * (s + SAMPLE_STEP), y + dy * (s + SAMPLE_STEP))) s += SAMPLE_STEP;
    return s;
  }

  /** Safe cell centres in one stretch of water, within `radius` of a point (launch spots). */
  safeNear([px, py]: XY, radius: number, zone: number): XY[] {
    const out: XY[] = [];
    const ring = this.zones[zone];
    for (let j = 0; j < this.ny; j += 3) {
      for (let i = 0; i < this.nx; i += 3) {
        const x = this.x0 + (i + 0.5) * CELL;
        const y = this.y0 + (j + 0.5) * CELL;
        if (this.safe[j * this.nx + i] && Math.hypot(x - px, y - py) <= radius && inRing([x, y], ring)) out.push([x, y]);
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

export const BOAT_VARIANTS = 3;

/** When each boat is out: a few from the morning, more after lunch, most in the evening. */
function sessions(rand: () => number): { start: number; end: number }[] {
  const out = [];
  const hour = 3600;
  for (let i = 0; i < 6; i++) out.push({ start: SAILING_START + rand() * 1.5 * hour, end: SAILING_END - rand() * 0.8 * hour });
  for (let i = 0; i < 5; i++) out.push({ start: 11.5 * hour + rand() * 2.5 * hour, end: 18.5 * hour + rand() * hour });
  for (let i = 0; i < 5; i++) out.push({ start: 15 * hour + rand() * 1.5 * hour, end: 19 * hour + rand() * 0.5 * hour });
  return out;
}

function planBoat(water: Water, index: number, session: { start: number; end: number }, windFrom: number): BoatPlan {
  const rand = mulberry32(1013 + index * 7919);
  const variant = index % BOAT_VARIANTS;
  const phase = rand() * 1000;
  const baseSpeed = 2.1 + rand() * 0.8;

  // Progress to windward: w = p . (unit vector toward where the wind comes from).
  const wx = Math.sin(windFrom * RAD);
  const wy = Math.cos(windFrom * RAD);
  const zone = index % UPSTREAM_EVERY === 2 && water.zones.length > 1 ? 1 : 0;
  const ws = water.zones[zone].map(([x, y]) => x * wx + y * wy);
  const wMin = Math.min(...ws);
  const wMax = Math.max(...ws);
  const span = wMax - wMin;
  const wLow = wMin + span * (0.08 + rand() * 0.3); // run down to here...
  const wHigh = wMax - span * (0.12 + rand() * 0.35); // ...beat up to here

  const ring = water.zones[zone];
  const middle: XY = zone === 0 ? water.frame.toXY(LAUNCH) : ring[Math.floor(ring.length / 2)];
  const nearby = water.safeNear(middle, LAUNCH_RADIUS, zone);
  const spots = nearby.length ? nearby : water.safeNear(middle, 1e5, zone);
  let [x, y] = spots[Math.floor(rand() * spots.length)];

  let upwind = x * wx + y * wy < wHigh;
  let tack: 1 | -1 = rand() < 0.5 ? 1 : -1;
  let heading = windFrom + tack * 45 + (upwind ? 0 : 180);
  const legs: Leg[] = [];
  let t = session.start;
  let pivots = 0;

  const courseFor = (up: boolean, side: 1 | -1) =>
    up ? windFrom + side * (40 + rand() * 10) : windFrom + 180 - side * (40 + rand() * 10);

  while (t < session.end) {
    const w = x * wx + y * wy;
    const wasUpwind = upwind;
    if (upwind && w >= wHigh) upwind = false;
    else if (!upwind && w <= wLow) upwind = true;
    const want = upwind ? 60 + rand() * 160 : 90 + rand() * 200;

    // Candidate courses, best first: the other tack (a tack or gybe), the same tack, then the
    // other point of sail. Changing point of sail (bearing away or heading up) keeps the side
    // that needs the smaller turn, so the bow never swings round more than ~100 degrees.
    const byTurn = (a: { course: number }, b: { course: number }) =>
      Math.abs(wrap180(a.course - heading)) - Math.abs(wrap180(b.course - heading));
    const options = (up: boolean) => [-tack as 1 | -1, tack].map((side) => ({ up, side, course: courseFor(up, side) }));
    const sameMode = options(upwind);
    if (upwind !== wasUpwind) sameMode.sort(byTurn);
    const candidates = [...sameMode, ...options(!upwind).sort(byTurn)].filter((c) => Math.abs(wrap180(c.course - heading)) <= 125);
    let chosen: { course: number; length: number; side: 1 | -1; up: boolean } | null = null;
    for (const c of candidates) {
      const dx = Math.sin(c.course * RAD);
      const dy = Math.cos(c.course * RAD);
      const length = Math.min(want, water.run(x, y, dx, dy, want + 4) - 4);
      if (length >= MIN_LEG) {
        chosen = { ...c, length };
        break;
      }
    }
    if (!chosen) {
      // Boxed in: the clear course outside the no-go zone that is longest, less a penalty
      // for how far the bow has to swing.
      let best = { course: heading, length: 0 };
      let bestScore = 0;
      for (let a = 0; a < 360; a += 10) {
        if (Math.abs(wrap180(a - windFrom)) < 40) continue;
        const length = water.run(x, y, Math.sin(a * RAD), Math.cos(a * RAD), want) - 2;
        const score = length - Math.abs(wrap180(a - heading)) * 0.6;
        if (length >= MIN_LEG && (score > bestScore || best.length === 0)) {
          best = { course: a, length };
          bestScore = score;
        }
      }
      const rel = wrap180(windFrom - best.course);
      chosen = { ...best, side: rel > 0 ? 1 : -1, up: Math.abs(rel) < 90 };
      pivots++;
    }

    const dx = Math.sin(chosen.course * RAD);
    const dy = Math.cos(chosen.course * RAD);
    let length = Math.max(0, chosen.length);
    const speed = baseSpeed * (chosen.up ? 0.9 : 1.1);
    const turn = wrap180(chosen.course - heading);
    if (Math.abs(turn) > 150) {
      // Turning right round (boxed in at the end of the water): come about in two quarter
      // turns, with a few metres across in between, rather than spinning on the spot.
      const across = heading + Math.sign(turn) * 90;
      const ax = Math.sin(across * RAD);
      const ay = Math.cos(across * RAD);
      const step = Math.min(10, water.run(x, y, ax, ay, 12) - 2);
      if (step >= 4) {
        legs.push({ t0: t, x, y, dx: ax, dy: ay, length: step, speed: baseSpeed * 0.7, r0: 0, r1: 0 });
        x += ax * step;
        y += ay * step;
        t += step / (baseSpeed * 0.7);
        length = Math.max(0, Math.min(length, water.run(x, y, dx, dy, length + 4) - 4));
      }
    }
    legs.push({ t0: t, x, y, dx, dy, length, speed, r0: 0, r1: 0 });
    upwind = chosen.up;
    tack = chosen.side;
    heading = chosen.course;
    if (length === 0) {
      t += 10; // in irons for a moment
      legs[legs.length - 1].speed = 0;
      continue;
    }
    x += dx * length;
    y += dy * length;
    t += length / speed;
  }

  // Round the corners: a tack or gybe swings the bow round over a few metres.
  for (let i = 1; i < legs.length; i++) {
    const a = legs[i - 1];
    const b = legs[i];
    const turn = Math.acos(Math.max(-1, Math.min(1, a.dx * b.dx + a.dy * b.dy))) / RAD;
    const r = turn > 160 ? 0 : Math.min(CORNER_RADIUS, a.length / 2, b.length / 2);
    a.r1 = r;
    b.r0 = r;
  }
  if (pivots > 0 && import.meta.env?.DEV) console.debug(`boat ${index}: ${pivots} boxed-in pivots`);
  return { id: `boat-${index}`, variant, start: session.start, end: session.end, phase, legs };
}

// ---------------------------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------------------------

interface Pose {
  x: number;
  y: number;
  hx: number; // heading direction (not normalised)
  hy: number;
}

function poseAt(plan: BoatPlan, t: number): Pose {
  const legs = plan.legs;
  let lo = 0;
  let hi = legs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (legs[mid].t0 <= t) lo = mid;
    else hi = mid - 1;
  }
  const leg = legs[lo];
  const s = Math.max(0, Math.min(leg.length, (t - leg.t0) * leg.speed));
  if (s < leg.r0 && lo > 0) {
    const prev = legs[lo - 1];
    return corner(leg.x, leg.y, prev.dx, prev.dy, leg.dx, leg.dy, leg.r0, 0.5 + s / (2 * leg.r0));
  }
  if (s > leg.length - leg.r1 && lo < legs.length - 1) {
    const next = legs[lo + 1];
    return corner(next.x, next.y, leg.dx, leg.dy, next.dx, next.dy, leg.r1, (s - (leg.length - leg.r1)) / (2 * leg.r1));
  }
  return { x: leg.x + leg.dx * s, y: leg.y + leg.dy * s, hx: leg.dx, hy: leg.dy };
}

/** Quadratic Bezier round a corner at (px, py), from direction d0 into d1, u in 0..1. */
function corner(px: number, py: number, d0x: number, d0y: number, d1x: number, d1y: number, r: number, u: number): Pose {
  const ax = px - d0x * r;
  const ay = py - d0y * r;
  const cx = px + d1x * r;
  const cy = py + d1y * r;
  const a = (1 - u) * (1 - u);
  const b = 2 * u * (1 - u);
  const c = u * u;
  return {
    x: a * ax + b * px + c * cx,
    y: a * ay + b * py + c * cy,
    hx: (1 - u) * d0x + u * d1x,
    hy: (1 - u) * d0y + u * d1y,
  };
}

/** The whole fleet: plans every boat's day once per wind direction. */
export class Fleet {
  readonly water: Water;
  private plans: BoatPlan[] = [];
  private windFrom = NaN;
  private readonly sessions: { start: number; end: number }[];

  constructor(readonly river: RiverData) {
    this.water = new Water(river);
    this.sessions = sessions(mulberry32(20261024));
    this.setWind(DEFAULT_WIND_FROM);
  }

  get wind() {
    return this.windFrom;
  }

  /** Re-plan for a new wind direction (rounded to whole degrees; same wind = no work). */
  setWind(windFromDegrees: number) {
    const w = Math.round(((windFromDegrees % 360) + 360) % 360);
    if (w === this.windFrom) return;
    this.windFrom = w;
    this.plans = this.sessions.map((s, i) => planBoat(this.water, i, s, w));
  }

  get boatPlans(): readonly BoatPlan[] {
    return this.plans;
  }

  /** Local-metre position of a boat at t, or null when it isn't out. For tests and checks. */
  positionXY(plan: BoatPlan, t: number): XY | null {
    if (t < plan.start || t > plan.end) return null;
    const p = poseAt(plan, t);
    return [p.x, p.y];
  }

  /** Every boat on the water at time t (seconds since midnight). */
  at(t: number, windFromDegrees = DEFAULT_WIND_FROM): BoatState[] {
    this.setWind(windFromDegrees);
    const frame = this.water.frame;
    const out: BoatState[] = [];
    for (const plan of this.plans) {
      if (t < plan.start || t > plan.end) continue;
      const pose = poseAt(plan, t);
      const heading = ((Math.atan2(pose.hx, pose.hy) / RAD) % 360 + 360) % 360;
      // Wind angle relative to the bow: positive = wind over the starboard side, so the boom
      // and the heel go to port.
      const rel = wrap180(this.windFrom - heading);
      const leeward = Math.max(-1, Math.min(1, Math.sin(rel * RAD) / Math.sin(35 * RAD)));
      const gust = 1 + 0.12 * Math.sin((t + plan.phase) / 9.7) + 0.06 * Math.sin((t + plan.phase) / 3.3);
      const heel = leeward * (13.5 + 4 * Math.cos(rel * RAD)) * gust; // ~17 deg beating, ~10 running
      const bob = Math.sin((t + plan.phase) * 2.1) * 0.05 + Math.sin((t + plan.phase) * 3.7) * 0.025;
      const rock = Math.sin((t + plan.phase) * 1.6) * 1.8;
      const grow = Math.min(1, (t - plan.start) / GROW_SECONDS, (plan.end - t) / GROW_SECONDS);

      const wake: [number, number][] = [];
      const wakeTimes: number[] = [];
      for (let k = WAKE_SECONDS; k >= 0; k -= WAKE_STEP) {
        const tk = Math.max(plan.start, t - k);
        const p = k === 0 ? pose : poseAt(plan, tk);
        wake.push(frame.toLngLat(p.x, p.y));
        wakeTimes.push(tk - t);
      }
      const [lng, lat] = frame.toLngLat(pose.x, pose.y);
      out.push({
        sailboat: true,
        id: plan.id,
        variant: plan.variant,
        trim: Math.abs(rel) < 100 ? 'close' : 'run',
        position: [lng, lat, bob],
        heading,
        heel,
        rock,
        side: rel >= 0 ? 1 : -1,
        grow: Math.max(0, grow),
        wake,
        wakeTimes,
      });
    }
    return out;
  }
}
