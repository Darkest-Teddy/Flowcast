// The public on BU's streets: residents, workers, patients and visitors who are not BU students or
// staff. (Below, "students" means every simulated BU person: students and modeled staff, sim/staff.ts.)
//
// Students and staff are simulated person by person and are the only people in university buildings. The
// streets and the T are busier than they alone make them: the MBTA's ridership counts
// and the pedestrian counts near campus (data/observations.ts) measure everyone. This module
// fills that gap with walkers who are not students:
//
//   public at a stop or site, per bin = max(0, observed - simulated students - extra sources)
//
// Student riders per stop and hour are a few dozen at most, so their counts are smoothed 1-2-1
// across bins before the subtraction; pedestrian sites (hundreds an hour) are not smoothed. Where
// students alone exceed a count the public adds nobody there (that is a student-model finding).
// Several studies of one intersection (2012, 2018, 2023) are merged: each hour takes the newest.
//
// * Transit riders: for every observed stop series, public riders step off at the published
//   arrival times in that bin (or walk to the stop and board), then walk 120-450 m along the
//   saved sidewalk routes away from (or toward) the stop.
// * Through walkers: at every pedestrian count site, people walking a few hundred metres of
//   sidewalk through the site, timed to pass it inside the bin. Hours without a count follow the
//   observed all-rider activity curve near BU (B branch stops + Kenmore gates), scaled to the
//   counted hours (see `activityProfile`).
//
// Public walkers never start or end at a university building: they use stretches of the walk
// routes at least END_CLEAR_METRES from any route end that is a BU location, and they are kept in
// their own list, so they never reach building occupancy, student counts or student panels.
// Everything is a pure function of (observations, simulated day, weekday): deterministic at any
// playback speed and in Clock mode (which builds today's weekday).
import type { CampusLocation, TransitRide, Trip, WaitingRider, WalkingAgent, WalkRoute } from './playback';
import type { TransitService } from './transitService';
import { ALIGHT_SECONDS } from './transitService';
import {
  binBounds, binOf, clockSeconds, dayTypeFor, screenEvents, screenOf, seriesForWeekday, simulatedPedestrians, simulatedTransit,
  type CalibrationObservations, type LngLat, type ObservationBin, type PedestrianSeries, type ScreenEvent, type TransitSeries,
} from '../data/observations';

export const PUBLIC_ID_PREFIX = 'public-';
export const isPublicId = (id: string) => id.startsWith(PUBLIC_ID_PREFIX);
/** A public walk never starts or ends closer than this (along the route) to a BU building it leads to. */
export const END_CLEAR_METRES = 40;
/** Distance a public transit rider walks from or to the stop. */
export const RIDER_WALK_METRES: [number, number] = [120, 450];
/** Each side of a count site a through walker covers. */
export const THROUGH_WALK_METRES: [number, number] = [100, 350];
/** Short crossing when a longer walk would overfill a neighbouring count site. */
export const SHORT_WALK_METRES: [number, number] = [25, 60];
/** Routes this close to a stop serve it. */
export const STOP_RADIUS_METRES = 35;
/** For a stop no saved walk passes within STOP_RADIUS_METRES (Longwood Ave @ Binney St, say). */
export const STOP_FALLBACK_METRES = 120;
/** Boarders reach the stop this long before the departure (gated: the entry is the arrival). */
export const BOARD_WAIT_SECONDS: [number, number] = [60, 480];
export const WALK_SPEED: [number, number] = [1.2, 1.55];
const BUCKET = 300;
const MODELS = 12;

export interface PublicWalk {
  id: string;
  model: number;
  route: WalkRoute;
  /** Metres along the route at the start and end; from > to walks the route backwards. */
  from: number;
  to: number;
  depart: number;
  speed: number;
  purpose: 'alight' | 'board' | 'through';
  /** Map stop for riders. */
  stop?: string;
}

/** A public rider stepping on or off a vehicle (or through Kenmore's gates), for scoring and stop counts. */
export interface PublicRide extends Pick<TransitRide, 'kind' | 'route' | 'direction' | 'stop' | 'time'> { waitStart?: number }
/** A public boarder standing at the stop: arrived at `waitStart`, boards at `boardsAt` (the published departure). */
export interface PublicWait extends WaitingRider { waitStart: number }

