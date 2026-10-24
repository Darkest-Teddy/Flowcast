// People getting on and off the T, MBTA buses and BU shuttles.
//
// Every Green Line surface station and bus / shuttle stop near campus (any stop the pipeline
// wrote `stopRoutes` for) gets one platform per direction it serves. Riders walk to it from a
// nearby building along the real walkway network and stand waiting there. When a *live*
// vehicle stops at the platform, the waiting riders walk the last few metres to its doors and
// vanish into it, and a few riders step off and walk to real campus buildings.
//
// Vehicles come from whichever TransitSource the map is drawing: the live MBTA / BU feeds in Live
// mode, or the schedule on the sim clock when playing back, so riders get on the vehicles you see.
// Everything a rider does runs on simulated time `t` (so 30x / 120x just make people come and go
// faster). Nothing here trusts arrival predictions to bring a vehicle: a prediction that says
// "Now" with no train in sight just leaves the queue waiting.
import type { CampusLocation, DayData, LocationKind, WalkingAgent } from './playback';
import type { TransitData, TransitSource, TransitStop, Vehicle } from '../transit/mbta';
import { distanceMetres, pointAlong, type Track } from '../transit/tracks';

type LngLat = [number, number];
type StopKind = 'subway' | 'bus' | 'shuttle';

// Importance: Green Line > shuttle > bus, and the four big B-branch stops on campus above all.
const BIG_STATIONS = new Set(['place-buest', 'place-bucen', 'place-amory', 'place-babck']);
const UNDERGROUND = new Set(['place-kencl']); // Kenmore's platforms are below the street
type Rank = 'big' | 'station' | 'shuttle' | 'bus';
const BOARD_WEIGHT: Record<Rank, number> = { big: 1, station: 0.55, shuttle: 0.4, bus: 0.2 };
const ALIGHT_WEIGHT: Record<Rank, number> = { big: 1, station: 0.6, shuttle: 0.8, bus: 0.5 };
const STOP_CAP: Record<Rank, number> = { big: 14, station: 10, shuttle: 8, bus: 5 }; // visible waiting, per stop
const INCOMING_ALLOWANCE = 2; // per platform, walking in on top of a full queue (may overfill it by this)
const ARRIVAL_WALK_MAX = 150; // metres: riders heading for a stop appear at most this far out
const ALIGHT_BASE: Record<StopKind, number> = { subway: 10, shuttle: 6, bus: 4 }; // off per vehicle, at the peak
const MAX_ALIGHT = 10;
// Riders per second joining the queue at a big station at the busiest moment of the day.
const PEAK_BOARD_RATE = 0.09;
const BOARDING_SPREAD: [number, number] = [8, 15]; // seconds from first to last of a full queue stepping off toward the doors
// All riders at once (waiting + walking): a few hundred characters at most.
const MAX_RIDERS = 420;
const ALIGHT_RESERVE = 40; // headroom kept for people getting off

// A vehicle is at a platform when it's this close along its track and (nearly) stopped.
const AT_STOP_METRES = 30;
const STOPPED_SPEED = 0.5; // m/s: "barely moving"
// A vehicle gone this long from a platform has left it (real ms or sim seconds, whichever comes
// first: at 120x a scheduled dwell is a fraction of a real second).
const VISIT_EXPIRY_MS = 15_000;
const VISIT_EXPIRY_SIM = 60;
const DOORS_OPEN_MS = 1_500; // doors count as open this long after the vehicle was last seen there...
const DOORS_OPEN_SIM = 5; // ...or this many sim seconds
const SERVICE_CHECK_MS = 5_000;
const SERVICE_HORIZON_MS = 40 * 60_000; // a predicted vehicle within this counts as "served"

// Doors along the vehicle (metres from its centre, + toward the front) and out to its side.
const DOORS: Record<StopKind, number[]> = { subway: [-17, -10, -3.5, 3.5, 10, 17], bus: [4.4, -1.2], shuttle: [4.4, -1.0] };
const DOOR_LATERAL = 1.45;
// Where people wait: a strip beside the track (metres from the track centre, and along it).
const PLATFORM_SHAPE: Record<StopKind, { near: number; far: number; half: number; ahead: number }> = {
  subway: { near: 2.5, far: 4.6, half: 21, ahead: 0 }, // a two-car train's length of platform
  bus: { near: 0.3, far: 1.9, half: 3.5, ahead: 1.5 }, // near/far are beyond the kerb
  shuttle: { near: 0.3, far: 1.9, half: 3.5, ahead: 1.5 },
};
const MIN_SPACING = 0.8; // metres between two people waiting

