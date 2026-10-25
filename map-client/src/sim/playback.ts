// Turns a day of precomputed trips into "where is everyone at time t".
// The server will eventually own this (plan Section 8.1); until then the client
// plays the pipeline's JSON directly so the renderer can be built and tuned now.
import { countedLocation, splitResidenceIds, splitResidences, splitResidenceStays } from './residenceSplit';
import { drain, occupancyIndexSteps, type OccupancyIndex } from './occupancyIndex';
import type { CasualtyEvent } from './casualties';
import { abreastOffset, MAX_ABREAST } from './groups';

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
  /** A residence that also holds classrooms (Kilachand): its beds, which its percentage is shown against. */
  residentialBeds?: number;
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
  residentialBeds?: number;
  id: string;
  name: string; // the building's busiest location right now
  short: string;
  position: [number, number];
  count: number;
  capacity: number;
  share: number;
  /** Tag height in metres when it isn't the building's roof (a dining hall in a tower's podium). */
  roof?: number;
  /** A venue event under way here: its crowd, shown beside (never inside) the student figures. */
  event?: { text: string; description: string };
  /** A venue that isn't a simulated place (Fenway Park): its tag shows only the event. */
  eventOnly?: boolean;
}

export interface Agent {
  /** 'staff' marks a BU employee (faculty or staff, sim/staff.ts); students carry no role. */
  role?: 'staff';
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
  | { kind: 'dining' | 'library' | 'gym' | 'outdoor'; fixed: false }
  /** An employee at their workplace (sim/staff.ts). */
  | { kind: 'work'; fixed: false }
  | { kind: 'estimated'; fixed: false; purpose: EstimatedActivityProfile['purpose'] }
  | { kind: 'off-campus-meal' | 'off-campus-outing' | 'unmapped-academic'; fixed: false }
  | { kind: 'gathering'; fixed: false; eventId: string }
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
  /** A ride between two campus stops (sim/campusRides.ts), recorded as a board and an alight on one trip:
   * the board record carries the published arrival where the rider steps off again, the alight record
   * the published departure where they got on. Commute rides have neither (the other end is off the map). */
  alightsAt?: number;
  boardedAt?: number;
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
export interface DayFile extends Omit<DayData, 'trips'> {
  walkRoutes: Record<string, WalkRoute>;
  trips: { agent: string; from: string; to: string; depart: number; speed: number }[];
}

export async function loadDay(url: string): Promise<DayData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  return expandDay(await res.json());
}

/** Places left off the map: After Hours at West Campus, a late-night counter in Claflin Hall, would
 * only ever show an empty tag through the modeled day (late-night snacks are not modeled). */
export const HIDDEN_LOCATIONS: ReadonlySet<string> = new Set(['after-hours-west']);