/**
 * Other non-student crowds (event visitors from sim/eventAttendance.ts, say). Their walkers are
 * drawn by their own module; here they only change how many public walkers are needed.
 * `inObservedCounts`: true when the observed baseline already includes them (a count taken on an
 * event day), so they replace part of the public fill; false (the usual case: the MBTA averages and
 * the Warren counts are ordinary term days) adds them on top without touching the baseline.
 */
export interface PublicSource {
  id: string;
  inObservedCounts: boolean;
  transit?(series: TransitSeries): number[];
  pedestrians?(site: PedestrianSeries): number[];
}

export interface PublicCrowdInput {
  observations: CalibrationObservations;
  day: {
    trips: readonly Trip[];
    transitRides?: readonly TransitRide[];
    walkRoutes?: Record<string, WalkRoute>;
    stopRoutes?: Record<string, WalkRoute>;
    locations: readonly CampusLocation[];
  };
  /** 0 = Monday. */
  weekday: number;
  transit?: TransitService;
  extraSources?: readonly PublicSource[];
}

export interface PublicCrowdStats {
  walks: number;
  riders: number;
  through: number;
  /** Pedestrian sites filled, and the hours each was filled for. */
  sites: number;
  transitSeries: number;
}

// ------------------------------------------------------------------ small helpers

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
/** Deterministic uniform [0, 1) from a key. */
const unit = (key: string) => hash(key) / 4294967296;
const between = (key: string, [lo, hi]: readonly [number, number]) => lo + (hi - lo) * unit(key);

/** Light 1-2-1 smoothing that keeps the total. */
export function smooth(values: readonly number[]): number[] {
  if (values.length < 3) return [...values];
  const out = values.map((v, i) => (values[Math.max(0, i - 1)] + 2 * v + values[Math.min(values.length - 1, i + 1)]) / 4);
  const total = values.reduce((s, v) => s + v, 0), smoothed = out.reduce((s, v) => s + v, 0);
  return smoothed > 0 ? out.map((v) => (v * total) / smoothed) : out;
}

/** Whole people per bin whose running total tracks the fractional one (no drift, no bias). */
export function wholePeople(values: readonly number[]): number[] {
  let cumulative = 0, given = 0;
  return values.map((v) => {
    cumulative += Math.max(0, v);
    const n = Math.round(cumulative) - given;
    given += n;
    return n;
  });
}

function segmentAt(route: WalkRoute, m: number): [number, number] {
  const c = route.cumulative;
  let lo = 0, hi = c.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid] <= m) lo = mid; else hi = mid; }
  const span = c[hi] - c[lo];
  return [lo, span > 0 ? Math.min(1, Math.max(0, (m - c[lo]) / span)) : 0];
}

function positionAt(route: WalkRoute, m: number): LngLat {
  const [i, f] = segmentAt(route, m);
  const a = route.path[i], b = route.path[i + 1] ?? a;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

function pointAt(route: WalkRoute, m: number): { position: LngLat; bearing: number } {
  const [i, f] = segmentAt(route, m);
  const a = route.path[i], b = route.path[i + 1] ?? a;
  return { position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], bearing: bearing(a, b) };
}

function bearing(a: LngLat, b: LngLat): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * toRad) * Math.cos(b[1] * toRad);
  const x = Math.cos(a[1] * toRad) * Math.sin(b[1] * toRad) - Math.sin(a[1] * toRad) * Math.cos(b[1] * toRad) * Math.cos((b[0] - a[0]) * toRad);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

const metresBetween = (a: LngLat, b: LngLat) =>
  Math.hypot((a[0] - b[0]) * 111_320 * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * 110_540);

/** Metres along the route of the point nearest `p`, when it is within `radius`. */
function nearestOnRoute(route: WalkRoute, p: LngLat, radius: number): number | null {
  const kx = 111_320 * Math.cos((p[1] * Math.PI) / 180), ky = 110_540;
  let best = Infinity, at = 0;
  for (let i = 1; i < route.path.length; i++) {
    const a = route.path[i - 1], b = route.path[i];
    const ax = (a[0] - p[0]) * kx, ay = (a[1] - p[1]) * ky, bx = (b[0] - p[0]) * kx, by = (b[1] - p[1]) * ky;
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const f = len2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / len2)) : 0;
    const d = Math.hypot(ax + f * dx, ay + f * dy);
    if (d < best) { best = d; at = route.cumulative[i - 1] + f * (route.cumulative[i] - route.cumulative[i - 1]); }
  }
  return best <= radius ? at : null;
}

