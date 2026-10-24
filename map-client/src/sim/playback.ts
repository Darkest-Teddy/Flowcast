// Turns a day of precomputed trips into "where is everyone at time t".
// The server will eventually own this (plan Section 8.1); until then the client
// plays the pipeline's JSON directly so the renderer can be built and tuned now.

export type LocationKind = 'dorm' | 'classroom' | 'library' | 'dining' | 'gym';

export interface CampusLocation {
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
  id: string;
  name: string; // the building's busiest location right now
  short: string;
  position: [number, number];
  count: number;
  capacity: number;
  share: number;
}

export interface Agent {
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

export interface DayData {
  day: string;
  campuses?: Campus[];
  buildings: BuildingFootprint[];
  locations: CampusLocation[];
  agents: Agent[];
  trips: Trip[];
  walkRoutes?: Record<string, { path: [number, number][]; cumulative: number[] }>;
}

export interface WalkingAgent {
  id: string;
  model: number;
  position: [number, number, number];
  bearing: number; // degrees clockwise from north
  to: string;
}

export interface Occupancy {
  location: CampusLocation;
  count: number;
  share: number; // count / capacity, can exceed 1
}

/** The file on disk: each walk route stored once, trips as who/where/when/how fast. */
interface DayFile extends Omit<DayData, 'trips'> {
  walkRoutes: Record<string, { path: [number, number][]; cumulative: number[] }>;
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
    }
    for (const list of this.tripsByAgent.values()) list.sort((a, b) => a.timestamps[0] - b.timestamps[0]);
  }

  get startTime(): number {
    return this.data.trips.length ? Math.min(...this.data.trips.map((t) => t.timestamps[0])) : 0;
  }

  get endTime(): number {
    return this.data.trips.length ? Math.max(...this.data.trips.map((t) => t.timestamps[t.timestamps.length - 1])) : 86400;
  }

  /** Agents outdoors on a walkway at time t; everyone else is inside a building. */
  walkingAt(t: number): WalkingAgent[] {
    const out: WalkingAgent[] = [];
    for (const [agentId, trips] of this.tripsByAgent) {
      const trip = trips.find((tr) => tr.timestamps[0] <= t && t < tr.timestamps[tr.timestamps.length - 1]);
      if (!trip) continue;
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

  /**
   * Roll location occupancy up to footprints, so co-located places share one label and glow.
   * Counts include every co-located place. The color scale retains the busiest place's
   * model load so a busy dining hall remains visible beneath a quiet dorm.
   */
  byBuilding(occupancy: Occupancy[]): BuildingOccupancy[] {
    const out = new Map<string, BuildingOccupancy>();
    for (const { location, count, share } of occupancy) {
      const current = out.get(location.building);
      if (current) {
        current.count += count;
        current.capacity += location.capacity;
        current.share = Math.max(current.share, share);
        continue;
      }
      out.set(location.building, {
        id: location.building,
        name: location.name,
        short: location.short,
        position: location.position,
        count,
        capacity: location.capacity,
        share,
      });
    }
    return [...out.values()];
  }

  /** Head count per location at time t: each agent is at its last destination, or home before its first trip. */
  occupancyAt(t: number): Occupancy[] {
    const counts = new Map<string, number>();
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
      return { location, count, share: count / location.capacity };
    });
  }
}

export function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor((seconds % 3600) / 60);
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}
