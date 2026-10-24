// Live MBTA data for the routes through campus: vehicle positions and predicted arrivals.
//
// Static data (route shapes, stops, colours) comes from data-pipeline/fetch_transit.py, so the
// browser only polls two endpoints. Without an API key the MBTA allows 20 requests/minute per
// IP — and a hackathon venue shares one IP — so polling is modest and backs off on 429.
// Optional: a free key from https://api-v3.mbta.com in VITE_MBTA_API_KEY (map-client/.env.local).

import { pollShuttleArrivals, pollShuttleVehicles, type ShuttleData } from './buShuttle';
import { isUnderground, makeTrack, pointAlong, snapToTracks, type Track } from './tracks';

const API = 'https://api-v3.mbta.com';
const API_KEY = import.meta.env.VITE_MBTA_API_KEY as string | undefined;
const VEHICLE_POLL_MS = 12_000;
const PREDICTION_POLL_MS = 30_000;
const MAX_BACKOFF_MS = 120_000;
// Each direction runs on its own track this far right of the shape's centreline (metres):
// the B branch's two tracks are ~4 m apart; buses keep to their side of the street.
const TRACK_OFFSET = { subway: 2.0, bus: 2.5, shuttle: 2.5 };
// Reports further than this from the route (a train in the yard, a bus deadheading) aren't snapped.
const SNAP_MAX_METRES = 40;
// Glide no faster than a Green Line train or bus really moves (16 m/s, ~35 mph); a bigger gap
// between reports (missed polls, back-off) jumps the vehicle rather than racing it down the street.
const MAX_GLIDE_SPEED = 16;
// BU's TransLoc feed updates every few seconds and has no published rate limit worth worrying about.
const SHUTTLE_POLL_MS = 6_000;

export interface TransitRoute {
  id: string;
  name: string; // "B", "57"
  longName: string;
  kind: 'subway' | 'bus' | 'shuttle';
  color: string; // "#00843D"
  textColor: string;
  directions: [string, string]; // by direction_id
  // Points in travel order; `underground` lists [first, last] point-index spans in a tunnel.
  paths: { direction: 0 | 1; path: [number, number][]; underground?: [number, number][] }[];
}

export interface TransitArea {
  id: string; // campus id, as in data-pipeline/campuses/*.json
  name: string;
  bbox: [number, number, number, number]; // west, south, east, north
  routes: string[];
}

export interface TransitStop {
  id: string;
  name: string;
  short: string;
  kind: 'station' | 'bus' | 'shuttle';
  area: string;
  position: [number, number];
  platforms: string[]; // the stop/platform ids predictions may name
  routes: string[];
}

export interface TransitData {
  areas: TransitArea[];
  routes: TransitRoute[];
  stops: TransitStop[];
}

export interface Vehicle {
  id: string;
  route: string;
  direction: 0 | 1;
  label: string;
  status: string; // STOPPED_AT | INCOMING_AT | IN_TRANSIT_TO
  bearing: number;
  /** Where to draw it now: eased from the previous report to the latest one. */
  position: [number, number];
  from: [number, number];
  to: [number, number];
  receivedAt: number; // performance.now() of the latest report
  interval: number; // ms until the next report is expected
  /** Set when the report snapped onto the vehicle's track: it then moves along the track. */
  track?: Track;
  sFrom: number;
  sTo: number;
}

export interface Arrival {
  stop: string; // TransitStop id
  route: string;
  direction: 0 | 1;
  time: number; // epoch ms
}

export interface FeedState {
  vehicles: Vehicle[];
  arrivals: Arrival[];
  updatedAt: number | null; // epoch ms of the last successful poll
  error: string | null;
}

export async function loadTransit(url: string): Promise<TransitData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

async function getJson(path: string, params: Record<string, string>) {
  const query = new URLSearchParams(params);
  // As a query param, not a header, so the browser skips the CORS preflight.
  if (API_KEY) query.set('api_key', API_KEY);
  const res = await fetch(`${API}${path}?${query}`);
  if (res.status === 429) throw Object.assign(new Error('MBTA rate limit reached'), { rateLimited: true });
  if (!res.ok) throw new Error(`MBTA ${path} returned ${res.status}`);
  return res.json();
}

interface VehicleReport {
  id: string;
  route: string;
  direction: 0 | 1;
  label: string;
  status: string;
  bearing?: number; // degrees clockwise from north, when the source's heading is trustworthy
  to: [number, number];
}

interface ApiResource {
  id: string;
  attributes: Record<string, unknown>;
  relationships: Record<string, { data: { id: string } | null }>;
}

/** Polls the MBTA and keeps the latest vehicles and arrivals; call positionsAt() every frame. */
export class MbtaFeed {
  state: FeedState = { vehicles: [], arrivals: [], updatedAt: null, error: null };
  private readonly routeIds: string;
  private readonly stopIds: string;
  private readonly stopForPlatform = new Map<string, string>();
  readonly tracks: Track[];
  private readonly timers: number[] = [];
  private stopped = false;