// How busy each hour is (0-23, interpolated): people about at all, how many leave campus, how many arrive.
const PRESENCE = [0.12, 0.06, 0.03, 0.03, 0.05, 0.15, 0.35, 0.7, 1, 1, 0.95, 0.9, 0.95, 0.9, 0.9, 1, 1.05, 1.05, 0.9, 0.75, 0.6, 0.5, 0.35, 0.2];
const LEAVING = [0.9, 0.9, 0.9, 0.9, 0.6, 0.55, 0.55, 0.6, 0.6, 0.65, 0.7, 0.8, 0.9, 0.9, 0.95, 1.1, 1.35, 1.45, 1.3, 1.1, 1, 1, 1, 0.9];
const ARRIVING = [0.3, 0.3, 0.3, 0.3, 0.4, 0.8, 1.2, 1.5, 1.6, 1.5, 1.3, 1.1, 1, 1, 0.9, 0.8, 0.7, 0.6, 0.55, 0.5, 0.45, 0.4, 0.35, 0.3];

type KindWeights = Record<LocationKind, number>;
// Where people getting off head, and where people catching one come from, by time of day.
const GOING_TO: [number, KindWeights][] = [
  [11, { classroom: 3, library: 1.5, dining: 1, gym: 0.5, dorm: 0.4, 'off-campus': 0 }],
  [16, { classroom: 2, library: 1.5, dining: 2, gym: 0.8, dorm: 0.8, 'off-campus': 0 }],
  [24, { classroom: 0.6, library: 1.2, dining: 2, gym: 1, dorm: 3, 'off-campus': 0 }],
];
const COMING_FROM: [number, KindWeights][] = [
  [11, { classroom: 0.6, library: 0.8, dining: 1, gym: 0.5, dorm: 3, 'off-campus': 0 }],
  [16, { classroom: 2, library: 1.5, dining: 2, gym: 0.8, dorm: 0.8, 'off-campus': 0 }],
  [24, { classroom: 2.5, library: 2, dining: 1.2, gym: 1, dorm: 0.6, 'off-campus': 0 }],
];

const METRES_PER_DEG_LAT = 110_540;
const metresPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

function offset([lng, lat]: LngLat, east: number, north: number): LngLat {
  return [lng + east / metresPerDegLng(lat), lat + north / METRES_PER_DEG_LAT];
}

/** Compass bearing (degrees clockwise from north) from a to b. */
function bearing(a: LngLat, b: LngLat): number {
  const east = (b[0] - a[0]) * metresPerDegLng(a[1]);
  const north = (b[1] - a[1]) * METRES_PER_DEG_LAT;
  return ((Math.atan2(east, north) * 180) / Math.PI + 360) % 360;
}

const unit = (deg: number): [number, number] => [Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180)];
const rightOf = (deg: number): [number, number] => [Math.cos((deg * Math.PI) / 180), -Math.sin((deg * Math.PI) / 180)];
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const walkSpeed = () => rand(1.1, 1.5); // same as the simulated students

function hourly(table: number[], t: number): number {
  const h = (((t / 3600) % 24) + 24) % 24;
  const i = Math.floor(h);
  return table[i] + (table[(i + 1) % 24] - table[i]) * (h - i);
}

function kindWeights(table: [number, KindWeights][], t: number): KindWeights {
  const h = (((t / 3600) % 24) + 24) % 24;
  return table.find(([until]) => h < until)![1];
}

function pickWeighted<T>(items: T[], weight: (item: T) => number): T {
  const weights = items.map(weight);
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < items.length; i++) if ((r -= weights[i]) <= 0) return items[i];
  return items[items.length - 1];
}

function cumulativeOf(path: LngLat[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + distanceMetres(path[i - 1], path[i]));
  return out;
}