/** The parsed day file as playable data. The server reads the same file from disk. */
export function expandDay(file: DayFile): DayData {
  const shown = (key: string) => !key.split('>').some((id) => HIDDEN_LOCATIONS.has(id));
  const walkRoutes = Object.fromEntries(Object.entries(file.walkRoutes).filter(([key]) => shown(key)));
  const stopRoutes = file.stopRoutes && Object.fromEntries(Object.entries(file.stopRoutes).filter(([key]) => shown(key)));
  // Expand to full trips; trips on the same route share its path array.
  const trips = file.trips.filter(({ from, to }) => shown(`${from}>${to}`)).map(({ agent, from, to, depart, speed }) => {
    const route = walkRoutes[`${from}>${to}`];
    return { agent, from, to, path: route.path, timestamps: route.cumulative.map((m) => depart + m / speed) };
  });
  return { ...file, locations: file.locations.filter((location) => !HIDDEN_LOCATIONS.has(location.id)), walkRoutes, stopRoutes, trips };
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

// A segment's bearing never changes, so it is worked out once per route (every trip on a route
// shares its path array) instead of with seven trig calls per walker per frame.
const segmentBearings = new WeakMap<[number, number][], Float64Array>();
function segmentBearing(path: [number, number][], i: number): number {
  let bearings = segmentBearings.get(path);
  if (!bearings) segmentBearings.set(path, (bearings = new Float64Array(path.length).fill(NaN)));
  let bearing = bearings[i];
  if (Number.isNaN(bearing)) bearing = bearings[i] = bearingBetween(path[i - 1], path[i]);
  return bearing;
}

/** The lookups a Playback is built on (see indexPlayback). */
export interface PlaybackIndex {
  agents: Map<string, Agent>;
  tripsByAgent: Map<string, Trip[]>;
  staysByAgent: Map<string, Stay[]>;
  stayOccupancy: OccupancyIndex | null;
  walkingBuckets: Map<number, Trip[]>;
  outdoorStays: { stay: Stay; location: CampusLocation }[];
  ridesByTrip: Map<string, TransitRide[]>;
  waitingBuckets: Map<number, TransitRide[]>;
  casualties: CasualtyEvent[];
  casualtyByAgent: Map<string, CasualtyEvent>;
  /** Walks shared with others (same places, route and times: friends going to a meal together,
   * sim/groups.ts), in metres right of travel, so those walkers are drawn side by side. */
  walkSides: Map<Trip, number>;
}

/** Index a day in resumable steps (yields every few thousand items), so a rebuilt day can be
 * prepared across frames without a hitch; `new Playback(data)` simply runs it to the end. */
export function* indexPlayback(data: DayData, chunk = 4096): Generator<void, PlaybackIndex> {
  let work = 0;
  // Counted with residences split into dorm and classrooms (sim/residenceSplit.ts); the stays themselves are unchanged.
  const stayOccupancy = data.stays ? yield* occupancyIndexSteps(splitResidenceStays(data.stays, data.locations), chunk) : null;
  const agents = new Map<string, Agent>(), tripsByAgent = new Map<string, Trip[]>(), staysByAgent = new Map<string, Stay[]>();
  const walkingBuckets = new Map<number, Trip[]>(), ridesByTrip = new Map<string, TransitRide[]>(), waitingBuckets = new Map<number, TransitRide[]>();
  const outdoorStays: { stay: Stay; location: CampusLocation }[] = [];
  for (const agent of data.agents) {
    if (agents.has(agent.id)) throw new Error(`Duplicate student: ${agent.id}`);
    agents.set(agent.id, agent);
    tripsByAgent.set(agent.id, []);
    if (++work % chunk === 0) yield;
  }
  const casualties = validateCasualties(data.casualties, agents);
  const casualtyByAgent = new Map<string, CasualtyEvent>();
  for (const event of casualties) casualtyByAgent.set(event.agentId, event);
  const doorway = doorways(data);
  // Walks are cut at an agent's casualty event, so neither markers nor trails show later movement.
  // The clipped copies are built once: trail candidates stay stable and rewinding needs no rebuild.
  for (const routed of data.trips) {
    const original = doorway(routed);
    const event = casualtyByAgent.get(original.agent);
    const trip = event ? clipTrip(original, event.at) : original;
    if (!trip) continue;
    const list = tripsByAgent.get(trip.agent) ?? [];
    list.push(trip);
    tripsByAgent.set(trip.agent, list);
    const start = trip.timestamps[0];
    const end = trip.timestamps[trip.timestamps.length - 1];
    for (let bucket = Math.floor(start / 300); bucket < Math.ceil(end / 300); bucket++) {
      const active = walkingBuckets.get(bucket) ?? [];
      active.push(trip);
      walkingBuckets.set(bucket, active);
    }
    if (++work % chunk === 0) yield;
  }
  // People setting off from the same door at the same moment (friends leaving a meal, sim/groups.ts)
  // would be drawn on top of each other for as long as their routes coincide: spread them abreast.
  // A bigger crowd leaving at once walks in rows MAX_ABREAST wide, people on identical walks side by side.
  const arrivalKey = (trip: Trip) => `${trip.to}|${trip.timestamps[trip.timestamps.length - 1]}|${trip.agent}`;
  const departures = new Map<string, Trip[]>();
  for (const trips of tripsByAgent.values()) for (const trip of trips) {
    const key = `${trip.from}|${Math.round(trip.timestamps[0] * 100)}|${trip.path[0]}`;
    const list = departures.get(key);
    if (list) list.push(trip); else departures.set(key, [trip]);
    if (++work % chunk === 0) yield;
  }
  const walkSides = new Map<Trip, number>();
  for (const list of departures.values()) {
    if (list.length < 2) continue;
    const keys = new Map(list.map(trip => [trip, arrivalKey(trip)]));
    list.sort((a, b) => keys.get(a)! < keys.get(b)! ? -1 : keys.get(a)! > keys.get(b)! ? 1 : 0);
    const width = Math.min(list.length, MAX_ABREAST);
    list.forEach((trip, rank) => walkSides.set(trip, abreastOffset(rank % MAX_ABREAST, width)));
    if (++work % chunk === 0) yield;
  }
  for (const ride of data.transitRides ?? []) {
    const list = ridesByTrip.get(ride.trip) ?? [];
    list.push(ride); ridesByTrip.set(ride.trip, list);
    if (++work % chunk === 0) yield;
    if (ride.kind !== 'board' || ride.waitStart === undefined) continue;
    for (let bucket = Math.floor(ride.waitStart / 300); bucket <= Math.floor(ride.time / 300); bucket++) {
      const waiting = waitingBuckets.get(bucket) ?? [];
      waiting.push(ride); waitingBuckets.set(bucket, waiting);
    }
  }
  for (const stay of data.stays ?? []) {
    const list = staysByAgent.get(stay.agent) ?? [];
    list.push(stay); staysByAgent.set(stay.agent, list);
    if (++work % chunk === 0) yield;
  }
  const outdoorLocations = new Map(data.locations.filter(location => location.kind === 'outdoor').map(location => [location.id, location]));
  for (const stay of data.stays ?? []) {
    const location = outdoorLocations.get(stay.location);
    if (location) outdoorStays.push({ stay, location });
    if (++work % chunk === 0) yield;
  }
  for (const list of staysByAgent.values()) { list.sort((a, b) => a.start - b.start); if (++work % chunk === 0) yield; }
  for (const list of tripsByAgent.values()) { list.sort((a, b) => a.timestamps[0] - b.timestamps[0]); if (++work % chunk === 0) yield; }
  return { agents, tripsByAgent, staysByAgent, stayOccupancy, walkingBuckets, outdoorStays, ridesByTrip, waitingBuckets, casualties, casualtyByAgent, walkSides };
}

export class Playback {
  readonly locations: CampusLocation[];
  private readonly agents: Map<string, Agent>;
  private readonly tripsByAgent: Map<string, Trip[]>;
  private readonly staysByAgent: Map<string, Stay[]>;
  private readonly stayOccupancy: OccupancyIndex | null;
  /** Residences reported as dorm + classrooms; stays there are counted with countedLocation. */
  private readonly splitIds: ReadonlySet<string>;
  private readonly walkingBuckets: Map<number, Trip[]>;
  private readonly outdoorStays: { stay: Stay; location: CampusLocation }[];
  private trailWindow: { first: number; last: number; trips: Trip[] } | null = null;
  private readonly ridesByTrip: Map<string, TransitRide[]>;
  private readonly waitingBuckets: Map<number, TransitRide[]>;
  /** Sorted copy of data.casualties; the caller's array is never reordered. */
  private readonly casualties: CasualtyEvent[];
  private readonly casualtyByAgent: Map<string, CasualtyEvent>;
  private readonly walkSides: Map<Trip, number>;

  readonly data: DayData;

  /** `index` (optional) is indexPlayback(data) already run, e.g. in slices between frames. */
  constructor(data: DayData, index?: PlaybackIndex) {
    for (const location of data.locations) {
      if (!Number.isFinite(location.capacity) || location.capacity < 0
        || location.referenceCapacity !== undefined && location.capacity !== location.referenceCapacity) {
        throw new Error(`Capacity differs from its source/model basis: ${location.id}`);
      }
    }
    this.data = data;
    this.locations = splitResidences(data.locations);
    this.splitIds = splitResidenceIds(data.locations);
    const built = index ?? drain(indexPlayback(data));
    this.stayOccupancy = built.stayOccupancy;
    this.agents = built.agents;
    this.tripsByAgent = built.tripsByAgent;
    this.staysByAgent = built.staysByAgent;
    this.walkingBuckets = built.walkingBuckets;
    this.outdoorStays = built.outdoorStays;
    this.ridesByTrip = built.ridesByTrip;
    this.waitingBuckets = built.waitingBuckets;
    this.casualties = built.casualties;
    this.casualtyByAgent = built.casualtyByAgent;
    this.walkSides = built.walkSides;
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
      // A ride between campus stops is aboard only between its two stops (counted once, on the alight record).
      if (ride.alightsAt !== undefined) continue;
      if (ride.boardedAt !== undefined ? ride.boardedAt <= t && t < ride.time : ride.kind === 'alight' ? t < ride.time : t >= ride.time) count++;
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
      // First timestamp after t (timestamps never decrease): a binary search, since every frame
      // places thousands of walkers along routes of dozens of points.
      let i = 1, hi = ts.length - 1;
      while (i < hi) { const mid = (i + hi) >>> 1; if (ts[mid] <= t) i = mid + 1; else hi = mid; }
      const a = trip.path[i - 1];
      const b = trip.path[i];
      const f = ts[i] === ts[i - 1] ? 0 : (t - ts[i - 1]) / (ts[i] - ts[i - 1]);
      // Walking abreast with others on the same walk: shifted `side` metres right of travel.
      const side = this.walkSides.get(trip) ?? 0;
      let ox = 0, oy = 0;
      if (side) {
        const kx = 111320 * Math.cos(a[1] * Math.PI / 180), dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * 111320, length = Math.hypot(dx, dy);
        if (length > 0) { ox = dy / length * side / kx; oy = -dx / length * side / 111320; }
      }
      out.push({
        id: agentId,
        model: this.agents.get(agentId)!.model,
        position: [a[0] + (b[0] - a[0]) * f + ox, a[1] + (b[1] - a[1]) * f + oy, 0],
        bearing: segmentBearing(trip.path, i),
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
        residentialBeds: location.residentialBeds,
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
            const where = countedLocation(stay, this.splitIds);
            const count = counts.get(where) ?? 0;
            if (count <= 1) counts.delete(where); else counts.set(where, count - 1);
          }
        }
      } else {
        for (const [agentId, stays] of this.staysByAgent) {
          if (this.isCasualty(agentId, t)) continue;
          const stay = stays.find((entry) => entry.start <= t && t < entry.end);
          if (stay && stay.location !== 'off-campus') {
            const where = countedLocation(stay, this.splitIds);
            counts.set(where, (counts.get(where) ?? 0) + 1);
          }
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

/** Walk routes start and end on the path network, often 20–100 m from the building, so walkers
 * would appear and vanish on the pavement. Each walk instead leaves from the nearest point on its
 * origin's footprint and ends on its destination's. The walk keeps its departure and arrival times
 * (stays and counts are unchanged) and covers the doorway legs by walking a little faster; a walk
 * that would need more than MAX_DOORWAY_PACE keeps its network ends. Places without a footprint
 * (stops, gateways, off-campus) keep their ends as they are. */
const MAX_DOORWAY_METRES = 150;
const MAX_DOORWAY_PACE = 2; // m/s

function doorways(data: DayData): (trip: Trip) => Trip {
  const rings = new Map<string, [number, number][][]>();
  for (const building of data.buildings ?? []) {
    const list = rings.get(building.id) ?? [];
    list.push(building.polygon); rings.set(building.id, list);
  }
  const buildingOf = new Map(data.locations.map((location) => [location.id, location.building]));
  const cache = new Map<string, [number, number] | null>();
  const door = (location: string, from: [number, number]): [number, number] | null => {
    const key = `${location}|${from[0]},${from[1]}`;
    if (cache.has(key)) return cache.get(key)!;
    const polygons = rings.get(buildingOf.get(location) ?? '') ?? [];
    let best: [number, number] | null = null, bestMetres = MAX_DOORWAY_METRES;
    if (!polygons.some((polygon) => contains(polygon, from))) {
      for (const polygon of polygons) for (let i = 0; i < polygon.length; i++) {
        const point = nearestOnSegment(from, polygon[i], polygon[(i + 1) % polygon.length]);
        const metres = metresBetween(from, point);
        if (metres < bestMetres) { best = point; bestMetres = metres; }
      }
    }
    cache.set(key, best);
    return best;
  };
  return (trip) => {
    const { path, timestamps } = trip;
    if (path.length < 2) return trip;
    const start = door(trip.from, path[0]), end = door(trip.to, path[path.length - 1]);
    if (!start && !end) return trip;
    const first = timestamps[0], seconds = timestamps[timestamps.length - 1] - first;
    const nextPath = [...(start ? [start] : []), ...path, ...(end ? [end] : [])];
    const along = [0];
    for (let i = 1; i < nextPath.length; i++) along.push(along[i - 1] + metresBetween(nextPath[i - 1], nextPath[i]));
    const length = along[along.length - 1];
    if (!(seconds > 0) || length / seconds > MAX_DOORWAY_PACE) return trip;
    return { ...trip, path: nextPath, timestamps: along.map((metres) => first + metres / length * seconds) };
  };
}

function metresBetween(a: [number, number], b: [number, number]): number {
  return Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 111320);
}

function nearestOnSegment(p: [number, number], a: [number, number], b: [number, number]): [number, number] {
  // Planar in degrees with longitude scaled to latitude; exact enough within one building.
  const k = Math.cos(p[1] * Math.PI / 180);
  const dx = (b[0] - a[0]) * k, dy = b[1] - a[1];
  const span = dx * dx + dy * dy;
  const f = span === 0 ? 0 : Math.max(0, Math.min(1, (((p[0] - a[0]) * k) * dx + (p[1] - a[1]) * dy) / span));
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

function contains(polygon: [number, number][], [x, y]: [number, number]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
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
