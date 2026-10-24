// Turns a day of precomputed trips into "where is everyone at time t".
// The server will eventually own this (plan Section 8.1); until then the client
// plays the pipeline's JSON directly so the renderer can be built and tuned now.
import { createOccupancyIndex, type OccupancyIndex } from './occupancyIndex';
import type { CasualtyEvent } from './casualties';

export type LocationKind = 'dorm' | 'classroom' | 'library' | 'dining' | 'gym' | 'outdoor' | 'off-campus';

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
  /** `dailyParticipants` on a row overrides the profile-wide limit for that weekday. */
  weekdayWindows: { weekday: number; windows: [number, number][]; dailyParticipants?: number }[];
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
  /** Capacity selected from the saved source/model basis, before playback. */
  referenceCapacity?: number;
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

/** One BU campus. Cross-campus travel requires a connected pedestrian route. */
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
  academicCampus?: string;
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

/** Why an agent occupies a stay. `fixed` stays (published classes) must never be relocated. */
export type StayPurpose =
  | { kind: 'class'; fixed: true; meetingId: string; courseCode: string }
  | { kind: 'dining' | 'library' | 'gym'; fixed: false }
  | { kind: 'estimated'; fixed: false; purpose: EstimatedActivityProfile['purpose'] }
  | { kind: 'off-campus-meal' | 'off-campus-outing' | 'unmapped-academic'; fixed: false }
  | { kind: 'wait'; fixed: false; before: 'class' | 'activity' }
  | { kind: 'home'; fixed: false };
export interface Stay { agent: string; location: string; start: number; end: number; purpose?: StayPurpose }

/**
 * A student stepping off (`alight`) or onto (`board`) one published MBTA trip at a campus stop.
 * `time` is the published arrival (alight) or departure (board); boarders wait from `waitStart`.
 */
export interface TransitRide {
  /** A scenario can invalidate a future ride without rewriting playback before the incident. */
  cancelledAt?: number;
  agent: string;
  kind: 'alight' | 'board';
  trip: string; // GTFS trip id
  route: string;
  direction: 0 | 1;
  stop: string; // map stop id
  time: number;
  waitStart?: number;
  position: [number, number];
}

/** A student standing at a stop for their published departure. */
export interface WaitingRider { id: string; model: number; stop: string; route: string; direction: 0 | 1; position: [number, number]; boardsAt: number }

export interface DayData {
  stays?: Stay[];
  transitRides?: TransitRide[];
  day: string;
  campuses?: Campus[];
  buildings: BuildingFootprint[];
  locations: CampusLocation[];
  agents: Agent[];
  trips: Trip[];
  walkRoutes?: Record<string, { path: [number, number][]; cumulative: number[] }>;
  /** Walks from transit stops to nearby locations, keyed "stopId>locationId" (see sim/riders.ts). */
  stopRoutes?: Record<string, WalkRoute>;
  /** Disaster scenarios only: at most one terminal event per agent, sorted by time then agent id. */
  casualties?: CasualtyEvent[];
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
  private readonly stayOccupancy: OccupancyIndex | null;
  private readonly walkingBuckets = new Map<number, Trip[]>();
  private readonly outdoorStays: { stay: Stay; location: CampusLocation }[] = [];
  private trailWindow: { first: number; last: number; trips: Trip[] } | null = null;
  private readonly ridesByTrip = new Map<string, TransitRide[]>();
  private readonly waitingBuckets = new Map<number, TransitRide[]>();
  /** Sorted copy of data.casualties; the caller's array is never reordered. */
  private readonly casualties: CasualtyEvent[];
  private readonly casualtyByAgent = new Map<string, CasualtyEvent>();

  readonly data: DayData;

