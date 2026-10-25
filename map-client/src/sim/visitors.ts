// Event visitors on the map: people who aren't BU students walking from the T, their garage or a
// rideshare drop-off to a venue before an event, and back after it. A separate population from the
// simulated students: they are drawn through the same character layers but never counted as
// students or in any building's occupancy.
//
// Everything is a pure function of sim time. Visitor i of an event reaches the door at the i-th
// quantile of the event's arrival curve and leaves at a low-discrepancy quantile of its departure
// curve; its origin, pace and place on the sidewalk come from a hash of (event, i). So the same
// people are in the same places at any playback speed, after a scrub, and in Clock mode.
//
// Per frame only visitors walking near the camera are touched: arrivals and departures are kept
// sorted, so those walking at `t` are found by binary search, and at most `cap` are drawn (a stable
// share by id, so drawn people don't flicker as the crowd grows).
import type { WalkingAgent } from './playback';
import type { VisitorOrigin } from '../data/eventCalendar';
import { arrivedShare, departureQuantile, originWeights, triangularQuantile, VISITOR_WALK_SPEED, type EventDay, type VenueEventEstimate } from './eventAttendance';

/** Most visitors drawn at once (the rest are counted, not drawn). */
export const VISITOR_DRAW_CAP = 600;
const SPEED_RANGE: [number, number] = [0.95, 1.45];
const SIDEWALK_HALF_WIDTH = 1.6; // metres either side of the route line
const CHARACTERS = 12;
const GOLDEN = 0.6180339887498949;

interface Route {
  origin: VisitorOrigin;
  path: [number, number][];
  cumulative: number[];
  length: number;
}

export interface PlannedVisitorEvent {
  estimate: VenueEventEstimate;
  slot: number;
  venue: [number, number];
  /** Furthest route from the venue, metres: an event this far beyond the camera's reach is skipped. */
  reach: number;
  routes: Route[];
  n: number;
  /** Door arrival per visitor, ascending with i. */
  arrive: Float64Array;
  /** Door departure per visitor; `byDeparture` lists visitor indices in departure order. */
  depart: Float64Array;
  byDeparture: Int32Array;
  departSorted: Float64Array;
  route: Uint8Array;
  walk: Float32Array; // seconds from origin to door
  share: Float32Array; // stable 0-1 per visitor: drawn when under the frame's keep share
  model: Uint8Array;
  side: Float32Array; // metres right of the route line
  maxWalk: number;
}

export interface VisitorPlan {
  date: string | null;
  events: PlannedVisitorEvent[];
}

export const NO_VISITORS: VisitorPlan = { date: null, events: [] };

/** 0-1 hash of (seed, i, salt); FNV-1a. */
export function hash01(seed: string, i: number, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let k = 0; k < seed.length; k++) h = Math.imul(h ^ seed.charCodeAt(k), 16777619);
  h = Math.imul(h ^ i, 16777619);
  h = Math.imul(h ^ (i >>> 16), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Every venue event's visitors for the day, precomputed once (no per-frame planning). */
export function planVisitors(day: EventDay): VisitorPlan {
  const events: PlannedVisitorEvent[] = [];
  day.events.forEach((estimate, slot) => {
    const origins = day.routes?.venues[estimate.venue.id]?.origins ?? [];
    const weighted = originWeights(estimate, origins).filter((w) => w.weight > 0 && w.origin.path.length >= 2);
    const n = estimate.visitors;
    if (!weighted.length || n <= 0) return;
    const routes: Route[] = weighted.map(({ origin }) => ({ origin, path: origin.path, cumulative: origin.cumulative, length: origin.cumulative[origin.cumulative.length - 1] }));
    const cumulativeWeight: number[] = [];
    let total = 0;
    for (const w of weighted) cumulativeWeight.push((total += w.weight));
    const seed = estimate.event.id;
    const arrive = new Float64Array(n), depart = new Float64Array(n), walk = new Float32Array(n), share = new Float32Array(n), side = new Float32Array(n);
    const route = new Uint8Array(n), model = new Uint8Array(n);
    let maxWalk = 0;
    for (let i = 0; i < n; i++) {
      arrive[i] = triangularQuantile((i + 0.5) / n, estimate.arrivalFrom, estimate.arrivalPeak, estimate.arrivalTo);
      depart[i] = departureQuantile(estimate, ((i + 0.5) * GOLDEN) % 1);
      const pick = hash01(seed, i, 1) * total;
      let r = 0;
      while (r < cumulativeWeight.length - 1 && cumulativeWeight[r] < pick) r++;
      route[i] = r;
      const speed = SPEED_RANGE[0] + (SPEED_RANGE[1] - SPEED_RANGE[0]) * hash01(seed, i, 2);
      walk[i] = routes[r].length / speed;
      if (walk[i] > maxWalk) maxWalk = walk[i];
      share[i] = hash01(seed, i, 3);
      model[i] = Math.floor(hash01(seed, i, 4) * CHARACTERS);
      side[i] = (hash01(seed, i, 5) * 2 - 1) * SIDEWALK_HALF_WIDTH;
    }
    const byDeparture = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => depart[a] - depart[b]);
    const departSorted = Float64Array.from(byDeparture, (i) => depart[i]);
    events.push({
      estimate, slot, venue: estimate.venue.position, reach: Math.max(...routes.map((r) => r.length)), routes, n,
      arrive, depart, byDeparture, departSorted, route, walk, share, model, side, maxWalk,
    });
  });
  return { date: day.date, events };
}