/** A route the public may walk, with the stretch of it that keeps clear of BU buildings. */
interface PoolRoute { key: string; route: WalkRoute; min: number; max: number; bbox: [number, number, number, number] }

function routePool(day: PublicCrowdInput['day']): PoolRoute[] {
  const pool: PoolRoute[] = [];
  const add = (key: string, route: WalkRoute, startsAtStop: boolean) => {
    const length = route.cumulative[route.cumulative.length - 1] ?? 0;
    const min = startsAtStop ? 0 : END_CLEAR_METRES, max = length - END_CLEAR_METRES;
    if (max - min < 30) return;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of route.path) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    pool.push({ key, route, min, max, bbox: [w, s, e, n] });
  };
  for (const [key, route] of Object.entries(day.walkRoutes ?? {})) add(`walk:${key}`, route, false);
  for (const [key, route] of Object.entries(day.stopRoutes ?? {})) add(`stop:${key}`, route, true);
  return pool.sort((a, b) => a.key.localeCompare(b.key));
}

const nearBox = (bbox: PoolRoute['bbox'], p: LngLat, metres: number) => {
  const dx = metres / (111_320 * Math.cos((p[1] * Math.PI) / 180)), dy = metres / 110_540;
  return p[0] >= bbox[0] - dx && p[0] <= bbox[2] + dx && p[1] >= bbox[1] - dy && p[1] <= bbox[3] + dy;
};

/**
 * Hourly all-rider activity near BU for the day type (B branch BU stops ons+offs, Kenmore gate
 * entries), scaled so a typical weekday's busiest hour is 1: weekends keep their own level.
 */
export function activityProfile(observations: CalibrationObservations, weekday: number): number[] {
  const hours = rawActivity(observations, weekday);
  const max = Math.max(...rawActivity(observations, 2));
  return max > 0 ? hours.map((v) => v / max) : hours.map((_, h) => (h >= 7 && h < 23 ? 1 : 0));
}

function rawActivity(observations: CalibrationObservations, weekday: number): number[] {
  const hours = new Array(24).fill(0);
  const bu = new Set(['place-bland', 'place-buest', 'place-bucen', 'place-amory', 'place-babck']);
  for (const s of seriesForWeekday(observations, weekday, { primaryOnly: true }).transit) {
    const counted = s.kind === 'gated-entries' || (s.route === 'Green-B' && bu.has(s.stop.mapStopId));
    if (!counted) continue;
    for (const b of s.bins) {
      const h = Math.floor(clockSeconds(b.start) / 3600);
      if (h >= 0 && h < 24) hours[h] += b.value;
    }
  }
  return hours;
}

const clock = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const HOURLY: ObservationBin[] = Array.from({ length: 24 }, (_, h) => ({
  start: `${String(h).padStart(2, '0')}:00`, end: `${String(h + 1).padStart(2, '0')}:00`, value: 0,
}));

/**
 * Hourly totals (students + public) a count site should see: the counted hours as observed, other
 * hours from the activity curve times people-per-activity interpolated between counted hours.
 * Weekends have no counts: the weekday ratio is applied to the weekend's own activity curve.
 */
export function siteHourlyTargets(series: PedestrianSeries | readonly PedestrianSeries[], weekdayProfile: readonly number[], profile: readonly number[], observedToday: boolean): (number | null)[] {
  const observed = new Map([...observedHours(Array.isArray(series) ? series : [series as PedestrianSeries])].map(([h, o]) => [h, o.value]));
  if (!observed.size) return new Array(24).fill(null);
  const ratios = [...observed].filter(([h]) => weekdayProfile[h] > 0.02).map(([h, v]) => [h + 0.5, v / weekdayProfile[h]] as const).sort((a, b) => a[0] - b[0]);
  const ratioAt = (x: number) => {
    if (!ratios.length) return 0;
    if (x <= ratios[0][0]) return ratios[0][1];
    for (let i = 1; i < ratios.length; i++) {
      if (x <= ratios[i][0]) {
        const [x0, y0] = ratios[i - 1], [x1, y1] = ratios[i];
        return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
      }
    }
    return ratios[ratios.length - 1][1];
  };
  return Array.from({ length: 24 }, (_, h) => (observedToday && observed.has(h) ? observed.get(h)! : ratioAt(h + 0.5) * profile[h]));
}

/** A counted hour: its total, the series it comes from, and the quarter-hour bins inside it when counted by quarter. */
export interface ObservedHour { value: number; series: PedestrianSeries; quarters: number[] | null }