/** Nearest point on a track to `p`, optionally only where `p` is no more than `maxLeft` metres left of it. */
function nearestOnTrack(track: Track, p: LngLat, maxLeft = Infinity): { s: number; distance: number; lateral: number } | null {
  const kx = metresPerDegLng(p[1]);
  let best: { s: number; distance: number; lateral: number } | null = null;
  const pts = track.points;
  for (let i = 1; i < pts.length; i++) {
    const ax = (pts[i - 1][0] - p[0]) * kx;
    const ay = (pts[i - 1][1] - p[1]) * METRES_PER_DEG_LAT;
    const sx = (pts[i][0] - pts[i - 1][0]) * kx;
    const sy = (pts[i][1] - pts[i - 1][1]) * METRES_PER_DEG_LAT;
    const len2 = sx * sx + sy * sy || 1;
    const f = Math.max(0, Math.min(1, -(ax * sx + ay * sy) / len2));
    const dx = -(ax + sx * f); // from the track point to p
    const dy = -(ay + sy * f);
    const distance = Math.hypot(dx, dy);
    // Right of travel is +: the right-hand normal of (sx, sy) is (sy, -sx).
    const lateral = (dx * sy - dy * sx) / Math.sqrt(len2);
    if (lateral < -maxLeft) continue;
    if (!best || distance < best.distance) {
      best = { s: track.cumulative[i - 1] + f * (track.cumulative[i] - track.cumulative[i - 1]), distance, lateral };
    }
  }
  return best;
}

/** Metres along a track between a stop and a vehicle; BU shuttle loops wrap round (Agganis Way is both ends). */
function alongDistance(entry: Entry, s: number): number {
  const d = Math.abs(s - entry.s);
  return entry.loop ? Math.min(d, entry.track.length - d) : d;
}

interface StopRoute {
  location: CampusLocation;
  path: LngLat[]; // starts at the stop, then the walk network to the building
  length: number;
}

interface Entry {
  track: Track; // vehicles on this track stop here...
  s: number; // ...this far along it
  side: 1 | -1; // which side of the track the platform is (1 = right of travel)
  loop?: boolean; // the track ends where it starts
}

interface Visit {
  key: string;
  platform: Platform;
  s: number;
  doors: LngLat[];
  lastSeen: number; // performance.now()
  lastSeenT: number; // sim seconds
}

export interface Platform {
  id: string;
  stop: TransitStop;
  kind: StopKind;
  entries: Entry[];
  origin: LngLat; // the track point at the stop
  along: [number, number]; // unit vector (east, north) in the direction of travel
  normal: [number, number]; // unit vector from the track toward where people wait
  near: number;
  far: number;
  half: number;
  ahead: number;
  cap: number;
  boardWeight: number;
  alightWeight: number;
  routes: StopRoute[];
  waiting: Waiter[];
  incoming: Mover[]; // walking here to wait
  acc: number; // arrival accumulator (Poisson)
  nextArrival: number;
  served: boolean; // a vehicle is around or predicted, so it's worth waiting
  visit: Visit | null; // the vehicle at the platform right now
}

interface Waiter {
  agent: WalkingAgent;
  uw: [number, number]; // metres along and out from the platform origin
}

interface Mover {
  agent: WalkingAgent;
  path: LngLat[];
  cumulative: number[];
  start: number; // sim seconds
  speed: number;
  seg: number;
  /** Before `start`: drawn standing at path[0] (a boarder about to go), or not at all (still on board). */
  hiddenBeforeStart: boolean;
  then: 'gone' | 'wait';
  platform?: Platform;
  uw?: [number, number];
  facing?: number;
  waiter?: Waiter;
}

export interface RiderStats {
  platforms: number;
  waiting: number;
  walking: number;
  boarded: number;
  alighted: number;
  visits: number;
}

export class RiderSim {
  readonly platforms: Platform[] = [];
  /** Characters walking (to a stop, to the doors, or off to a building) and standing waiting, for this frame. */
  walking: WalkingAgent[] = [];
  standing: WalkingAgent[] = [];
  readonly stats: RiderStats = { platforms: 0, waiting: 0, walking: 0, boarded: 0, alighted: 0, visits: 0 };

  private readonly byTrack = new Map<Track, { platform: Platform; entry: Entry }[]>();
  private readonly visits = new Map<string, Visit>();
  private movers: Mover[] = [];
  private activity: Float32Array; // 0-1 per minute of the day: how many simulated students are out walking
  private lastT: number | null = null;
  private lastServiceCheck = -Infinity;
  private lastSource: TransitSource | null = null;
  private nextId = 0;