/** First index with values[i] >= x (values ascending). */
function lowerBound(values: Float64Array, x: number): number {
  let lo = 0, hi = values.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** How many of an event's visitors are walking at `t` (to the venue, and away from it). */
export function walkingCounts(e: PlannedVisitorEvent, t: number): { arriving: number; leaving: number } {
  let arriving = 0, leaving = 0;
  for (let i = lowerBound(e.arrive, t), end = lowerBound(e.arrive, t + e.maxWalk + 1e-6); i < end; i++) if (e.arrive[i] > t && e.arrive[i] - e.walk[i] <= t) arriving++;
  for (let k = lowerBound(e.departSorted, t - e.maxWalk), end = lowerBound(e.departSorted, t); k < end; k++) {
    const i = e.byDeparture[k];
    if (e.depart[i] + e.walk[i] > t) leaving++;
  }
  return { arriving, leaving };
}

const KX = 111_320 * Math.cos((42.35 * Math.PI) / 180);
const KY = 110_540;
function metres(a: [number, number], b: [number, number]): number {
  return Math.hypot((a[0] - b[0]) * KX, (a[1] - b[1]) * KY);
}

/** Position and bearing `d` metres along a route (origin to door), shifted `side` metres to the right of travel. */
function along(route: Route, d: number, side: number, reverse: boolean): { position: [number, number, number]; bearing: number } {
  const { path, cumulative, length } = route;
  const at = Math.min(length, Math.max(0, reverse ? length - d : d));
  let lo = 1, hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < at) lo = mid + 1;
    else hi = mid;
  }
  const a = path[lo - 1], b = path[lo];
  const seg = cumulative[lo] - cumulative[lo - 1];
  const f = seg > 0 ? (at - cumulative[lo - 1]) / seg : 0;
  let dx = (b[0] - a[0]) * KX, dy = (b[1] - a[1]) * KY;
  if (reverse) { dx = -dx; dy = -dy; }
  const len = Math.hypot(dx, dy) || 1;
  // Right of travel: (dy, -dx) normalised.
  const ox = (dy / len) * side, oy = (-dx / len) * side;
  return {
    position: [a[0] + (b[0] - a[0]) * f + ox / KX, a[1] + (b[1] - a[1]) * f + oy / KY, 0],
    bearing: (Math.atan2(dx, dy) * 180) / Math.PI,
  };
}

export interface VisitorFrame {
  /** Visitors to draw this frame (at most the cap), as walking characters. */
  drawn: WalkingAgent[];
  /** Everyone walking to or from a venue now, drawn or not. */
  walking: number;
}

const EMPTY_FRAME: VisitorFrame = { drawn: [], walking: 0 };

/**
 * Visitors walking at `t` near the camera, at most `cap` drawn. `nearMetres` is how far from the
 * camera centre people are drawn (null: anywhere in view); `inView` filters by the view bounds.
 * No event within reach: no work at all.
 */
