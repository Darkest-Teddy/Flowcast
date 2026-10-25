// Real observed counts near BU (MBTA ridership, pedestrian counts) and pure helpers that turn a
// simulated day into the same measurements, so the model can be scored against them.
//
// The file is built by data-pipeline/fetch_calibration_observations.py; see
// docs/calibration-observations.md for sources, coverage and caveats.
import type { TransitRide, Trip } from '../sim/playback';

export type ObservationDayType = 'weekday' | 'friday' | 'saturday' | 'sunday';
export type LngLat = [number, number];

/** One measured interval. Times are "HH:MM" local Boston time on the calendar day; end may be "24:00". */
export interface ObservationBin {
  start: string; end: string; value: number;
  /** Reporting dates behind this bin mean; absent periods are not zero observations. */
  days?: number;
  dates?: string[];
}

export interface ObservationSource {
  id: string;
  title: string;
  url: string;
  license: string;
  period: string;
  notes: string;
  [key: string]: unknown;
}

export interface TransitSeries {
  id: string;
  kind: 'gated-entries' | 'apc-boardings' | 'apc-alightings';
  mode: 'subway' | 'light-rail' | 'bus';
  stop: { name: string; mapStopId: string; mbtaStopIds: string[]; position: LngLat };
  /** GTFS route id, or "Green" for a gated station shared by every Green Line branch. */
  route: string;
  direction: 0 | 1 | null;
  dayType: ObservationDayType;
  bins: ObservationBin[];
  unit: string;
  source: string;
  period?: string;
  /** Plausible share of the counted people who are BU students: [low, high]. */
  expectedStudentShare: [number, number];
  /** `primary`: a calibration target. `comparison`: another measurement of the same flow. */
  role?: 'primary' | 'comparison';
  notes?: string;
}

/**
 * How a count site sees people. A cordon counts everyone entering a circle; a line counts crossings
 * of one screenline; `lines` is an intersection's crosswalks: a short line across each mapped
 * crosswalk segment, segments grouped into legs (`group`) so that crossing one leg in several
 * segments (Comm Ave's carriageways and trackbed) counts once per pass (passes within
 * `mergeMetres` of walking).
 */
export type Screen =
  | { type: 'cordon'; radiusMetres: number }
  | { type: 'line'; from: LngLat; to: LngLat }
  | { type: 'lines'; lines: { from: LngLat; to: LngLat; group?: string }[]; mergeMetres?: number };

export interface PedestrianSeries {
  id: string;
  site: string;
  position: LngLat;
  measure?: 'intersection-crossings' | 'screenline';
  screen?: Screen;
  date: string;
  dayType: ObservationDayType;
  /** Weekdays (0 = Monday) the count was taken on, when known. */
  weekdays?: number[];
  bins: ObservationBin[];
  unit: string;
  direction: string | null;
  source: string;
  /** `context`: old or out-of-term counts; not a calibration target. */
  quality?: 'primary' | 'context';
  expectedStudentShare: [number, number];
  notes?: string;
}

export interface CalibrationObservations {
  schemaVersion: 1;
  generatedAt: string;
  notes?: string[];
  sources: ObservationSource[];
  transit: TransitSeries[];
  pedestrian: PedestrianSeries[];
}