  /** `tracks` are the feed's (MbtaFeed.tracks); the schedule runs on the very same Track objects. */
  constructor(day: DayData, data: TransitData, tracks: Track[]) {
    this.activity = activityCurve(day);
    const locations = new Map(day.locations.map((l) => [l.id, l]));
    const routesByStop = new Map<string, StopRoute[]>();
    for (const [key, route] of Object.entries(day.stopRoutes ?? {})) {
      const [stopId, locId] = key.split('>');
      const location = locations.get(locId);
      if (!location) continue;
      const list = routesByStop.get(stopId) ?? [];
      list.push({ location, path: route.path, length: route.cumulative[route.cumulative.length - 1] });
      routesByStop.set(stopId, list);
    }
    const kindOf = new Map(data.routes.map((r) => [r.id, r.kind]));
    for (const stop of data.stops) {
      const routes = routesByStop.get(stop.id);
      if (!routes || UNDERGROUND.has(stop.id)) continue;
      const kind: StopKind = stop.kind === 'station' ? 'subway' : stop.kind;
      const served = tracks.filter((t) => stop.routes.includes(t.route) && kindOf.get(t.route) === kind);
      const platforms = kind === 'subway' ? this.stationPlatforms(stop, served) : this.kerbPlatform(stop, served);
      const rank: Rank = BIG_STATIONS.has(stop.id) ? 'big' : kind === 'subway' ? 'station' : kind;
      for (const p of platforms) {
        p.cap = Math.ceil(STOP_CAP[rank] / platforms.length);
        p.boardWeight = BOARD_WEIGHT[rank] / platforms.length;
        p.alightWeight = ALIGHT_WEIGHT[rank];
        p.routes = routes;
        this.platforms.push(p);
        for (const entry of p.entries) {
          entry.loop = distanceMetres(entry.track.points[0], entry.track.points[entry.track.points.length - 1]) < 50;
          const list = this.byTrack.get(entry.track) ?? [];
          list.push({ platform: p, entry });
          this.byTrack.set(entry.track, list);
        }
      }
    }
    this.stats.platforms = this.platforms.length;
  }

  /** Green Line: one platform per direction, right of each direction's track. */
  private stationPlatforms(stop: TransitStop, tracks: Track[]): Platform[] {
    const out: Platform[] = [];
    for (const direction of [0, 1] as const) {
      const entries: Entry[] = [];
      for (const track of tracks.filter((t) => t.direction === direction)) {
        const hit = nearestOnTrack(track, stop.position);
        if (hit && hit.distance <= 40) entries.push({ track, s: hit.s, side: 1 });
      }
      if (entries.length) out.push(this.makePlatform(`${stop.id}:${direction}`, stop, 'subway', entries, 0));
    }
    return out;
  }

  /** A bus or shuttle stop: one kerbside platform, served by each route's track that passes it on that side. */
  private kerbPlatform(stop: TransitStop, tracks: Track[]): Platform[] {
    let hits: (Entry & { distance: number; lateral: number })[] = [];
    for (const track of tracks) {
      // The stop is at the kerb, right of travel; a loop's opposite pass has it far to the left.
      const hit = nearestOnTrack(track, stop.position, 3.5) ?? nearestOnTrack(track, stop.position);
      if (hit && hit.distance <= 25) hits.push({ track, s: hit.s, side: hit.lateral >= -1 ? 1 : -1, distance: hit.distance, lateral: hit.lateral });
    }
    // A stop is on one side of the street: per route, keep only the direction that has it furthest right.
    const bestDirection = new Map<string, { direction: number; lateral: number }>();
    for (const h of hits) {
      const best = bestDirection.get(h.track.route);
      if (!best || h.lateral > best.lateral) bestDirection.set(h.track.route, { direction: h.track.direction, lateral: h.lateral });
    }
    hits = hits.filter((h) => bestDirection.get(h.track.route)!.direction === h.track.direction);
    if (!hits.length) return [];
    hits.sort((a, b) => a.distance - b.distance);
    const kerb = Math.min(7, Math.max(2, Math.abs(hits[0].lateral)));
    return [this.makePlatform(stop.id, stop, stop.kind === 'shuttle' ? 'shuttle' : 'bus', hits, kerb)];
  }