  private mbtaVehicles: Vehicle[] = [];
  private shuttleVehicles: Vehicle[] = [];
  private mbtaArrivals: Arrival[] = [];
  private shuttleArrivals: Arrival[] = [];

  /** `data` may include BU shuttle routes and stops (merged in by the caller); `shuttle` turns on their polling. */
  constructor(
    private readonly data: TransitData,
    private readonly onChange: (state: FeedState) => void,
    private readonly shuttle?: ShuttleData,
  ) {
    this.routeIds = data.routes.filter((r) => r.kind !== 'shuttle').map((r) => r.id).join(',');
    this.stopIds = data.stops.filter((s) => s.kind !== 'shuttle').map((s) => s.id).join(',');
    for (const stop of data.stops) for (const platform of stop.platforms) this.stopForPlatform.set(platform, stop.id);
    this.tracks = data.routes.flatMap((route) =>
      route.paths.map(({ direction, path, underground }) =>
        makeTrack(route.id, direction, path, TRACK_OFFSET[route.kind], underground),
      ),
    );
  }

  start() {
    this.loop(() => this.pollVehicles(), VEHICLE_POLL_MS);
    this.loop(() => this.pollPredictions(), PREDICTION_POLL_MS);
    if (this.shuttle) {
      this.loop(() => this.pollShuttleVehicles(), SHUTTLE_POLL_MS);
      this.loop(() => this.pollShuttleArrivals(), PREDICTION_POLL_MS);
    }
  }

  stop() {
    this.stopped = true;
    this.timers.forEach((t) => clearTimeout(t));
  }

  /**
   * Vehicles eased toward their latest report over one poll interval, so they glide instead of
   * jump. Only vehicles on a mapped track are returned: off it (underground past our map, in a
   * yard, deadheading) there's no reliable position or heading to draw them with.
   */
  positionsAt(now: number): Vehicle[] {
    for (const v of this.state.vehicles) {
      const f = Math.min(1, (now - v.receivedAt) / v.interval);
      if (v.track) {
        const at = pointAlong(v.track, v.sFrom + (v.sTo - v.sFrom) * f);
        v.position = at.position;
        v.bearing = at.bearing;
      } else {
        v.position = [v.from[0] + (v.to[0] - v.from[0]) * f, v.from[1] + (v.to[1] - v.from[1]) * f];
      }
    }
    // Trains in a tunnel (Kenmore, Hynes, the D past Fenway) are underground: don't draw them.
    return this.state.vehicles.filter((v) => v.track && !isUnderground(v.track, this.alongTrack(v, now)));
  }

  private alongTrack(v: Vehicle, now: number): number {
    const f = Math.min(1, (now - v.receivedAt) / v.interval);
    return v.sFrom + (v.sTo - v.sFrom) * f;
  }

  /** Soonest upcoming arrival per route and direction at a stop. */
  nextArrivals(stopId: string, now = Date.now()): Arrival[] {
    const best = new Map<string, Arrival>();
    for (const a of this.state.arrivals) {
      if (a.stop !== stopId || a.time < now - 30_000) continue;
      const key = `${a.route}:${a.direction}`;
      if (!best.has(key) || a.time < best.get(key)!.time) best.set(key, a);
    }
    return [...best.values()].sort((a, b) => a.route.localeCompare(b.route) || a.direction - b.direction);
  }

  /** Soonest arrival each way at a stop, whichever route (Kenmore has B, C and D trains). */
  nextEachWay(stopId: string, now = Date.now()): Partial<Record<0 | 1, Arrival>> {
    const out: Partial<Record<0 | 1, Arrival>> = {};
    for (const a of this.nextArrivals(stopId, now)) {
      if (!out[a.direction] || a.time < out[a.direction]!.time) out[a.direction] = a;
    }
    return out;
  }

  private loop(poll: () => Promise<void>, interval: number) {
    let delay = interval;
    const run = async () => {
      if (this.stopped) return;
      try {
        await poll();
        delay = interval;
        this.state.error = null;
      } catch (err) {
        const rateLimited = (err as { rateLimited?: boolean }).rateLimited;
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        this.state.error = rateLimited ? 'MBTA rate limit reached; retrying' : 'MBTA data unavailable; retrying';
      }
      this.onChange(this.state);
      if (!this.stopped) this.timers.push(window.setTimeout(run, delay));
    };
    run();
  }

  private async pollVehicles() {
    const json = await getJson('/vehicles', {
      'filter[route]': this.routeIds,
      'fields[vehicle]': 'latitude,longitude,bearing,current_status,direction_id,label',
    });
    const reports = (json.data as ApiResource[]).map((r): VehicleReport => {
      const a = r.attributes as { latitude: number; longitude: number; bearing: number; current_status: string; direction_id: 0 | 1; label: string };
      return {
        id: r.id,
        route: r.relationships.route.data!.id,
        direction: a.direction_id,
        label: a.label,
        status: a.current_status,
        bearing: a.bearing,
        to: [a.longitude, a.latitude],
      };
    });
    this.mbtaVehicles = this.place(reports, this.mbtaVehicles, VEHICLE_POLL_MS);
    this.publishVehicles();
  }