/**
 * Hours fully counted by one or more series of one site. Several studies count the same
 * intersection (2012, 2018, 2023): each hour takes the most recent study that covers it.
 */
export function observedHours(series: readonly PedestrianSeries[]): Map<number, ObservedHour> {
  const out = new Map<number, ObservedHour>();
  const newestFirst = [...series].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  for (const s of newestFirst) {
    const bounds = binBounds(s.bins);
    for (let h = 0; h < 24; h++) {
      if (out.has(h)) continue;
      const inHour = s.bins.map((b, i) => ({ b, i })).filter(({ i }) => bounds[i][0] >= h * 3600 && bounds[i][1] <= (h + 1) * 3600);
      const covered = inHour.reduce((sum, { i }) => sum + bounds[i][1] - bounds[i][0], 0);
      if (covered !== 3600) continue;
      const quarters = inHour.length === 4 && inHour.every(({ i }) => bounds[i][1] - bounds[i][0] === 900)
        ? inHour.sort((x, y) => bounds[x.i][0] - bounds[y.i][0]).map(({ b }) => b.value) : null;
      out.set(h, { value: inHour.reduce((sum, { b }) => sum + b.value, 0), series: s, quarters });
    }
  }
  return out;
}

/** Count sites grouped by place (several studies of one intersection), each with its newest series. */
export function siteClusters(series: readonly PedestrianSeries[]): { key: string; series: PedestrianSeries[]; reference: PedestrianSeries }[] {
  const groups = new Map<string, PedestrianSeries[]>();
  for (const s of series) {
    const key = (s as PedestrianSeries & { siteKey?: string }).siteKey ?? `${s.position[0].toFixed(4)},${s.position[1].toFixed(4)}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups].sort((a, b) => a[0].localeCompare(b[0])).map(([key, list]) => ({
    key, series: list, reference: [...list].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))[0],
  }));
}

/** BU building entrances (every non-outdoor campus location), bucketed for "never at a university building" checks. */
class EntranceIndex {
  private readonly cells = new Map<number, LngLat[]>();
  private readonly metres: number;
  constructor(locations: readonly CampusLocation[], metres: number) {
    this.metres = metres;
    for (const l of locations) {
      if (l.kind === 'outdoor' || l.kind === 'off-campus') continue;
      const key = EntranceIndex.cell(Math.floor(l.position[0] / 0.001), Math.floor(l.position[1] / 0.001));
      this.cells.set(key, [...(this.cells.get(key) ?? []), l.position]);
    }
  }
  private static cell(ix: number, iy: number) { return ix * 1_000_003 + iy; }
  /** True when p is at least `metres` (under one 0.001 degree cell) from every BU location. */
  clear(p: LngLat): boolean {
    const ix = Math.floor(p[0] / 0.001), iy = Math.floor(p[1] / 0.001);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const q of this.cells.get(EntranceIndex.cell(ix + dx, iy + dy)) ?? []) if (metresBetween(p, q) < this.metres) return false;
    }
    return true;
  }
}
/** Public walks never start or end this close to a BU building's location point. */
export const ENTRANCE_CLEAR_METRES = 20;

// ------------------------------------------------------------------ the crowd

export class PublicCrowd {
  readonly walks: PublicWalk[] = [];
  readonly rides: PublicRide[] = [];
  /** Public boarders standing at their stop between walking up and their vehicle leaving. */
  readonly waits: PublicWait[] = [];
  readonly stats: PublicCrowdStats;
  private readonly buckets = new Map<number, PublicWalk[]>();
  private readonly waitBuckets = new Map<number, PublicWait[]>();

  private addWait(wait: PublicWait) {
    this.waits.push(wait);
    for (let bucket = Math.floor(wait.waitStart / 300); bucket <= Math.floor(wait.boardsAt / 300); bucket++) {
      const list = this.waitBuckets.get(bucket) ?? [];
      list.push(wait); this.waitBuckets.set(bucket, list);
    }
  }

  /** Public riders waiting at stops at `t`: as many as the observed boardings at that stop and hour leave for. */
  waitingAt(t: number): WaitingRider[] {
    const out: WaitingRider[] = [];
    for (const wait of this.waitBuckets.get(Math.floor(t / 300)) ?? []) {
      if (wait.waitStart <= t && t < wait.boardsAt) out.push(wait);
    }
    return out;
  }
  private readonly siteEvents = new Map<string, Map<WalkRoute, { m: number; event: ScreenEvent }[]>>();

  constructor(input: PublicCrowdInput) {
    const { observations, day, weekday, transit } = input;
    const extras = input.extraSources ?? [];
    const pool = routePool(day);
    const studentRides = day.transitRides ?? [];
    const today = seriesForWeekday(observations, weekday, { primaryOnly: true });
    const seed = `${weekday}`;
    const entrances = new EntranceIndex(day.locations, ENTRANCE_CLEAR_METRES);
    // Clearance of each route at 10 m steps, worked out once per step (0 unknown, 1 clear, 2 not).
    const clearance = new Map<PoolRoute, Uint8Array>();
    const clearAt = (route: PoolRoute, x: number) => {
      let flags = clearance.get(route);
      if (!flags) clearance.set(route, (flags = new Uint8Array(Math.ceil(route.max / 10) + 2)));
      const i = Math.round(x / 10);
      if (!flags[i]) flags[i] = entrances.clear(positionAt(route.route, i * 10)) ? 1 : 2;
      return flags[i] === 1;
    };
    /** The nearest 10 m step to m (stepping toward `toward` first) that is clear of every BU building. */
    const settle = (route: PoolRoute, m: number, toward: number): number | null => {
      const sign = Math.sign(toward - m) || 1;
      const base = Math.round(m / 10) * 10;
      for (let k = 0; k <= 8; k++) {
        for (const x of k === 0 ? [base] : [base + sign * k * 10, base - sign * k * 10]) {
          if (x >= route.min && x <= route.max && clearAt(route, x)) return x;
        }
      }
      return null;
    };
    let next = 0;
    const add = (walk: Omit<PublicWalk, 'id' | 'model'>) => {
      const id = `${PUBLIC_ID_PREFIX}${next++}`;
      const full: PublicWalk = { ...walk, id, model: hash(id) % MODELS };
      this.walks.push(full);
      return full;
    };

    // ---- transit riders
    const servingCache = new Map<string, { route: PoolRoute; m: number }[]>();
    const serving = (stop: string, position: LngLat) => {
      let list = servingCache.get(stop);
      if (list) return list;
      list = [];
      // Routes leaving the stop, else routes passing it; a stop no saved walk reaches takes the nearest sidewalk.
      for (const radius of [STOP_RADIUS_METRES, STOP_FALLBACK_METRES]) {
        for (const route of pool) {
          if (route.key.startsWith(`stop:${stop}>`)) { list.push({ route, m: 0 }); continue; }
          if (!nearBox(route.bbox, position, radius)) continue;
          const m = nearestOnRoute(route.route, position, radius);
          if (m !== null && m >= route.min && m <= route.max) list.push({ route, m });
        }
        if (list.length) break;
      }
      servingCache.set(stop, list);
      return list;
    };
    let transitSeries = 0;
    for (const series of today.transit) {
      const bounds = binBounds(series.bins);
      const students = smooth(simulatedTransit(studentRides, series));
      const known = extras.filter((x) => x.inObservedCounts && x.transit).map((x) => x.transit!(series));
      const gap = series.bins.map((b, i) => Math.max(0, b.value - students[i] - known.reduce((s, k) => s + (k[i] ?? 0), 0)));
      const people = wholePeople(gap);
      const options = serving(series.stop.mapStopId, series.stop.position);
      if (!options.length || !people.some((n) => n > 0)) continue;
      transitSeries++;
      const kind = series.kind === 'apc-alightings' ? 'alight' : 'board';
      const direction = series.direction ?? 0;
      const visits = series.route !== 'Green' && series.direction !== null
        ? transit?.visits(series.stop.mapStopId, series.route, series.direction, weekday, kind) : undefined;
      people.forEach((n, bin) => {
        const [start, end] = bounds[bin];
        const times = visits ? (kind === 'alight' ? visits.arrivals : visits.departures).filter((t) => t >= start && t < end) : [];
        for (let k = 0; k < n; k++) {
          const key = `${seed}|${series.id}|${bin}|${k}`;
          const time = times.length ? times[Math.floor(unit(`${key}|v`) * times.length)] : start + unit(`${key}|t`) * (end - start);
          // Walk away from the stop (alight) or toward it (board), along whichever way has room,
          // to a point clear of BU buildings (another route serving the stop if this one has none).
          let walk: { route: PoolRoute; m: number; far: number } | null = null;
          for (let attempt = 0; attempt < 4 && !walk; attempt++) {
            const { route, m } = options[Math.floor(unit(`${key}|r${attempt}`) * options.length)];
            const forwardRoom = route.max - m, backRoom = m - route.min;
            const forward = backRoom < 60 || (forwardRoom >= 60 && unit(`${key}|d`) < 0.5);
            const distance = Math.min(between(`${key}|m`, RIDER_WALK_METRES), forward ? forwardRoom : backRoom);
            const far = distance >= 20 ? settle(route, forward ? m + distance : m - distance, m) : null;
            if (far !== null && Math.abs(far - m) >= 20) walk = { route, m, far };
          }
          if (!walk) continue;
          const { route, m, far } = walk;
          const distance = Math.abs(far - m);
          const speed = between(`${key}|s`, WALK_SPEED);
          const gated = series.kind === 'gated-entries';
          if (kind === 'alight') {
            const depart = time + ALIGHT_SECONDS;
            add({ route: route.route, from: m, to: far, depart, speed, purpose: 'alight', stop: series.stop.mapStopId });
            this.rides.push({ kind, route: series.route, direction, stop: series.stop.mapStopId, time });
          } else {
            // Gated entries happen as the rider reaches the gates; APC boardings at the departure.
            const reach = gated ? time : time - between(`${key}|w`, BOARD_WAIT_SECONDS);
            const walker = add({ route: route.route, from: far, to: m, depart: reach - distance / speed, speed, purpose: 'board', stop: series.stop.mapStopId });
            this.rides.push({ kind, route: series.route, direction, stop: series.stop.mapStopId, time, waitStart: reach });
            // Then they stand at the stop until their vehicle leaves (inside the gates, out of sight, at a gated station).
            if (!gated && time > reach) this.addWait({ id: walker.id, model: walker.model, stop: series.stop.mapStopId, route: series.route,
              direction: direction as 0 | 1, position: series.stop.position, boardsAt: time, waitStart: reach });
          }
        }
      });
    }
    const riders = this.walks.length;

    // ---- through walkers at the count sites
    // Weekday counts only exist; weekends use the weekday people-per-activity ratio (siteHourlyTargets).
    const weekdaySeries = observations.pedestrian.filter((s) => s.dayType === 'weekday' && s.quality !== 'context' && s.bins.length);
    const observedToday = dayTypeFor(weekday, 'pedestrian') === 'weekday';
    const weekdayProfile = activityProfile(observations, 2);
    const profile = activityProfile(observations, weekday);
    // One target per place: the newest study for each counted hour; the newest study's screen for the fill.
    const clusters = siteClusters(weekdaySeries);
    const sites = clusters.map((c) => c.reference);
    for (const site of sites) {
      const byRoute = new Map<WalkRoute, { m: number; event: ScreenEvent }[]>();
      const screen = screenOf(site);
      const reach = (screen.type === 'cordon' ? screen.radiusMetres : 60) + 5;
      for (const route of pool) {
        if (!nearBox(route.bbox, site.position, reach)) continue;
        const events = screenEvents(route.route.path, site.position, screenOf(site))
          .map((event) => ({ event, m: route.route.cumulative[event.segment] + event.fraction * ((route.route.cumulative[event.segment + 1] ?? route.route.cumulative[event.segment]) - route.route.cumulative[event.segment]) }));
        if (events.length) byRoute.set(route.route, events);
      }
      this.siteEvents.set(site.id, byRoute);
    }
    const hourlySite = (site: PedestrianSeries): PedestrianSeries => ({ ...site, bins: HOURLY });
    // residual[site][hour] = target total - students - public riders already passing - known extras,
    // each counted through the screen of the study that sets that hour's target.
    const residual = new Map<string, number[]>();
    const quarterWeights = new Map<string, (number[] | null)[]>();
    for (const cluster of clusters) {
      const site = cluster.reference;
      const targets = siteHourlyTargets(cluster.series, weekdayProfile, profile, observedToday);
      if (targets.every((t) => t === null)) continue;
      const hours = observedHours(cluster.series);
      const others = new Map<string, number[]>();
      const othersOf = (s: PedestrianSeries) => {
        let v = others.get(s.id);
        if (!v) {
          const hourly = hourlySite(s);
          const students = simulatedPedestrians(day.trips, hourly); // hundreds an hour: not smoothed
          const riders = this.pedestrianCounts(hourly);
          const known = extras.filter((x) => x.inObservedCounts && x.pedestrians).map((x) => x.pedestrians!(hourly));
          others.set(s.id, (v = students.map((n, h) => n + riders[h] + known.reduce((sum, k) => sum + (k[h] ?? 0), 0))));
        }
        return v;
      };
      residual.set(site.id, targets.map((t, h) => (t === null ? 0 : t - othersOf(observedToday ? hours.get(h)?.series ?? site : site)[h])));
      // Within a counted hour, public passes follow the counted quarter hours (less the students in each).
      const studentBins = new Map<string, number[]>();
      quarterWeights.set(site.id, Array.from({ length: 24 }, (_, h) => {
        const o = observedToday ? hours.get(h) : undefined;
        if (!o?.quarters) return null;
        let students = studentBins.get(o.series.id);
        if (!students) studentBins.set(o.series.id, (students = simulatedPedestrians(day.trips, o.series)));
        const bounds = binBounds(o.series.bins);
        const w = o.quarters.map((v, q) => {
          const i = bounds.findIndex(([start]) => start === h * 3600 + q * 900);
          return Math.max(0, v - (i >= 0 ? students![i] : 0));
        });
        return w.some((x) => x > 0) ? w : null;
      }));
    }
    const candidates = new Map<string, { route: PoolRoute; m: number }[]>();
    // Every count-site crossing along each route, so a walk's crossings are a filter, not a search.
    const crossingsOn = new Map<WalkRoute, { site: string; m: number }[]>();
    for (const site of sites) {
      const list: { route: PoolRoute; m: number }[] = [];
      for (const route of pool) {
        for (const e of this.siteEvents.get(site.id)?.get(route.route) ?? []) {
          if (e.m >= route.min && e.m <= route.max) list.push({ route, m: e.m });
          crossingsOn.set(route.route, [...(crossingsOn.get(route.route) ?? []), { site: site.id, m: e.m }]);
        }
      }
      candidates.set(site.id, list);
    }
    const crossedBy = (route: WalkRoute, lo: number, hi: number) => (crossingsOn.get(route) ?? []).filter((x) => x.m >= lo && x.m < hi);
    for (let h = 0; h < 24; h++) {
      let guard = 0;
      for (;;) {
        let best: string | null = null, most = 0.5;
        for (const [id, r] of residual) if (r[h] > most && candidates.get(id)!.length) { most = r[h]; best = id; }
        if (!best || guard++ > 20000) break;
        const list = candidates.get(best)!;
        const key = `${seed}|through|${h}|${guard}`;
        let chosen: { route: PoolRoute; lo: number; hi: number; at: number; crossed: { site: string; m: number }[] } | null = null;
        let chosenScore = -Infinity;
        for (let c = 0; c < 8; c++) {
          const { route, m } = list[Math.floor(unit(`${key}|c${c}`) * list.length)];
          for (const lengths of [THROUGH_WALK_METRES, SHORT_WALK_METRES]) {
            const lo = settle(route, Math.max(route.min, m - between(`${key}|a${c}`, lengths)), m);
            const hi = settle(route, Math.min(route.max, m + between(`${key}|b${c}`, lengths)), m);
            if (lo === null || hi === null || lo > m || hi < m || hi - lo < 20) continue;
            const crossed = crossedBy(route.route, lo, hi);
            const score = crossed.reduce((s, x) => s + ((residual.get(x.site)?.[h] ?? 0) >= 0.5 ? 1 : -1.5), 0) - (lengths === SHORT_WALK_METRES ? 0.25 : 0);
            if (score > chosenScore) { chosenScore = score; chosen = { route, lo, hi, at: m, crossed }; }
          }
        }
        if (!chosen) { residual.get(best)![h] = 0; continue; }
        // Busy hours take several people along the chosen stretch at once (each at their own time and pace).
        const crossedResidual = Math.min(...chosen.crossed.map((x) => residual.get(x.site)?.[h] ?? 0));
        const people = Math.max(1, Math.min(6, Math.floor(Math.max(most, crossedResidual) / 40)));
        const weights = quarterWeights.get(best)?.[h];
        for (let k = 0; k < people; k++) {
          const each = `${key}|${k}`;
          const speed = between(`${each}|s`, WALK_SPEED);
          const forward = unit(`${each}|d`) < 0.5;
          const from = forward ? chosen.lo : chosen.hi, to = forward ? chosen.hi : chosen.lo;
          let passAt = h * 3600 + unit(`${each}|t`) * 3600;
          if (weights) {
            const total = weights.reduce((s, w) => s + w, 0);
            let pick = unit(`${each}|q`) * total, q = 0;
            while (q < 3 && pick >= weights[q]) pick -= weights[q++];
            passAt = h * 3600 + q * 900 + unit(`${each}|t`) * 900;
          }
          const depart = passAt - Math.abs(chosen.at - from) / speed;
          add({ route: chosen.route.route, from, to, depart, speed, purpose: 'through' });
          for (const x of chosen.crossed) {
            const hour = Math.floor((depart + Math.abs(x.m - from) / speed) / 3600);
            const r = residual.get(x.site);
            if (r && hour >= 0 && hour < 24) r[hour] -= 1;
          }
        }
      }
    }

    for (const walk of this.walks) {
      const end = walk.depart + Math.abs(walk.to - walk.from) / walk.speed;
      for (let b = Math.floor(walk.depart / BUCKET); b <= Math.floor(end / BUCKET); b++) {
        const list = this.buckets.get(b) ?? [];
        list.push(walk); this.buckets.set(b, list);
      }
    }
    this.stats = { walks: this.walks.length, riders, through: this.walks.length - riders, sites: residual.size, transitSeries };
  }

  /** Public walkers on the streets at time t (ids `public-N`, never a student id). */
  walkingAt(t: number): WalkingAgent[] {
    const out: WalkingAgent[] = [];
    for (const walk of this.buckets.get(Math.floor(t / BUCKET)) ?? []) {
      const travelled = (t - walk.depart) * walk.speed;
      const length = Math.abs(walk.to - walk.from);
      if (travelled < 0 || travelled >= length) continue;
      const forward = walk.to >= walk.from;
      const at = pointAt(walk.route, walk.from + (forward ? travelled : -travelled));
      out.push({ id: walk.id, model: walk.model, position: [at.position[0], at.position[1], 0],
        bearing: forward ? at.bearing : (at.bearing + 180) % 360, to: walk.stop ?? 'street' });
    }
    return out;
  }

  countAt(t: number): number {
    let n = 0;
    for (const walk of this.buckets.get(Math.floor(t / BUCKET)) ?? []) {
      const travelled = (t - walk.depart) * walk.speed;
      if (travelled >= 0 && travelled < Math.abs(walk.to - walk.from)) n++;
    }
    return n;
  }

  /** Public riders at a transit series' stop in each of its bins. */
  transitCounts(series: TransitSeries): number[] {
    return simulatedTransit(this.rides, series);
  }

  /** Public walkers passing a pedestrian site's screen in each of its bins (same rule as for students). */
  pedestrianCounts(site: PedestrianSeries): number[] {
    const bounds = binBounds(site.bins);
    const out = new Array(bounds.length).fill(0);
    let byRoute = this.siteEvents.get(site.id);
    if (!byRoute) {
      byRoute = new Map();
      for (const walk of this.walks) {
        if (byRoute.has(walk.route)) continue;
        const events = screenEvents(walk.route.path, site.position, screenOf(site));
        byRoute.set(walk.route, events.map((event) => ({ event, m: walk.route.cumulative[event.segment] + event.fraction * ((walk.route.cumulative[event.segment + 1] ?? walk.route.cumulative[event.segment]) - walk.route.cumulative[event.segment]) })));
      }
      this.siteEvents.set(site.id, byRoute);
    }
    const screen = screenOf(site);
    for (const walk of this.walks) {
      const events = byRoute.get(walk.route);
      const lo = Math.min(walk.from, walk.to), hi = Math.max(walk.from, walk.to);
      const count = (m: number) => {
        const i = binOf(bounds, walk.depart + Math.abs(m - walk.from) / walk.speed);
        if (i >= 0) out[i]++;
      };
      // Starting inside a cordon counts as passing it, as it does for a student's walk.
      const startsInside = screen.type === 'cordon' && metresBetween(pointAt(walk.route, walk.from).position, site.position) <= screen.radiusMetres;
      if (startsInside) count(walk.from);
      for (const e of events ?? []) {
        if (e.m < lo || e.m >= hi) continue;
        if (startsInside && Math.abs(e.m - walk.from) < 1) continue;
        count(e.m);
      }
    }
    return out;
  }
}

export function buildPublicCrowd(input: PublicCrowdInput): PublicCrowd {
  return new PublicCrowd(input);
}