  private makePlatform(id: string, stop: TransitStop, kind: StopKind, entries: Entry[], kerb: number): Platform {
    const main = entries[0];
    const at = pointAlong(main.track, main.s);
    const right = rightOf(at.bearing);
    const shape = PLATFORM_SHAPE[kind];
    return {
      id,
      stop,
      kind,
      entries,
      origin: at.position,
      along: unit(at.bearing),
      normal: [right[0] * main.side, right[1] * main.side],
      near: kerb + shape.near,
      far: kerb + shape.far,
      half: shape.half,
      ahead: shape.ahead,
      cap: 0,
      boardWeight: 0,
      alightWeight: 0,
      routes: [],
      waiting: [],
      incoming: [],
      acc: 0,
      nextArrival: -Math.log(1 - Math.random()),
      served: true,
      visit: null,
    };
  }

  /**
   * Advance to sim time `t` (seconds since midnight). `now` is performance.now(); `source` is
   * what the map draws vehicles from this frame (the live feed, or the schedule set to `t`).
   */
  step(t: number, now: number, source: TransitSource) {
    const dt = this.lastT === null ? 0 : t - this.lastT;
    // First frame, a scrub or the day wrapping round: start over with queues at a plausible size.
    if (this.lastT === null || dt < -1 || dt > 1800) this.reset(t);
    this.lastT = t;
    const simDt = Math.max(0, dt);

    const vehicles = source.positionsAt(now);
    if (now - this.lastServiceCheck > SERVICE_CHECK_MS || source !== this.lastSource) {
      this.lastServiceCheck = now;
      this.lastSource = source;
      this.checkService(source, vehicles);
    }
    this.findVehicles(t, now, vehicles);
    this.spawnArrivals(t, simDt);
    this.giveUp(t, simDt);
    this.advance(t);
  }

  private reset(t: number) {
    this.movers = [];
    this.visits.clear();
    for (const p of this.platforms) {
      p.waiting = [];
      p.incoming = [];
      p.visit = null;
      p.acc = 0;
      const expected = this.boardRate(p, t) * 240; // a few minutes' worth since the last vehicle
      const n = Math.min(p.cap, Math.round(expected * rand(0.5, 1.3)));
      for (let i = 0; i < n; i++) {
        const uw = this.freeSpot(p);
        if (uw) p.waiting.push({ agent: this.standingAgent(p, uw), uw });
      }
    }
  }

  private activityAt(t: number): number {
    const m = (((t / 60) % 1440) + 1440) % 1440;
    const i = Math.floor(m);
    return this.activity[i] + (this.activity[(i + 1) % 1440] - this.activity[i]) * (m - i);
  }

  /** Riders per sim second joining a platform's queue: time of day, the class-change rush, and the stop's importance. */
  private boardRate(p: Platform, t: number): number {
    const busy = hourly(PRESENCE, t) * hourly(LEAVING, t) * (0.4 + 0.6 * this.activityAt(t));
    return PEAK_BOARD_RATE * p.boardWeight * busy * (p.served ? 1 : 0.15);
  }

  private alightCount(p: Platform, t: number): number {
    const busy = hourly(PRESENCE, t) * hourly(ARRIVING, t) * (0.4 + 0.6 * this.activityAt(t));
    return Math.min(MAX_ALIGHT, Math.round(ALIGHT_BASE[p.kind] * p.alightWeight * busy * rand(0.7, 1.3)));
  }

  private get total(): number {
    let n = this.movers.length;
    for (const p of this.platforms) n += p.waiting.length;
    return n;
  }

  /** Is anything coming? Without a vehicle around or predicted, people stop gathering (and drift off). */
  private checkService(source: TransitSource, vehicles: Vehicle[]) {
    const state = source.state as { updatedAt?: number | null };
    if (state.updatedAt === null) return; // live feed not up yet: assume service
    const onTrack = new Set(vehicles.map((v) => v.track).filter(Boolean));
    const soon = Date.now() + SERVICE_HORIZON_MS;
    for (const p of this.platforms) {
      p.served = p.entries.some((e) => onTrack.has(e.track)) || source.nextArrivals(p.stop.id).some((a) => a.time < soon);
    }
  }