  constructor(data: DayData) {
    for (const location of data.locations) {
      if (!Number.isFinite(location.capacity) || location.capacity < 0
        || location.referenceCapacity !== undefined && location.capacity !== location.referenceCapacity) {
        throw new Error(`Capacity differs from its source/model basis: ${location.id}`);
      }
    }
    this.data = data;
    this.stayOccupancy = data.stays ? createOccupancyIndex(data.stays) : null;
    this.locations = data.locations;
    for (const agent of data.agents) {
      if (this.agents.has(agent.id)) throw new Error(`Duplicate student: ${agent.id}`);
      this.agents.set(agent.id, agent);
      this.tripsByAgent.set(agent.id, []);
    }
    this.casualties = validateCasualties(data.casualties, this.agents);
    for (const event of this.casualties) this.casualtyByAgent.set(event.agentId, event);
    // Walks are cut at an agent's casualty event, so neither markers nor trails show later movement.
    // The clipped copies are built once: trail candidates stay stable and rewinding needs no rebuild.
    for (const original of data.trips) {
      const event = this.casualtyByAgent.get(original.agent);
      const trip = event ? clipTrip(original, event.at) : original;
      if (!trip) continue;
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
    for (const ride of data.transitRides ?? []) {
      const list = this.ridesByTrip.get(ride.trip) ?? [];
      list.push(ride); this.ridesByTrip.set(ride.trip, list);
      if (ride.kind !== 'board' || ride.waitStart === undefined) continue;
      for (let bucket = Math.floor(ride.waitStart / 300); bucket <= Math.floor(ride.time / 300); bucket++) {
        const waiting = this.waitingBuckets.get(bucket) ?? [];
        waiting.push(ride); this.waitingBuckets.set(bucket, waiting);
      }
    }
    for (const stay of data.stays ?? []) {
      const list = this.staysByAgent.get(stay.agent) ?? [];
      list.push(stay); this.staysByAgent.set(stay.agent, list);
    }
    const outdoorLocations = new Map(data.locations.filter(location => location.kind === 'outdoor').map(location => [location.id, location]));
    for (const stay of data.stays ?? []) {
      const location = outdoorLocations.get(stay.location);
      if (location) this.outdoorStays.push({ stay, location });
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

  /** Stable GPU candidates; timestamps clip the exact visible trail inside this window. */
  trailsAt(t: number, trailLength: number): Trip[] {
    const first = Math.floor((t - trailLength) / 300);
    const last = Math.floor(t / 300);
    if (this.trailWindow?.first === first && this.trailWindow.last === last) return this.trailWindow.trips;
    const trips = new Set<Trip>();
    for (let bucket = first; bucket <= last; bucket++) {
      for (const trip of this.walkingBuckets.get(bucket) ?? []) trips.add(trip);
    }
    this.trailWindow = { first, last, trips: [...trips] };
    return this.trailWindow.trips;
  }

  /** Modeled students aboard a published trip at time t: those yet to step off plus those who got on. */
  studentsAboard(trip: string, t: number): number {
    let count = 0;
    for (const ride of this.ridesByTrip.get(trip) ?? []) {
      if (ride.cancelledAt !== undefined && t >= ride.cancelledAt) continue;
      if (this.isCasualty(ride.agent, t)) continue;
      if (ride.kind === 'alight' ? t < ride.time : t >= ride.time) count++;
    }
    return count;
  }

  /** Students waiting at stops for their published departure at time t. */
  waitingAt(t: number): WaitingRider[] {
    const out: WaitingRider[] = [];
    for (const ride of this.waitingBuckets.get(Math.floor(t / 300)) ?? []) {
      if (ride.cancelledAt !== undefined && t >= ride.cancelledAt) continue;
      if (ride.waitStart! > t || t >= ride.time) continue;
      if (this.isCasualty(ride.agent, t)) continue;
      out.push({ id: ride.agent, model: this.agents.get(ride.agent)?.model ?? 0, stop: ride.stop, route: ride.route,
        direction: ride.direction, position: ride.position, boardsAt: ride.time });
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

  /** Stationary outdoor people are distinct from walkers and off-map students. */
  outdoorAt(t: number): WalkingAgent[] {
    return this.outdoorStays.filter(({ stay }) => stay.start <= t && t < stay.end && !this.isCasualty(stay.agent, t)).map(({ stay, location }) => ({
      id: stay.agent,
      model: this.agents.get(stay.agent)!.model,
      position: [location.position[0], location.position[1], 0],
      bearing: 0,
      to: location.id,
    }));
  }

  populationAt(t: number) {
    const occupancy = this.occupancyAt(t);
    const indoors = occupancy.reduce((sum, entry) => sum + (entry.location.kind === 'outdoor' ? 0 : entry.count), 0);
    const outdoors = occupancy.reduce((sum, entry) => sum + (entry.location.kind === 'outdoor' ? entry.count : 0), 0);
    const walking = this.walkingAt(t).length;
    let injured = 0, fatalities = 0;
    for (const event of this.casualtiesAt(t)) if (event.outcome === 'fatality') fatalities++; else injured++;
    const total = this.data.agents.length;
    return { total, indoors, outdoors, walking, offCampus: total - indoors - outdoors - walking - injured - fatalities,
      injured, fatalities, alive: total - fatalities };
  }

  /** Casualty events that have happened by time t (inclusive), in time then agent order. Never includes future events. */
  casualtiesAt(t: number): CasualtyEvent[] {
    if (!Number.isFinite(t)) return [];
    let lo = 0, hi = this.casualties.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.casualties[mid].at <= t) lo = mid + 1; else hi = mid; }
    return this.casualties.slice(0, lo);
  }

  /** From its event onward an injured or killed agent leaves every normal category. Rewinding before it restores them. */
  private isCasualty(agentId: string, t: number): boolean {
    const event = this.casualtyByAgent.get(agentId);
    return event !== undefined && t >= event.at;
  }

  /**
   * Show the busiest modeled space on each footprint. Its name, count and reference
   * capacity describe that same space, rather than mixing totals with a maximum ratio.
   */
  byBuilding(occupancy: Occupancy[]): BuildingOccupancy[] {
    const out = new Map<string, BuildingOccupancy>();
    for (const { location, count, modeled = location.activityModeled !== false } of occupancy) {
      if (location.kind === 'off-campus' || location.kind === 'outdoor') continue;
      const share = occupancyShare(count, location.capacity);
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
    // Copy before removing casualties so an index that ever caches its maps is never corrupted for rewinds.
    const counts = new Map(this.stayOccupancy?.countsAt(t) ?? []);
    if (this.data.stays) {
      if (this.stayOccupancy) {
        // Remove each active casualty's scheduled stay using the index's own rule: on-map, nonzero, start <= t < end.
        for (const event of this.casualtiesAt(t)) {
          for (const stay of this.staysByAgent.get(event.agentId) ?? []) {
            if (stay.location === 'off-campus' || stay.start === stay.end || stay.start > t || t >= stay.end) continue;
            const count = counts.get(stay.location) ?? 0;
            if (count <= 1) counts.delete(stay.location); else counts.set(stay.location, count - 1);
          }
        }
      } else {
        for (const [agentId, stays] of this.staysByAgent) {
          if (this.isCasualty(agentId, t)) continue;
          const stay = stays.find((entry) => entry.start <= t && t < entry.end);
          if (stay && stay.location !== 'off-campus') counts.set(stay.location, (counts.get(stay.location) ?? 0) + 1);
        }
      }
      return this.locations.filter((location) => location.kind !== 'off-campus').map((location) => {
        const count = counts.get(location.id) ?? 0;
        return { location, count, share: location.capacity > 0 ? count / location.capacity : 0, modeled: location.activityModeled !== false };
      });
    }
    for (const [agentId, trips] of this.tripsByAgent) {
      if (this.isCasualty(agentId, t)) continue;
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

const CASUALTY_OUTCOMES = new Set(['injured', 'fatality']);
const CASUALTY_CAUSES = new Set(['fire', 'earthquake', 'meteor']);

/** Checks every record without mutating it; returns a sorted copy (time, then agent id). */
function validateCasualties(events: readonly CasualtyEvent[] | undefined, agents: ReadonlyMap<string, Agent>): CasualtyEvent[] {
  if (events === undefined) return [];
  if (!Array.isArray(events)) throw new Error('Invalid casualties: expected an array');
  const seen = new Set<string>();
  for (const event of events) {
    const id = event?.agentId;
    if (typeof id !== 'string' || !agents.has(id)) throw new Error(`Casualty for unknown student: ${String(id)}`);
    if (seen.has(id)) throw new Error(`More than one casualty event for student: ${id}`);
    seen.add(id);
    if (!CASUALTY_OUTCOMES.has(event.outcome)) throw new Error(`Invalid casualty outcome for ${id}`);
    if (!CASUALTY_CAUSES.has(event.cause)) throw new Error(`Invalid casualty cause for ${id}`);
    if (typeof event.at !== 'number' || !Number.isFinite(event.at) || event.at < 0 || event.at > 86400) throw new Error(`Invalid casualty time for ${id}`);
    const p = event.position;
    if (!Array.isArray(p) || p.length !== 2 || !p.every(Number.isFinite) || Math.abs(p[0]) > 180 || Math.abs(p[1]) > 90) {
      throw new Error(`Invalid casualty position for ${id}`);
    }
    if (event.buildingId !== undefined && typeof event.buildingId !== 'string') throw new Error(`Invalid casualty building for ${id}`);
  }
  return [...events].sort((a, b) => a.at - b.at || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

/** The part of a walk before `at`, ending at its interpolated position; null when the walk starts at or after `at`. */
function clipTrip(trip: Trip, at: number): Trip | null {
  const ts = trip.timestamps;
  if (ts[0] >= at) return null;
  if (ts[ts.length - 1] <= at) return trip;
  let i = 1;
  while (ts[i] <= at) i++;
  const a = trip.path[i - 1], b = trip.path[i];
  const f = ts[i] === ts[i - 1] ? 0 : (at - ts[i - 1]) / (ts[i] - ts[i - 1]);
  const end: [number, number] = [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  const path = trip.path.slice(0, i);
  const timestamps = ts.slice(0, i);
  if (ts[i - 1] < at) { path.push(end); timestamps.push(at); }
  return { ...trip, path, timestamps };
}

export function occupancyShare(count: number, capacity: number): number {
  if (!Number.isInteger(count) || count < 0 || !Number.isFinite(capacity) || capacity < 0) throw new Error('Invalid occupancy');
  return capacity > 0 ? count / capacity : 0;
}

export function formatClock(seconds: number): string {
  const h = Math.floor(seconds / 3600) % 24;
  const m = Math.floor((seconds % 3600) / 60);
  const suffix = h < 12 ? 'AM' : 'PM';
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${suffix}`;
}
