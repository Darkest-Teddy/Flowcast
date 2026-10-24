import type { Arrival, TransitData, TransitSource, Vehicle } from './mbta';
import { isUnderground, pointAlong, snapToTracks, type Track } from './tracks';

export interface PublishedScheduleData {
  schemaVersion: 1;
  referenceWeekStart: string;
  dates: string[];
  priorDate: string;
  feed: { start: string; end: string; version: string };
  sourceUrl: string;
  stops: Record<string, { position: [number, number]; mapStopId: string | null }>;
  trips: { id: string; route: string; direction: 0 | 1; weekdays: number[];
    stops: { stop: string; arrival: number; departure: number }[] }[];
}
interface Anchor { s: number; arrival: number; departure: number; mapStopId: string | null }
interface Run {
  id: string; route: string; direction: 0 | 1; weekdays: number[];
  track: Track; anchors: Anchor[]; start: number; end: number;
}
const DAY = 86400;
const SNAP_METRES = 50;

export async function loadPublishedSchedule(url = '/data/transit-schedule.json'): Promise<PublishedScheduleData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Published timetable unavailable (${response.status})`);
  const data = await response.json();
  if (data.schemaVersion !== 1 || !Array.isArray(data.trips) || !data.stops || data.dates?.length !== 7) {
    throw new Error('Unsupported published timetable');
  }
  return data;
}

/** Published dwell/arrival anchors govern movement; route geometry supplies metres. */
export class PublishedTransit implements TransitSource {
  readonly state: { arrivals: Arrival[] } = { arrivals: [] };
  readonly tracks: Track[];
  readonly coverage: { publishedTrips: number; mappedRuns: number; unmappedTrips: number };
  private readonly byDay = new Map<number, Run[]>();
  /** Per weekday and route: first published start and last published end (service-day seconds). */
  private readonly spans = new Map<string, [number, number]>();
  private readonly timetabledRoutes = new Set<string>();
  private readonly routeNames: Map<string, string>;
  private active: { run: Run; offset: number }[] = [];
  private activeKey = '';
  private time = 0;
  private weekday = 2;
  private pendingArrivals: { stop: string; route: string; direction: 0 | 1; at: number }[] = [];

  constructor(data: TransitData, tracks: Track[], schedule: PublishedScheduleData) {
    this.tracks = tracks;
    this.routeNames = new Map(data.routes.map((route) => [route.id, route.name]));
    const byRoute = new Map<string, Track[]>();
    for (const track of tracks) {
      const key = `${track.route}:${track.direction}`;
      const list = byRoute.get(key) ?? [];
      list.push(track); byRoute.set(key, list);
    }
    // Each physical stop is snapped once per route/direction, not once per trip.
    const snaps = new Map<string, ReturnType<typeof snapToTracks>>();
    let mappedTrips = 0, runCount = 0;
    for (const trip of schedule.trips) {
      const possible = byRoute.get(`${trip.route}:${trip.direction}`) ?? [];
      let current: { track: Track; anchors: Anchor[] } | null = null;
      let tripRuns = 0;
      const flush = () => {
        if (current && current.anchors.length >= 2) {
          const anchors = current.anchors;
          const run: Run = { id: `${trip.id}:${tripRuns}`, route: trip.route, direction: trip.direction,
            weekdays: trip.weekdays, track: current.track, anchors,
            start: anchors[0].arrival, end: anchors[anchors.length - 1].departure };
          if (run.end > run.start) {
            for (const day of run.weekdays) {
              const list = this.byDay.get(day) ?? [];
              list.push(run); this.byDay.set(day, list);
            }
            tripRuns++; runCount++;
          }
        }
        current = null;
      };
      for (const stop of trip.stops) {
        const info = schedule.stops[stop.stop];
        const key = `${trip.route}:${trip.direction}:${stop.stop}`;
        if (!snaps.has(key)) snaps.set(key, info ? snapToTracks(possible, info.position) : null);
        const hit = snaps.get(key);
        if (!info || !hit || hit.distance > SNAP_METRES || stop.arrival > stop.departure) { flush(); continue; }
        const previous: Anchor | undefined = current?.anchors[current.anchors.length - 1];
        // Clipped route components and backwards snaps must never become teleporting links.
        if (current && (current.track !== hit.track || (previous &&
          (hit.s < previous.s - 1 || stop.arrival < previous.departure ||
            (hit.s > previous.s + 1 && stop.arrival <= previous.departure))))) flush();
        if (!current) current = { track: hit.track, anchors: [] };
        current.anchors.push({ s: hit.s, arrival: stop.arrival, departure: stop.departure, mapStopId: info.mapStopId });
      }
      flush();
      if (tripRuns) mappedTrips++;
    }
    for (const rows of this.byDay.values()) rows.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
    for (const [day, runs] of this.byDay) for (const run of runs) {
      const key = `${day}|${run.route}`, span = this.spans.get(key);
      this.spans.set(key, span ? [Math.min(span[0], run.start), Math.max(span[1], run.end)] : [run.start, run.end]);
      this.timetabledRoutes.add(run.route);
    }
    this.coverage = { publishedTrips: schedule.trips.length, mappedRuns: runCount, unmappedTrips: schedule.trips.length - mappedTrips };
  }

  setTime(time: number, weekday = 2) {
    if (!Number.isFinite(time) || time < 0 || time >= DAY || !Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      this.active = []; this.state.arrivals = []; this.activeKey = ''; return;
    }
    this.time = time; this.weekday = weekday;
    const key = `${weekday}:${Math.floor(time)}`;
    if (this.activeKey === key) { this.refreshArrivals(); return; }
    this.activeKey = key;
    this.active = [];
    this.pendingArrivals = [];
    // The previous service day contributes its 24:xx/25:xx trips after midnight.
    for (const [day, offset] of [[weekday, 0], [weekday - 1, DAY]]) {
      const serviceTime = time + offset;
      for (const run of this.byDay.get(day) ?? []) {
        if (run.start > serviceTime + 3600) break;
        if (run.end < serviceTime) continue;
        if (run.start <= serviceTime && serviceTime <= run.end) this.active.push({ run, offset });
        for (const anchor of run.anchors) {
          if (anchor.mapStopId && anchor.arrival >= serviceTime && anchor.arrival <= serviceTime + 3600) {
            this.pendingArrivals.push({ stop: anchor.mapStopId, route: run.route, direction: run.direction,
              at: anchor.arrival - offset });
          }
        }
      }
    }
    this.refreshArrivals();
  }

  private refreshArrivals() {
    const now = Date.now();
    this.state.arrivals = this.pendingArrivals.filter((a) => a.at >= this.time).map(({ at, ...arrival }) =>
      ({ ...arrival, time: now + (at - this.time) * 1000 })).sort((a, b) => a.time - b.time);
  }

  positionsAt(now = performance.now()): Vehicle[] {
    const vehicles: Vehicle[] = [];
    for (const { run, offset } of this.active) {
      const t = this.time + offset;
      if (t < run.start || t > run.end) continue;
      const rows = run.anchors;
      let s = rows[rows.length - 1].s;
      let stopped = true;
      for (let i = 0; i < rows.length; i++) {
        const anchor = rows[i];
        if (t >= anchor.arrival && t <= anchor.departure) { s = anchor.s; break; }
        const next = rows[i + 1];
        if (next && anchor.departure < t && t < next.arrival) {
          s = anchor.s + (next.s - anchor.s) * (t - anchor.departure) / (next.arrival - anchor.departure);
          stopped = false; break;
        }
      }
      if (isUnderground(run.track, s)) continue;
      const { position, bearing } = pointAlong(run.track, s);
      vehicles.push({ id: `published:${this.weekday}:${offset}:${run.id}`, route: run.route, direction: run.direction,
        label: this.routeNames.get(run.route) ?? run.route, status: stopped ? 'STOPPED_AT' : 'IN_TRANSIT_TO',
        bearing, position, from: position, to: position, receivedAt: now, interval: 0,
        track: run.track, sFrom: s, sTo: s });
    }
    return vehicles;
  }

  inService(routeId: string): boolean | undefined {
    if (!this.timetabledRoutes.has(routeId)) return undefined;
    const within = (day: number, t: number) => { const span = this.spans.get(`${day}|${routeId}`); return !!span && span[0] <= t && t <= span[1]; };
    return within(this.weekday, this.time) || within((this.weekday + 6) % 7, this.time + DAY);
  }

  nextArrivals(stopId: string, now = Date.now()): Arrival[] {
    return this.state.arrivals.filter((arrival) => arrival.stop === stopId && arrival.time >= now);
  }

  nextEachWay(stopId: string, now = Date.now()): Partial<Record<0 | 1, Arrival>> {
    const result: Partial<Record<0 | 1, Arrival>> = {};
    for (const arrival of this.nextArrivals(stopId, now)) if (!result[arrival.direction]) result[arrival.direction] = arrival;
    return result;
  }
}