  /** Vehicles stopped at a platform: open the doors. */
  private findVehicles(t: number, now: number, vehicles: Vehicle[]) {
    for (const p of this.platforms) {
      if (p.visit && (now - p.visit.lastSeen > DOORS_OPEN_MS || t - p.visit.lastSeenT > DOORS_OPEN_SIM)) p.visit = null;
    }
    for (const v of vehicles) {
      const candidates = v.track && this.byTrack.get(v.track);
      if (!candidates) continue;
      let sNow = v.sTo;
      let stopped: boolean;
      if (v.label === 'scheduled') {
        // The schedule holds each vehicle at every stop for its dwell and says so.
        stopped = v.status === 'STOPPED_AT';
      } else {
        // Live: it glides from report to report. MBTA says STOPPED_AT (the drawn train may still be
        // gliding in to where it stopped), or it's barely moving. BU shuttles' status comes from speed.
        const f = Math.min(1, Math.max(0, (now - v.receivedAt) / v.interval));
        sNow = v.sFrom + (v.sTo - v.sFrom) * f;
        const speed = f < 1 ? Math.abs(v.sTo - v.sFrom) / (v.interval / 1000) : 0;
        stopped = speed < STOPPED_SPEED || (v.status === 'STOPPED_AT' && speed < 4);
      }
      if (!stopped) continue;
      for (const { platform, entry } of candidates) {
        if (alongDistance(entry, v.sTo) > AT_STOP_METRES || alongDistance(entry, sNow) > AT_STOP_METRES * 1.5) continue;
        const key = `${v.id}|${platform.id}`;
        let visit = this.visits.get(key);
        if (!visit || Math.abs(visit.s - v.sTo) > 3) {
          const fresh = !visit;
          visit = { key, platform, s: v.sTo, doors: this.doors(platform, entry, v.track!, v.sTo), lastSeen: now, lastSeenT: t };
          this.visits.set(key, visit);
          if (fresh) this.alight(platform, visit, t);
        }
        visit.lastSeen = now;
        visit.lastSeenT = t;
        platform.visit = visit;
      }
    }
    for (const [key, visit] of this.visits) {
      if (now - visit.lastSeen > VISIT_EXPIRY_MS || t - visit.lastSeenT > VISIT_EXPIRY_SIM) this.visits.delete(key);
    }
    this.stats.visits = this.visits.size;

    // Everyone waiting where a vehicle has its doors open gets on, first come first served.
    for (const p of this.platforms) {
      if (!p.visit || !p.waiting.length) continue;
      // Spread over BOARDING_SPREAD seconds (people let others off, shuffle up), so a full
      // platform takes 10-20 s to get on.
      const spread = rand(BOARDING_SPREAD[0], BOARDING_SPREAD[1]);
      p.waiting.forEach((w, i) => this.board(p, w, t + rand(0.5, 2) + (i / Math.max(1, p.waiting.length - 1)) * spread * Math.min(1, p.waiting.length / 6)));
      p.waiting = [];
    }
  }

  private doors(p: Platform, entry: Entry, track: Track, s: number): LngLat[] {
    return DOORS[p.kind].map((d) => {
      const at = pointAlong(track, s + d);
      const right = rightOf(at.bearing);
      return offset(at.position, right[0] * entry.side * DOOR_LATERAL, right[1] * entry.side * DOOR_LATERAL);
    });
  }

  private nearestDoor(visit: Visit, from: LngLat): LngLat {
    let best = visit.doors[0];
    let bestD = Infinity;
    for (const door of visit.doors) {
      const d = distanceMetres(from, door) + rand(0, 3); // not everyone picks the very nearest
      if (d < bestD) [best, bestD] = [door, d];
    }
    return best;
  }

  private board(p: Platform, w: Waiter, start: number) {
    const from: LngLat = [w.agent.position[0], w.agent.position[1]];
    const door = this.nearestDoor(p.visit!, from);
    this.addMover({ agent: w.agent, path: [from, door], start, hiddenBeforeStart: false, then: 'gone' });
    this.stats.boarded++;
  }

