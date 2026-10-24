// Live MBTA data for the routes through campus: vehicle positions and predicted arrivals.
//
// Static data (route shapes, stops, colours) comes from data-pipeline/fetch_transit.py, so the
// browser only polls two endpoints. Without an API key the MBTA allows 20 requests/minute per
// IP — and a hackathon venue shares one IP — so polling is modest and backs off on 429.
// Optional: a free key from https://api-v3.mbta.com in VITE_MBTA_API_KEY (map-client/.env.local).

const API = 'https://api-v3.mbta.com';
const API_KEY = import.meta.env.VITE_MBTA_API_KEY as string | undefined;
const VEHICLE_POLL_MS = 12_000;
const PREDICTION_POLL_MS = 30_000;
const MAX_BACKOFF_MS = 120_000;

export interface TransitRoute {
  id: string;
  name: string; // "B", "57"
  longName: string;
  kind: 'subway' | 'bus';
  color: string; // "#00843D"
  textColor: string;
  directions: [string, string]; // by direction_id
  paths: [number, number][][];
}

export interface TransitStop {
  id: string;
  name: string;
  short: string;
  kind: 'station' | 'bus';
  position: [number, number];
  platforms: string[]; // the stop/platform ids predictions may name
  routes: string[];
}

export interface TransitData {
  routes: TransitRoute[];
  stops: TransitStop[];
  bbox: [number, number, number, number]; // west, south, east, north
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
  private readonly timers: number[] = [];
  private stopped = false;

  constructor(
    private readonly data: TransitData,
    private readonly onChange: (state: FeedState) => void,
  ) {
    this.routeIds = data.routes.map((r) => r.id).join(',');
    this.stopIds = data.stops.map((s) => s.id).join(',');
    for (const stop of data.stops) for (const platform of stop.platforms) this.stopForPlatform.set(platform, stop.id);
  }

  start() {
    this.loop(() => this.pollVehicles(), VEHICLE_POLL_MS);
    this.loop(() => this.pollPredictions(), PREDICTION_POLL_MS);
  }

  stop() {
    this.stopped = true;
    this.timers.forEach((t) => clearTimeout(t));
  }

  /** Vehicles eased toward their latest report over one poll interval, so they glide instead of jump. */
  positionsAt(now: number): Vehicle[] {
    for (const v of this.state.vehicles) {
      const f = Math.min(1, (now - v.receivedAt) / VEHICLE_POLL_MS);
      v.position = [v.from[0] + (v.to[0] - v.from[0]) * f, v.from[1] + (v.to[1] - v.from[1]) * f];
    }
    return this.state.vehicles;
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
    const [west, south, east, north] = this.data.bbox;
    const margin = 0.01;
    const previous = new Map(this.state.vehicles.map((v) => [v.id, v]));
    const now = performance.now();
    this.state.vehicles = (json.data as ApiResource[])
      .map((r): Vehicle | null => {
        const a = r.attributes as { latitude: number; longitude: number; bearing: number; current_status: string; direction_id: 0 | 1; label: string };
        const to: [number, number] = [a.longitude, a.latitude];
        if (to[0] < west - margin || to[0] > east + margin || to[1] < south - margin || to[1] > north + margin) return null;
        const prev = previous.get(r.id);
        return {
          id: r.id,
          route: r.relationships.route.data!.id,
          direction: a.direction_id,
          label: a.label,
          status: a.current_status,
          bearing: a.bearing ?? prev?.bearing ?? 0,
          from: prev ? [...prev.position] : to,
          to,
          position: prev ? [...prev.position] : to,
          receivedAt: now,
        };
      })
      .filter((v): v is Vehicle => v !== null);
    this.state.updatedAt = Date.now();
  }

  private async pollPredictions() {
    const json = await getJson('/predictions', {
      'filter[stop]': this.stopIds,
      'filter[route]': this.routeIds,
      'fields[prediction]': 'arrival_time,departure_time,direction_id',
    });
    this.state.arrivals = (json.data as ApiResource[]).flatMap((r) => {
      const a = r.attributes as { arrival_time: string | null; departure_time: string | null; direction_id: 0 | 1 };
      const when = a.arrival_time ?? a.departure_time; // first stops only have a departure
      const stop = this.stopForPlatform.get(r.relationships.stop.data?.id ?? '');
      if (!when || !stop) return [];
      return [{ stop, route: r.relationships.route.data!.id, direction: a.direction_id, time: Date.parse(when) }];
    });
    this.state.updatedAt = Date.now();
  }
}

/** "Now", "1 min", "12 min". */
export function minutesUntil(time: number, now = Date.now()): string {
  const minutes = Math.floor((time - now) / 60_000);
  return minutes < 1 ? 'Now' : `${minutes} min`;
}