export async function loadObservations(url = '/data/calibration-observations.json'): Promise<CalibrationObservations> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Calibration observations unavailable (${response.status})`);
  const data = await response.json();
  if (!isObservations(data)) throw new Error('Unsupported calibration observations file');
  return data;
}

export function isObservations(data: unknown): data is CalibrationObservations {
  const d = data as CalibrationObservations | null;
  return !!d && d.schemaVersion === 1 && Array.isArray(d.transit) && Array.isArray(d.pedestrian) && Array.isArray(d.sources);
}

// ------------------------------------------------------------------ day types and bins

/** The MBTA day type a simulated weekday (0 = Monday) is compared with. Bus APC splits Friday off; rail and counts don't. */
export function dayTypeFor(weekday: number, mode: TransitSeries['mode'] | 'pedestrian'): ObservationDayType {
  if (weekday === 5) return 'saturday';
  if (weekday === 6) return 'sunday';
  return weekday === 4 && mode === 'bus' ? 'friday' : 'weekday';
}

/** Series measured on the kind of day the simulated weekday is. */
export function seriesForWeekday(data: CalibrationObservations, weekday: number, options: { primaryOnly?: boolean } = {}) {
  const primary = options.primaryOnly ?? false;
  return {
    transit: data.transit.filter((s) => s.dayType === dayTypeFor(weekday, s.mode) && (!primary || s.role !== 'comparison')),
    pedestrian: data.pedestrian.filter((s) => s.dayType === dayTypeFor(weekday, 'pedestrian')
      && (!s.weekdays?.length || s.weekdays.includes(weekday)) && (!primary || s.quality !== 'context')),
  };
}

/** "07:30" -> 27000 seconds after midnight. */
export function clockSeconds(text: string): number {
  const [h, m] = text.split(':').map(Number);
  return h * 3600 + m * 60;
}

export function binBounds(bins: readonly ObservationBin[]): [number, number][] {
  return bins.map((b) => [clockSeconds(b.start), clockSeconds(b.end)]);
}

/** Smooth only adjacent, equal-duration measured bins; never bridge a missing interval. */
export function smoothObservedBins(values: readonly number[], bins: readonly ObservationBin[]): number[] {
  const bounds = binBounds(bins);
  const adjacent = (a: number, b: number) => a >= 0 && b < bounds.length
    && bounds[a][1] === bounds[b][0]
    && bounds[a][1] - bounds[a][0] === bounds[b][1] - bounds[b][0];
  return values.map((value, i) => ((adjacent(i - 1, i) ? values[i - 1] : value) + 2 * value
    + (adjacent(i, i + 1) ? values[i + 1] : value)) / 4);
}

/** Index of the bin containing t (start inclusive, end exclusive), or -1. */
export function binOf(bounds: readonly [number, number][], t: number): number {
  for (let i = 0; i < bounds.length; i++) if (bounds[i][0] <= t && t < bounds[i][1]) return i;
  return -1;
}

// ------------------------------------------------------------------ simulated transit

type RideLike = Pick<TransitRide, 'kind' | 'route' | 'direction' | 'stop' | 'time'> & { waitStart?: number; cancelledAt?: number };

export function rideMatches(series: TransitSeries, ride: RideLike): boolean {
  if (ride.stop !== series.stop.mapStopId) return false;
  if (series.kind === 'apc-alightings' ? ride.kind !== 'alight' : ride.kind !== 'board') return false;
  if (series.route === 'Green' ? !ride.route.startsWith('Green') : ride.route !== series.route) return false;
  return series.direction === null || ride.direction === series.direction;
}

/**
 * Simulated equivalent of a transit series: riders stepping on or off at that stop in each bin.
 * Gated entries are counted when the rider reaches the station (the start of their wait), APC
 * boardings when the vehicle leaves, alightings when it arrives.
 */
export function simulatedTransit(rides: readonly RideLike[], series: TransitSeries): number[] {
  const bounds = binBounds(series.bins);
  const out = new Array(bounds.length).fill(0);
  for (const ride of rides) {
    if (ride.cancelledAt !== undefined || !rideMatches(series, ride)) continue;
    const t = series.kind === 'gated-entries' ? ride.waitStart ?? ride.time : ride.time;
    const i = binOf(bounds, t);
    if (i >= 0) out[i]++;
  }
  return out;
}

// ------------------------------------------------------------------ simulated pedestrians

/** A point where a path enters a site's screen: segment index and fraction along it. */
export interface ScreenEvent { segment: number; fraction: number }

const M_PER_DEG_LAT = 110_540;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

export function screenOf(site: Pick<PedestrianSeries, 'screen'>): Screen {
  return site.screen ?? { type: 'cordon', radiusMetres: 20 };
}

/** Where a path crosses the screen at `center`: cordon entries (including starting inside) or line crossings. */
export function screenEvents(path: readonly LngLat[], center: LngLat, screen: Screen): ScreenEvent[] {
  const kx = mPerDegLng(center[1]);
  const local = (p: LngLat): [number, number] => [(p[0] - center[0]) * kx, (p[1] - center[1]) * M_PER_DEG_LAT];
  const events: ScreenEvent[] = [];
  if (path.length === 0) return events;
  if (screen.type === 'cordon') {
    const r = screen.radiusMetres, r2 = r * r;
    let [x0, y0] = local(path[0]);
    if (x0 * x0 + y0 * y0 <= r2) events.push({ segment: 0, fraction: 0 });
    for (let i = 1; i < path.length; i++) {
      const [x1, y1] = local(path[i]);
      const outside = x0 * x0 + y0 * y0 > r2;
      if (outside && Math.min(x0, x1) <= r && Math.max(x0, x1) >= -r && Math.min(y0, y1) <= r && Math.max(y0, y1) >= -r) {
        // First root of |p0 + f (p1 - p0)|^2 = r^2 with f in [0, 1].
        const dx = x1 - x0, dy = y1 - y0;
        const a = dx * dx + dy * dy, b = 2 * (x0 * dx + y0 * dy), c = x0 * x0 + y0 * y0 - r2;
        const disc = b * b - 4 * a * c;
        if (a > 0 && disc >= 0) {
          const f = (-b - Math.sqrt(disc)) / (2 * a);
          if (f >= 0 && f <= 1) events.push({ segment: i - 1, fraction: f });
        }
      }
      x0 = x1; y0 = y1;
    }
    return events;
  }
  const lines = screen.type === 'line' ? [{ from: screen.from, to: screen.to, group: 'line' }] : screen.lines;
  const pts = path.map(local);
  // Metres walked to each path point, to merge passes over one leg's several segments.
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const hits: { segment: number; fraction: number; group: string; m: number }[] = [];
  lines.forEach((line, index) => {
    const [ax, ay] = local(line.from), [bx, by] = local(line.to);
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      const d = (x1 - x0) * (by - ay) - (y1 - y0) * (bx - ax);
      if (d === 0) continue;
      const f = ((ax - x0) * (by - ay) - (ay - y0) * (bx - ax)) / d;
      const g = ((ax - x0) * (y1 - y0) - (ay - y0) * (x1 - x0)) / d;
      if (f >= 0 && f < 1 && g >= 0 && g <= 1) hits.push({ segment: i - 1, fraction: f, group: line.group ?? `line-${index}`, m: along[i - 1] + f * (along[i] - along[i - 1]) });
    }
  });
  hits.sort((a, b) => a.m - b.m);
  const merge = screen.type === 'lines' ? screen.mergeMetres ?? 40 : 0;
  const lastOfGroup = new Map<string, number>();
  for (const hit of hits) {
    const last = lastOfGroup.get(hit.group);
    lastOfGroup.set(hit.group, hit.m);
    if (last !== undefined && hit.m - last <= merge) continue;
    events.push({ segment: hit.segment, fraction: hit.fraction });
  }
  return events;
}

/** Per-path cache: trips that share a walk route share its path array. Keyed by the site's screen object. */
const eventCache = new WeakMap<readonly LngLat[], Map<Screen | string, ScreenEvent[]>>();
export function cachedScreenEvents(path: readonly LngLat[], site: Pick<PedestrianSeries, 'id' | 'position' | 'screen'>): ScreenEvent[] {
  let bySite = eventCache.get(path);
  if (!bySite) eventCache.set(path, (bySite = new Map()));
  // Copies of a series (other bins) share its screen object; a site without one uses the default cordon.
  const key = site.screen ?? `default|${site.position[0]},${site.position[1]}`;
  let events = bySite.get(key);
  if (!events) bySite.set(key, (events = screenEvents(path, site.position, screenOf(site))));
  return events;
}

type TimedPath = Pick<Trip, 'path' | 'timestamps'>;
/** Trips grouped by their (shared) path with each path's bounding box, worked out once per trip list. */
const groupedTrips = new WeakMap<readonly TimedPath[], { path: readonly LngLat[]; box: [number, number, number, number]; trips: TimedPath[] }[]>();
function tripsByPath(trips: readonly TimedPath[]) {
  let groups = groupedTrips.get(trips);
  if (groups) return groups;
  const byPath = new Map<readonly LngLat[], TimedPath[]>();
  for (const trip of trips) {
    const list = byPath.get(trip.path);
    if (list) list.push(trip); else byPath.set(trip.path, [trip]);
  }
  groups = [...byPath].map(([path, list]) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of path) { if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y; }
    return { path, box: [w, s, e, n] as [number, number, number, number], trips: list };
  });
  groupedTrips.set(trips, groups);
  return groups;
}

/** How far from its position a site's screen reaches, in metres. */
function screenReach(site: Pick<PedestrianSeries, 'position' | 'screen'>): number {
  const screen = screenOf(site);
  if (screen.type === 'cordon') return screen.radiusMetres;
  const lines = screen.type === 'line' ? [screen] : screen.lines;
  const kx = mPerDegLng(site.position[1]);
  let reach = 0;
  for (const l of lines) for (const p of [l.from, l.to]) reach = Math.max(reach, Math.hypot((p[0] - site.position[0]) * kx, (p[1] - site.position[1]) * M_PER_DEG_LAT));
  return reach;
}

/** Simulated pedestrians passing a site's screen in each bin (each pass counts once, like a manual count). */
export function simulatedPedestrians(trips: readonly TimedPath[], site: PedestrianSeries): number[] {
  const bounds = binBounds(site.bins);
  const out = new Array(bounds.length).fill(0);
  if (!bounds.length) return out;
  const first = Math.min(...bounds.map((b) => b[0])), last = Math.max(...bounds.map((b) => b[1]));
  const reach = screenReach(site) + 5;
  const dx = reach / mPerDegLng(site.position[1]), dy = reach / M_PER_DEG_LAT;
  const [px, py] = site.position;
  for (const group of tripsByPath(trips)) {
    const [w, s, e, n] = group.box;
    if (px < w - dx || px > e + dx || py < s - dy || py > n + dy) continue;
    const events = cachedScreenEvents(group.path, site);
    if (!events.length) continue;
    for (const trip of group.trips) {
      const ts = trip.timestamps;
      if (ts[ts.length - 1] < first || ts[0] >= last) continue;
      for (const { segment, fraction } of events) {
        const t = ts[segment] + fraction * ((ts[segment + 1] ?? ts[segment]) - ts[segment]);
        const i = binOf(bounds, t);
        if (i >= 0) out[i]++;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ comparison metrics

/** Pearson correlation of two equal-length series; null when either is constant or too short (< 3 bins). */
export function pearson(a: readonly number[], b: readonly number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 3) return null;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, db = b[i] - mb;
    sab += da * db; saa += da * da; sbb += db * db;
  }
  return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
}

/** Hours between the busiest bins (bin midpoints); null if either series is all zero. */
export function peakHoursApart(bins: readonly ObservationBin[], a: readonly number[], b: readonly number[]): number | null {
  const peak = (v: readonly number[]) => v.reduce((best, x, i) => (x > v[best] ? i : best), 0);
  if (!a.some((x) => x > 0) || !b.some((x) => x > 0)) return null;
  const mid = (i: number) => (clockSeconds(bins[i].start) + clockSeconds(bins[i].end)) / 2;
  return Math.abs(mid(peak(a)) - mid(peak(b))) / 3600;
}

export interface SeriesScore {
  id: string;
  kind: string;
  /** Sum of reported bins, not a measured daily total when coverage/denominators differ. */
  observedTotal: number;
  simulatedTotal: number;
  /** Shape: Pearson r of the bin values (null for < 3 bins or a flat series). */
  pearson: number | null;
  peakHoursApart: number | null;
  /** simulated / observed totals. */
  ratio: number | null;
  /** The band `ratio` should fall in: the student share for students alone, about 1 with everyone. */
  expected: [number, number];
  inBand: boolean | null;
  /** Bins where the simulation is outside observed x [expected low, expected high]. */
  binsOutOfBand: number;
}

export function compareSeries(id: string, kind: string, bins: readonly ObservationBin[], simulated: readonly number[], expected: [number, number]): SeriesScore {
  const observed = bins.map((b) => b.value);
  const observedTotal = observed.reduce((s, v) => s + v, 0);
  const simulatedTotal = simulated.reduce((s, v) => s + v, 0);
  const ratio = observedTotal > 0 ? simulatedTotal / observedTotal : null;
  let binsOutOfBand = 0;
  observed.forEach((v, i) => { if (simulated[i] < v * expected[0] - 0.5 || simulated[i] > v * expected[1] + 0.5) binsOutOfBand++; });
  return {
    id, kind, observedTotal, simulatedTotal,
    pearson: pearson(observed, simulated), peakHoursApart: peakHoursApart(bins, observed, simulated),
    ratio, expected, inBand: ratio === null ? null : ratio >= expected[0] && ratio <= expected[1], binsOutOfBand,
  };
}

/** Everyone (students plus the public crowd) should match the observed totals within this band. */
export const EVERYONE_BAND: [number, number] = [0.85, 1.15];

export interface DayCounts {
  rides: readonly RideLike[];
  trips: readonly Pick<Trip, 'path' | 'timestamps'>[];
  /** Extra simulated counts (e.g. the public crowd) added bin by bin to the students'. */
  extraTransit?: (series: TransitSeries) => number[];
  extraPedestrians?: (site: PedestrianSeries) => number[];
}

/** Score one simulated day against every series for its day type. */
export function scoreDay(data: CalibrationObservations, weekday: number, counts: DayCounts, options: { primaryOnly?: boolean; everyone?: boolean } = {}): SeriesScore[] {
  const { transit, pedestrian } = seriesForWeekday(data, weekday, { primaryOnly: options.primaryOnly ?? true });
  const add = (a: number[], b?: number[]) => (b ? a.map((v, i) => v + (b[i] ?? 0)) : a);
  const band = (share: [number, number]) => (options.everyone ? EVERYONE_BAND : share);
  return [
    ...transit.map((s) => compareSeries(s.id, s.kind, s.bins, add(simulatedTransit(counts.rides, s), counts.extraTransit?.(s)), band(s.expectedStudentShare))),
    ...pedestrian.map((s) => compareSeries(s.id, 'pedestrian', s.bins, add(simulatedPedestrians(counts.trips, s), counts.extraPedestrians?.(s)), band(s.expectedStudentShare))),
  ];
}
