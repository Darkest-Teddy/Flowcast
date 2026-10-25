import type { CampusLocation, DayData, Stay, StayPurpose, Trip, WalkRoute } from './playback';
import { ALIGHT_SECONDS, MAX_STOP_WAIT_SECONDS } from './transitService';
import {
  ACTIVITY_DECISION_ASSUMPTIONS, minimumUseful, POLICY_KINDS, purposeResolver, RELOCATABLE_KINDS, VenueLedger, venueOpenFor,
  type IncidentActivity, type IncidentContext, type IncidentDecision,
} from './incidentActivities';
export type { IncidentAction, IncidentActivity, IncidentContext, IncidentDecision } from './incidentActivities';
export { ACTIVITY_DECISION_ASSUMPTIONS, ACTIVITY_DECISION_LIMITATIONS } from './incidentActivities';
import { DISASTER_ASSUMPTIONS, hazardZone, isDisasterKind, type DisasterKind } from './disasters';
export { DISASTER_ASSUMPTIONS, DISASTER_LIMITATIONS, isDisasterKind, type DisasterKind } from './disasters';
import { computeCasualties, type CasualtyEvent } from './casualties';
export { CASUALTY_ASSUMPTIONS, CASUALTY_LIMITATIONS, computeCasualties, type CasualtyEvent } from './casualties';
import { fireGeometry, concat, polyline, type FireGeometry, type LngLat, type Polyline, type Tree } from './fireEvacuation';
import { meteorEscape } from './meteorFlee';
import { cutPolyline, FIRE_CROWD_ASSUMPTIONS, planSpot, turnBackDistance, type CrowdPlan, type FireCrowd, type FireDispersal } from './fireCrowd';
export { FIRE_CROWD_ASSUMPTIONS, FIRE_CROWD_LIMITATIONS, type FireCrowd, type FireDispersal } from './fireCrowd';

export type IncidentKind = 'fire-drill' | 'fire-alarm' | 'building-closure' | 'fire' | 'earthquake' | 'meteor';
export interface Incident {
  id: string;
  kind: IncidentKind;
  locationId: string;
  /** Seconds since midnight. Requested closure is [start, start + duration); drill clearance can extend it.
   * For fire, earthquake and meteor the duration only sets the active response; damaged buildings stay closed until midnight. */
  start: number;
  duration: number;
  /** Earthquake and meteor hazard radius around the target location (defaults 250 m and 100 m). Other kinds: 0 or omitted. */
  radiusMetres?: number;
  /** Fire only: occupants first gather outside in loose crowds on nearby sidewalks (sim/fireCrowd.ts), then move on.
   * Needs the building's mapped footprint and saved pedestrian geometry around it; otherwise the fire disperses directly. */
  outdoorCrowd?: boolean;
}
/** Hazard zone of a fire, earthquake or meteor scenario. Model-derived and uncalibrated. */
export interface IncidentHazard {
  radiusMetres: number;
  /** Exits start no earlier than this (earthquake shaking and sheltering); equals start otherwise. */
  responseStartsAt: number;
  /** End of the visible active fire, shaking or impact response (start + duration). Affected
   * locations do not reopen then: they stay closed until IncidentResult.endsAt, the end of the day. */
  activeUntil: number;
  affectedLocationIds: string[];
  affectedBuildingIds: string[];
}

/**
 * evacuated: drill occupant walked to the modeled assembly point.
 * interrupted: closure occupant waited at the nearest saved-route location and returned to finish the activity.
 * cancelled: the remaining visit was dropped (closure occupant left early on the next saved walk, or an arrival skipped an expired visit).
 *   Disaster visits are always cancelled unless relocated: damaged buildings never reopen the same day.
 * delayed: arrival waited or turned back, then made the visit after reopening.
 * relocated: closure occupant or arrival moved its optional activity to another open venue.
 */
export type IncidentOutcome = 'evacuated' | 'interrupted' | 'cancelled' | 'delayed' | 'relocated';
export interface IncidentParticipant {
  agentId: string;
  role: 'occupant' | 'arrival';
  departAt: number;
  /** Arrival at the drill assembly point; always null for closures and arrivals. */
  assemblyAt: number | null;
  /** When the incident stops constraining this person (assembly release, closure reopening, or early departure). */
  releaseAt: number;
  resumedAt: number;
  /** Disasters: end of the leg they run rather than walk, from `departAt` (DISASTER_LIMITATIONS).
   *  Absent for a drill or a closure, and for anyone who never has to get clear. */
  fleesUntil?: number;
  outcome?: IncidentOutcome;
  /** Existing location where an interrupted closure occupant waits. */
  waitLocationId?: string;
  /** Alternative venue for a relocated activity. */
  relocationId?: string;
  /** Activity-aware decision; always set. Reveal only once `decision.at` has passed. */
  decision?: IncidentDecision;
  /** Fire outdoor crowd: the standing area (an outdoor location) the evacuee waited at. */
  crowdLocationId?: string;
  /** Fire outdoor crowd: how the person moved on (revealed with `decision`). */
  dispersal?: FireDispersal;
  /** Fire outdoor crowd: venue where a displaced resident shelters. */
  shelterId?: string;
}
export interface IncidentResult {
  day: DayData;
  affectedAgents: number;
  /** Modeled drill assembly point; null for building closures, which have no assembly or muster. */
  assemblyLocation: CampusLocation | null;
  participants: IncidentParticipant[];
  requestedEndsAt: number;
  /** When access reopens. Disasters: 86400 (damaged buildings stay closed for the rest of the day). */
  endsAt: number;
  /** Measured metric distance from the drill assembly point to the nearest saved footprint edge; null for closures. */
  assemblyClearanceMetres?: number | null;
  /** Present only for fire, earthquake and meteor scenarios. */
  hazard?: IncidentHazard;
  /** Illustrative injuries and fatalities (disasters only; same array as day.casualties), sorted by at then agentId.
   * The day's stays and trips stay the planned paths; playback stops each person at their event. */
  casualties?: CasualtyEvent[];
  /** Fire with an outdoor crowd: standing areas (also in day.locations), per-person spots and exits. */
  crowd?: FireCrowd;
}

/** Illustrative, uncalibrated assumptions; not a building evacuation assessment. */
export const INCIDENT_ASSUMPTIONS = {
  reactionMinSeconds: 15, reactionMaxSeconds: 90,
  floorHeightMetres: 3.5, stairSecondsPerFloor: 8,
  exitPersonsPerSecond: 2, returnPersonsPerSecond: 1,
  musterSeconds: 60, assemblyMinimumWalkMetres: 20,
  assemblyFootprintClearanceMetres: 10,
} as const;
export const INCIDENT_LIMITATIONS = [
  'Assembly is a point on saved pedestrian geometry at least 10 metres (an uncalibrated buffer) outside every saved footprint, not a verified safe or official assembly area; capacity is unknown.',
  'Reaction (15–90 seconds), estimated stair descent, shared-footprint exit flow (2 persons/second), muster (60 seconds), and return flow (1 person/second) are uncalibrated assumptions. Closures reuse the same reaction, stair and exit-flow values for clearing.',
  'Closures have no assembly, muster or extension. An occupant whose saved schedule leaves the building before a round trip to the nearest saved-route location and back could finish leaves early on that saved walk (cancelled); others wait at that nearest location, whose access and capacity are not checked, and return after reopening (interrupted).',
  'Restrictions apply to building visits. Unchanged through-traffic on saved paths can cross closed footprints.',
  'Published transit rides are retained only when the changed walking itinerary can still reach them; missed rides are removed without choosing a replacement service.',
  'Saved paths are reversible; no emergency exits, accessible egress, hazard spread, pedestrian exclusion zones or assembly capacity are modeled.',
  'Arrivals wait at origin or retrace their traveled approach. A visit that would end before they could reach it is skipped when a saved route or saved return connects; otherwise the original walk is replayed. Class end times are never shifted.',
  'Requires complete explicit daily timelines and one incident on an immutable baseline. Scenarios whose drill muster or closure clearing exceed midnight are rejected.',
] as const;

const DAY = 86400;
const EPS = 1e-7;
const samePoint = (a: number[], b: number[]) => a.length === 2 && b.length === 2
  && a.every((value, index) => Math.abs(value - b[index]) <= 1e-10);
const endOf = (trip: Trip) => trip.timestamps[trip.timestamps.length - 1];
// Same lower bound used by sourceDay for travel between off-campus gateways.
function gatewaySeconds(a: [number, number], b: [number, number], speed: number): number {
  const radians = Math.PI / 180;
  const h = Math.sin((b[1] - a[1]) * radians / 2) ** 2
    + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin((b[0] - a[0]) * radians / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h))) / speed;
}
const fail = (detail: string): never => { throw new Error(`Unsupported day timeline: ${detail}`); };
type Event = { start: number; end: number; from: string; to: string; trip?: Trip; stay?: Stay };

