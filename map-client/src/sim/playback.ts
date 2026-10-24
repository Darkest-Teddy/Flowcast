// Turns a day of precomputed trips into "where is everyone at time t".
// The server will eventually own this (plan Section 8.1); until then the client
// plays the pipeline's JSON directly so the renderer can be built and tuned now.

export type LocationKind = 'dorm' | 'classroom' | 'library' | 'dining' | 'gym' | 'off-campus';

export interface EstimatedHousingProfile {
  locationId: string;
  campus: string;
  studentLevel: 'undergraduate' | 'graduate';
  capacity: number;
  occupancyRate: number;
  confidence: 'low';
  basis: string;
  note: string;
  proxy: string;
  capacityRange?: [number, number];
  occupancyRateRange?: [number, number];
}
export interface EstimatedActivityProfile {
  locationId: string;
  campus: string;
  purpose: 'academic' | 'research' | 'community' | 'arena' | 'rowing';
  studentLevel: 'undergraduate' | 'graduate' | 'any';
  weekdayWindows: { weekday: number; windows: [number, number][] }[];
  durationMinutes: number;
  attendanceProbability: number;
  capacity: number;
  dailyParticipants: number;
  confidence: 'low';
  basis: string;
  note: string;
  proxy: string;
  capacityRange?: [number, number];
  participantRange?: [number, number];
}
export interface CampusLocation {
  estimatedProfile?: EstimatedActivityProfile;
  estimatedHousingProfile?: EstimatedHousingProfile;
  activityModeled?: boolean;
  capacityBasis?: string;
  id: string;
  name: string;
  short: string; // what students call it: "CDS", "GSU", "StuVi"
  kind: LocationKind;
  position: [number, number];
  capacity: number;
  building: string; // OSM footprint id; several locations can share one (a dorm and its dining hall)
  campus?: string; // Campus.id
}

/** One BU campus. Agents live and walk within a single campus; campuses are kilometres apart. */
export interface Campus {
  id: string; // "charles-river", "medical", "fenway"
  name: string;
  bbox: [number, number, number, number]; // south, west, north, east
  center: [number, number]; // [lng, lat], mean of the campus's locations
}

/** One ring of a building footprint. Multi-part buildings appear once per ring. */
export interface BuildingFootprint {
  id: string;
  name: string | null;
  polygon: [number, number][];
  height: number;
  campus?: string;
}

export interface BuildingOccupancy {
  modeled?: boolean;
  capacityBasis?: string;
  id: string;
  name: string; // the building's busiest location right now
  short: string;
  position: [number, number];
  count: number;
  capacity: number;
  share: number;
  /** Tag height in metres when it isn't the building's roof (a dining hall in a tower's podium). */
  roof?: number;
}

export interface Agent {
  residency?: 'resident' | 'commuter';
  studentLevel?: 'undergraduate' | 'graduate';
  attendance?: 'full-time' | 'part-time';
  walkSpeed?: number;
  id: string;
  home: string;
  model: number;
  campus?: string;
}

export interface Trip {
  agent: string;
  from: string;
  to: string;
  path: [number, number][];
  timestamps: number[]; // seconds since midnight, one per path point
}

export interface Stay { agent: string; location: string; start: number; end: number }

export interface DayData {
  stays?: Stay[];
  day: string;
  campuses?: Campus[];
  buildings: BuildingFootprint[];
  locations: CampusLocation[];
  agents: Agent[];
  trips: Trip[];
  walkRoutes?: Record<string, { path: [number, number][]; cumulative: number[] }>;
  /** Walks from transit stops to nearby locations, keyed "stopId>locationId" (see sim/riders.ts). */
  stopRoutes?: Record<string, WalkRoute>;
}

export interface WalkRoute {
  path: [number, number][];
  cumulative: number[]; // metres from the start, one per point
}

export interface WalkingAgent {
  id: string;
  model: number;
  position: [number, number, number];
  bearing: number; // degrees clockwise from north
  to: string;
}

export interface Occupancy {
  modeled?: boolean;
  location: CampusLocation;
  count: number;
  share: number; // count / capacity, can exceed 1
}

/** The file on disk: each walk route stored once, trips as who/where/when/how fast. */
interface DayFile extends Omit<DayData, 'trips'> {
  walkRoutes: Record<string, WalkRoute>;
  trips: { agent: string; from: string; to: string; depart: number; speed: number }[];
}

export async function loadDay(url: string): Promise<DayData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const file: DayFile = await res.json();
  // Expand to full trips; trips on the same route share its path array.
  const trips = file.trips.map(({ agent, from, to, depart, speed }) => {
    const route = file.walkRoutes[`${from}>${to}`];
    return { agent, from, to, path: route.path, timestamps: route.cumulative.map((m) => depart + m / speed) };
  });
  return { ...file, trips };
}