  /** A few people step off at the doors and walk to buildings nearby. */
  private alight(p: Platform, visit: Visit, t: number) {
    const n = Math.min(this.alightCount(p, t), MAX_RIDERS - this.total);
    const weights = kindWeights(GOING_TO, t);
    for (let i = 0; i < n; i++) {
      const route = pickWeighted(p.routes, (r) => weights[r.location.kind] / (1 + r.length / 250));
      const door = visit.doors[Math.floor(Math.random() * visit.doors.length)];
      const step = offset(door, p.normal[0] * 1.8, p.normal[1] * 1.8);
      const agent = this.newAgent(route.location.id, door);
      this.addMover({ agent, path: [door, step, ...route.path.slice(1)], start: t + i * rand(0.6, 1.1) + rand(0, 1), hiddenBeforeStart: true, then: 'gone' });
      this.stats.alighted++;
    }
  }

  /** New riders set off from a nearby building to wait at the platform. */
  private spawnArrivals(t: number, dt: number) {
    if (dt <= 0) return;
    let total = this.total;
    const weights = kindWeights(COMING_FROM, t);
    for (const p of this.platforms) {
      // A couple more may be on their way than can wait, so the queue fills between vehicles.
      const cap = p.served ? p.cap + INCOMING_ALLOWANCE : 1;
      if (p.waiting.length + p.incoming.length >= cap) {
        p.acc = 0;
        continue;
      }
      p.acc += this.boardRate(p, t) * dt;
      let spawned = 0;
      while (p.acc >= p.nextArrival && spawned < 3 && total < MAX_RIDERS - ALIGHT_RESERVE && p.waiting.length + p.incoming.length < cap) {
        p.acc -= p.nextArrival;
        p.nextArrival = -Math.log(1 - Math.random());
        const uw = this.freeSpot(p);
        if (!uw) break;
        const route = pickWeighted(p.routes, (r) => weights[r.location.kind] / (1 + r.length / 250));
        const spot = this.spotPosition(p, uw);
        const path = [...route.path.slice(1).reverse(), spot];
        const agent = this.newAgent(p.stop.id, path[0]);
        const mover = this.addMover({ agent, path, start: t, hiddenBeforeStart: true, then: 'wait', platform: p, uw, facing: this.facing(p) });
        // Join the walk at most ARRIVAL_WALK_MAX metres out (already on the way), so the queue
        // reflects demand now rather than five minutes ago.
        const length = mover.cumulative[mover.cumulative.length - 1];
        if (length > ARRIVAL_WALK_MAX) mover.start = t - (length - ARRIVAL_WALK_MAX * rand(0.5, 1)) / mover.speed;
        p.incoming.push(mover);
        spawned++;
        total++;
      }
      // Don't bank a backlog (e.g. while the queue was full), but never below the next draw.
      p.acc = Math.min(p.acc, p.nextArrival + 2);
    }
  }

  /** With nothing coming, people drift off now and then (back to a building) instead of waiting forever. */
  private giveUp(t: number, dt: number) {
    if (dt <= 0) return;
    for (const p of this.platforms) {
      if (p.served || p.waiting.length <= 1 || Math.random() > dt / 45) continue;
      const w = p.waiting.splice(Math.floor(Math.random() * p.waiting.length), 1)[0];
      const route = pickWeighted(p.routes, (r) => 1 / (1 + r.length / 250));
      const from: LngLat = [w.agent.position[0], w.agent.position[1]];
      w.agent.to = route.location.id;
      this.addMover({ agent: w.agent, path: [from, ...route.path.slice(1)], start: t, hiddenBeforeStart: false, then: 'gone' });
    }
  }

  private addMover(m: Omit<Mover, 'cumulative' | 'speed' | 'seg'>): Mover {
    const mover: Mover = { ...m, cumulative: cumulativeOf(m.path), speed: walkSpeed(), seg: 1 };
    this.movers.push(mover);
    return mover;
  }

  private newAgent(to: string, at: LngLat): WalkingAgent {
    return { id: `rider-${this.nextId++}`, model: Math.floor(Math.random() * 12), position: [at[0], at[1], 0], bearing: 0, to };
  }

  /** Face the track, or look up the line for the next one. */
  private facing(p: Platform): number {
    const toTrack = (Math.atan2(-p.normal[0], -p.normal[1]) * 180) / Math.PI;
    const upLine = (Math.atan2(-p.along[0], -p.along[1]) * 180) / Math.PI;
    return ((Math.random() < 0.7 ? toTrack + rand(-35, 35) : upLine + rand(-25, 25)) + 360) % 360;
  }

  private spotPosition(p: Platform, [u, w]: [number, number]): LngLat {
    return offset(p.origin, p.along[0] * u + p.normal[0] * w, p.along[1] * u + p.normal[1] * w);
  }