function timelines(day: DayData): Map<string, Event[]> {
  if (!day.stays) fail('explicit stays are required');
  const locations = new Set(day.locations.map(location => location.id));
  if (locations.size !== day.locations.length) fail('duplicate locations');
  locations.add('off-campus');
  // The source-day planner omits zero-length walks between co-located venues
  // (for example Questrom and Pardee). Require saved geometry as evidence.
  const zeroRoutes = new Map<string, { to: string; point: [number, number] }[]>();
  for (const [key, route] of Object.entries(day.walkRoutes ?? {})) {
    const [from, to] = key.split('>');
    if (!locations.has(from) || !locations.has(to) || route.path.length < 2 || route.path.length !== route.cumulative.length
      || !route.cumulative.every(distance => distance === 0)
      || !route.path.every(point => point.every(Number.isFinite) && samePoint(point, route.path[0]))) continue;
    const edges = zeroRoutes.get(from) ?? [];
    edges.push({ to, point: route.path[0] }); zeroRoutes.set(from, edges);
  }
  const colocated = (from: string, to: string) => {
    const visited = new Set([from]);
    const queue = [{ to: from, point: undefined as [number, number] | undefined }];
    for (const node of queue) for (const edge of zeroRoutes.get(node.to) ?? []) {
      if (visited.has(edge.to) || node.point && !samePoint(node.point, edge.point)) continue;
      if (edge.to === to) return true;
      visited.add(edge.to); queue.push(edge);
    }
    return false;
  };
  const result = new Map<string, Event[]>();
  for (const agent of day.agents) {
    if (result.has(agent.id)) fail(`duplicate agent ${agent.id}`);
    result.set(agent.id, []);
  }
  const add = (agent: string, event: Event) => {
    const events = result.get(agent);
    if (!events || !locations.has(event.from) || !locations.has(event.to)) fail('unknown agent or location');
    if (!Number.isFinite(event.start) || !Number.isFinite(event.end)
      || event.start < 0 || event.end > DAY || event.end <= event.start) fail('invalid interval');
    events!.push(event);
  };
  for (const stay of day.stays!) add(stay.agent, { start: stay.start, end: stay.end, from: stay.location, to: stay.location, stay });
  for (const trip of day.trips) {
    if (trip.path.length < 2 || trip.path.length !== trip.timestamps.length
      || trip.path.some(point => point.length !== 2 || !point.every(Number.isFinite))
      || trip.timestamps.some((time, index) => !Number.isFinite(time) || index > 0 && (time < trip.timestamps[index - 1]
        || time === trip.timestamps[index - 1] && !samePoint(trip.path[index], trip.path[index - 1])))) fail('invalid trip geometry or timestamps');
    add(trip.agent, { start: trip.timestamps[0], end: endOf(trip), from: trip.from, to: trip.to, trip });
  }
  for (const [agent, events] of result) {
    events.sort((a, b) => a.start - b.start);
    let time = 0;
    let where = events[0]?.from;
    let endpoint: [number, number] | undefined;
    for (const event of events) {
      if (Math.abs(event.start - time) > EPS || event.from !== where && !colocated(where!, event.from)) fail(`gap, overlap or disconnected itinerary for ${agent}`);
      if (event.trip) {
        // Off-map stays can represent travel between different campus gateways.
        if (endpoint && event.from !== 'off-campus' && !samePoint(endpoint, event.trip.path[0])) fail(`disconnected geometry for ${agent}`);
        endpoint = event.trip.path[event.trip.path.length - 1];
      }
      time = event.end; where = event.to;
    }
    if (Math.abs(time - DAY) > EPS) fail(`incomplete day for ${agent}`);
  }
  return result;
}

function routesFrom(day: DayData, origin: string, blocked: Set<string>): Map<string, WalkRoute> {
  const known = new Set(day.locations.filter(location => location.kind !== 'off-campus').map(location => location.id));
  const edges = new Map<string, { to: string; route: WalkRoute }[]>();
  for (const [key, route] of Object.entries(day.walkRoutes ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const [from, to, extra] = key.split('>');
    if (extra || !known.has(from) || !known.has(to) || blocked.has(to)
      || route.path.length < 2 || route.path.length !== route.cumulative.length || route.cumulative[0] !== 0
      || route.path.some(point => point.length !== 2 || !point.every(Number.isFinite))
      || route.cumulative.some((distance, index) => !Number.isFinite(distance) || distance < 0
        || index > 0 && (distance < route.cumulative[index - 1]
          || distance === route.cumulative[index - 1] && !samePoint(route.path[index], route.path[index - 1])))
      || route.cumulative[route.cumulative.length - 1] <= 0) continue;
    const list = edges.get(from) ?? [];
    list.push({ to, route }); edges.set(from, list);
  }
  const paths = new Map<string, WalkRoute>();
  const costs = new Map([[origin, 0]]);
  const visited = new Set<string>();
  while (true) {
    let current: string | undefined;
    for (const node of costs.keys()) if (!visited.has(node) && (current === undefined || costs.get(node)! < costs.get(current)!)) current = node;
    if (current === undefined) break;
    visited.add(current);
    const prefix = paths.get(current);
    for (const { to, route } of edges.get(current) ?? []) {
      if (prefix && !samePoint(prefix.path[prefix.path.length - 1], route.path[0])) continue;
      const cost = costs.get(current)! + route.cumulative[route.cumulative.length - 1];
      if (cost >= (costs.get(to) ?? Infinity)) continue;
      costs.set(to, cost);
      paths.set(to, prefix ? {
        path: [...prefix.path, ...route.path.slice(1)],
        cumulative: [...prefix.cumulative, ...route.cumulative.slice(1).map(distance => costs.get(current)! + distance)],
      } : route);
    }
  }
  return paths;
}

function inside(point: [number, number], polygon: [number, number][]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    const cross = (point[0] - a[0]) * (b[1] - a[1]) - (point[1] - a[1]) * (b[0] - a[0]);
    if (Math.abs(cross) < 1e-14 && point[0] >= Math.min(a[0], b[0]) && point[0] <= Math.max(a[0], b[0])
      && point[1] >= Math.min(a[1], b[1]) && point[1] <= Math.max(a[1], b[1])) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1])
      && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}

function prefix(route: WalkRoute, distance: number): WalkRoute {
  const i = route.cumulative.findIndex(value => value >= distance);
  if (i <= 0) return { path: [route.path[0], route.path[0]], cumulative: [0, 0] };
  const fraction = (distance - route.cumulative[i - 1]) / (route.cumulative[i] - route.cumulative[i - 1]);
  const a = route.path[i - 1], b = route.path[i];
  const point: [number, number] = fraction === 1 ? b : [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
  return { path: [...route.path.slice(0, i), point], cumulative: [...route.cumulative.slice(0, i), distance] };
}
function distanceAtPoint(route: WalkRoute, point: [number, number]): number | undefined {
  for (let i = 1; i < route.path.length; i++) {
    const a = route.path[i - 1], b = route.path[i];
    const dx = b[0] - a[0], dy = b[1] - a[1], length2 = dx * dx + dy * dy;
    if (length2 === 0) continue;
    const fraction = ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / length2;
    if (fraction >= 0 && fraction <= 1 && samePoint(point, [a[0] + fraction * dx, a[1] + fraction * dy]))
      return route.cumulative[i - 1] + fraction * (route.cumulative[i] - route.cumulative[i - 1]);
  }
  return undefined;
}
function suffix(route: WalkRoute, distance: number): WalkRoute {
  const cut = prefix(route, distance), i = route.cumulative.findIndex(d => d >= distance);
  return { path: [cut.path.at(-1)!, ...route.path.slice(i)], cumulative: [0, ...route.cumulative.slice(i).map(d => d - distance)] };
}
function reverse(route: WalkRoute): WalkRoute {
  return { path: [...route.path].reverse(), cumulative: [...route.cumulative].reverse().map(d => route.cumulative.at(-1)! - d) };
}
function hash(value: string): number {
  let h = 2166136261;
  for (const c of value) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0) / 4294967296;
}