export function visitorsAt(plan: VisitorPlan, t: number, center: [number, number], nearMetres: number | null,
  inView: (p: [number, number, number]) => boolean, cap = VISITOR_DRAW_CAP): VisitorFrame {
  if (!plan.events.length) return EMPTY_FRAME;
  const live = plan.events.filter((e) => t >= e.arrive[0] - e.maxWalk && t <= e.departSorted[e.n - 1] + e.maxWalk
    && (nearMetres === null || metres(center, e.venue) <= nearMetres + e.reach));
  if (!live.length) return EMPTY_FRAME;
  const counts = live.map((e) => walkingCounts(e, t));
  const walking = counts.reduce((s, c) => s + c.arriving + c.leaving, 0);
  if (!walking) return { drawn: [], walking: 0 };
  // Keep share stepped (powers of 1.25), so the drawn set doesn't churn every frame as counts move.
  const raw = Math.min(1, cap / walking);
  const keep = raw >= 1 ? 1 : 1.25 ** Math.floor(Math.log(raw) / Math.log(1.25));
  const near2 = nearMetres === null ? Infinity : nearMetres;
  const drawn: WalkingAgent[] = [];
  const push = (e: PlannedVisitorEvent, i: number, d: number, reverse: boolean) => {
    if (drawn.length >= cap) return;
    const r = e.routes[e.route[i]];
    const { position, bearing } = along(r, d, e.side[i], reverse);
    if (nearMetres !== null && metres(center, [position[0], position[1]]) > near2) return;
    if (!inView(position)) return;
    drawn.push({ id: `visitor:${e.slot}:${i}`, model: e.model[i], position, bearing, to: reverse ? r.origin.id : e.estimate.venue.id });
  };
  for (const e of live) {
    for (let i = lowerBound(e.arrive, t), end = lowerBound(e.arrive, t + e.maxWalk + 1e-6); i < end; i++) {
      if (e.share[i] >= keep) continue;
      const start = e.arrive[i] - e.walk[i];
      if (e.arrive[i] > t && start <= t) push(e, i, ((t - start) / e.walk[i]) * e.routes[e.route[i]].length, false);
    }
    for (let k = lowerBound(e.departSorted, t - e.maxWalk), end = lowerBound(e.departSorted, t); k < end; k++) {
      const i = e.byDeparture[k];
      if (e.share[i] >= keep) continue;
      if (e.depart[i] + e.walk[i] > t) push(e, i, ((t - e.depart[i]) / e.walk[i]) * e.routes[e.route[i]].length, true);
    }
  }
  return { drawn, walking };
}

// The day's plan the map is showing, so other features can ask for visitors by time alone.
let currentPlan: VisitorPlan = NO_VISITORS;
/** Set by the map whenever the shown day (or its venue events) changes. */
export function setCurrentVisitorPlan(plan: VisitorPlan): void {
  currentPlan = plan;
}

export interface EventVisitorsFrame {
  /** Every event visitor walking at `time` (to a venue, or away from it), positions included. Ids start `visitor:`. */
  walkers: WalkingAgent[];
  /** Per venue: visitors walking now. Visitors inside a venue are eventLoadAt's `visitors`. */
  walkingByVenue: Record<string, number>;
}

/**
 * Event visitors walking at sim `time` (local seconds on the shown day), uncapped and not limited to
 * the camera: for other crowd models (the public crowd) to include as one extra, non-student source.
 * Ids are `visitor:<event>:<i>`, so a consumer can drop them from any other source to avoid double
 * counting. Never part of student totals or university-building occupancy.
 */
export function eventVisitorsAt(time: number, plan: VisitorPlan = currentPlan): EventVisitorsFrame {
  const walkingByVenue: Record<string, number> = {};
  if (!plan.events.length) return { walkers: [], walkingByVenue };
  const frame = visitorsAt(plan, time, [0, 0], null, () => true, Infinity);
  for (const e of plan.events) {
    const { arriving, leaving } = walkingCounts(e, time);
    if (arriving + leaving) walkingByVenue[e.estimate.venue.id] = (walkingByVenue[e.estimate.venue.id] ?? 0) + arriving + leaving;
  }
  return { walkers: frame.drawn, walkingByVenue };
}

/** The visitor a character id names, for tooltips: `visitor:<slot>:<i>`. */
export function visitorFromId(plan: VisitorPlan, id: string): { estimate: VenueEventEstimate; origin: VisitorOrigin } | null {
  const match = /^visitor:(\d+):(\d+)$/.exec(id);
  if (!match) return null;
  const e = plan.events.find((p) => p.slot === Number(match[1]));
  const i = Number(match[2]);
  return e && i < e.n ? { estimate: e.estimate, origin: e.routes[e.route[i]].origin } : null;
}

/** Share of an event's visitors who have reached the door by `t` (for tests and panels). */
export const visitorsArrived = (e: PlannedVisitorEvent, t: number) => arrivedShare(e.estimate, t);
export { VISITOR_WALK_SPEED };
