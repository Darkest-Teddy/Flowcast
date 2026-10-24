// Real Bluebikes rides at BU's docks: a replay of one real day plus the docks' live status.
//
// bikes.json comes from data-pipeline/fetch_bikes.py: every ride that started or ended at a dock
// near BU on one real day, routed on OpenStreetMap's bike network (rides only record their two
// docks, so the street path is inferred; the time at the BU dock is the real one), and each dock's
// typical-weekday profile. Live bikes and docks come straight from Bluebikes' public GBFS feed,
// which allows browser requests and updates every 60 s.

const GBFS_STATUS = 'https://gbfs.lyft.com/gbfs/1.1/bos/en/station_status.json';
const POLL_MS = 60_000; // the feed's own ttl
const MAX_BACKOFF_MS = 300_000;

export interface BikeStation {
  id: string; // trip-data station id, e.g. "A32003"
  gbfsId: string | null; // live-feed id
  name: string;
  short: string;
  campus: string; // Campus.id
  near: string; // the closest BU location id
  position: [number, number];
  capacity: number | null;
  /** Average rides docked (arrivals) / undocked (departures) per bin on the profiled weekday. */
  profile: { arrivals: number[]; departures: number[] };
}

export interface BikeTrip {
  from: string | null;
  to: string | null;
  fromName: string;
  toName: string;
  type: 'classic' | 'electric';
  member: boolean;
  /** Both ends lie on the map; otherwise the ride is drawn to the map's edge. */
  reached: boolean;
  path: [number, number][];
  timestamps: number[]; // seconds since midnight, one per path point
}

export interface BikeData {
  source: string;
  month: string; // "2026-09"
  weekday: string; // "Wednesday"
  replayDate: string; // "2026-09-23"
  profileDates: string[];
  ridesPerDay: Record<string, number>;
  binSeconds: number;
  stationRadiusMetres: number;
  stations: BikeStation[];
  trips: BikeTrip[];
}

export interface RidingBike {
  trip: BikeTrip;
  position: [number, number, number];
  heading: number; // degrees clockwise from north
}

export async function loadBikes(url: string): Promise<BikeData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return res.json();
}

function headingBetween(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

/** Where each of the day's real rides is at time t. */
export class BikeReplay {
  readonly trips: BikeTrip[];
  private readonly longest: number;

  constructor(readonly data: BikeData) {
    this.trips = [...data.trips].sort((a, b) => a.timestamps[0] - b.timestamps[0]);
    this.longest = Math.max(0, ...this.trips.map((t) => t.timestamps[t.timestamps.length - 1] - t.timestamps[0]));
  }

  ridingAt(t: number): RidingBike[] {
    const out: RidingBike[] = [];
    // Trips are sorted by start, so only those that started within the longest ride can be moving.
    for (let i = this.firstStartingAfter(t - this.longest); i < this.trips.length; i++) {
      const trip = this.trips[i];
      const ts = trip.timestamps;
      if (ts[0] > t) break;
      if (t >= ts[ts.length - 1]) continue;
      let k = 1;
      while (ts[k] <= t) k++;
      const a = trip.path[k - 1];
      const b = trip.path[k];
      const f = ts[k] === ts[k - 1] ? 0 : (t - ts[k - 1]) / (ts[k] - ts[k - 1]);
      out.push({ trip, position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0], heading: headingBetween(a, b) });
    }
    return out;
  }

  private firstStartingAfter(t: number): number {
    let lo = 0;
    let hi = this.trips.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.trips[mid].timestamps[0] < t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

/** Typical rides docked and undocked at these stations in the `minutes` after time t. */
export function typicalAt(stations: BikeStation[], binSeconds: number, t: number, minutes = 60) {
  const bins = Math.max(1, Math.round((minutes * 60) / binSeconds));
  const first = Math.floor(t / binSeconds);
  let arrivals = 0;
  let departures = 0;
  for (const s of stations) {
    const n = s.profile.arrivals.length;
    for (let i = first; i < first + bins; i++) {
      const bin = ((i % n) + n) % n;
      arrivals += s.profile.arrivals[bin];
      departures += s.profile.departures[bin];
    }
  }
  return { arrivals, departures };
}

/** Rides docked + undocked per hour across these stations, one value per bin. */
export function activityCurve(stations: BikeStation[], binSeconds: number): number[] {
  const n = stations[0]?.profile.arrivals.length ?? 0;
  const perHour = 3600 / binSeconds;
  return Array.from({ length: n }, (_, i) => stations.reduce((sum, s) => sum + s.profile.arrivals[i] + s.profile.departures[i], 0) * perHour);
}

export interface DockStatus {
  bikes: number; // includes e-bikes
  ebikes: number;
  docks: number;
  renting: boolean;
  returning: boolean;
  reportedAt: number; // epoch ms
}

export interface DockFeedState {
  docks: Map<string, DockStatus>; // by gbfsId
  updatedAt: number | null;
  error: string | null;
}

/** Polls Bluebikes' live station status for the BU docks. */
export class BluebikesFeed {
  state: DockFeedState = { docks: new Map(), updatedAt: null, error: null };
  private readonly ids: Set<string>;
  private timer = 0;
  private stopped = false;

  constructor(
    stations: BikeStation[],
    private readonly onChange: (state: DockFeedState) => void,
  ) {
    this.ids = new Set(stations.flatMap((s) => (s.gbfsId ? [s.gbfsId] : [])));
  }

  start() {
    let delay = POLL_MS;
    const run = async () => {
      if (this.stopped) return;
      try {
        await this.poll();
        delay = POLL_MS;
        this.state.error = null;
      } catch {
        delay = Math.min(delay * 2, MAX_BACKOFF_MS);
        this.state.error = 'Bluebikes live data unavailable; retrying';
      }
      this.onChange(this.state);
      if (!this.stopped) this.timer = window.setTimeout(run, delay);
    };
    run();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  status(station: BikeStation): DockStatus | undefined {
    return station.gbfsId ? this.state.docks.get(station.gbfsId) : undefined;
  }

  private async poll() {
    const res = await fetch(GBFS_STATUS);
    if (!res.ok) throw new Error(`Bluebikes status returned ${res.status}`);
    const json = (await res.json()) as {
      data: {
        stations: {
          station_id: string;
          num_bikes_available: number;
          num_ebikes_available?: number;
          num_docks_available: number;
          is_renting: number;
          is_returning: number;
          last_reported: number;
        }[];
      };
    };
    const docks = new Map<string, DockStatus>();
    for (const s of json.data.stations) {
      if (!this.ids.has(s.station_id)) continue;
      docks.set(s.station_id, {
        bikes: s.num_bikes_available,
        ebikes: s.num_ebikes_available ?? 0,
        docks: s.num_docks_available,
        renting: s.is_renting === 1,
        returning: s.is_returning === 1,
        reportedAt: s.last_reported * 1000,
      });
    }
    this.state.docks = docks;
    this.state.updatedAt = Date.now();
  }
}

/** "Wed, Sep 23, 2026" from "2026-09-23" (a calendar date, so no timezone shift). */
export function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