  /** Somewhere on the platform not on top of anyone else (waiting or on their way). */
  private freeSpot(p: Platform): [number, number] | null {
    const taken = [...p.waiting.map((w) => w.uw), ...p.incoming.map((m) => m.uw!)];
    for (let tries = 0; tries < 12; tries++) {
      const uw: [number, number] = [p.ahead + rand(-p.half, p.half), rand(p.near, p.far)];
      if (taken.every(([u, w]) => Math.hypot(u - uw[0], w - uw[1]) >= MIN_SPACING)) return uw;
    }
    return null;
  }

  private standingAgent(p: Platform, uw: [number, number]): WalkingAgent {
    const agent = this.newAgent(p.stop.id, this.spotPosition(p, uw));
    agent.bearing = this.facing(p);
    return agent;
  }

  /** Move everyone along their paths; arrivals join the queue (or step straight on), the rest vanish at the end. */
  private advance(t: number) {
    const walking: WalkingAgent[] = [];
    const standing: WalkingAgent[] = [];
    const still: Mover[] = [];
    const movers = this.movers;
    this.movers = []; // anyone who steps straight onto a waiting vehicle on arrival lands here
    for (const m of movers) {
      const s = (t - m.start) * m.speed;
      if (s < 0) {
        if (!m.hiddenBeforeStart) standing.push(m.agent);
        still.push(m);
        continue;
      }
      const c = m.cumulative;
      if (s >= c[c.length - 1]) {
        if (m.then === 'wait') {
          this.arrive(m, t);
          if (!m.platform!.waiting.includes(m.waiter!)) standing.push(m.agent);
        }
        continue;
      }
      if (s < c[m.seg - 1]) m.seg = 1;
      while (m.seg < c.length - 1 && c[m.seg] <= s) m.seg++;
      const a = m.path[m.seg - 1];
      const b = m.path[m.seg];
      const f = c[m.seg] === c[m.seg - 1] ? 0 : (s - c[m.seg - 1]) / (c[m.seg] - c[m.seg - 1]);
      m.agent.position[0] = a[0] + (b[0] - a[0]) * f;
      m.agent.position[1] = a[1] + (b[1] - a[1]) * f;
      if (a[0] !== b[0] || a[1] !== b[1]) m.agent.bearing = bearing(a, b);
      walking.push(m.agent);
      still.push(m);
    }
    this.movers = [...still, ...this.movers];
    for (const p of this.platforms) for (const w of p.waiting) standing.push(w.agent);
    this.walking = walking;
    this.standing = standing;
    this.stats.walking = walking.length;
    this.stats.waiting = standing.length;
  }

  /** At the platform: wait, or if a vehicle is already there, head for its doors. */
  private arrive(m: Mover, t: number) {
    const p = m.platform!;
    p.incoming = p.incoming.filter((x) => x !== m);
    const spot = m.path[m.path.length - 1];
    m.agent.position[0] = spot[0];
    m.agent.position[1] = spot[1];
    m.agent.bearing = m.facing ?? m.agent.bearing;
    m.waiter = { agent: m.agent, uw: m.uw! };
    if (p.visit) this.board(p, m.waiter, t + rand(0, 1));
    else p.waiting.push(m.waiter);
  }
}

/** Simulated students out walking, per minute of the day, smoothed and scaled to 0-1: the class-change rush. */
function activityCurve(day: DayData): Float32Array {
  const diff = new Float32Array(1442);
  for (const trip of day.trips) {
    const a = Math.max(0, Math.min(1439, Math.floor(trip.timestamps[0] / 60)));
    const b = Math.max(a, Math.min(1439, Math.floor(trip.timestamps[trip.timestamps.length - 1] / 60)));
    diff[a] += 1;
    diff[b + 1] -= 1;
  }
  const walking = new Float32Array(1440);
  let run = 0;
  for (let i = 0; i < 1440; i++) walking[i] = run += diff[i];
  const smooth = new Float32Array(1440);
  for (let i = 0; i < 1440; i++) {
    let sum = 0;
    for (let k = -4; k <= 4; k++) sum += walking[(i + k + 1440) % 1440];
    smooth[i] = sum / 9;
  }
  const max = Math.max(1, ...smooth);
  return smooth.map((v) => v / max);
}
