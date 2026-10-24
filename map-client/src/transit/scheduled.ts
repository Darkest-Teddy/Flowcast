// Scheduled transit for playback mode. Live MBTA and BU feeds can only move at real time, so
// when the simulated day is fast-forwarded (30x, 120x...) trains and buses come from here
// instead: they run on the same tracks at typical headways and speeds, dwell at every stop,
// and follow the simulation clock, so they stay in proportion to the walkers.
import type { Arrival, TransitData, TransitRoute, Vehicle } from './mbta';
import { isUnderground, pointAlong, snapToTracks, type Track } from './tracks';

/** Typical service, in seconds: [peak headway, off-peak headway, cruise speed m/s, dwell s]. */
const SERVICE: Record<TransitRoute['kind'], [number, number, number, number]> = {
  subway: [6 * 60, 9 * 60, 8, 25], // Green Line surface running down the Comm Ave median
  bus: [10 * 60, 15 * 60, 6, 20],
  shuttle: [15 * 60, 20 * 60, 6, 30],
};
// The 57 and the B branch are the busiest services through campus.
const HEADWAY_OVERRIDE: Record<string, [number, number]> = { '57': [8 * 60, 12 * 60], 'Green-B': [5 * 60, 8 * 60] };
const SERVICE_START = 5.5 * 3600;
const SERVICE_END = 24.5 * 3600;
const STOP_SNAP_METRES = 35;

const isPeak = (t: number) => (t >= 7 * 3600 && t < 10 * 3600) || (t >= 16 * 3600 && t < 19 * 3600);

interface Profile {
  track: Track;
  kind: TransitRoute['kind'];
  stops: { stopId: string; s: number; arrive: number; depart: number }[]; // times from leaving the start
  speed: number;
  total: number; // seconds from start to end of track
  offset: number; // seconds: staggers routes so they don't all depart together
  headway: [number, number];
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class ScheduledTransit {
  readonly state: { arrivals: Arrival[] } = { arrivals: [] };
  private readonly profiles: Profile[];
  private vehicles: Vehicle[] = [];
  private time = 0;

  constructor(
    data: TransitData,
    readonly tracks: Track[],
  ) {
    const routes = new Map(data.routes.map((r) => [r.id, r]));
    this.profiles = tracks.flatMap((track): Profile[] => {
      const route = routes.get(track.route);
      if (!route) return [];
      const [peak, off, speed, dwell] = SERVICE[route.kind];
      const stops = data.stops
        .filter((s) => s.routes.includes(route.id))
        .map((s) => ({ stopId: s.id, hit: snapToTracks([track], s.position) }))
        .filter((x) => x.hit && x.hit.distance <= STOP_SNAP_METRES)
        .map((x) => ({ stopId: x.stopId, s: x.hit!.s }))
        .sort((a, b) => a.s - b.s);
      let clock = 0;
      let at = 0;
      const timed = stops.map((stop) => {
        clock += (stop.s - at) / speed;
        at = stop.s;
        const arrive = clock;
        clock += dwell;
        return { ...stop, arrive, depart: clock };
      });
      const total = clock + (track.length - at) / speed;
      const headway = HEADWAY_OVERRIDE[route.id] ?? [peak, off];
      return [{ track, kind: route.kind, stops: timed, speed, total, offset: hash(`${track.route}:${track.direction}`) % headway[1], headway }];
    });
  }

  /** Advance to simulation time `t` (seconds since midnight). Call once per frame. */
  setTime(t: number) {
    this.time = t;
    const vehicles: Vehicle[] = [];
    const arrivals: Arrival[] = [];
    const wallNow = Date.now();
    for (const p of this.profiles) {
      const headway = isPeak(t) ? p.headway[0] : p.headway[1];
      // Every departure from the start of the track that is still somewhere along it.
      const first = Math.ceil((t - p.total - p.offset) / headway);
      const last = Math.floor((t - p.offset) / headway);
      for (let n = first; n <= last; n++) {
        const departed = n * headway + p.offset;
        if (departed < SERVICE_START || departed > SERVICE_END) continue;
        const v = this.vehicleAt(p, t - departed, `${p.track.route}-${p.track.direction}-${n}`);
        if (v) vehicles.push(v);
      }
      // Next two arrivals at each stop. Shown as "sim minutes from now" via a wall-clock time.
      for (const stop of p.stops) {
        const k = Math.ceil((t - stop.arrive - p.offset) / headway);
        for (const n of [k, k + 1]) {
          const eta = n * headway + p.offset + stop.arrive - t;
          const departed = n * headway + p.offset;
          if (departed < SERVICE_START || departed > SERVICE_END) continue;
          arrivals.push({ stop: stop.stopId, route: p.track.route, direction: p.track.direction, time: wallNow + eta * 1000 });
        }
      }
    }
    this.vehicles = vehicles;
    this.state.arrivals = arrivals;
  }

  private vehicleAt(p: Profile, elapsed: number, id: string): Vehicle | null {
    let s = 0;
    let stopped = false;
    let prevS = 0;
    let prevTime = 0;
    let done = false;
    for (const stop of p.stops) {
      if (elapsed < stop.arrive) {
        s = prevS + (elapsed - prevTime) * p.speed;
        done = true;
        break;
      }
      if (elapsed < stop.depart) {
        s = stop.s;
        stopped = true;
        done = true;
        break;
      }
      prevS = stop.s;
      prevTime = stop.depart;
    }
    if (!done) s = Math.min(p.track.length, prevS + (elapsed - prevTime) * p.speed);
    if (isUnderground(p.track, s)) return null;
    const at = pointAlong(p.track, s);
    return {
      id,
      route: p.track.route,
      direction: p.track.direction,
      label: 'scheduled',
      status: stopped ? 'STOPPED_AT' : 'IN_TRANSIT_TO',
      bearing: at.bearing,
      position: at.position,
      from: at.position,
      to: at.position,
      receivedAt: 0,
      interval: 1,
      track: p.track,
      sFrom: s,
      sTo: s,
    };
  }

  positionsAt(): Vehicle[] {
    return this.vehicles;
  }

  nextArrivals(stopId: string, now = Date.now()): Arrival[] {
    const best = new Map<string, Arrival>();
    for (const a of this.state.arrivals) {
      if (a.stop !== stopId || a.time < now - 30_000) continue;
      const key = `${a.route}:${a.direction}`;
      if (!best.has(key) || a.time < best.get(key)!.time) best.set(key, a);
    }
    return [...best.values()].sort((a, b) => a.route.localeCompare(b.route) || a.direction - b.direction);
  }

  nextEachWay(stopId: string, now = Date.now()): Partial<Record<0 | 1, Arrival>> {
    const out: Partial<Record<0 | 1, Arrival>> = {};
    for (const a of this.nextArrivals(stopId, now)) if (!out[a.direction] || a.time < out[a.direction]!.time) out[a.direction] = a;
    return out;
  }

  get currentTime() {
    return this.time;
  }
}