function bearingBetween(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

export class Playback {
  readonly locations: CampusLocation[];
  private readonly agents = new Map<string, Agent>();
  private readonly tripsByAgent = new Map<string, Trip[]>();
  private readonly staysByAgent = new Map<string, Stay[]>();
  private readonly walkingBuckets = new Map<number, Trip[]>();

  readonly data: DayData;

  constructor(data: DayData) {
    this.data = data;
    this.locations = data.locations;
    for (const agent of data.agents) {
      this.agents.set(agent.id, agent);
      this.tripsByAgent.set(agent.id, []);
    }
    for (const trip of data.trips) {
      const list = this.tripsByAgent.get(trip.agent) ?? [];
      list.push(trip);
      this.tripsByAgent.set(trip.agent, list);
      const start = trip.timestamps[0];
      const end = trip.timestamps[trip.timestamps.length - 1];
      for (let bucket = Math.floor(start / 300); bucket < Math.ceil(end / 300); bucket++) {
        const active = this.walkingBuckets.get(bucket) ?? [];
        active.push(trip);
        this.walkingBuckets.set(bucket, active);
      }
    }
    for (const stay of data.stays ?? []) {
      const list = this.staysByAgent.get(stay.agent) ?? [];
      list.push(stay); this.staysByAgent.set(stay.agent, list);
    }
    for (const list of this.staysByAgent.values()) list.sort((a, b) => a.start - b.start);
    for (const list of this.tripsByAgent.values()) list.sort((a, b) => a.timestamps[0] - b.timestamps[0]);
  }

  // Computed once: the frame loop reads endTime every frame, and each read scanned all ~8,000 trips.
  private bounds: [number, number] | null = null;

  get startTime(): number {
    this.bounds ??= this.timeBounds();
    return this.bounds[0];
  }

  get endTime(): number {
    this.bounds ??= this.timeBounds();
    return this.bounds[1];
  }

  private timeBounds(): [number, number] {
    let start = Infinity;
    let end = -Infinity;
    for (const t of this.data.trips) {
      start = Math.min(start, t.timestamps[0]);
      end = Math.max(end, t.timestamps[t.timestamps.length - 1]);
    }
    return this.data.trips.length ? [start, end] : [0, 86400];
  }

  /** Trips under way at any moment in [from, to] (seconds), each once, in a stable order. */
  tripsBetween(from: number, to: number): Trip[] {
    const out: Trip[] = [];
    const seen = new Set<Trip>();
    for (let bucket = Math.floor(from / 300); bucket <= Math.floor(to / 300); bucket++) {
      for (const trip of this.walkingBuckets.get(bucket) ?? []) {
        if (seen.has(trip)) continue;
        seen.add(trip);
        if (trip.timestamps[0] <= to && trip.timestamps[trip.timestamps.length - 1] >= from) out.push(trip);
      }
    }
    return out;
  }

  /** Only trips active in this five-minute bucket need position interpolation. */
  walkingAt(t: number): WalkingAgent[] {
    const out: WalkingAgent[] = [];
    for (const trip of this.walkingBuckets.get(Math.floor(t / 300)) ?? []) {
      if (trip.timestamps[0] > t || t >= trip.timestamps[trip.timestamps.length - 1]) continue;
      const agentId = trip.agent;
      const ts = trip.timestamps;
      let i = 1;
      while (ts[i] <= t) i++;
      const a = trip.path[i - 1];
      const b = trip.path[i];
      const f = ts[i] === ts[i - 1] ? 0 : (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
      out.push({
        id: agentId,
        model: this.agents.get(agentId)!.model,
        position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0],
        bearing: bearingBetween(a, b),
        to: trip.to,
      });
    }
    return out;
  }

  populationAt(t: number) {
    const indoors = this.occupancyAt(t).reduce((sum, entry) => sum + entry.count, 0);
    const walking = this.walkingAt(t).length;
    return { total: this.data.agents.length, indoors, walking, offCampus: this.data.agents.length - indoors - walking };
  }

  /**
   * Show the busiest modeled space on each footprint. Its name, count and reference
   * capacity describe that same space, rather than mixing totals with a maximum ratio.
   */
  byBuilding(occupancy: Occupancy[]): BuildingOccupancy[] {
    const out = new Map<string, BuildingOccupancy>();
    for (const { location, count, share, modeled = location.activityModeled !== false } of occupancy) {
      if (location.kind === 'off-campus') continue;
      const current = out.get(location.building);
      if (current && (Number(current.modeled !== false) > Number(modeled)
        || (current.modeled !== false) === modeled && (current.share > share || current.share === share && current.count >= count))) continue;
      out.set(location.building, {
        id: location.building,
        name: location.name,
        short: location.short,
        position: location.position,
        count,
        capacity: location.capacity,
        share,
        modeled,
        capacityBasis: location.capacityBasis,
      });
    }
    return [...out.values()];
  }

  /** Head count per location at time t: each agent is at its last destination, or home before its first trip. */
  occupancyAt(t: number): Occupancy[] {
    const counts = new Map<string, number>();
    if (this.data.stays) {
      for (const stays of this.staysByAgent.values()) {
        const stay = stays.find((entry) => entry.start <= t && t < entry.end);
        if (stay && stay.location !== 'off-campus') counts.set(stay.location, (counts.get(stay.location) ?? 0) + 1);
      }
      return this.locations.filter((location) => location.kind !== 'off-campus').map((location) => {
        const count = counts.get(location.id) ?? 0;
        return { location, count, share: location.capacity > 0 ? count / location.capacity : 0, modeled: location.activityModeled !== false };
      });
    }
    for (const [agentId, trips] of this.tripsByAgent) {
      let where: string | null = this.agents.get(agentId)!.home;
      for (const trip of trips) {
        if (trip.timestamps[0] > t) break;
        where = t < trip.timestamps[trip.timestamps.length - 1] ? null : trip.to;
      }
      if (where) counts.set(where, (counts.get(where) ?? 0) + 1);
    }
    return this.locations.map((location) => {
      const count = counts.get(location.id) ?? 0;
      return { location, count, share: location.capacity > 0 ? count / location.capacity : 0, modeled: location.activityModeled !== false };
    });
  }
}

export function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor((seconds % 3600) / 60);
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}