/** Smallest metric distance from point to any footprint edge (local equirectangular projection). */
function footprintClearance(point: [number, number], polygons: [number, number][][]): number {
  const ky = 111320, kx = ky * Math.cos(point[1] * Math.PI / 180);
  let best = Infinity;
  for (const polygon of polygons) for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = (polygon[j][0] - point[0]) * kx, ay = (polygon[j][1] - point[1]) * ky;
    const bx = (polygon[i][0] - point[0]) * kx, by = (polygon[i][1] - point[1]) * ky;
    const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Pure transform. Drill reopening can extend beyond the requested duration for clearance and muster; closures cannot. */
export function applyIncident(day: DayData, incident: Incident, context?: IncidentContext): IncidentResult {
  const requestedEndsAt = incident.start + incident.duration;
  if (!incident.id?.trim() || !['fire-drill', 'fire-alarm', 'building-closure', 'fire', 'earthquake', 'meteor'].includes(incident.kind)
    || !Number.isFinite(incident.start) || incident.start < 0 || !Number.isFinite(incident.duration)
    || incident.duration <= 0 || !Number.isFinite(requestedEndsAt) || requestedEndsAt > DAY)
    throw new Error('Invalid incident: id, kind, start and positive duration within one day required');
  const disaster = isDisasterKind(incident.kind) ? DISASTER_ASSUMPTIONS[incident.kind] : undefined;
  const radiusMetres = incident.radiusMetres ?? disaster?.defaultRadiusMetres ?? 0;
  const spreads = incident.kind === 'earthquake' || incident.kind === 'meteor';
  if (!Number.isFinite(radiusMetres) || radiusMetres < 0 || radiusMetres > DISASTER_ASSUMPTIONS.maxRadiusMetres || !spreads && radiusMetres !== 0)
    throw new Error(`Invalid incident: radiusMetres must be 0–${DISASTER_ASSUMPTIONS.maxRadiusMetres} for earthquakes and meteors, and 0 or omitted otherwise`);
  if (disaster && incident.duration < disaster.minDurationSeconds)
    throw new Error(`Invalid incident: a ${incident.kind} needs a duration of at least ${disaster.minDurationSeconds / 60} minutes`);
  const target = day.locations.find(location => location.id === incident.locationId);
  if (!target || target.kind === 'off-campus' || target.id === 'off-campus' || target.kind === 'outdoor' && !spreads)
    throw new Error(spreads ? 'Incident target must be an existing on-campus location' : 'Incident target must be an existing on-campus indoor location');
  const drill = incident.kind === 'fire-drill' || incident.kind === 'fire-alarm';
  const zone = disaster ? hazardZone(day, target, radiusMetres) : undefined;
  const blocked = new Set(zone ? zone.locationIds : day.locations.filter(location => location.id === target.id
    || target.building && location.building === target.building).map(location => location.id));
  // Disasters damage every affected building for the rest of the simulated day. The requested
  // duration only bounds the active response (hazard.activeUntil); nobody re-enters before midnight.
  const allDay = !!zone;
  const closedUntil = allDay ? DAY : requestedEndsAt;
  const responseStartsAt = incident.start + (disaster?.responseDelaySeconds ?? 0);
  const reactionMin = disaster?.reactionMinSeconds ?? INCIDENT_ASSUMPTIONS.reactionMinSeconds;
  const reactionMax = disaster?.reactionMaxSeconds ?? INCIDENT_ASSUMPTIONS.reactionMaxSeconds;
  // Exit and return flows are per building footprint (or per location without one), never campus-wide.
  const locationBuilding = new Map(day.locations.map(location => [location.id, location.building]));
  const flowKey = (id: string) => locationBuilding.get(id) || `location:${id}`;
  const heights = new Map<string, number>();
  for (const building of day.buildings) heights.set(building.id, Math.max(heights.get(building.id) ?? 0, building.height));
  const byAgent = timelines(day);
  const routes = new Map([...blocked].map(id => [id, routesFrom(day, id, blocked)]));
  const speeds = new Map(day.agents.map(agent => [agent.id, agent.walkSpeed ?? 1.4]));
  const speedOf = (id: string) => {
    const speed = speeds.get(id)!;
    if (!Number.isFinite(speed) || speed <= 0) fail(`invalid walking speed for ${id}`);
    return speed;
  };
  // Getting clear of a fire, the shaking or an impact is run, not walked (DISASTER_LIMITATIONS);
  // a drill or a closure is walked throughout.
  const fleeSpeed = (id: string) => speedOf(id) * (disaster ? DISASTER_ASSUMPTIONS.runSpeedMultiplier : 1);
  const meteorWalkers = new Map<string, { event: Event; route: WalkRoute; destination: string; approach: WalkRoute }>();
  if (incident.kind === 'meteor') for (const [id, events] of byAgent) {
    const event = events.find(e => e.trip && e.start <= incident.start && incident.start < e.end);
    if (!event) continue;
    const escape = meteorEscape(event.trip!, incident.start, target.position, radiusMetres, blocked);
    if (escape) meteorWalkers.set(id, { event, ...escape });
  }
  const occupants = [...byAgent].flatMap(([id, events]) => {
    const event = events.find(e => e.stay && e.start <= incident.start && incident.start < e.end && blocked.has(e.to));
    if (!event) return [];
    const building = locationBuilding.get(event.to);
    const height = Math.max(0, building ? heights.get(building) ?? 0 : 0);
    const reaction = reactionMin + (reactionMax - reactionMin) * hash(`${incident.id}:${id}:reaction`);
    const stairs = Math.floor(height / INCIDENT_ASSUMPTIONS.floorHeightMetres * hash(`${id}:floor`)) * INCIDENT_ASSUMPTIONS.stairSecondsPerFloor;
    return [{ id, event, ready: responseStartsAt + reaction + stairs }];
  }).sort((a, b) => a.ready - b.ready || a.id.localeCompare(b.id));
  const joins = (id: string, event: Event, route: WalkRoute) => {
    const events = byAgent.get(id)!, index = events.indexOf(event);
    const previous = events.slice(0, index).filter(e => e.trip).at(-1)?.trip;
    const next = events.slice(index).find(e => e.trip)?.trip;
    return !(previous && !samePoint(previous.path.at(-1)!, route.path[0]) || next && !samePoint(next.path[0], route.path[0]));
  };

  let evacuation: Map<string, WalkRoute> | undefined;
  let assemblyLocation: CampusLocation | null = null, assemblyClearanceMetres: number | null = null;
  const assemblyId = `incident:${incident.id}:assembly`;
  if (drill) {
    // Use a prefix of real geometry, never a location centroid or an invented straight-line exit.
    const polygons = day.buildings.map(building => building.polygon);
    const candidates = [...routes.get(target.id)!.entries()].sort((a, b) => a[1].cumulative.at(-1)! - b[1].cumulative.at(-1)! || a[0].localeCompare(b[0]));
    for (const [destination, route] of candidates) {
      for (let distance = INCIDENT_ASSUMPTIONS.assemblyMinimumWalkMetres; distance < route.cumulative.at(-1)!; distance += 5) {
        const cut = prefix(route, distance), point = cut.path.at(-1)!;
        if (day.buildings.some(building => inside(point, building.polygon))
          || footprintClearance(point, polygons) < INCIDENT_ASSUMPTIONS.assemblyFootprintClearanceMetres) continue;
        const joined = new Map<string, WalkRoute>();
        for (const id of blocked) {
          const other = routes.get(id)!.get(destination);
          if (!other) break;
          if (samePoint(other.path[0], route.path[0])) joined.set(id, cut);
          else {
            const distance = distanceAtPoint(other, point);
            if (distance !== undefined && distance > 0) joined.set(id, prefix(other, distance));
          }
        }
        if (joined.size === blocked.size) { evacuation = joined; assemblyClearanceMetres = footprintClearance(point, polygons); break; }
      }
      if (evacuation) break;
    }
    if (!evacuation) throw new Error('No saved walk route to a common outdoor assembly point');
    if (day.locations.some(l => l.id === assemblyId)) throw new Error('Incident assembly id already exists');
    assemblyLocation = { id: assemblyId, name: 'Modeled outdoor assembly', short: 'Assembly',
      kind: 'outdoor', position: evacuation.get(target.id)!.path.at(-1)!, capacity: 0, building: '', campus: target.campus };
  }
  // Closure waiting place: the nearest existing location by saved walk, joining the occupant's itinerary.
  const waitRoutes = new Map([...blocked].map(id => [id, [...routes.get(id)!.entries()]
    .filter(([to]) => !to.startsWith('incident:'))
    .sort((a, b) => a[1].cumulative.at(-1)! - b[1].cumulative.at(-1)! || a[0].localeCompare(b[0]))]));
  const waitFor = (id: string, event: Event) => waitRoutes.get(event.to)!.find(([, route]) => joins(id, event, route));
  // First saved walk that leaves the closed footprint after `index`, passing only through closed locations
  // of the same footprint (a walk into another hazard building is never an early exit).
  const exitWalk = (events: Event[], index: number) => {
    const own = flowKey(events[index].to);
    for (let i = index + 1; i < events.length; i++) {
      if (events[i].trip && !blocked.has(events[i].to)) return i;
      if (!blocked.has(events[i].to) || events[i].trip && flowKey(events[i].to) !== own) return -1;
    }
    return -1;
  };
  // First saved walk to a location outside the whole hazard zone (disasters: every zone visit is cancelled).
  const zoneExit = (events: Event[], index: number) => {
    for (let i = index + 1; i < events.length; i++) if (events[i].trip && !blocked.has(events[i].to)) return i;
    return -1;
  };

  // Activity-aware decisions. Purpose comes from the stay or an exact source interval; a
  // wait/untagged stay looks ahead only to an immediately following stay at the same location.
  const purposeOf = purposeResolver(day);
  type Activity = { kind: IncidentActivity; start: number; end: number; index: number };
  const activityAt = (events: Event[], index: number): Activity => {
    const event = events[index], own = event.stay ? purposeOf(event.stay) : undefined;
    const next = events[index + 1];
    if ((!own || own.kind === 'wait') && next?.stay && next.stay.location === event.stay?.location && Math.abs(next.start - event.end) <= EPS) {
      const ahead = purposeOf(next.stay);
      // Untagged time may be treated as waiting for a class only; tagged waits name what they precede.
      if (ahead && ahead.kind !== 'wait' && (own ? (own.before === 'class') === (ahead.kind === 'class') : ahead.kind === 'class'))
        return { kind: ahead.kind, start: next.start, end: next.end, index: index + 1 };
    }
    return { kind: own?.kind ?? 'unknown', start: event.start, end: event.end, index };
  };
  const fixedBetween = (events: Event[], from: number, to: number, except: number) =>
    events.slice(from, to).some((e, offset) => from + offset !== except && e.stay && purposeOf(e.stay)?.kind === 'class');
  const locationById = new Map(day.locations.map(location => [location.id, location]));
  const agentHome = new Map(day.agents.map(agent => [agent.id, agent.home]));
  const ledger = new VenueLedger(day.stays!);
  const venueRoutes = new Map<string, Map<string, WalkRoute>>();
  const routesOf = (id: string) => {
    let found = venueRoutes.get(id);
    if (!found) { found = routesFrom(day, id, blocked); venueRoutes.set(id, found); }
    return found;
  };
  type Relocation = { venue: CampusLocation; toVenue: WalkRoute; toNext: WalkRoute; arrive: number; activityEnd: number; leaveIndex: number };
  const relocations = new Map<string, Relocation>();
  /** Nearest compatible open venue with room, reachable and rejoining the itinerary on saved walks only. */
  const findRelocation = (id: string, events: Event[], index: number, kind: IncidentActivity, departAt: number, need: number, leaveIndex: number)
    : { relocation?: Relocation; why: string } => {
    if (!context) return { why: 'no venue hours context' };
    const event = events[index], leave = events[leaveIndex];
    if (!leave?.trip || leave.to === 'off-campus') return { why: 'no saved on-campus walk to rejoin the itinerary' };
    // Occupants start inside the closed building; arrivals not yet walking start at their origin.
    if (event.trip && event.from === 'off-campus') return { why: 'no alternative on saved walks' };
    const start = event.trip ? event.trip.path[0] : events.slice(0, index).filter(e => e.trip).at(-1)?.trip!.path.at(-1);
    const speed = speedOf(id), min = minimumUseful(kind);
    let closed = 0, full = 0, short = 0;
    const candidates = [...(event.trip ? routesOf(event.from) : routes.get(event.to)!).entries()]
      .map(([venueId, route]) => ({ venue: locationById.get(venueId), route }))
      .filter((c): c is { venue: CampusLocation; route: WalkRoute } => !!c.venue && c.venue.kind === kind && !blocked.has(c.venue.id))
      .sort((a, b) => a.route.cumulative.at(-1)! - b.route.cumulative.at(-1)! || a.venue.id.localeCompare(b.venue.id));
    for (const { venue, route } of candidates) {
      const walkSeconds = route.cumulative.at(-1)! / speed;
      if (walkSeconds > ACTIVITY_DECISION_ASSUMPTIONS.maxRelocationWalkSeconds) break;
      if (start && !samePoint(start, route.path[0])) continue;
      const toNext = routesOf(venue.id).get(leave.to);
      if (!toNext || !samePoint(route.path.at(-1)!, toNext.path[0]) || !samePoint(toNext.path.at(-1)!, leave.trip.path.at(-1)!)) continue;
      const arrive = departAt + walkSeconds;
      // Never reach the next saved destination later than originally scheduled.
      const activityEnd = Math.min(arrive + need, leave.end - toNext.cumulative.at(-1)! / speed);
      if (activityEnd - arrive < min) { short++; continue; }
      if (!venueOpenFor(context, venue, arrive, activityEnd)) { closed++; continue; }
      if (!ledger.fits(venue, arrive, activityEnd)) { full++; continue; }
      return { relocation: { venue, toVenue: route, toNext, arrive, activityEnd, leaveIndex }, why: '' };
    }
    // Stable categories (no per-person numbers) so the UI can group decisions.
    if (full && !closed && !short) return { why: 'alternatives full' };
    if (closed && !full && !short) return { why: 'alternatives closed or hours unknown' };
    if (short && !closed && !full) return { why: 'too little time at alternatives' };
    return { why: candidates.length && (closed || full || short) ? 'no usable alternative' : 'no alternative on saved walks' };
  };

  // Fire with an outdoor crowd (sim/fireCrowd.ts): exits, standing areas and spots around the burning
  // building. Without a mapped footprint or standing room the fire disperses directly, as below.
  const tripLine = (id: string, trip: Trip): Polyline => ({ path: trip.path, cumulative: trip.timestamps.map(t => (t - trip.timestamps[0]) * speedOf(id)) });
  const doorOf = (id: string) => {
    for (const [key, route] of Object.entries(day.walkRoutes ?? {})) if (key.split('>')[0] === id) return route.path[0];
    return undefined;
  };
  let geometry: FireGeometry | null = null;
  if (incident.kind === 'fire' && incident.outdoorCrowd && target.building) {
    const paths = new Set<readonly LngLat[]>();
    for (const trip of day.trips) if (blocked.has(trip.to) || blocked.has(trip.from)) paths.add(trip.path);
    geometry = fireGeometry(day, target.building, [...blocked].map(doorOf).filter((door): door is [number, number] => !!door),
      occupants.length, context?.fireScene, [...paths]);
  }
  const crowdPrefix = `incident:${incident.id}:crowd:`;
  if (geometry && day.locations.some(l => l.id.startsWith(crowdPrefix))) throw new Error('Incident crowd id already exists');
  const crowdLocations: CampusLocation[] = geometry ? geometry.areas.map(area => ({ id: `${crowdPrefix}${area.index}`,
    name: `Evacuated crowd outside ${target.short || target.name}`, short: 'Outside', kind: 'outdoor', position: area.centre,
    capacity: 0, building: '', campus: target.campus })) : [];
  const crowdPlans = new Map<string, CrowdPlan>();

  const participants: IncidentParticipant[] = [];
  const exits = new Map<string, number>();
  let endsAt = closedUntil;
  for (const occupant of occupants) {
    const key = flowKey(occupant.event.to);
    const queued = Math.max(occupant.ready, (exits.get(key) ?? incident.start) + 1 / INCIDENT_ASSUMPTIONS.exitPersonsPerSecond);
    if (geometry) {
      // Everyone evacuates through the exit queue, then stands outside; what they do next is decided when they leave the crowd.
      exits.set(key, queued);
      const events = byAgent.get(occupant.id)!, index = events.indexOf(occupant.event);
      const next = zoneExit(events, index), home = agentHome.get(occupant.id)!;
      const heading = next >= 0 ? tripLine(occupant.id, events[next].trip!)
        : home !== 'off-campus' && !blocked.has(home) ? routesOf(occupant.event.to).get(home) : undefined;
      const from = events.slice(0, index).filter(e => e.trip).at(-1)?.trip!.path.at(-1);
      // Out of the building and over to the crowd at a run; they stand still from plan.arriveAt.
      const plan = planSpot(geometry, incident.id, occupant.id, queued, fleeSpeed(occupant.id), incident.start, { heading, from, ready: occupant.ready });
      if (plan.leaveAt >= DAY) throw new Error(`Invalid incident: the ${incident.kind} response and recovery must fit within the day (crowd past midnight)`);
      crowdPlans.set(occupant.id, plan);
      participants.push({ agentId: occupant.id, role: 'occupant', departAt: plan.departAt, assemblyAt: plan.arriveAt, releaseAt: plan.leaveAt, resumedAt: 0,
        fleesUntil: plan.arriveAt, outcome: 'cancelled', crowdLocationId: crowdLocations[plan.area.index].id });
      continue;
    }
    if (drill) {
      exits.set(key, queued); const exit = queued;
      const assemblyAt = exit + evacuation!.get(occupant.event.to)!.cumulative.at(-1)! / speedOf(occupant.id);
      endsAt = Math.max(endsAt, assemblyAt + INCIDENT_ASSUMPTIONS.musterSeconds);
      participants.push({ agentId: occupant.id, role: 'occupant', departAt: exit, assemblyAt, releaseAt: 0, resumedAt: 0, outcome: 'evacuated' });
    } else {
      const events = byAgent.get(occupant.id)!, index = events.indexOf(occupant.event), leaveIndex = exitWalk(events, index);
      const leave = leaveIndex >= 0 ? events[leaveIndex] : undefined;
      const wait = waitFor(occupant.id, occupant.event);
      const walkSeconds = wait ? wait[1].cumulative.at(-1)! / speedOf(occupant.id) : Infinity;
      const backBy = Math.max(queued + walkSeconds, closedUntil) + walkSeconds;
      const relocationLeaveIndex = allDay ? zoneExit(events, index) : leaveIndex;
      const forcedLeave = !!leave && (leave.start <= backBy || !wait);
      const activity = activityAt(events, index);
      let action: 'wait' | 'leave' | 'relocate' = forcedLeave ? 'leave' : 'wait';
      let reason = allDay ? (forcedLeave ? 'building closed for the rest of the day; leaves on the saved walk' : 'building closed for the rest of the day; waits outside the zone')
        : forcedLeave ? (wait ? 'schedule leaves before reopening' : 'no saved walk to a waiting place') : 'waits nearby for reopening';
      let relocation: Relocation | undefined;
      // Nobody walks out during earthquake shaking: a scheduled departure only stands once the response has started.
      const scheduledFirst = !!leave && leave.start <= queued && leave.start >= responseStartsAt;
      if (scheduledFirst) reason = 'scheduled departure precedes the exit slot';
      else if (POLICY_KINDS.has(activity.kind)) {
        const min = minimumUseful(activity.kind), waitUseful = wait ? activity.end - backBy : -Infinity;
        const need = activity.end - Math.max(incident.start, activity.start);
        const eaten = activity.kind === 'dining' ? Math.max(0, incident.start - activity.start) / (activity.end - activity.start) : 0;
        // Disasters: later classes in a damaged building are cancelled too, so leaving is always allowed.
        const leaveOk = !!leave && (allDay || !fixedBetween(events, index, leaveIndex, activity.index)
          && (forcedLeave || leave.to === agentHome.get(occupant.id) || leave.to === 'off-campus'
            || leave.start - queued <= ACTIVITY_DECISION_ASSUMPTIONS.earlyLeaveHorizonSeconds));
        const waitOk = !!wait && !forcedLeave && waitUseful >= min;
        let relocationWhy = '';
        if (RELOCATABLE_KINDS.has(activity.kind) && eaten < ACTIVITY_DECISION_ASSUMPTIONS.mealFinishedShare) {
          if (!allDay && (!leave || fixedBetween(events, index, leaveIndex, activity.index))) relocationWhy = 'a later class in the building cannot be skipped';
          else {
            const found = findRelocation(occupant.id, events, index, activity.kind, queued, need, relocationLeaveIndex);
            const useful = found.relocation ? found.relocation.activityEnd - found.relocation.arrive : 0;
            if (found.relocation && (!waitOk || useful > waitUseful)) relocation = found.relocation;
            else relocationWhy = found.relocation ? 'waiting keeps more activity time than moving' : found.why;
          }
        }
        const suffix = relocationWhy ? `; ${relocationWhy}` : '';
        if (relocation) {
          action = 'relocate'; reason = 'moves to an open alternative with room';
        } else if (activity.kind === 'dining' && eaten >= ACTIVITY_DECISION_ASSUMPTIONS.mealFinishedShare && leaveOk) {
          action = 'leave'; reason = 'meal mostly finished';
        } else if (waitOk) {
          action = 'wait'; reason = (activity.kind === 'class' ? 'fixed class; enough time remains after reopening' : 'enough time remains after reopening') + suffix;
        } else if (leaveOk) {
          action = 'leave'; reason = (allDay ? 'building closed for the rest of the day; leaves on the saved walk'
            : forcedLeave ? 'schedule leaves before reopening' : 'too little time would remain after reopening') + suffix;
        } else if (wait) {
          action = 'wait'; reason = (allDay ? 'building closed for the rest of the day; waits outside the zone' : 'too little time would remain, but no early saved walk') + suffix;
        } else if (leave) action = 'leave';
      }
      if (action === 'wait' && !wait) throw new Error(`No saved walk route out of the closed building for ${occupant.id}`);
      // A scheduled departure before the queued exit slot is kept as-is and does not consume exit flow.
      const natural = action === 'leave' && leave!.start <= queued && leave!.start >= responseStartsAt;
      const departAt = natural ? leave!.start : queued;
      if (!natural) exits.set(key, queued);
      if (departAt >= DAY) throw new Error('Invalid incident: building clearing must finish before midnight');
      if (relocation) { relocations.set(occupant.id, relocation); ledger.reserve(relocation.venue.id, relocation.arrive, relocation.activityEnd); }
      participants.push({ agentId: occupant.id, role: 'occupant', departAt,
        assemblyAt: null, releaseAt: 0, resumedAt: 0,
        outcome: action === 'relocate' ? 'relocated' : action === 'leave' || allDay ? 'cancelled' : 'interrupted',
        ...(action === 'wait' ? { waitLocationId: wait![0] } : {}),
        ...(relocation ? { relocationId: relocation.venue.id } : {}),
        decision: { activity: activity.kind, action, reason, at: departAt,
          destinationId: relocation ? relocation.venue.id : action === 'wait' ? wait![0] : leave!.to } });
    }
  }
  if (drill && endsAt >= DAY) throw new Error('Invalid incident: evacuation and muster must finish before midnight');
  const affected = new Map(occupants.map(o => [o.id, { event: o.event, at: incident.start }]));
  for (const [id, plan] of meteorWalkers) {
    affected.set(id, { event: plan.event, at: incident.start });
    participants.push({ agentId: id, role: 'arrival', departAt: incident.start, assemblyAt: null,
      releaseAt: incident.start, resumedAt: 0, outcome: 'cancelled',
      decision: { activity: 'unknown', action: 'leave', at: incident.start, destinationId: plan.destination,
        reason: 'runs away from the meteor along the current saved walk' } });
  }
  for (const [id, events] of byAgent) {
    if (affected.has(id)) continue;
    const inbound = events.find(e => e.trip && blocked.has(e.to) && e.end > incident.start && e.end < endsAt);
    if (!inbound) continue;
    const at = Math.max(incident.start, inbound.start);
    affected.set(id, { event: inbound, at });
    // An optional activity not yet walked to may move to an open alternative instead of waiting.
    const index = events.indexOf(inbound), activity = events[index + 1]?.stay ? activityAt(events, index + 1) : undefined;
    const leaveIndex = allDay ? zoneExit(events, index) : exitWalk(events, index);
    let relocation: Relocation | undefined;
    if (activity && at === inbound.start && RELOCATABLE_KINDS.has(activity.kind) && leaveIndex >= 0
      && (allDay || !fixedBetween(events, index + 1, leaveIndex, activity.index))) {
      const waitUseful = activity.end - (endsAt + (inbound.end - inbound.start));
      const found = findRelocation(id, events, index, activity.kind, at, activity.end - activity.start, leaveIndex);
      if (found.relocation && (waitUseful < minimumUseful(activity.kind) || found.relocation.activityEnd - found.relocation.arrive > waitUseful))
        relocation = found.relocation;
    }
    if (relocation) { relocations.set(id, relocation); ledger.reserve(relocation.venue.id, relocation.arrive, relocation.activityEnd); }
    participants.push({ agentId: id, role: 'arrival', departAt: at, assemblyAt: null, releaseAt: allDay ? at : endsAt, resumedAt: 0,
      outcome: relocation ? 'relocated' : 'delayed',
      ...(relocation ? { relocationId: relocation.venue.id, decision: { activity: activity!.kind, action: 'relocate' as const, at,
        destinationId: relocation.venue.id, reason: 'moves to an open alternative with room' } } : {}) });
  }
  const trips = day.trips.filter(t => !affected.has(t.agent));
  const stays = day.stays!.filter(s => !affected.has(s.agent));
  const stay = (agent: string, location: string, start: number, end: number, purpose?: StayPurpose) => {
    if (start < DAY && end > start) stays.push({ agent, location, start, end: Math.min(DAY, end), ...(purpose ? { purpose } : {}) });
  };
  /** Stay on in an incident building until egress. A tagged purpose never outlasts its original
   * interval; indoor time after it (reaction, exit queue) is tagged as waiting. */
  const remain = (agent: string, event: Event, start: number, end: number) => {
    const purpose = event.stay!.purpose;
    if (!purpose || end <= event.end + EPS) { stay(agent, event.to, start, end, purpose); return; }
    stay(agent, event.to, start, event.end, purpose);
    stay(agent, event.to, Math.max(start, event.end), end, { kind: 'wait', fixed: false, before: 'activity' });
  };
  const waitPurpose = (kind: IncidentActivity): StayPurpose | undefined =>
    POLICY_KINDS.has(kind) ? { kind: 'wait', fixed: false, before: kind === 'class' ? 'class' : 'activity' } : undefined;
  const walk = (agent: string, from: string, to: string, route: WalkRoute, at: number, speed = speedOf(agent)) => {
    const end = at + route.cumulative.at(-1)! / speed;
    if (end > at && at < DAY) trips.push({ agent, from, to, path: route.path, timestamps: route.cumulative.map(d => at + d / speed) });
    return end;
  };
  // Return flow is per footprint, like exits.
  const returns = new Map<string, number>();
  const returnSlot = (id: string) => { const key = flowKey(id), n = returns.get(key) ?? 0; returns.set(key, n + 1); return n; };
  // Saved walks to and from off-campus gateways (any person's, either direction), for rejoining a
  // schedule whose next stop outside the zone is reached through a gateway.
  let gateways: Map<string, WalkRoute[]> | undefined;
  // Buckets by coordinates rounded to ~1 cm; samePoint still decides the match.
  const pointKey = (point: number[]) => `${point[0].toFixed(7)},${point[1].toFixed(7)}`;
  const gatewayWalk = (from: string, start: [number, number], to: string, end: [number, number]) => {
    if (!gateways) {
      gateways = new Map();
      for (const trip of day.trips) {
        if ((trip.from === 'off-campus') === (trip.to === 'off-campus') || blocked.has(trip.from) || blocked.has(trip.to)) continue;
        const speed = speeds.get(trip.agent)!;
        if (!Number.isFinite(speed) || speed <= 0) continue;
        const route = { path: trip.path, cumulative: trip.timestamps.map(t => (t - trip.timestamps[0]) * speed) };
        if (route.cumulative.at(-1)! <= 0) continue;
        for (const [key, value] of [[`${trip.from}>${trip.to}`, route], [`${trip.to}>${trip.from}`, reverse(route)]] as const) {
          const bucket = `${key}>${pointKey(value.path[0])}>${pointKey(value.path.at(-1)!)}`;
          const list = gateways.get(bucket) ?? []; list.push(value); gateways.set(bucket, list);
        }
      }
    }
    let best: WalkRoute | undefined;
    for (const route of gateways.get(`${from}>${to}>${pointKey(start)}>${pointKey(end)}`) ?? [])
      if (samePoint(route.path[0], start) && samePoint(route.path.at(-1)!, end) && (!best || route.cumulative.at(-1)! < best.cumulative.at(-1)!)) best = route;
    return best;
  };
  /** Disasters: from a place outside the zone, skip every saved zone visit after `index` and rejoin the
   * itinerary at its next stop outside the zone, by the saved return or a saved walk only. Without one,
   * the person stays where they are for the rest of the day; nobody is moved without a walk. */
  const continueOutside = (id: string, events: Event[], index: number, location: string, point: [number, number],
    availableAt: number, purpose?: StayPurpose) => {
    const next = zoneExit(events, index), leave = next >= 0 ? events[next] : undefined;
    if (leave) {
      if (leave.to === location && (location === 'off-campus' || samePoint(leave.trip!.path.at(-1)!, point))) {
        const until = Math.max(availableAt, leave.end);
        stay(id, location, availableAt, until, purpose);
        return { location, availableAt: until, cursor: next + 1, rejoined: true };
      }
      const end = leave.trip!.path.at(-1)!;
      const routed = location !== 'off-campus' && leave.to !== 'off-campus' ? routesOf(location).get(leave.to) : undefined;
      const direct = routed && samePoint(routed.path[0], point) && samePoint(routed.path.at(-1)!, end) ? routed
        : location === 'off-campus' || leave.to === 'off-campus' ? gatewayWalk(location, point, leave.to, end) : undefined;
      if (direct) {
        const depart = Math.max(availableAt, leave.end - direct.cumulative.at(-1)! / speedOf(id));
        stay(id, location, availableAt, depart, purpose);
        return { location: leave.to, availableAt: walk(id, location, leave.to, direct, depart), cursor: next + 1, rejoined: true };
      }
    }
    stay(id, location, availableAt, DAY, purpose);
    return { location, availableAt: DAY, cursor: events.length, rejoined: false };
  };
  // Outdoor crowd: moving on from a standing spot (evacuees) or a turn-back point (arrivals), using the
  // same rules as direct dispersal (relocation, then the next stop of the day outside the zone).
  const treeCache = new Map<string, Tree | null>();
  const treeAt = (point: LngLat) => {
    const key = `${point[0]},${point[1]}`;
    if (!treeCache.has(key)) treeCache.set(key, geometry!.treeFrom(point));
    return treeCache.get(key)!;
  };
  type CrowdOrigin = { label: string; lead: Polyline; tree: Tree };
  const joinFrom = (from: CrowdOrigin, route: WalkRoute) => { const joined = geometry!.join(from.tree, route); return joined ? concat([from.lead, joined]) : null; };
  /** Nearest dining hall, library or gym by saved walk with room for the rest of the day: open now, else opened as an emergency shelter. */
  const shelterFor = (location: string, arrive: number) => {
    const candidates = [...routesOf(location).entries()].map(([venueId, route]) => ({ venue: locationById.get(venueId), route }))
      .filter((c): c is { venue: CampusLocation; route: WalkRoute } => !!c.venue && FIRE_CROWD_ASSUMPTIONS.shelterKinds.includes(c.venue.kind)
        && !blocked.has(c.venue.id) && c.route.cumulative.at(-1)! <= FIRE_CROWD_ASSUMPTIONS.maxShelterWalkMetres)
      .sort((a, b) => a.route.cumulative.at(-1)! - b.route.cumulative.at(-1)! || a.venue.id.localeCompare(b.venue.id));
    const open = context && candidates.find(c => venueOpenFor(context, c.venue, arrive, Math.min(DAY, arrive + 3600)) && ledger.fits(c.venue, arrive, DAY));
    if (open) return { ...open, open: true };
    const roomy = candidates.find(c => ledger.fits(c.venue, arrive, DAY)) ?? candidates[0];
    return roomy ? { ...roomy, open: false } : undefined;
  };
  type Placed = { location: string; availableAt: number; cursor: number; offMap?: { at: number; point: [number, number] } };
  const moveOn = (id: string, events: Event[], index: number, location: string, from: CrowdOrigin, at: number,
    participant: IncidentParticipant, occupant: boolean): Placed | null => {
    const speed = speedOf(id), home = agentHome.get(id)!;
    const activity = occupant ? activityAt(events, index) : events[index + 1]?.stay ? activityAt(events, index + 1) : { kind: 'unknown' as const, start: at, end: at, index };
    const decide = (action: IncidentDecision['action'], destinationId: string, reason: string, dispersal: FireDispersal) => {
      participant.decision = { activity: activity.kind, action, destinationId, reason, at };
      participant.dispersal = dispersal;
    };
    const next = zoneExit(events, index);
    // An optional meal, study session or workout still worth doing moves to an open venue with room.
    if (occupant && next >= 0 && RELOCATABLE_KINDS.has(activity.kind)) {
      const eaten = activity.kind === 'dining' ? Math.max(0, incident.start - activity.start) / (activity.end - activity.start) : 0;
      const plan = eaten < ACTIVITY_DECISION_ASSUMPTIONS.mealFinishedShare
        ? findRelocation(id, events, index, activity.kind, at, activity.end - at, next).relocation : undefined;
      const line = plan && joinFrom(from, plan.toVenue);
      const arrive = line ? at + line.cumulative.at(-1)! / speed : Infinity;
      if (plan && line && plan.activityEnd - arrive >= minimumUseful(activity.kind)) {
        walk(id, from.label, plan.venue.id, line, at);
        ledger.reserve(plan.venue.id, arrive, plan.activityEnd);
        stay(id, plan.venue.id, arrive, plan.activityEnd, { kind: activity.kind as 'dining' | 'library' | 'gym', fixed: false });
        const availableAt = walk(id, plan.venue.id, events[next].to, plan.toNext, plan.activityEnd);
        participant.outcome = 'relocated'; participant.relocationId = plan.venue.id;
        decide('relocate', plan.venue.id, 'moves the activity to an open venue with room', 'relocated');
        return { location: events[next].to, availableAt, cursor: next + 1 };
      }
    }
    if (next < 0) {
      // Nothing more planned outside the building today: home when it is elsewhere, else shelter.
      const homeRoute = home !== 'off-campus' && !blocked.has(home) ? routesOf(location).get(home) : undefined;
      const toHome = homeRoute && joinFrom(from, homeRoute);
      if (toHome) {
        stay(id, home, walk(id, from.label, home, toHome, at), DAY, HOME_STAY);
        decide('leave', home, 'nothing more planned today; goes home', 'home');
        return { location: home, availableAt: DAY, cursor: events.length };
      }
      const shelter = shelterFor(location, at + 300), line = shelter && joinFrom(from, shelter.route);
      if (!shelter || !line) return null;
      const arrive = walk(id, from.label, shelter.venue.id, line, at);
      ledger.reserve(shelter.venue.id, arrive, DAY);
      stay(id, shelter.venue.id, arrive, DAY, { kind: 'wait', fixed: false, before: 'activity' });
      participant.shelterId = shelter.venue.id;
      decide('wait', shelter.venue.id, blocked.has(home)
        ? (shelter.open ? 'home is the burning building; shelters at an open venue with room' : 'home is the burning building; nearest venue with room opened as an emergency shelter')
        : 'nothing more planned outside the building; shelters at a venue nearby', 'shelter');
      return { location: shelter.venue.id, availableAt: DAY, cursor: events.length };
    }
    const leave = events[next], destination = leave.to, direct = joinFrom(from, tripLine(id, leave.trip!));
    if (!direct) return null;
    if (destination === home || destination === 'off-campus') {
      const availableAt = walk(id, from.label, destination, direct, at);
      decide('leave', destination, destination === 'off-campus' ? 'heads for their usual stop or gateway and leaves campus' : 'next stop is home; goes home now',
        destination === 'off-campus' ? 'transit' : 'home');
      return { location: destination, availableAt, cursor: next + 1, offMap: destination === 'off-campus' ? { at: availableAt, point: direct.path.at(-1)! } : undefined };
    }
    const arrive = at + direct.cumulative.at(-1)! / speed;
    if (leave.end - arrive > FIRE_CROWD_ASSUMPTIONS.nextActivityHorizonSeconds && home !== 'off-campus' && !blocked.has(home) && home !== destination) {
      const homeRoute = routesOf(location).get(home), toHome = homeRoute && joinFrom(from, homeRoute), onward = routesOf(home).get(destination);
      if (toHome && onward && samePoint(onward.path[0], toHome.path.at(-1)!) && samePoint(onward.path.at(-1)!, leave.trip!.path.at(-1)!)) {
        const atHome = walk(id, from.label, home, toHome, at);
        const depart = Math.max(atHome, leave.end - onward.cumulative.at(-1)! / speed);
        stay(id, home, atHome, depart, HOME_STAY);
        decide('leave', home, 'next activity is more than an hour away; goes home first', 'home');
        return { location: destination, availableAt: walk(id, home, destination, onward, depart), cursor: next + 1 };
      }
    }
    decide('leave', destination, leave.end - arrive > 600 ? 'goes on to the next activity and waits there' : 'goes on to the next activity', 'next-activity');
    return { location: destination, availableAt: walk(id, from.label, destination, direct, at), cursor: next + 1 };
  };
  for (const participant of participants) {
    const id = participant.agentId, { event, at } = affected.get(id)!;
    const events = byAgent.get(id)!;
    let cursor = events.indexOf(event), availableAt: number, location: string;
    for (const e of events) {
      if (e.end <= at) { if (e.trip) trips.push(e.trip); else stays.push(e.stay!); }
      else if (e.stay && e.start < at) stay(id, e.from, e.start, at, e.stay.purpose);
    }
    let crowdHandled = false, crowdOffMap: { at: number; point: [number, number] } | undefined;
    const meteorPlan = meteorWalkers.get(id);
    if (meteorPlan) {
      const trip = event.trip!;
      if (at > event.start) trips.push({ ...trip, path: meteorPlan.approach.path,
        timestamps: meteorPlan.approach.cumulative.map(t => event.start + t) });
      availableAt = walk(id, at > event.start ? trip.to : trip.from, meteorPlan.destination, meteorPlan.route, at, fleeSpeed(id));
      participant.fleesUntil = availableAt;
      location = meteorPlan.destination;
      if (location === trip.to) cursor++;
      else ({ location, availableAt, cursor } = continueOutside(id, events, cursor, location, meteorPlan.route.path.at(-1)!, availableAt));
      crowdHandled = true;
      if (location === 'off-campus') crowdOffMap = { at: availableAt, point: meteorPlan.route.path.at(-1)! };
    } else if (geometry && participant.role === 'occupant') {
      // Out by the chosen exit to a standing spot, wait there, then move on.
      const plan = crowdPlans.get(id)!, label = crowdLocations[plan.area.index].id;
      remain(id, event, at, participant.departAt);
      // Same pace planSpot timed the arrival at, or the stay outside would start mid-walk.
      walk(id, event.to, label, plan.path, participant.departAt, fleeSpeed(id));
      stay(id, label, plan.arriveAt, plan.leaveAt);
      const origin = { label, lead: plan.lead, tree: plan.tree };
      let placed = moveOn(id, events, cursor, event.to, origin, plan.leaveAt, participant, true);
      if (!placed) {
        // No joined walk onward: the nearest saved waiting place, then the schedule outside the zone, as without the crowd.
        for (const [waitId, route] of waitRoutes.get(event.to)!.slice(0, 8)) {
          const line = joinFrom(origin, route);
          if (!line) continue;
          const arrived = walk(id, label, waitId, line, plan.leaveAt);
          participant.waitLocationId = waitId;
          participant.decision = { activity: activityAt(events, cursor).kind, action: 'wait', at: plan.leaveAt, destinationId: waitId,
            reason: 'building closed for the rest of the day; waits outside the zone' };
          participant.dispersal = 'shelter';
          placed = continueOutside(id, events, cursor, waitId, route.path.at(-1)!, arrived, waitPurpose(activityAt(events, cursor).kind));
          break;
        }
      }
      if (!placed) {
        stays.pop(); stay(id, label, plan.arriveAt, DAY);
        participant.releaseAt = DAY;
        participant.decision = { activity: activityAt(events, cursor).kind, action: 'wait', at: plan.leaveAt, destinationId: label, reason: 'no saved walk onward; stays outside' };
        participant.dispersal = 'shelter';
        placed = { location: label, availableAt: DAY, cursor: events.length };
      }
      ({ location, availableAt, cursor } = placed);
      crowdOffMap = placed.offMap ?? (location === 'off-campus' ? { at: availableAt, point: events[cursor - 1].trip!.path.at(-1)! } : undefined);
      crowdHandled = true;
    } else if (geometry && participant.role === 'arrival' && participant.outcome !== 'relocated' && event.start < requestedEndsAt
      && !blocked.has(event.from)) {
      // Walking toward the fire while it is active: turn back short of it, then the same choice as evacuees.
      const trip = event.trip!, line = tripLine(id, trip), speed = speedOf(id);
      let along = turnBackDistance(geometry, line, FIRE_CROWD_ASSUMPTIONS.turnBackMetres);
      if (event.start + along / speed < incident.start) along = (incident.start - event.start) * speed;
      const turnAt = event.start + along / speed, approach = cutPolyline(line, along), point = approach.path.at(-1)!;
      if (approach.path.length >= 2) walk(id, trip.from, trip.to, approach, event.start);
      participant.departAt = participant.releaseAt = turnAt;
      const tree = treeAt(point);
      let placed = tree ? moveOn(id, events, cursor, trip.to, { label: approach.path.length >= 2 ? trip.to : trip.from, lead: polyline([point]), tree }, turnAt, participant, false) : null;
      if (!placed) {
        // Retrace the approach and rejoin the schedule outside the zone from the origin.
        let back = turnAt;
        if (approach.path.length >= 2) {
          const reversed = { path: [...approach.path].reverse(), cumulative: [...approach.cumulative].reverse().map(d => approach.cumulative.at(-1)! - d) };
          // They walked up to the fire; they run back the way they came.
          back = walk(id, trip.to, trip.from, reversed, turnAt, fleeSpeed(id));
          participant.fleesUntil = back;
        }
        participant.decision = { activity: events[cursor + 1]?.stay ? activityAt(events, cursor + 1).kind : 'unknown', action: 'cancel', at: turnAt,
          destinationId: trip.from, reason: 'turns back short of the fire; visit cancelled' };
        participant.dispersal = trip.from === agentHome.get(id) ? 'home' : 'next-activity';
        placed = continueOutside(id, events, cursor, trip.from, trip.path[0], back);
      }
      ({ location, availableAt, cursor } = placed);
      crowdOffMap = placed.offMap ?? (location === 'off-campus'
        ? { at: availableAt, point: cursor > 0 && events[cursor - 1].trip && events[cursor - 1].to === 'off-campus' ? events[cursor - 1].trip!.path.at(-1)! : trip.path[0] } : undefined);
      crowdHandled = true;
    } else if (participant.outcome === 'relocated') {
      // Optional activity moves to another venue on saved walks, then rejoins the itinerary at the
      // destination of the first saved walk out of the footprint, never later than scheduled.
      const plan = relocations.get(id)!, kind = participant.decision!.activity as 'dining' | 'library' | 'gym';
      const origin = event.trip ? event.from : event.to;
      if (!event.trip) remain(id, event, at, participant.departAt);
      const arrived = walk(id, origin, plan.venue.id, plan.toVenue, participant.departAt,
        participant.role === 'occupant' ? fleeSpeed(id) : speedOf(id));
      if (participant.role === 'occupant' && disaster) participant.fleesUntil = arrived;
      stay(id, plan.venue.id, arrived, plan.arrive, waitPurpose(kind));
      stay(id, plan.venue.id, plan.arrive, plan.activityEnd, { kind, fixed: false });
      location = events[plan.leaveIndex].to;
      availableAt = walk(id, plan.venue.id, location, plan.toNext, plan.activityEnd);
      cursor = plan.leaveIndex + 1;
      participant.releaseAt = participant.departAt;
    } else if (participant.role === 'occupant' && allDay && participant.waitLocationId) {
      // Damaged building: wait outside the zone, then rejoin the schedule outside it. No return walk.
      const [waitId, route] = waitFor(id, event)!;
      remain(id, event, at, participant.departAt);
      const arrived = walk(id, event.to, waitId, route, participant.departAt, fleeSpeed(id));
      participant.fleesUntil = arrived;
      participant.releaseAt = participant.departAt;
      ({ location, availableAt, cursor } = continueOutside(id, events, cursor, waitId, route.path.at(-1)!, arrived,
        waitPurpose(participant.decision!.activity)));
    } else if (participant.role === 'occupant' && participant.outcome === 'cancelled') {
      // Leave early on the saved walk(s) out of the footprint; the next activity starts at its original time.
      const leaveIndex = exitWalk(events, cursor);
      remain(id, event, at, participant.departAt);
      availableAt = participant.departAt;
      for (let i = cursor + 1; i <= leaveIndex; i++) {
        const trip = events[i].trip;
        if (!trip) continue;
        const factor = disaster ? DISASTER_ASSUMPTIONS.runSpeedMultiplier : 1;
        const timestamps = trip.timestamps.map(t => availableAt + (t - events[i].start) / factor);
        trips.push(factor === 1 && availableAt === events[i].start ? trip : { ...trip, timestamps });
        availableAt = timestamps.at(-1)!;
      }
      if (disaster) participant.fleesUntil = availableAt;
      location = events[leaveIndex].to;
      cursor = leaveIndex + 1;
      participant.releaseAt = participant.departAt;
    } else if (participant.role === 'occupant' && participant.outcome === 'interrupted') {
      const [waitId, route] = waitFor(id, event)!;
      remain(id, event, at, participant.departAt);
      const arrived = walk(id, event.to, waitId, route, participant.departAt);
      participant.releaseAt = Math.max(arrived, closedUntil + returnSlot(event.to) / INCIDENT_ASSUMPTIONS.returnPersonsPerSecond);
      stay(id, waitId, arrived, participant.releaseAt, waitPurpose(participant.decision!.activity));
      availableAt = walk(id, waitId, event.to, reverse(route), participant.releaseAt);
      location = event.to;
    } else if (participant.role === 'occupant') {
      const route = evacuation!.get(event.to)!;
      if (!joins(id, event, route)) fail(`saved evacuation route does not join itinerary for ${id}`);
      remain(id, event, at, participant.departAt);
      walk(id, event.to, assemblyId, route, participant.departAt);
      // Recovery is chosen before release: only people walking back into the footprint join the return queue.
      availableAt = endsAt;
      location = event.to;
      // Join a later saved walk at a shared path vertex, skipping the expired activity.
      let shortcut: { index: number; route: WalkRoute } | undefined;
      for (let i = cursor + 1; i < events.length && !shortcut; i++) {
        const e = events[i];
        if (!e.trip || e.start > availableAt || blocked.has(e.to)
          || e.end < availableAt && (!events[i + 1]?.stay || events[i + 1].end <= availableAt)) continue;
        const distances = e.trip.timestamps.map(t => (t - e.start) * speedOf(id));
        for (let j = route.path.length - 1; j > 0 && !shortcut; j--) {
          const saved = { path: e.trip.path, cumulative: distances };
          const distance = distanceAtPoint(saved, route.path[j]);
          if (distance === undefined) continue;
          const tail = suffix(saved, distance);
          const back = reverse({path: route.path.slice(j), cumulative: route.cumulative.slice(j).map(d => d - route.cumulative[j])});
          shortcut = { index: i, route: { path: [...back.path, ...tail.path.slice(1)], cumulative: [...back.cumulative, ...tail.cumulative.slice(1).map(d => back.cumulative.at(-1)! + d)] } };
        }
      }
      const skips = shortcut && event.end <= endsAt;
      // Mandatory evacuation and muster come first; the building reopens at release, so the choice
      // is whether enough activity time remains to make returning worthwhile.
      const back = route.cumulative.at(-1)! / speedOf(id), activity = activityAt(events, cursor);
      const policy = POLICY_KINDS.has(activity.kind), left = activity.end - (endsAt + back);
      const leaveIndex = exitWalk(events, cursor), leave = leaveIndex >= 0 ? events[leaveIndex] : undefined;
      // Too little time left: walk back to the entrance (continuity) and leave at once on the saved
      // onward walk, unless that would skip another fixed class or leave unreasonably early.
      const eaten = activity.kind === 'dining' ? Math.max(0, incident.start - activity.start) / (activity.end - activity.start) : 0;
      const finished = eaten >= ACTIVITY_DECISION_ASSUMPTIONS.mealFinishedShare;
      const early = !skips && policy && left > 0 && (left < minimumUseful(activity.kind) || finished) && !!leave
        && !fixedBetween(events, cursor, leaveIndex, activity.index)
        && (leave.to === agentHome.get(id) || leave.to === 'off-campus'
          || leave.start - (endsAt + back) <= ACTIVITY_DECISION_ASSUMPTIONS.earlyLeaveHorizonSeconds);
      // Only people re-entering for a still-active activity join the return queue; others leave at reopening.
      const activeUntil = policy ? Math.max(event.end, activity.end) : event.end;
      const reenters = !skips && !early && activeUntil > endsAt + back;
      participant.releaseAt = reenters ? endsAt + returnSlot(event.to) / INCIDENT_ASSUMPTIONS.returnPersonsPerSecond : endsAt;
      stay(id, assemblyId, participant.assemblyAt!, participant.releaseAt);
      availableAt = participant.releaseAt;
      const resume = !skips && !early && left > 0;
      participant.decision = { activity: activity.kind, action: resume ? 'resume' : 'cancel', at: participant.releaseAt,
        destinationId: skips ? events[shortcut!.index].to : early ? leave!.to : location,
        reason: skips ? 'activity ended during the drill; joins the next saved walk'
          : early ? (left < minimumUseful(activity.kind) ? 'too little time would remain after release; leaves early' : 'meal mostly finished')
          : !resume ? 'activity ended during the drill; continues the saved schedule'
          : policy && left < minimumUseful(activity.kind) ? 'too little time would remain, but no early saved walk'
          : 'enough time remains after release' };
      if (skips) {
        location = events[shortcut!.index].to;
        availableAt = walk(id, assemblyId, location, shortcut!.route, availableAt);
        cursor = shortcut!.index + 1;
      } else if (early) {
        availableAt = walk(id, assemblyId, location, reverse(route), availableAt);
        for (let i = cursor + 1; i <= leaveIndex; i++) {
          const trip = events[i].trip;
          if (!trip) continue;
          const shift = availableAt - events[i].start;
          trips.push(shift === 0 ? trip : { ...trip, timestamps: trip.timestamps.map(t => t + shift) });
          availableAt = events[i].end + shift;
        }
        location = leave!.to;
        cursor = leaveIndex + 1;
      } else availableAt = walk(id, assemblyId, location, reverse(route), availableAt);
    } else {
      location = event.from;
      availableAt = at;
      const approach = event.end - event.start;
      if (at > event.start) {
        const trip = event.trip!;
        const partial = prefix({ path: trip.path, cumulative: trip.timestamps.map(t => t - event.start) }, at - event.start);
        trips.push({ ...trip, path: partial.path, timestamps: partial.cumulative.map(t => event.start + t) });
        const back = reverse(partial);
        trips.push({ agent: id, from: event.to, to: location, path: back.path, timestamps: back.cumulative.map(t => at + t) });
        availableAt = at + partial.cumulative.at(-1)!;
      }
      if (allDay) {
        // Damaged zone: the visit is cancelled. An origin inside the zone (a walk between two hazard
        // buildings) continues to the nearest waiting place outside it first.
        let point = event.trip!.path[0];
        if (blocked.has(location)) {
          const wait = waitRoutes.get(location)!.find(([, route]) => samePoint(route.path[0], point));
          if (!wait) throw new Error(`No saved walk route out of the hazard zone for ${id}`);
          availableAt = walk(id, location, wait[0], wait[1], availableAt);
          location = wait[0]; point = wait[1].path.at(-1)!;
          participant.waitLocationId = wait[0];
        }
        ({ location, availableAt, cursor } = continueOutside(id, events, cursor, location, point, availableAt));
        participant.outcome = 'cancelled';
      } else {
        if (blocked.has(location) && availableAt < endsAt) {
          // Multi-building hazards: a walk between two hazard locations turns back to an origin that is
          // itself excluded, so continue to the nearest waiting place outside the zone and return at reopening.
          const wait = waitRoutes.get(location)!.find(([, route]) => samePoint(route.path[0], event.trip!.path[0]));
          if (!wait) throw new Error(`No saved walk route out of the hazard zone for ${id}`);
          const arrived = walk(id, location, wait[0], wait[1], availableAt);
          const leaveAt = Math.max(arrived, endsAt);
          stay(id, wait[0], arrived, leaveAt);
          availableAt = walk(id, wait[0], location, reverse(wait[1]), leaveAt);
          participant.waitLocationId = wait[0];
        }
        const reopenedAt = Math.max(endsAt, availableAt);
        // A visit is expired when the saved schedule leaves the footprint before a post-reopening approach could arrive.
        const leaveIndex = exitWalk(events, cursor);
        const leave = leaveIndex >= 0 ? events[leaveIndex] : undefined;
        if (leave && leave.start <= reopenedAt + approach) {
          if (leave.to === location && samePoint(leave.trip!.path.at(-1)!, event.trip!.path[0])) {
            // The saved return reaches this origin: omit the round trip.
            stay(id, location, availableAt, reopenedAt);
            availableAt = reopenedAt; cursor = leaveIndex + 1; participant.outcome = 'cancelled';
          } else {
            const direct = location !== 'off-campus' && leave.to !== 'off-campus' ? routesFrom(day, location, blocked).get(leave.to) : undefined;
            if (direct && samePoint(direct.path[0], event.trip!.path[0]) && samePoint(direct.path.at(-1)!, leave.trip!.path.at(-1)!)) {
              // Go straight to the next activity, arriving no later than originally scheduled when time allows.
              const depart = Math.max(availableAt, leave.end - direct.cumulative.at(-1)! / speedOf(id));
              stay(id, location, availableAt, depart);
              availableAt = walk(id, location, leave.to, direct, depart);
              location = leave.to; cursor = leaveIndex + 1; participant.outcome = 'cancelled';
            }
          }
        }
        if (participant.outcome !== 'cancelled') {
          stay(id, location, availableAt, reopenedAt);
          availableAt = reopenedAt;
        }
      }
    }
    if (participant.role === 'arrival' && participant.outcome !== 'relocated' && !crowdHandled) {
      const visit = events[events.indexOf(event) + 1];
      const activity = visit?.stay && blocked.has(visit.to) ? activityAt(events, events.indexOf(visit)) : { kind: 'unknown' as const };
      participant.decision = participant.outcome === 'cancelled'
        ? { activity: activity.kind, action: 'cancel', at, destinationId: location,
          reason: allDay ? 'building closed for the rest of the day; visit cancelled' : 'visit would end before the building reopens' }
        : { activity: activity.kind, action: 'wait', at, destinationId: event.to,
          reason: at > event.start ? 'turns back on its approach and visits after reopening' : 'waits at origin and visits after reopening' };
    }
    participant.resumedAt = availableAt;
    let offMapArrival: { at: number; point: [number, number] } | undefined = crowdHandled ? crowdOffMap : location === 'off-campus'
      ? participant.role === 'arrival' && event.from === 'off-campus'
        ? { at: at + (at - event.start), point: event.trip!.path[0] }
        : { at: availableAt, point: events[cursor - 1].trip!.path.at(-1)! }
      : undefined;
    for (let k = cursor; k < events.length; k++) {
      const item = events[k];
      if (allDay && blocked.has(item.to)) {
        // Damaged zone: skip every later visit and rejoin the schedule at the next stop outside it.
        const point = item.trip ? item.trip.path[0] : events.slice(0, k).filter(e => e.trip).at(-1)?.trip!.path.at(-1);
        if (!point) fail(`no saved position before a hazard-zone visit for ${id}`);
        const from = item.trip ? item.from : location;
        const next = continueOutside(id, events, k, from, point!, availableAt);
        if (next.location !== from) offMapArrival = next.location === 'off-campus'
          ? { at: next.availableAt, point: events[next.cursor - 1].trip!.path.at(-1)! } : undefined;
        location = next.location; availableAt = next.availableAt; k = next.cursor - 1;
        continue;
      }
      if (item.trip) {
        const gatewayReady = item.from === 'off-campus' && offMapArrival
          ? offMapArrival.at + gatewaySeconds(offMapArrival.point, item.trip.path[0], speedOf(id)) : 0;
        // Never re-enter the closed footprint early: wait at the current location so the walk arrives at reopening.
        const reopenReady = blocked.has(item.to) ? endsAt - (item.end - item.start) : 0;
        const depart = Math.max(availableAt, item.start, gatewayReady, reopenReady);
        stay(id, location, availableAt, depart);
        const delay = depart - item.start;
        if (depart < DAY) trips.push(delay === 0 ? item.trip : { ...item.trip, timestamps: item.trip.timestamps.map(t => t + delay) });
        availableAt = item.end + delay; location = item.to;
        offMapArrival = item.to === 'off-campus' ? { at: availableAt, point: item.trip.path.at(-1)! } : undefined;
        if (delay > 0) participant.resumedAt = availableAt;
      } else if (item.end > availableAt) {
        location = item.from;
        const purpose = item.stay!.purpose, known = purposeOf(item.stay!);
        // Early arrival before a known activity is waiting, never part of the class or activity itself.
        if (known && availableAt < item.start - EPS && known.kind !== 'wait' && known.kind !== 'home') {
          stay(id, location, availableAt, item.start, { kind: 'wait', fixed: false, before: known.kind === 'class' ? 'class' : 'activity' });
          stay(id, location, item.start, item.end, purpose);
        } else stay(id, location, availableAt, item.end, purpose);
        availableAt = item.end;
      }
    }
  }
  // Keep only published rides still reachable after replanning. Missed services are not replaced
  // with invented departures; unchanged journeys retain their original boarding records.
  const changedWalks = new Map<string, Trip[]>(), changedOffMap = new Map<string, Stay[]>();
  if (day.transitRides?.length) {
    for (const trip of trips) if (affected.has(trip.agent) && (trip.from === 'off-campus' || trip.to === 'off-campus')) {
      const list = changedWalks.get(trip.agent) ?? []; list.push(trip); changedWalks.set(trip.agent, list);
    }
    for (const item of stays) if (affected.has(item.agent) && item.location === 'off-campus') {
      const list = changedOffMap.get(item.agent) ?? []; list.push(item); changedOffMap.set(item.agent, list);
    }
  }
  const rematched = new Set<Trip>();
  const transitRides = day.transitRides?.map(ride => {
    if (!affected.has(ride.agent) || ride.time < incident.start || ride.cancelledAt !== undefined) return ride;
    const cancelled = { ...ride, cancelledAt: incident.start };
    const walks = changedWalks.get(ride.agent) ?? [], offMap = changedOffMap.get(ride.agent) ?? [];
    if (ride.kind === 'alight') {
      const walk = walks.find(trip => trip.from === 'off-campus'
        && Math.abs(trip.timestamps[0] - ride.time - ALIGHT_SECONDS) < EPS && samePoint(trip.path[0], ride.position));
      return walk && offMap.some(item => item.start <= ride.time && item.end >= walk.timestamps[0]) ? ride : cancelled;
    }
    const walk = walks.find(trip => trip.to === 'off-campus' && endOf(trip) <= ride.time
      && ride.time - endOf(trip) <= MAX_STOP_WAIT_SECONDS && samePoint(trip.path.at(-1)!, ride.position)
      && offMap.some(item => Math.abs(item.start - endOf(trip)) < EPS && item.end > ride.time));
    if (walk) return { ...ride, waitStart: endOf(walk) };
    // Outdoor crowd: someone heading home early takes the next published departure of their usual service
    // (a ride between campus stops, sim/campusRides.ts, is not a way home: it is kept or cancelled).
    const visits = ride.alightsAt === undefined && geometry && context?.transit?.visits(ride.stop, ride.route, ride.direction, context.weekday, 'board');
    const early = visits && walks.filter(trip => trip.to === 'off-campus' && !rematched.has(trip) && endOf(trip) >= incident.start
      && endOf(trip) <= ride.time && samePoint(trip.path.at(-1)!, ride.position)).sort((a, b) => endOf(a) - endOf(b))[0];
    const offStay = early && offMap.find(item => Math.abs(item.start - endOf(early)) < EPS);
    if (visits && early && offStay) {
      const k = visits.departures.findIndex(time => time >= endOf(early) && time <= Math.min(endOf(early) + MAX_STOP_WAIT_SECONDS, offStay.end - 60));
      if (k >= 0) { rematched.add(early); return { ...ride, trip: visits.trips[k], time: visits.departures[k], waitStart: endOf(early) }; }
    }
    return cancelled;
  });
  if (geometry) {
    // Leaving campus counts as "by transit" only with a published departure still to board.
    const riding = new Set((transitRides ?? []).filter(ride => ride.kind === 'board' && ride.cancelledAt === undefined && ride.time >= incident.start).map(ride => ride.agent));
    for (const participant of participants) if (participant.dispersal === 'transit' && !riding.has(participant.agentId)) participant.dispersal = 'home';
  }
  const result = { ...day, locations: assemblyLocation ? [...day.locations, assemblyLocation] : crowdLocations.length ? [...day.locations, ...crowdLocations] : day.locations, trips, stays,
    ...(transitRides ? { transitRides } : {}) };
  // New scenarios never return a malformed day: late egress, waiting or return walks that would
  // run past midnight (or any other gap or overlap) reject instead.
  let casualties: CasualtyEvent[] | undefined;
  if (zone) {
    try { timelines(result); }
    catch (error) { throw new Error(`Invalid incident: the ${incident.kind} response and recovery must fit within the day (${(error as Error).message})`); }
    // Post-process the complete transformed timeline: exposure uses only modeled positions up to each event.
    casualties = computeCasualties(result, { kind: incident.kind as DisasterKind, start: incident.start, activeUntil: requestedEndsAt, target,
      radiusMetres, affectedLocationIds: zone.locationIds, affectedBuildingIds: zone.buildingIds });
  }
  const outDay: DayData = casualties ? { ...result, casualties } : result;
  // Casualty-only people (e.g. through-walkers) count once alongside planning participants.
  const affectedAgents = new Set([...affected.keys(), ...(casualties ?? []).map(event => event.agentId)]).size;
  return { day: outDay,
    affectedAgents, assemblyLocation, assemblyClearanceMetres, participants, requestedEndsAt, endsAt,
    ...(zone ? { hazard: { radiusMetres, responseStartsAt, activeUntil: requestedEndsAt,
      affectedLocationIds: zone.locationIds, affectedBuildingIds: zone.buildingIds } } : {}),
    ...(casualties ? { casualties } : {}),
    ...(geometry ? { crowd: crowdResult(geometry, crowdLocations, crowdPlans) } : {}) };
}

function crowdResult(geometry: FireGeometry, areas: CampusLocation[], plans: Map<string, CrowdPlan>): FireCrowd {
  const spots: FireCrowd['spots'] = {};
  for (const [id, plan] of plans) {
    const spot = plan.area.spots[plan.spot];
    spots[id] = { position: spot.position, bearing: spot.bearing, area: areas[plan.area.index].id };
  }
  return { areas, spots, exits: geometry.exits.map(exit => exit.edge) };
}
const HOME_STAY: StayPurpose = { kind: 'home', fixed: false };