  private async pollShuttleVehicles() {
    const reports = (await pollShuttleVehicles()).map((v): VehicleReport => ({
      id: v.id,
      route: v.route,
      direction: 0,
      label: v.label,
      status: v.speed > 1 ? 'IN_TRANSIT_TO' : 'STOPPED_AT',
      // TransLoc reports heading 0 when stopped; only trust it while moving.
      bearing: v.speed > 1 ? v.heading : undefined,
      to: v.position,
    }));
    this.shuttleVehicles = this.place(reports, this.shuttleVehicles, SHUTTLE_POLL_MS);
    this.publishVehicles();
  }

  private publishVehicles() {
    this.state.vehicles = [...this.mbtaVehicles, ...this.shuttleVehicles];
    this.state.updatedAt = Date.now();
  }

  /** Snap fresh reports onto their tracks, gliding on from where each vehicle is drawn now. */
  private place(reports: VehicleReport[], previousList: Vehicle[], interval: number): Vehicle[] {
    const margin = 0.01;
    const nearCampus = ([lng, lat]: [number, number]) =>
      this.data.areas.some(({ bbox: [west, south, east, north] }) => lng >= west - margin && lng <= east + margin && lat >= south - margin && lat <= north + margin);
    const previous = new Map(previousList.map((v) => [v.id, v]));
    const now = performance.now();
    return reports
      .map((r): Vehicle | null => {
        if (!nearCampus(r.to)) return null;
        const prev = previous.get(r.id);
        const vehicle: Vehicle = {
          id: r.id,
          route: r.route,
          direction: r.direction,
          label: r.label,
          status: r.status,
          bearing: r.bearing ?? prev?.bearing ?? 0,
          from: prev ? [...prev.position] : r.to,
          to: r.to,
          position: prev ? [...prev.position] : r.to,
          receivedAt: now,
          interval,
          sFrom: 0,
          sTo: 0,
        };
        // Prefer the track for the vehicle's own direction; fall back to the route's other track.
        // A reported heading (when trustworthy) also steers it off the opposite-direction side.
        const ownTracks = this.tracks.filter((t) => t.route === r.route && t.direction === r.direction);
        const snapped =
          snapToTracks(ownTracks, r.to, r.bearing) ?? snapToTracks(this.tracks.filter((t) => t.route === r.route), r.to, r.bearing);
        if (snapped && snapped.distance <= SNAP_MAX_METRES) {
          vehicle.track = snapped.track;
          vehicle.sTo = snapped.s;
          vehicle.sFrom = snapped.s;
          if (prev?.track === snapped.track) {
            const current = this.alongTrack(prev, now);
            // GPS jitter can put a report slightly behind; vehicles don't reverse, so hold still.
            vehicle.sTo = snapped.s < current && current - snapped.s < 30 ? current : snapped.s;
            if (Math.abs(vehicle.sTo - current) <= MAX_GLIDE_SPEED * (interval / 1000)) vehicle.sFrom = current;
          }
          const at = pointAlong(snapped.track, vehicle.sFrom);
          vehicle.position = at.position;
          vehicle.bearing = at.bearing;
        }
        return vehicle;
      })
      .filter((v): v is Vehicle => v !== null);
  }

  private async pollPredictions() {
    const json = await getJson('/predictions', {
      'filter[stop]': this.stopIds,
      'filter[route]': this.routeIds,
      'fields[prediction]': 'arrival_time,departure_time,direction_id',
    });
    this.mbtaArrivals = (json.data as ApiResource[]).flatMap((r) => {
      const a = r.attributes as { arrival_time: string | null; departure_time: string | null; direction_id: 0 | 1 };
      const when = a.arrival_time ?? a.departure_time; // first stops only have a departure
      const stop = this.stopForPlatform.get(r.relationships.stop.data?.id ?? '');
      if (!when || !stop) return [];
      return [{ stop, route: r.relationships.route.data!.id, direction: a.direction_id, time: Date.parse(when) }];
    });
    this.publishArrivals();
  }

  private async pollShuttleArrivals() {
    this.shuttleArrivals = await pollShuttleArrivals(this.shuttle!.stopForRouteStop);
    this.publishArrivals();
  }

  private publishArrivals() {
    this.state.arrivals = [...this.mbtaArrivals, ...this.shuttleArrivals];
    this.state.updatedAt = Date.now();
  }
}

/** "Now", "1 min", "12 min". */
export function minutesUntil(time: number, now = Date.now()): string {
  const minutes = Math.floor((time - now) / 60_000);
  return minutes < 1 ? 'Now' : `${minutes} min`;
}
