// Scheduled transit for playback mode. Live MBTA and BU feeds can only move at real time, so
// when the simulated day is played back or fast-forwarded (1x, 30x, 120x...) trains and buses
// come from here instead: they run on the same tracks at typical headways, accelerate and brake
// (motion.ts), dwell at every stop, wait at red signals on the simulation clock, and follow the
// simulation clock, so they stay in proportion to the walkers.
import type { Arrival, TransitData, TransitRoute, Vehicle } from './mbta';
import { isUnderground, pointAlong, type Track } from './tracks';
import { nominalTripSeconds, planTrip, trackFeatures, tripAt, type TrackFeatures, type TripPlan } from './motion';

/** Typical service, in seconds: [peak headway, off-peak headway, dwell]. */
const SERVICE: Record<TransitRoute['kind'], [number, number, number]> = {
  subway: [6 * 60, 9 * 60, 25], // Green Line surface running down the Comm Ave median
  bus: [10 * 60, 15 * 60, 15],
  shuttle: [15 * 60, 20 * 60, 25],
};
// The 57 and the B branch are the busiest services through campus.
const HEADWAY_OVERRIDE: Record<string, [number, number]> = { '57': [8 * 60, 12 * 60], 'Green-B': [5 * 60, 8 * 60] };
const SERVICE_START = 5.5 * 3600;
const SERVICE_END = 24.5 * 3600;
// Trips can run this much longer than their nominal time per signal on the way (worst case:
// arriving just as it turns red), which bounds which departures can still be on the track.
const SIGNAL_ALLOWANCE = 75;

const isPeak = (t: number) => (t >= 7 * 3600 && t < 10 * 3600) || (t >= 16 * 3600 && t < 19 * 3600);

interface Profile {
  track: Track;
  name: string; // vehicle id prefix: route-direction, plus a branch number where a route has several
  kind: TransitRoute['kind'];
  dwell: number;
  features: TrackFeatures | null;
  span: number; // the longest a trip can take, seconds
  offset: number; // seconds: staggers routes so they don't all depart together
  headway: [number, number];
  plans: Map<number, TripPlan>; // by departure time
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
    private readonly data: TransitData,
    readonly tracks: Track[],
  ) {
    const routes = new Map(data.routes.map((r) => [r.id, r]));
    const seen = new Map<string, number>();
    this.profiles = tracks.flatMap((track): Profile[] => {
      const route = routes.get(track.route);
      if (!route) return [];
      const [peak, off, dwell] = SERVICE[route.kind];
      const headway = HEADWAY_OVERRIDE[route.id] ?? [peak, off];
      // Routes with several branches one way (the 8, the 47) get one id prefix per branch.
      const key = `${track.route}-${track.direction}`;
      const branch = seen.get(key) ?? 0;
      seen.set(key, branch + 1);
      const name = branch ? `${key}b${branch}` : key;
      return [{ track, name, kind: route.kind, dwell, features: null, span: 0, offset: hash(`${track.route}:${track.direction}`) % headway[1], headway, plans: new Map() }];
    });
  }

  /** Stops and signals along a profile's track; plans are redone if they change (street loaded). */
  private featuresOf(p: Profile): TrackFeatures {
    const features = trackFeatures(p.track, p.kind, this.data.stops);
    if (features !== p.features) {
      p.features = features;
      p.span = nominalTripSeconds(p.track, features, p.kind, p.dwell) + SIGNAL_ALLOWANCE * (features.signals.length + 1);
      p.plans.clear();
    }
    return features;
  }

  private planFor(p: Profile, departed: number): TripPlan {
    let plan = p.plans.get(departed);
    if (!plan) {
      plan = planTrip(p.track, p.features!, p.kind, departed, p.dwell);
      p.plans.set(departed, plan);
    }
    return plan;
  }

  /** Advance to simulation time `t` (seconds since midnight). Call once per frame. */
  setTime(t: number) {
    this.time = t;
    const vehicles: Vehicle[] = [];
    const arrivals: Arrival[] = [];
    const wallNow = Date.now();
    for (const p of this.profiles) {
      this.featuresOf(p);
      const headway = isPeak(t) ? p.headway[0] : p.headway[1];
      // Every departure from the start of the track that may still be somewhere along it, and
      // the next two to leave (for arrival times at the first stops).
      const first = Math.ceil((t - p.span - p.offset) / headway);
      const last = Math.floor((t - p.offset) / headway);
      const next = new Map<string, number[]>();
      for (let n = first; n <= last + 2; n++) {
        const departed = n * headway + p.offset;
        if (departed < SERVICE_START || departed > SERVICE_END) continue;
        const plan = this.planFor(p, departed);
        for (const [stop, arrive] of plan.arrivals) {
          if (arrive < t - 30) continue;
          const list = next.get(stop) ?? [];
          list.push(arrive);
          next.set(stop, list);
        }
        if (n > last) continue;
        const v = this.vehicleAt(p, plan, t, `${p.name}-${n}`);
        if (v) vehicles.push(v);
      }
      // Next two arrivals at each stop. Shown as "sim minutes from now" via a wall-clock time.
      for (const [stop, times] of next) {
        for (const arrive of times.sort((a, b) => a - b).slice(0, 2)) {
          arrivals.push({ stop, route: p.track.route, direction: p.track.direction, time: wallNow + (arrive - t) * 1000 });
        }
      }
      // Forget trips long finished or far in the future (after scrubbing).
      if (p.plans.size > 64) {
        for (const departed of p.plans.keys()) if (departed < t - p.span - 600 || departed > t + 4 * headway) p.plans.delete(departed);
      }
    }
    this.vehicles = vehicles;
    this.state.arrivals = arrivals;
  }

  private vehicleAt(p: Profile, plan: TripPlan, t: number, id: string): Vehicle | null {
    const at = tripAt(plan, t);
    if (!at || isUnderground(p.track, at.s)) return null;
    const { position, bearing } = pointAlong(p.track, at.s);
    return {
      id,
      route: p.track.route,
      direction: p.track.direction,
      label: 'scheduled',
      // STOPPED_AT only while standing at a stop; waiting at a red light is still in transit.
      status: at.holding === 'stop' ? 'STOPPED_AT' : 'IN_TRANSIT_TO',
      holding: at.holding,
      speed: at.v,
      bearing,
      position,
      from: position,
      to: position,
      receivedAt: 0,
      interval: 1,
      track: p.track,
      sFrom: at.s,
      sTo: at.s,
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
