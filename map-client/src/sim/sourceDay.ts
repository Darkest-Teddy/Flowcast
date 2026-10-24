import { dateForWeekday, openingHoursForDate, WEEKDAYS, type CampusData, type SourceMeeting } from '../data/campusData';
import { fitrecVisitStart } from '../data/fitrecUsage';
import { effectiveMeetingIntervals } from '../data/academicCalendar';
import { courseLevel, countsTowardDegreeLoad, eligibleStudentLevels } from './courseEligibility';
import type { Agent, CampusLocation, DayData, EstimatedActivityProfile, TransitRide, Trip } from './playback';
import { ALIGHT_SECONDS, lastAtOrBefore, MAX_EARLY_ARRIVAL_SECONDS, MAX_STOP_PAIR_METRES, MAX_STOP_WAIT_SECONDS, MIN_WEEKLY_TRIPS,
  routeKind, TRANSIT_COMMUTER_SHARE, VEHICLE_PEAK_MAX_LOAD, type TransitService } from './transitService';

const DAY = 86400;
const WALK_SPEED = 1.4;
const NO_TRANSIT = {};
const weeklyCache = new WeakMap<DayData, WeakMap<CampusData, WeakMap<object, (weekday: number) => SourceDay>>>();
const HOME_BREAK = 15 * 60;
const OFF_CAMPUS_BREAK = 30 * 60;
export const MODELED_OFF_CAMPUS_MEAL_SHARE = 0.35;
const MAX_GATEWAY_WALK_METRES = 2000;
const OPTIONAL_CAPACITY_BUCKET_SECONDS = 60;
const SOURCE_COVERED_ESTIMATED_ACTIVITY_FACTOR = 0.15;
const ESTIMATED_TIME_ATTEMPTS = 3;
const COURSE_CANDIDATE_ATTEMPTS = 96;
const AFFINITY_ATTEMPT_SHARE = 0.65;
const COMPONENT_BUNDLE_SEARCH_LIMIT = 48;
const COMPONENT_OPTIONS_PER_COMPONENT = 12;
const UNMAPPED_ACADEMIC_MINUTES = 120;
export const MODELED_ACTIVITY_SHOULDER_SHARE = 0.25;
const ARRIVAL_LEAD = { minimum: 2 * 60, spread: 10 * 60 };
const RESIDENT_ACTIVITIES = [
  { kind: 'dining', at: 8, spread: 2, shoulder: [7, 11], minutes: 25, probability: 0.45 },
  { kind: 'dining', at: 12, spread: 2, shoulder: [10.5, 16], minutes: 35, probability: 0.75 },
  { kind: 'library', at: 14, spread: 5, shoulder: [8, 22], minutes: 75, probability: 0.55 },
  { kind: 'dining', at: 18, spread: 3, shoulder: [16, 22], minutes: 40, probability: 0.7 },
  { kind: 'gym', at: 17, spread: 5, shoulder: [6, 22], minutes: 55, probability: 0.25 },
] as const;

const estimatedProfile = (location: CampusLocation): EstimatedActivityProfile | undefined => location.estimatedProfile;

type Route = { path: [number, number][]; cumulative: number[] };
interface Stop {
  location: string;
  start: number;
  end: number;
  meeting?: SourceMeeting;
  attendanceLimit?: number;
  activity?: 'dining' | 'library' | 'gym' | 'off-campus-meal' | 'estimated' | 'unmapped-academic';
  estimatedProfile?: EstimatedActivityProfile;
  component?: string;
  unmappedAcademic?: true;
}

export interface SourceAssignment {
  agentId: string;
  meetingId: string;
  courseCode: string;
  locationId: string;
  startSec: number;
  endSec: number;
  component?: string;
}

export interface SourceDayStats {
  eligibleMeetings: number;
  assignedClasses: number;
  scheduledStudents: number;
  skippedCalendar: number;
  sharedCandidatesSuppressed: number;
  unroutableCandidates: number;
  unroutableTrips: number;
  invalidRoutes: number;
  composedRoutes: number;
  composedTrips: number;
  capacityLimitedCandidates: number;
  roomCapacityLimitedCandidates: number;
  excludedNonDegreeSections: number;
  affinityCourseEnrollments: number;
  excludedIncompleteComponentCourses: number;
  componentBundleRejectedCandidates: number;
  linkedCourseEnrollments: number;
  modeledDegreeCourseSlots: number;
  mappedCourseSlotTargets: number;
  unmappedCourseSlotTargets: number;
  mappedCourseCoverage: Record<'undergraduate' | 'graduate', { mappedOfferings: number; totalOfferings: number; fraction: number }>;

  weeklyEnrolledStudents: number;
  weeklyEnrollments: number;
  unassignedStudents: number;
  eligibleWeeklySections: number;
  campusAccessTrips: number;
  modeledActivities: number;
  modeledOffCampusMeals: number;
  unavailableActivities: number;
  optionalCapacityRejected: number;
  estimatedActivities: number;
  unmappedAcademicBlocks: number;
  behaviorRejectedCandidates: number;
  optionalTravelRejectedCandidates: number;
  estimatedLocationCounts: Record<string, number>;
  /** Commuters assigned a published MBTA commute (stable for the week). */
  transitCommuters: number;
  transitAlightings: number;
  transitBoardings: number;
  /** Rider legs at their own stop with no published trip fitting the itinerary (walked from the stop). Legs
   * whose destination needs a different stop within the 2 km access limit are walked from that stop. */
  transitUnmatchedLegs: number;
  assumptions: string[];
}

export interface SourceActivity {
  agentId: string;
  locationId: string;
  startSec: number;
  endSec: number;
  kind: 'dining' | 'library' | 'gym' | 'off-campus-meal' | 'estimated' | 'unmapped-academic';
  estimated?: true;
  purpose?: EstimatedActivityProfile['purpose'] | 'unmapped-academic';
  basis?: string;
  confidence?: 'low';
  note?: string;
  proxy?: string;
}

export interface SourceDay extends DayData {
  transitRides: TransitRide[];
  sourceStats: SourceDayStats;
  sourceAssignments: SourceAssignment[];
  sourceActivities: SourceActivity[];
}

function fraction(key: string): number {
  let value = 2166136261;
  for (let index = 0; index < key.length; index++) value = Math.imul(value ^ key.charCodeAt(index), 16777619);
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13; value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

/** Scenario arrival distribution; known venue hours and itinerary constraints still decide admission. */
export function sampleActivityStart(seed: string, activityIndex: number): number {
  const activity = RESIDENT_ACTIVITIES[activityIndex];
  if (!activity) throw new Error('Unknown activity index');
  if (fraction(`${seed}:shoulder`) < MODELED_ACTIVITY_SHOULDER_SHARE) {
    return (activity.shoulder[0] + fraction(`${seed}:shoulder-time`) * (activity.shoulder[1] - activity.shoulder[0])) * 3600;
  }
  return (activity.at + fraction(`${seed}:time`) * activity.spread) * 3600;
}

export function sampleMappedCourseLoad(agentId: string, degreeSlots: number, coverage: number): number {
  let mapped = 0;
  for (let slot = 0; slot < degreeSlots; slot++) if (fraction(`${agentId}:mapped-course-slot:${slot}`) < coverage) mapped++;
  return mapped;
}

function straightLineMetres(a: [number, number], b: [number, number]): number {
  const radians = Math.PI / 180;
  const dlat = (b[1] - a[1]) * radians, dlng = (b[0] - a[0]) * radians;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dlng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function campusOf(location: CampusLocation): string {
  return location.campus ?? 'charles-river';
}

function validRoute(route: Route): boolean {
  return route.path.length >= 2 && route.cumulative.length === route.path.length
    && route.cumulative[0] === 0
    && route.path.every((point) => point.length === 2 && point.every(Number.isFinite))
    && route.cumulative.every((distance, index) => Number.isFinite(distance) && distance >= 0
      && (index === 0 || distance >= route.cumulative[index - 1]));
}

/**
 * Cached synthetic weekly enrollment; source seats are upper bounds, never actual enrollment.
 * With a published `transit` timetable, a modeled share of commuters ride real scheduled trips
 * to and from their gateway stop; without it every gateway is only a walking access point.
 */
export function buildSourceDay(base: DayData, data: CampusData, weekday: number, transit?: TransitService): SourceDay {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Weekday must be Monday=0 through Sunday=6');
  let cache = weeklyCache.get(base);
  if (!cache) { cache = new WeakMap(); weeklyCache.set(base, cache); }
  let byTransit = cache.get(data);
  if (!byTransit) { byTransit = new WeakMap(); cache.set(data, byTransit); }
  let makeDay = byTransit.get(transit ?? NO_TRANSIT);
  if (!makeDay) { makeDay = buildWeek(base, data, transit); byTransit.set(transit ?? NO_TRANSIT, makeDay); }
  return makeDay(weekday);
}

function buildWeek(base: DayData, data: CampusData, transit?: TransitService): (weekday: number) => SourceDay {
  const locations = new Map(base.locations.map((location) => [location.id, location]));
  for (const agent of base.agents) {
    if (agent.home !== 'off-campus' && !locations.has(agent.home)) throw new Error(`Student ${agent.id} has an unknown home ${agent.home}`);
  }
  const stats: SourceDayStats = {
    eligibleMeetings: 0, assignedClasses: 0, scheduledStudents: 0, skippedCalendar: 0,
    sharedCandidatesSuppressed: 0, unroutableCandidates: 0, unroutableTrips: 0, invalidRoutes: 0,
    composedRoutes: 0, composedTrips: 0, capacityLimitedCandidates: 0, roomCapacityLimitedCandidates: 0, excludedNonDegreeSections: 0, affinityCourseEnrollments: 0, excludedIncompleteComponentCourses: 0, componentBundleRejectedCandidates: 0, linkedCourseEnrollments: 0, modeledDegreeCourseSlots: 0, mappedCourseSlotTargets: 0, unmappedCourseSlotTargets: 0,
    mappedCourseCoverage: { undergraduate: { mappedOfferings: 0, totalOfferings: 0, fraction: 1 }, graduate: { mappedOfferings: 0, totalOfferings: 0, fraction: 1 } },
    weeklyEnrolledStudents: 0, weeklyEnrollments: 0, unassignedStudents: 0, eligibleWeeklySections: 0, campusAccessTrips: 0, modeledActivities: 0, modeledOffCampusMeals: 0, unavailableActivities: 0, optionalCapacityRejected: 0, estimatedActivities: 0, unmappedAcademicBlocks: 0, behaviorRejectedCandidates: 0, optionalTravelRejectedCandidates: 0, estimatedLocationCounts: {},
    transitCommuters: 0, transitAlightings: 0, transitBoardings: 0, transitUnmatchedLegs: 0,
    assumptions: [
      'Enrollment is synthetic and fixed for the whole reference week; published classes supply places, times, and seat upper bounds, not actual enrollment.',
      'Default course eligibility follows BU’s published numeric guide: 100–399 undergraduate, 400–599 undergraduate/graduate, 600–999 graduate; MED MD and graduate-school prefixes use graduate defaults. This is not a prerequisite or individual-permission checker.',
      'Each uncovered course slot may reserve one stable 120-minute weekday academic/study block outside the map, subject to route and schedule feasibility. These are explicit estimates, not published courses or observed location histories.',
      'Class arrivals use stable 2–12-minute leads when gaps permit. Home breaks require home dwell at least 15 minutes and at least their extra walking detour. Optional added walking cannot exceed the activity duration.',
      'Gateway changes reserve a straight-line distance/speed lower bound in off-map time in addition to meals/breaks; no route or transport mode outside the saved network is asserted.',
      'Only the eligible mapped/full canonical course-offering coverage fraction of each synthetic degree load is targeted on the map, sampled stably per student. This is an offering-coverage proxy, not measured enrollment; uncovered study remains unknown rather than redistributed to mapped classrooms.',
      'Nondegree 0xx and PDP offerings remain visible in source data but are omitted from modeled degree-course enrollment; noncredit attendance is unknown.',
      'Explicit linked lecture, discussion, and lab requirements are admitted atomically as one degree course. Missing mapped components or unresolved source requirements exclude that course; unknown relationships are not invented.',
      'Each student has a stable synthetic school affinity weighted by eligible section seats. The planner prefers that school for target minus one courses, allowing cross-school electives and feasible fallback. This is a model preference, not an observed major.',
      'Modeled course loads are 1–2 for part-time students, 3–4 for full-time graduate students, and 4–5 for full-time undergraduates; only mapped, reachable, mutually feasible weekly sections are assigned. Linked lecture/lab requirements are unknown.',
      'Concurrent published meetings share one physical building-code/room-code seat pool, including partial time overlaps. Conflicting catalog entries reduce modeled attendance rather than shifting source times or enlarging room capacity.',
      'Unknown room capacity uses a conservative 24-student cap; cross-listed shared occurrences share the same seat pool.',
      'Walking follows compatible bundled pedestrian routes at each student’s stable modeled speed (default 1.4 m/s).',
      'Campus gateway access walks are capped at 2 km; sections requiring longer or unavailable gateway paths are not assigned when campus gateway data exist.',
      'Off-campus students prefer a stable modeled campus gateway, using a compatible saved gateway when the preferred path is unavailable or over 2 km; only the campus access leg is shown, not an observed commute or transit boarding. Arrival leads vary by 2–12 minutes.',
      'Optional arrival times retain their core windows with a 25% broad-day shoulder: breakfast 07–11, lunch 10:30–16, study 08–22, dinner 16–22, and gym 06–22. These are uncalibrated behavior assumptions, not fitted occupancy percentages; published service hours still govern admission.',
      'Residents, including those whose homes are outside the map, may take probability-bounded modeled meal, study, and gym trips, including weekends; these are synthetic preferences, not observed attendance. Feasible home breaks and waits fill gaps.',
      'Commuter optional visits are confined to days with published classes and intervals between their first and last class; no extra campus days are assumed.',
      'Off-campus students may leave via their gateway during a gap that permits access walks and at least 30 minutes off-campus; campus waiting remains modeled when a departure does not fit.',
      'Optional visits require published exact-date or valid weekly opening hours; exact-date closures override weekly schedules. Missing or undated hours do not imply availability. Published classes retain their own source times.',
      'Explicit low-confidence scenario profiles may supply estimated academic, research, community, arena, or rowing activities. These use existing students, never published enrollment; source-unassigned students receive priority and source-covered students have a 15% relative participation weight.',
      'Estimated availability never overrides known dated/weekly closures. Restricted arena/rowing profiles describe purpose-specific student participants, not public access. At most one estimated activity is added per student per day.',
      'Optional presence, including waits, reserves conservative minute buckets within existing venue capacities. Published class presence is reserved first and never trimmed.',
      'Open, reachable optional venues are selected with modeled capacity/distance weights, not observed preferences; unavailable venues receive no overflow traffic.',
      `A modeled ${Math.round(MODELED_OFF_CAMPUS_MEAL_SHARE * 100)}% share of attempted resident meals (an uncalibrated model parameter) uses physical gateway walks and off-campus stays; no restaurant, off-map route, or observed meal behavior is asserted. Infeasible meals are skipped.`,
      'Date-limited class notes are excluded. Undated opening-hour snapshots are not authoritative.',
    ],
  };
  if (transit) stats.assumptions.push(
    `With the published MBTA timetable loaded, a stable ${Math.round(TRANSIT_COMMUTER_SHARE * 1000) / 10}% of commuting students ride transit: the public-transportation share of all Charles River Campus commuters (employees and students) in BU's 2013–2023 Institutional Master Plan, Section 8.4 (December 2010 data). It is not a student-only or per-campus measurement.`,
    `Riders use one gateway stop for the week, chosen in proportion to published weekly trips of each route direction stopping there (at least ${MIN_WEEKLY_TRIPS}), and return from the nearest stop within ${MAX_STOP_PAIR_METRES} m served the other way. Each walk onto campus starts ${ALIGHT_SECONDS} s after a published arrival (at most ${MAX_EARLY_ARRIVAL_SECONDS / 60} min early); each walk off campus ends with a wait of at most ${MAX_STOP_WAIT_SECONDS / 60} min for a published departure. Legs no published trip fits are walked from the stop and counted as unmatched.`,
    `MBTA times are the saved GTFS reference week of ${transit.referenceWeekStart}, aligned to the scenario by weekday. BU Shuttle times are TransLoc's recorded current schedules inside captured windows and BU's 2024–25 TransLoc GTFS baseline elsewhere; shuttle lines are loops, so riders go home onward round the same line. Origins, transfers and the off-map part of each journey are unknown. Non-riders do not walk in from Green Line platforms.`,
  );
  const routes = new Map<string, Route>();
  const adjacent = new Map<string, { to: string; route: Route }[]>();
  const endpoints = new Map<string, [number, number]>();
  const near = (a: [number, number], b: [number, number]) => Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111320) <= 1;
  for (const [key, route] of Object.entries(base.walkRoutes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const [from, to] = key.split('>');
    const origin = locations.get(from), destination = locations.get(to);
    if (!origin || !destination || !validRoute(route)
      || (endpoints.has(from) && !near(endpoints.get(from)!, route.path[0]))
      || (endpoints.has(to) && !near(endpoints.get(to)!, route.path[route.path.length - 1]))) {
      stats.invalidRoutes++;
      continue;
    }
    if (!endpoints.has(from)) endpoints.set(from, route.path[0]);
    if (!endpoints.has(to)) endpoints.set(to, route.path[route.path.length - 1]);
    routes.set(key, route);
    const list = adjacent.get(from) ?? [];
    list.push({ to, route });
    adjacent.set(from, list);
  }
  const composed = new Set<string>(), missing = new Set<string>();
  const routeBetween = (from: string, to: string): Route | undefined => {
    const origin = locations.get(from), destination = locations.get(to);
    if (!origin || !destination) return undefined;
    const key = `${from}>${to}`;
    if (routes.has(key)) return routes.get(key);
    if (missing.has(key)) return undefined;
    const costs = new Map([[from, 0]]), previous = new Map<string, { from: string; route: Route }>();
    const visited = new Set<string>();
    while (true) {
      let current: string | undefined;
      for (const node of costs.keys()) {
        if (!visited.has(node) && (current === undefined || costs.get(node)! < costs.get(current)!)) current = node;
      }
      if (current === undefined || current === to) break;
      visited.add(current);
      for (const edge of adjacent.get(current) ?? []) {
        const cost = costs.get(current)! + edge.route.cumulative[edge.route.cumulative.length - 1];
        if (cost < (costs.get(edge.to) ?? Infinity)) {
          costs.set(edge.to, cost);
          previous.set(edge.to, { from: current, route: edge.route });
        }
      }
    }
    if (!previous.has(to)) { missing.add(key); return undefined; }
    const legs: Route[] = [];
    let current = to;
    while (current !== from) {
      const step = previous.get(current)!;
      legs.unshift(step.route);
      current = step.from;
    }
    const path: [number, number][] = [], cumulative: number[] = [];
    let offset = 0;
    for (const leg of legs) {
      if (path.length && !near(path[path.length - 1], leg.path[0])) { missing.add(key); return undefined; }
      for (let index = path.length ? 1 : 0; index < leg.path.length; index++) {
        path.push(leg.path[index]);
        cumulative.push(offset + leg.cumulative[index]);
      }
      offset += leg.cumulative[leg.cumulative.length - 1];
    }
    const route = { path, cumulative };
    routes.set(key, route);
    composed.add(key);
    stats.composedRoutes++;
    return route;
  };
  const speed = (agent: Agent): number => {
    const value = (agent as Agent & { walkSpeed?: number }).walkSpeed;
    return value === undefined ? WALK_SPEED : Math.max(1.1, Math.min(1.6, Number.isFinite(value) ? value : WALK_SPEED));
  };
  const offCampus = (agent: Agent) => agent.home === 'off-campus' || (agent as Agent & { residency?: string }).residency === 'commuter';
  const duration = (from: string, to: string, agent: Agent): number => {
    if (from === to) return 0;
    const route = from === 'off-campus' || to === 'off-campus'
      ? accessRoute(agent, from === 'off-campus' ? to : from, from === 'off-campus' ? 'in' : 'out') : routeBetween(from, to);
    return route ? route.cumulative[route.cumulative.length - 1] / speed(agent) : Infinity;
  };
  const gateways = new Map<string, Map<string, Route>>();
  for (const [key, route] of Object.entries(base.stopRoutes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const [stop, location] = key.split('>');
    if (!locations.has(location) || !validRoute(route) || route.cumulative.at(-1)! <= 0) continue;
    const endpoint = endpoints.get(location);
    if (endpoint && !near(endpoint, route.path.at(-1)!)) continue;
    const links = gateways.get(stop) ?? new Map<string, Route>();
    if (links.size && !near(links.values().next().value!.path[0], route.path[0])) continue;
    links.set(location, route); gateways.set(stop, links);
  }
  const gatesByCampus = new Map<string, string[]>();
  for (const [gate, links] of gateways) {
    const campus = campusOf(locations.get(links.keys().next().value!)!);
    const list = gatesByCampus.get(campus) ?? []; list.push(gate); gatesByCampus.set(campus, list);
  }
  const gateCache = new Map<string, Route | undefined>();
  const gatePoint = (gate: string): [number, number] => gateways.get(gate)!.values().next().value!.path[0];
  const agentCampus = (agent: Agent): string => {
    const campus = agent.home === 'off-campus' ? agent.academicCampus ?? agent.campus : agent.campus;
    return campus ?? (locations.has(agent.home) ? campusOf(locations.get(agent.home)!) : 'charles-river');
  };
  // With a published timetable, Green Line platforms are reached by train only; people walking
  // in from off the map use the street-side stops as access points instead.
  const isStation = (gate: string) => gate.startsWith('place-');
  const walkInGates = new Map<string, string[]>();
  for (const [campus, gates] of gatesByCampus) {
    const plain = transit ? gates.filter((gate) => !isStation(gate)) : gates;
    walkInGates.set(campus, plain.length ? plain : gates);
  }
  // A transit commute: arrive at one stop in one direction, go home from the nearest stop the
  // same route serves the other way (the same station for the T, across the street for a bus).
  type Commute = { inGate: string; outGate: string; route: string; inDirection: 0 | 1; outDirection: 0 | 1; weight: number };
  const commutesByCampus = new Map<string, Commute[]>();
  if (transit) for (const [campus, gates] of gatesByCampus) {
    const options: Commute[] = [];
    const serves = (gate: string, route: string, direction: number) => transit.services(gate)
      .some((service) => service.route === route && service.direction === direction && service.weeklyTrips >= MIN_WEEKLY_TRIPS);
    for (const gate of [...gates].sort()) for (const service of transit.services(gate)) {
      if (service.weeklyTrips < MIN_WEEKLY_TRIPS) continue;
      // A loop (every BU Shuttle line) runs one way: the trip home is the same line, onward round the loop.
      const opposite = (1 - service.direction) as 0 | 1;
      const back = gates.some((other) => serves(other, service.route, opposite)) ? opposite : service.direction;
      let partner: string | undefined, best = Infinity;
      for (const other of [...gates].sort()) {
        if (!serves(other, service.route, back)) continue;
        const distance = straightLineMetres(gatePoint(gate), gatePoint(other));
        if (distance < best) { best = distance; partner = other; }
      }
      if (partner && best <= MAX_STOP_PAIR_METRES) options.push({ inGate: gate, outGate: partner, route: service.route,
        inDirection: service.direction, outDirection: back, weight: service.weeklyTrips });
    }
    if (options.length) commutesByCampus.set(campus, options);
  }
  const commuteCache = new Map<string, Commute | null>();
  /** Stable for the week: a modeled share of commuters ride, weighted by published service at each stop. */
  const commuteOf = (agent: Agent): Commute | undefined => {
    if (!transit || agent.residency !== 'commuter') return undefined;
    let commute = commuteCache.get(agent.id);
    if (commute === undefined) {
      commute = null;
      if (fraction(`${agent.id}:transit-commute`) < TRANSIT_COMMUTER_SHARE) {
        const options = commutesByCampus.get(agentCampus(agent)) ?? [];
        let choice = fraction(`${agent.id}:transit-service`) * options.reduce((sum, option) => sum + option.weight, 0);
        commute = options.find((option) => (choice -= option.weight) < 0) ?? null;
      }
      commuteCache.set(agent.id, commute);
    }
    return commute ?? undefined;
  };
  type Leg = 'in' | 'out';
  const gateFor = (agent: Agent, leg: Leg): string | undefined => {
    const commute = commuteOf(agent);
    if (commute) return leg === 'in' ? commute.inGate : commute.outGate;
    const gates = walkInGates.get(agentCampus(agent)) ?? [];
    return gates[Math.floor(fraction(`${agent.id}:campus-gateway`) * gates.length)];
  };
  const routeFromGate = (gate: string, location: string): Route | undefined => {
    const key = `${gate}>${location}`;
    if (gateCache.has(key)) return gateCache.get(key);
    const links = gateways.get(gate)!;
    let best = links.get(location);
    if (best && best.cumulative.at(-1)! > MAX_GATEWAY_WALK_METRES) best = undefined;
    if (!best) for (const [via, leg] of links) {
      const onward = routeBetween(via, location);
      if (!onward || !near(leg.path.at(-1)!, onward.path[0])) continue;
      const offset = leg.cumulative.at(-1)!;
      const candidate = { path: [...leg.path, ...onward.path.slice(1)], cumulative: [...leg.cumulative, ...onward.cumulative.slice(1).map(d => d + offset)] };
      if (candidate.cumulative.at(-1)! <= MAX_GATEWAY_WALK_METRES && (!best || candidate.cumulative.at(-1)! < best.cumulative.at(-1)!)) best = candidate;
    }
    gateCache.set(key, best); return best;
  };
  const accessCache = new Map<string, Route | undefined>();
  const accessRoute = (agent: Agent, location: string, leg: Leg): Route | undefined => {
    const preferred = gateFor(agent, leg);
    if (!preferred) return undefined;
    const key = `${preferred}>${location}`;
    if (accessCache.has(key)) return accessCache.get(key);
    let route = routeFromGate(preferred, location);
    if (!route) {
      const target = locations.get(location);
      if (target) for (const gate of walkInGates.get(campusOf(target)) ?? []) {
        if (gate === preferred) continue;
        const alternative = routeFromGate(gate, location);
        if (alternative && (!route || alternative.cumulative.at(-1)! < route.cumulative.at(-1)!)) route = alternative;
      }
    }
    accessCache.set(key, route); return route;
  };
  const accessDuration = (agent: Agent, location: string, leg: Leg) => (accessRoute(agent, location, leg)?.cumulative.at(-1) ?? Infinity) / speed(agent);
  type WeeklyStop = Stop & { weekday: number; pool: string; room?: string; roomSlots?: number[] };
  type Section = { id: string; course: string; campus: string; stops: WeeklyStop[]; aliases: Section[] };
  const sections = new Map<string, Section>();
  const limits = new Map<string, number>();
  const used = new Map<string, number>();
  const occurrences = new Set<string>();
  const rooms = new Map<string, { knownLimit?: number; boundaries: Set<number>; stops: WeeklyStop[] }>();
  const physicalRoom = (source: CampusData['locations'][string], meeting: SourceMeeting): string => {
    const building = meeting.buildingCode || (source.buildingCodes.length === 1 ? source.buildingCodes[0] : undefined);
    const identity = building ? `code:${building.trim().toUpperCase()}` : `mapped:${locations.get(source.id)!.building || source.id}`;
    return `${identity}:room:${meeting.roomCode.trim().toUpperCase() || `unresolved:${meeting.sharedKey ?? meeting.id}`}`;
  };

  const dates = Array.from({ length: 7 }, (_, day) => dateForWeekday(data, day));
  const openingCache = new Map<string, [number, number][]>();
  const optionalWindows = (location: string, weekday: number): [number, number][] => {
    if (data.locations[location]?.hoursStatus === 'restricted') return [];
    const key = `${location}:${weekday}`;
    const cached = openingCache.get(key);
    if (cached) return cached;
    const windows = venueWindows(data, location, locations.get(location)?.kind, weekday);
    openingCache.set(key, windows); return windows;
  };
  const isOpen = (stop: WeeklyStop): boolean => {
    if (stop.meeting || stop.location === 'off-campus') return true;
    if (stop.estimatedProfile) {
      const profile = stop.estimatedProfile;
      const source = data.locations[stop.location];
      if (source?.hoursStatus === 'restricted' && profile.purpose !== 'arena' && profile.purpose !== 'rowing') return false;
      if (!profile.weekdayWindows.some(row => row.weekday === stop.weekday && row.windows.some(([start, end]) => start <= stop.start && stop.end <= end))) return false;
      const known = openingHoursForDate(source?.hours ?? [], dates[stop.weekday], stop.weekday);
      return !known.length || known.some(entry => entry.windows.some(([start, end]) => start <= stop.start && stop.end <= end));
    }
    return optionalWindows(stop.location, stop.weekday).some(([opens, closes]) => opens <= stop.start && stop.end <= closes);
  };
  const excludedNonDegree = new Set<string>();
  const componentRules = data.courseComponentRules ?? {};
  const incompleteCourses = new Set(Object.entries(componentRules).filter(([, rule]) =>
    rule.status !== 'resolved' || !rule.hasCompleteMappedOption || !rule.components.length).map(([course]) => course));
  stats.excludedIncompleteComponentCourses = [...incompleteCourses].filter(course => componentRules[course].mappedCourse).length;

  for (const source of Object.values(data.locations).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!locations.has(source.id)) continue;
    for (const meeting of [...source.meetings].sort((a, b) => a.id.localeCompare(b.id))) {
      if (meeting.calendarRestricted) { stats.skippedCalendar++; continue; }
      if (incompleteCourses.has(meeting.courseCode)) continue;
      const id = meeting.sourceSectionKey ?? `${meeting.courseCode}:${meeting.section}`;
      if (!countsTowardDegreeLoad(meeting.courseCode)) { excludedNonDegree.add(id); continue; }
      const section: Section = sections.get(id) ?? { id, course: meeting.courseCode, campus: campusOf(locations.get(source.id)!), stops: [], aliases: [] };
      for (const interval of effectiveMeetingIntervals(meeting, data)) {
        const weekday = interval.weekday, start = interval.startSec - weekday * DAY, end = interval.endSec - weekday * DAY;
        if (weekday < 0 || weekday > 6 || start < 0 || start >= end || end > DAY || !Number.isFinite(start + end)) continue;
        const pool = `${meeting.sharedKey ?? meeting.id}:${weekday}:${start}:${end}`;
        const limit = meeting.roomCapacity !== null && Number.isFinite(meeting.roomCapacity) ? Math.max(0, Math.floor(meeting.roomCapacity)) : 24;
        limits.set(pool, Math.min(limits.get(pool) ?? Infinity, limit));
        if (occurrences.has(pool)) stats.sharedCandidatesSuppressed++;
        occurrences.add(pool);
        const room = physicalRoom(source, meeting);
        const roomState = rooms.get(room) ?? { boundaries: new Set<number>(), stops: [] };
        if (meeting.roomCapacity !== null && Number.isFinite(meeting.roomCapacity)) {
          roomState.knownLimit = Math.min(roomState.knownLimit ?? Infinity, Math.max(0, Math.floor(meeting.roomCapacity)));
        }
        roomState.boundaries.add(weekday * DAY + start); roomState.boundaries.add(weekday * DAY + end);
        if (!section.stops.some((stop) => stop.pool === pool)) {
          const stop = { location: source.id, start, end, weekday, meeting, pool, room };
          section.stops.push(stop); roomState.stops.push(stop);
        }
        rooms.set(room, roomState);
      }
      if (section.stops.length) sections.set(id, section);
    }
  }
  // Exact boundary segments share seats across partially overlapping section patterns.
  const roomSlotLimits: number[] = [];
  for (const room of rooms.values()) {
    const boundaries = [...room.boundaries].sort((a, b) => a - b);
    const indices = new Map(boundaries.map((time, index) => [time, index]));
    const offset = roomSlotLimits.length;
    for (let index = 1; index < boundaries.length; index++) roomSlotLimits.push(room.knownLimit ?? 24);
    for (const stop of room.stops) {
      const first = indices.get(stop.weekday * DAY + stop.start)!;
      const last = indices.get(stop.weekday * DAY + stop.end)!;
      stop.roomSlots = Array.from({ length: last - first }, (_, index) => offset + first + index);
    }
  }
  const roomAttendance = new Int32Array(roomSlotLimits.length);
  // Cross-listed aliases with identical weekly occurrences represent one section.
  const signatures = new Map<string, Section>();
  const canonicalForAlias = new Map<string, Section>();
  const sectionsByCode = new Map<string, Section[]>();
  const byCampus = new Map<string, Section[]>();
  for (const section of sections.values()) {
    section.stops.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
    const labelKey = `${section.course}:${section.stops[0].meeting!.section.trim().toUpperCase()}`;
    const sameLabel = sectionsByCode.get(labelKey) ?? [];
    sameLabel.push(section); sectionsByCode.set(labelKey, sameLabel);
    const signature = section.stops.map((stop) => stop.pool).sort().join('|');
    const canonical = signatures.get(signature);
    if (canonical) { canonical.aliases.push(section); canonicalForAlias.set(section.id, canonical); continue; }
    section.aliases = [section]; signatures.set(signature, section); canonicalForAlias.set(section.id, section);
    const list = byCampus.get(section.campus) ?? [];
    list.push(section); byCampus.set(section.campus, list);
  }
  stats.eligibleWeeklySections = signatures.size;
  stats.excludedNonDegreeSections = excludedNonDegree.size;
  function feasible(stops: WeeklyStop[], agent: Agent): boolean {
    let previous: WeeklyStop | undefined;
    for (const stop of stops) {
      if (!isOpen(stop)) return false;
      if (!previous || previous.weekday !== stop.weekday) {
        if (previous && previous.end + (previous.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, previous.location, 'out') : duration(previous.location, agent.home, agent)) > DAY) return false;
        if ((stop.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, stop.location, 'in') : duration(agent.home, stop.location, agent)) > stop.start) { stats.unroutableCandidates++; return false; }
      } else {
        const walk = duration(previous.location, stop.location, agent);
        if (!Number.isFinite(walk)) stats.unroutableCandidates++;
        if (previous.end + walk > stop.start) return false;

      }
      previous = stop;
    }
    return !previous || previous.end + (previous.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, previous.location, 'out') : duration(previous.location, agent.home, agent)) <= DAY;
  }
  const schoolOf = (course: string) => /^([A-Z]{2,5})\s/.exec(course)?.[1] ?? 'unknown';
  const eligibleAliases = (section: Section, level: Agent['studentLevel']) => section.aliases.filter(alias =>
    !level || eligibleStudentLevels(alias.course).includes(level));
  const selectAlias = (section: Section, agent: Agent, school: string): Section | undefined => eligibleAliases(section, agent.studentLevel)
    .sort((a, b) => Number(schoolOf(b.course) === school) - Number(schoolOf(a.course) === school)
      || Number(courseLevel(b.course) === agent.studentLevel) - Number(courseLevel(a.course) === agent.studentLevel)
      || a.id.localeCompare(b.id))[0];
  type CandidateIndex = { all: Section[]; schools: Map<string, Section[]>; weights: [string, number][] };
  const candidateIndices = new Map<string, CandidateIndex>();
  const indexFor = (campus: string, level: Agent['studentLevel']): CandidateIndex => {
    const key = `${campus}:${level ?? 'unknown'}`;
    const cached = candidateIndices.get(key);
    if (cached) return cached;
    const all = (byCampus.get(campus) ?? []).filter(section => eligibleAliases(section, level).length);
    const schools = new Map<string, Section[]>(), weights = new Map<string, number>();
    for (const section of all) {
      const aliases = eligibleAliases(section, level);
      const uniqueSchools = new Set(aliases.map(alias => schoolOf(alias.course)));
      const seats = Math.min(...section.stops.map(stop => limits.get(stop.pool)!));
      for (const school of uniqueSchools) {
        const list = schools.get(school) ?? []; list.push(section); schools.set(school, list);
        weights.set(school, (weights.get(school) ?? 0) + seats / uniqueSchools.size);
      }
    }
    const index = { all, schools, weights: [...weights] };
    candidateIndices.set(key, index); return index;
  };
  const catalogGroups = data.catalogCourseCoverage?.courseGroups ?? data.catalogCourseCodes?.map(code => [code]);
  const mappedCodes = new Set([...sections.values()].map(section => section.course));
  if (catalogGroups) for (const level of ['undergraduate', 'graduate'] as const) {
    const eligibleGroups = catalogGroups.map(group => group.filter(code => countsTowardDegreeLoad(code) && eligibleStudentLevels(code).includes(level))).filter(group => group.length);
    const mappedOfferings = eligibleGroups.filter(group => group.some(code => mappedCodes.has(code))).length;
    stats.mappedCourseCoverage[level] = { mappedOfferings, totalOfferings: eligibleGroups.length,
      fraction: eligibleGroups.length ? mappedOfferings / eligibleGroups.length : 0 };
  }
  type Admission = { section: Section; alias: Section; component?: string };
  const sectionCode = (alias: Section) => alias.stops[0].meeting!.section.trim().toUpperCase();
  const sectionFull = (section: Section) => section.stops.some(stop => (used.get(stop.pool) ?? 0) >= limits.get(stop.pool)!
    || stop.roomSlots!.some(slot => roomAttendance[slot] >= roomSlotLimits[slot]));
  const bundleFor = (section: Section, alias: Section, agent: Agent, existing: WeeklyStop[]): Admission[] | undefined => {
    const rule = componentRules[alias.course];
    if (!rule) return [{ section, alias }];
    const anchor = rule.components.find(component => component.sections.includes(sectionCode(alias)));
    if (!anchor) return undefined;
    const selected = new Map<string, Admission>([[anchor.id, { section, alias, component: anchor.id }]]);
    const dependenciesFit = () => rule.dependencies.every(dependency => ![...selected.values()].some(choice => sectionCode(choice.alias) === dependency.section)
      || dependency.requires.every(requirement => !selected.has(requirement.component)
        || requirement.sections.includes(sectionCode(selected.get(requirement.component)!.alias))));
    const options = new Map(rule.components.map(component => [component.id, component.sections.flatMap(code =>
      (sectionsByCode.get(`${alias.course}:${code}`) ?? []).map(choice =>
        ({ alias: choice, section: canonicalForAlias.get(choice.id)!, component: component.id })))
      .filter(choice => !agent.studentLevel || eligibleStudentLevels(choice.alias.course).includes(agent.studentLevel))]));
    const missing = rule.components.filter(component => component.id !== anchor.id)
      .sort((a, b) => options.get(a.id)!.length - options.get(b.id)!.length);
    let searched = 0;
    const search = (index: number): Admission[] | undefined => {
      if (!dependenciesFit()) return undefined;
      if (index === missing.length) {
        const chosen = [...selected.values()];
        return feasible([...existing, ...chosen.flatMap(choice => choice.alias.stops)].sort((a, b) => a.weekday - b.weekday || a.start - b.start), agent) ? chosen : undefined;
      }
      const component = missing[index], candidates = options.get(component.id)!;
      const start = Math.floor(fraction(`${agent.id}:${alias.course}:${component.id}:component-choice`) * candidates.length);
      for (let attempt = 0; attempt < Math.min(candidates.length, COMPONENT_OPTIONS_PER_COMPONENT) && searched < COMPONENT_BUNDLE_SEARCH_LIMIT; attempt++, searched++) {
        const choice = candidates[(start + attempt) % candidates.length];
        if (sectionFull(choice.section) || [...selected.values()].some(other => other.section === choice.section)) continue;
        selected.set(component.id, choice);
        if (dependenciesFit() && feasible([...existing, ...[...selected.values()].flatMap(row => row.alias.stops)].sort((a, b) => a.weekday - b.weekday || a.start - b.start), agent)) {
          const result = search(index + 1);
          if (result) return result;
        }
        selected.delete(component.id);
      }
      return undefined;
    };
    return search(0);
  };
  const enrollment = new Map<string, WeeklyStop[]>();
  const unmappedLoads = new Map<string, number>();
  const fullSections = new Set<Section>();
  const order = [...base.agents].sort((a, b) => fraction(`weekly:${a.id}`) - fraction(`weekly:${b.id}`) || a.id.localeCompare(b.id));
  for (const agent of order) {
    const campus = agent.academicCampus ?? agent.campus ?? campusOf(locations.get(agent.home)!);
    const index = indexFor(campus, agent.studentLevel);
    let schoolChoice = fraction(`${agent.id}:academic-affinity`) * index.weights.reduce((sum, [, weight]) => sum + weight, 0);
    const affinity = index.weights.find(([, weight]) => { schoolChoice -= weight; return schoolChoice < 0; })?.[0] ?? 'unknown';
    let stops: WeeklyStop[] = [];
    const courses = new Set<string>();
    let courseCount = 0, attempts = 0;
    const minimum = agent.attendance === 'part-time' ? 1 : agent.studentLevel === 'graduate' ? 3 : 4;
    const degreeTarget = minimum + Math.floor(fraction(`${agent.id}:course-count`) * 2);
    const coverage = agent.studentLevel ? stats.mappedCourseCoverage[agent.studentLevel].fraction : 1;
    const target = sampleMappedCourseLoad(agent.id, degreeTarget, coverage);
    stats.modeledDegreeCourseSlots += degreeTarget; stats.mappedCourseSlotTargets += target;
    stats.unmappedCourseSlotTargets += degreeTarget - target;
    unmappedLoads.set(agent.id, degreeTarget - target);
    const tested = new Set<Section>();
    const scan = (candidates: Section[], limit: number, budget: number, phase: string) => {
      const startIndex = Math.floor(fraction(`${agent.id}:weekly-start:${phase}`) * candidates.length);
      const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
      let stride = 1 + Math.floor(fraction(`${agent.id}:weekly-stride:${phase}`) * Math.max(1, candidates.length - 1));
      while (candidates.length && gcd(stride, candidates.length) !== 1) stride++;
      for (let attempt = 0; attempt < budget && candidates.length && courseCount < limit; attempt++, attempts++) {
        const position = (startIndex + attempt * stride) % candidates.length;
        const section = candidates[position];
        const poolFull = section.stops.some(stop => (used.get(stop.pool) ?? 0) >= limits.get(stop.pool)!);
        const roomFull = section.stops.some(stop => stop.roomSlots!.some(slot => roomAttendance[slot] >= roomSlotLimits[slot]));
        if (fullSections.has(section) || poolFull || roomFull) {
          candidates[position] = candidates[candidates.length - 1]; candidates.pop(); fullSections.add(section);
          if (poolFull) stats.capacityLimitedCandidates++;
          else if (roomFull) stats.roomCapacityLimitedCandidates++;
          continue;
        }
        if (tested.has(section)) continue;
        tested.add(section);
        const alias = selectAlias(section, agent, affinity)!;
        if (courses.has(alias.course) || section.aliases.some(other => courses.has(other.course))) continue;
        const bundle = bundleFor(section, alias, agent, stops);
        if (!bundle) { stats.componentBundleRejectedCandidates++; continue; }
        const componentStops = bundle.flatMap(choice => choice.alias.stops.map(stop => choice.component ? { ...stop, component: choice.component } : stop));
        const proposed = [...stops, ...componentStops].sort((a, b) => a.weekday - b.weekday || a.start - b.start);
        if (!feasible(proposed, agent)) continue;
        stops = proposed; courseCount++;
        for (const choice of bundle) for (const other of choice.section.aliases) courses.add(other.course);
        if (componentRules[alias.course]) stats.linkedCourseEnrollments++;
        if (schoolOf(alias.course) === affinity) stats.affinityCourseEnrollments++;
        for (const stop of componentStops) {
          used.set(stop.pool, (used.get(stop.pool) ?? 0) + 1);
          for (const slot of stop.roomSlots!) roomAttendance[slot]++;
        }
      }
    };
    scan(index.schools.get(affinity) ?? [], Math.max(0, target - 1), Math.floor(COURSE_CANDIDATE_ATTEMPTS * AFFINITY_ATTEMPT_SHARE), 'affinity');
    scan(index.all, target, COURSE_CANDIDATE_ATTEMPTS - attempts, 'elective-fallback');
    if (courseCount) stats.weeklyEnrolledStudents++;
    stats.weeklyEnrollments += courseCount;
    enrollment.set(agent.id, stops);
  }
  stats.unassignedStudents = base.agents.length - stats.weeklyEnrolledStudents;
  // Predict the same waits as the emitter; reserve complete presence, not just planned activity time.
  const resourceLocations = base.locations.filter(location => ['dining', 'library', 'gym'].includes(location.kind) || estimatedProfile(location));
  const resourceIndex = new Map(resourceLocations.map((location, index) => [location.id, index]));
  const bucketsPerDay = DAY / OPTIONAL_CAPACITY_BUCKET_SECONDS;
  type PlannedStay = { location: string; start: number; end: number };
  type PlannedMove = { from: string; to: string; route: Route; depart: number; arrive: number };
  type DayPlan = { stays: PlannedStay[]; moves: PlannedMove[]; walkingSeconds: number; rides: Omit<TransitRide, 'agent'>[]; unmatchedLegs: number };
  const reversed = new WeakMap<Route, Route>();
  const movementRoute = (agent: Agent, from: string, to: string): Route | undefined => {
    if (from !== 'off-campus' && to !== 'off-campus') return routeBetween(from, to);
    const inward = accessRoute(agent, from === 'off-campus' ? to : from, from === 'off-campus' ? 'in' : 'out');
    if (!inward || from === 'off-campus') return inward;
    let outward = reversed.get(inward);
    if (!outward) {
      const length = inward.cumulative.at(-1)!;
      outward = { path: [...inward.path].reverse(), cumulative: [...inward.cumulative].reverse().map(distance => length - distance) };
      reversed.set(inward, outward);
    }
    return outward;
  };
  /**
   * The published arrival a rider steps off before walking in. Prefers the last vehicle that lets
   * them start walking by `wanted` (at most an hour early), else the first one that still makes
   * `latest`. `fits` rejects starts whose earlier arrival would break a venue's hours.
   */
  // Modeled students using each published trip today (alighting plus boarding, so the vehicle's
  // simultaneous student load can never exceed it). Reset per day; committed per student.
  let tripLoad = new Map<string, number>();
  const tripHasRoom = (trip: string, route: string) => (tripLoad.get(trip) ?? 0) < VEHICLE_PEAK_MAX_LOAD[routeKind(route)];
  const matchAlighting = (commute: Commute, weekday: number, earliest: number, wanted: number, latest: number,
    fits: (walkStart: number) => boolean) => {
    const visits = transit!.visits(commute.inGate, commute.route, commute.inDirection, weekday, 'alight');
    if (!visits) return undefined;
    const low = Math.max(earliest, wanted - MAX_EARLY_ARRIVAL_SECONDS);
    const usable = (index: number) => {
      const start = visits.arrivals[index] + ALIGHT_SECONDS;
      return start >= low - 1e-7 && start <= latest + 1e-7 && tripHasRoom(visits.trips[index], commute.route) && fits(start);
    };
    const before = lastAtOrBefore(visits.arrivals, wanted - ALIGHT_SECONDS);
    for (let index = before; index >= 0 && visits.arrivals[index] + ALIGHT_SECONDS >= low - 1e-7; index--) if (usable(index)) return { visits, index };
    for (let index = before + 1; index < visits.arrivals.length && visits.arrivals[index] + ALIGHT_SECONDS <= latest + 1e-7; index++) if (usable(index)) return { visits, index };
    return undefined;
  };
  const planDay = (agent: Agent, stops: WeeklyStop[]): DayPlan | undefined => {
    const stays: PlannedStay[] = [], moves: PlannedMove[] = [];
    const rides: DayPlan['rides'] = [];
    let unmatchedLegs = 0;
    const commute = commuteOf(agent);
    const weekday = stops[0]?.weekday ?? 0;
    const home = offCampus(agent) ? 'off-campus' : agent.home;
    let from = home, freeAt = 0, notBeforeDeparture = 0, walkingSeconds = 0, valid = true;
    let currentBasis: WeeklyStop | undefined;
    let outside: { point: [number, number]; arrived: number; dwell: number } | undefined;
    const addStay = (location: string, start: number, end: number, basis?: WeeklyStop) => {
      if (end <= start) return;
      if (start < 0 || end > DAY || (basis && !basis.meeting && !isOpen({ ...basis, start, end }))) { valid = false; return; }
      stays.push({ location, start, end });
    };
    const offReady = (destination: string): number => {
      if (!outside) return freeAt;
      const gate = accessRoute(agent, destination, 'in')?.path[0];
      return gate ? outside.arrived + outside.dwell + straightLineMetres(outside.point, gate) / speed(agent) : Infinity;
    };
    const move = (destination: string, depart: number): boolean => {
      if (destination === from) return true;
      const route = movementRoute(agent, from, destination);
      if (!route || depart < freeAt - 1e-7 || (from === 'off-campus' && depart < offReady(destination) - 1e-7)) return false;
      const seconds = route.cumulative.at(-1)! / speed(agent), arrive = depart + seconds;
      if (!Number.isFinite(arrive) || depart < 0 || arrive > DAY) return false;
      if (seconds > 0) { moves.push({ from, to: destination, route, depart, arrive }); walkingSeconds += seconds; }
      else if (straightLineMetres(route.path[0], route.path.at(-1)!) > 1) return false;
      if (destination === 'off-campus') outside = { point: route.path.at(-1)!, arrived: arrive, dwell: 0 };
      else if (from === 'off-campus') outside = undefined;
      from = destination; freeAt = arrive; currentBasis = undefined; notBeforeDeparture = arrive;
      return true;
    };
    for (const stop of stops) {
      if (home === 'off-campus' && from !== 'off-campus' && stop.location === 'off-campus') {
        if (!move('off-campus', freeAt)) return undefined;
      }
      if (home === 'off-campus' && from !== 'off-campus' && stop.location !== 'off-campus') {
        const out = accessRoute(agent, from, 'out'), inward = accessRoute(agent, stop.location, 'in');
        if (out && inward) {
          const transfer = straightLineMetres(out.path[0], inward.path[0]) / speed(agent);
          if (freeAt + accessDuration(agent, from, 'out') + OFF_CAMPUS_BREAK + transfer + accessDuration(agent, stop.location, 'in') <= stop.start) {
            if (!move('off-campus', freeAt)) return undefined;
            outside!.dwell = OFF_CAMPUS_BREAK;
          }
        }
      }
      if (home !== 'off-campus' && from !== home) {
        const toHome = duration(from, home, agent), homeToNext = duration(home, stop.location, agent);
        const extra = Math.max(0, toHome + homeToNext - duration(from, stop.location, agent));
        const dwell = Math.max(HOME_BREAK, extra);
        const departHomeward = from === 'off-campus' ? Math.max(freeAt, offReady(home)) : freeAt;
        if (departHomeward + toHome + dwell + homeToNext <= stop.start) {
          addStay(from, freeAt, departHomeward, currentBasis);
          if (!move(home, departHomeward)) return undefined;
          notBeforeDeparture = freeAt + dwell;
        }
      }
      if (from === stop.location) addStay(from, freeAt, stop.start, currentBasis);
      else {
        const walk = duration(from, stop.location, agent);
        const earliest = Math.max(freeAt, notBeforeDeparture, from === 'off-campus' ? offReady(stop.location) : 0);
        const desiredLead = stop.meeting ? ARRIVAL_LEAD.minimum + fraction(`${agent.id}:${stop.weekday}:${stop.meeting.id}:arrival-lead`) * ARRIVAL_LEAD.spread : 0;
        const latest = stop.start - walk;
        let depart = Math.max(earliest, latest - desiredLead);
        if (depart > latest + 1e-7) return undefined;
        let ride: DayPlan['rides'][number] | undefined;
        const gate = from === 'off-campus' && commute ? movementRoute(agent, from, stop.location)?.path[0] : undefined;
        if (commute && gate) {
          // Riders arrive on a published trip; walking starts once they are off it.
          const onPlatform = straightLineMetres(gate, gatePoint(commute.inGate)) <= 1;
          const fits = (start: number) => !!stop.meeting || start + walk >= stop.start
            || isOpen({ ...stop, start: start + walk, end: stop.start });
          const match = onPlatform ? matchAlighting(commute, weekday, earliest, depart, latest, fits) : undefined;
          if (match) {
            depart = match.visits.arrivals[match.index] + ALIGHT_SECONDS;
            ride = { kind: 'alight', trip: match.visits.trips[match.index], route: commute.route, direction: commute.inDirection,
              stop: commute.inGate, time: match.visits.arrivals[match.index], position: gate };
          } else if (onPlatform) unmatchedLegs++;
        }
        addStay(from, freeAt, depart, currentBasis);
        if (!move(stop.location, depart)) return undefined;
        if (ride) rides.push(ride);
        addStay(stop.location, freeAt, stop.start, stop);
      }
      addStay(stop.location, stop.start, stop.end, stop);
      if (stop.location === 'off-campus' && outside) outside.dwell += stop.end - stop.start;
      from = stop.location; freeAt = stop.end; notBeforeDeparture = freeAt; currentBasis = stop;
      if (!valid) return undefined;
    }
    if (from !== home) {
      const depart = from === 'off-campus' ? Math.max(freeAt, offReady(home)) : freeAt;
      addStay(from, freeAt, depart, currentBasis);
      if (!move(home, depart)) return undefined;
    }
    addStay(home, freeAt, DAY);
    if (!valid) return undefined;
    // Riders leaving campus wait at their stop for the next published departure the other way,
    // and must be aboard before any later return to campus.
    if (commute) moves.forEach((leg, index) => {
      if (leg.to !== 'off-campus') return;
      const stopPoint = leg.route.path.at(-1)!;
      const visits = transit!.visits(commute.outGate, commute.route, commute.outDirection, weekday, 'board');
      const returnLeg = moves.slice(index + 1).find((later) => later.from === 'off-campus');
      const limit = Math.min(leg.arrive + MAX_STOP_WAIT_SECONDS, returnLeg ? returnLeg.depart - ALIGHT_SECONDS - 60 : DAY - 1);
      let best = -1;
      // A walk that had to use another stop (no route within 2 km from the rider's own) isn't a ride.
      if (straightLineMetres(stopPoint, gatePoint(commute.outGate)) > 1) return;
      if (visits) {
        for (let k = Math.max(0, lastAtOrBefore(visits.arrivals, leg.arrive - 600)); k < visits.arrivals.length && visits.arrivals[k] <= limit; k++) {
          const departure = visits.departures[k];
          if (departure >= leg.arrive && departure <= limit && tripHasRoom(visits.trips[k], commute.route)
            && (best < 0 || departure < visits.departures[best])) best = k;
        }
      }
      if (best < 0) { unmatchedLegs++; return; }
      rides.push({ kind: 'board', trip: visits!.trips[best], route: commute.route, direction: commute.outDirection,
        stop: commute.outGate, time: visits!.departures[best], waitStart: leg.arrive, position: stopPoint });
    });
    return { stays, moves, walkingSeconds, rides, unmatchedLegs };
  };
  const presenceKeys = (plan: DayPlan): Set<number> => {
    const keys = new Set<number>();
    for (const stay of plan.stays) {
      const index = resourceIndex.get(stay.location);
      if (index === undefined) continue;
      for (let minute = Math.floor(stay.start / OPTIONAL_CAPACITY_BUCKET_SECONDS); minute < Math.ceil(stay.end / OPTIONAL_CAPACITY_BUCKET_SECONDS); minute++) keys.add(index * bucketsPerDay + minute);
    }
    return keys;
  };
  const days = new Map<number, SourceDay>();
  return (weekday) => {
    const cached = days.get(weekday);
    if (cached) return cached;
    const trips: Trip[] = [];
    const transitRides: TransitRide[] = [];
    tripLoad = new Map();
    let transitUnmatchedLegs = 0;
    const riders = new Set<string>();
    const stays: { agent: string; location: string; start: number; end: number }[] = [];
    const assignments: SourceAssignment[] = [];
    const activities: SourceActivity[] = [];
    let composedTrips = 0, scheduledStudents = 0, campusAccessTrips = 0, modeledActivities = 0, modeledOffCampusMeals = 0, unavailableActivities = 0, optionalCapacityRejected = 0, estimatedActivities = 0;
    let unmappedAcademicBlocks = 0, behaviorRejectedCandidates = 0, optionalTravelRejectedCandidates = 0;
    const estimatedLocationCounts: Record<string, number> = {};
    const capacityLedger = new Int32Array(resourceLocations.length * bucketsPerDay);
    const baselinePresence = new Map<string, Set<number>>();
    for (const agent of base.agents) {
      const plan = planDay(agent, enrollment.get(agent.id)!.filter(stop => stop.weekday === weekday));
      if (!plan) throw new Error(`Published schedule has no feasible itinerary for ${agent.id}`);
      const keys = presenceKeys(plan);
      baselinePresence.set(agent.id, keys);
      for (const key of keys) capacityLedger[key]++;
    }
    const activityPlanningOrder = [...base.agents].sort((a, b) => Number(enrollment.get(a.id)!.length > 0) - Number(enrollment.get(b.id)!.length > 0)
      || fraction(`activity-order:${a.id}`) - fraction(`activity-order:${b.id}`) || a.id.localeCompare(b.id));
    for (const agent of activityPlanningOrder) {
      let stops = enrollment.get(agent.id)!.filter((stop) => stop.weekday === weekday);
      const fixedClasses = stops.length;
      const baseline = baselinePresence.get(agent.id)!;
      let reserved = new Set<number>();
      let currentPlan = planDay(agent, stops)!;
      const capacityFor = (proposed: WeeklyStop[], activitySeconds: number): Set<number> | undefined => {
        const plan = planDay(agent, proposed);
        if (!plan) { behaviorRejectedCandidates++; return undefined; }
        if (plan.walkingSeconds - currentPlan.walkingSeconds > activitySeconds + 1e-7) { optionalTravelRejectedCandidates++; return undefined; }
        const keys = presenceKeys(plan);
        for (const key of baseline) keys.delete(key);
        for (const key of keys) {
          const location = resourceLocations[Math.floor(key / bucketsPerDay)];
          const limit = Math.max(0, Math.floor(Math.min(location.capacity, estimatedProfile(location)?.capacity ?? Infinity)));
          if (capacityLedger[key] - (reserved.has(key) ? 1 : 0) + 1 > limit) { optionalCapacityRejected++; return undefined; }
        }
        return keys;
      };
      const reserve = (keys: Set<number>) => {
        for (const key of reserved) capacityLedger[key]--;
        for (const key of keys) capacityLedger[key]++;
        reserved = keys;
      };
      const resident = agent.residency === 'resident' || (!agent.residency && agent.home !== 'off-campus');
      const campus = agent.campus ?? (locations.has(agent.home) ? campusOf(locations.get(agent.home)!) : 'charles-river');
      const activityCampuses = new Set([campus, ...stops.map(stop => campusOf(locations.get(stop.location)!))]);
      const classStart = stops[0]?.start ?? DAY;
      const classEnd = stops.at(-1)?.end ?? 0;
      const academicDays = [0, 1, 2, 3, 4].sort((a, b) => fraction(`${agent.id}:unmapped-academic-day:${a}`) - fraction(`${agent.id}:unmapped-academic-day:${b}`));
      if (academicDays.slice(0, Math.min(5, unmappedLoads.get(agent.id) ?? 0)).includes(weekday)) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const start = (9 + fraction(`${agent.id}:${weekday}:unmapped-academic-time:${attempt}`) * 7) * 3600;
          const stop: WeeklyStop = { location: 'off-campus', start, end: start + UNMAPPED_ACADEMIC_MINUTES * 60,
            weekday, pool: '', activity: 'unmapped-academic', unmappedAcademic: true };
          const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
          const keys = feasible(proposed, agent) ? capacityFor(proposed, UNMAPPED_ACADEMIC_MINUTES * 60) : undefined;
          if (!keys) continue;
          reserve(keys); stops = proposed; currentPlan = planDay(agent, stops)!; unmappedAcademicBlocks++; modeledActivities++;
          break;
        }
      }
      const estimates: { proposed: WeeklyStop[]; keys: Set<number>; location: string; weight: number }[] = [];
      const sourceCovered = enrollment.get(agent.id)!.length > 0;
      for (const location of base.locations) {
        const profile = estimatedProfile(location);
        if (!profile || !activityCampuses.has(campusOf(location)) || (profile.studentLevel !== 'any' && agent.studentLevel !== profile.studentLevel)
          || (estimatedLocationCounts[location.id] ?? 0) >= profile.dailyParticipants) continue;
        const seed = `${agent.id}:${weekday}:estimated:${location.id}`;
        if (fraction(`${seed}:participation`) >= profile.attendanceProbability * (sourceCovered ? SOURCE_COVERED_ESTIMATED_ACTIVITY_FACTOR : 1)) continue;
        const windows = profile.weekdayWindows.filter(row => row.weekday === weekday).flatMap(row => row.windows)
          .filter(([start, end]) => end - start >= profile.durationMinutes * 60);
        if (!windows.length) continue;
        for (let attempt = 0; attempt < ESTIMATED_TIME_ATTEMPTS; attempt++) {
          const window = windows[Math.floor(fraction(`${seed}:${attempt}:window`) * windows.length)];
          const start = window[0] + fraction(`${seed}:${attempt}:time`) * (window[1] - window[0] - profile.durationMinutes * 60);
          const stop: WeeklyStop = { location: location.id, start, end: start + profile.durationMinutes * 60,
            weekday, pool: '', activity: 'estimated', estimatedProfile: profile };
          const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
          if (!isOpen(stop) || !feasible(proposed, agent)) continue;
          const keys = capacityFor(proposed, profile.durationMinutes * 60);
          if (!keys) continue;
          const travelTime = duration(proposed[proposed.indexOf(stop) - 1]?.location ?? agent.home, location.id, agent)
            + duration(location.id, proposed[proposed.indexOf(stop) + 1]?.location ?? agent.home, agent);
          estimates.push({ proposed, keys, location: location.id, weight: Math.sqrt(Math.max(1, profile.capacity)) / (300 + travelTime) });
          break;
        }
      }
      let estimatedChoice = fraction(`${agent.id}:${weekday}:estimated-choice`) * estimates.reduce((sum, row) => sum + row.weight, 0);
      const estimate = estimates.find(row => { estimatedChoice -= row.weight; return estimatedChoice < 0; });
      if (estimate) {
        reserve(estimate.keys); stops = estimate.proposed; currentPlan = planDay(agent, stops)!; estimatedActivities++; modeledActivities++;
        estimatedLocationCounts[estimate.location] = (estimatedLocationCounts[estimate.location] ?? 0) + 1;
      }
      if (resident || fixedClasses > 1) {
        for (const [index, activity] of RESIDENT_ACTIVITIES.entries()) {
          const seed = `${agent.id}:${weekday}:activity:${index}`;
          if (fraction(`${seed}:attend`) >= activity.probability) continue;
          const start = sampleActivityStart(seed, index);
          const withinClassDay = (time: number) => resident || (time >= classStart && time + activity.minutes * 60 <= classEnd);
          const offCampusMeal = activity.kind === 'dining' && fraction(`${seed}:off-campus`) < MODELED_OFF_CAMPUS_MEAL_SHARE;
          if (offCampusMeal) {
            if (!withinClassDay(start)) continue;
            const stop: WeeklyStop = { location: 'off-campus', start, end: start + activity.minutes * 60, weekday, pool: '', activity: 'off-campus-meal' };
            const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
            const keys = (agent.home === 'off-campus' || accessRoute(agent, agent.home, 'out')) && feasible(proposed, agent) ? capacityFor(proposed, activity.minutes * 60) : undefined;
            if (keys) {
              reserve(keys); stops = proposed; currentPlan = planDay(agent, stops)!; modeledActivities++; modeledOffCampusMeals++;
            } else unavailableActivities++;
            continue;
          }
          const candidates: { stop: WeeklyStop; proposed: WeeklyStop[]; weight: number; keys: Set<number> }[] = [];
          for (const location of base.locations) {
            if (location.kind !== activity.kind || !activityCampuses.has(campusOf(location))) continue;
            const visitStart = location.id === 'fitrec' && activity.kind === 'gym'
              ? fitrecVisitStart(data.fitrecUsage, dateForWeekday(data, weekday), fraction(`${seed}:fitrec-hour`), fraction(`${seed}:fitrec-minute`)) ?? start
              : start;
            if (!withinClassDay(visitStart)) continue;
            const stop: WeeklyStop = { location: location.id, start: visitStart, end: visitStart + activity.minutes * 60, weekday, pool: '', activity: activity.kind };
            if (!isOpen(stop)) continue;
            const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
            if (!feasible(proposed, agent)) continue;
            const keys = capacityFor(proposed, activity.minutes * 60);
            if (!keys) continue;
            const index = proposed.indexOf(stop);
            const origin = proposed[index - 1]?.location ?? agent.home;
            const destination = proposed[index + 1]?.location ?? agent.home;
            const travelTime = duration(origin, location.id, agent) + duration(location.id, destination, agent);
            candidates.push({ stop, proposed, keys, weight: Math.sqrt(Math.max(1, location.capacity)) / (300 + travelTime) });
          }
          const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
          let choice = fraction(`${seed}:venue`) * totalWeight;
          const selected = candidates.find(candidate => { choice -= candidate.weight; return choice < 0; });
          if (selected) { reserve(selected.keys); stops = selected.proposed; currentPlan = planDay(agent, stops)!; modeledActivities++; }
          else unavailableActivities++;
        }
      }
      if (fixedClasses) scheduledStudents++;
      const plan = planDay(agent, stops)!;
      for (const stay of plan.stays) stays.push({ agent: agent.id, ...stay });
      for (const ride of plan.rides) {
        transitRides.push({ agent: agent.id, ...ride }); riders.add(agent.id);
        tripLoad.set(ride.trip, (tripLoad.get(ride.trip) ?? 0) + 1);
      }
      transitUnmatchedLegs += plan.unmatchedLegs;
      for (const move of plan.moves) {
        const timestamps = move.route.cumulative.map(distance => move.depart + distance / speed(agent));
        trips.push({ agent: agent.id, from: move.from, to: move.to, path: move.route.path, timestamps });
        if (move.from === 'off-campus' || move.to === 'off-campus') campusAccessTrips++;
        if (composed.has(`${move.from}>${move.to}`)) composedTrips++;
      }
      for (const stop of stops) {
        if (stop.meeting) assignments.push({ agentId: agent.id, meetingId: stop.meeting.id, courseCode: stop.meeting.courseCode,
          locationId: stop.location, startSec: stop.start, endSec: stop.end, ...(stop.component ? { component: stop.component } : {}) });
        if (stop.activity) activities.push({ agentId: agent.id, locationId: stop.location, startSec: stop.start, endSec: stop.end, kind: stop.activity,
          ...(stop.estimatedProfile ? { estimated: true as const, purpose: stop.estimatedProfile.purpose, basis: stop.estimatedProfile.basis,
            confidence: stop.estimatedProfile.confidence, note: stop.estimatedProfile.note, proxy: stop.estimatedProfile.proxy } : {}),
          ...(stop.unmappedAcademic ? { estimated: true as const, purpose: 'unmapped-academic' as const, basis: 'modeled_unmapped_academic_time',
            confidence: 'low' as const, note: 'Estimated off-map academic/study commitment; actual course, location and schedule are unknown.', proxy: 'Eligible mapped/full catalog offering coverage and a 120-minute weekly scenario per uncovered course slot' } : {}) });
      }
    }
    const residentLocations = new Set(base.agents.filter(agent => agent.residency === 'resident').map(agent => agent.home));
    const dayLocations = base.locations.map(location => {
      const source = data.locations[location.id];
      const hasClass = source?.meetings.some(meeting => effectiveMeetingIntervals(meeting, data).some(interval => interval.weekday === weekday));
      const optionalOnly = ['dining', 'library', 'gym'].includes(location.kind) && !residentLocations.has(location.id) && !hasClass && !location.estimatedProfile;
      return optionalOnly ? { ...location, activityModeled: openingHoursForDate(source?.hours ?? [], dates[weekday], weekday).length > 0 } : location;
    });
    transitRides.sort((a, b) => a.time - b.time || a.agent.localeCompare(b.agent));
    const result: SourceDay = { ...base, locations: dayLocations, day: WEEKDAYS[weekday], trips, stays, transitRides,
      sourceStats: { ...stats, eligibleMeetings: [...occurrences].filter((key) => Number(key.split(':').at(-3)) === weekday).length,
        assignedClasses: assignments.length, scheduledStudents, composedTrips, campusAccessTrips, modeledActivities, modeledOffCampusMeals, unavailableActivities, optionalCapacityRejected, estimatedActivities, unmappedAcademicBlocks, behaviorRejectedCandidates, optionalTravelRejectedCandidates, estimatedLocationCounts,
        transitCommuters: riders.size, transitAlightings: transitRides.filter((ride) => ride.kind === 'alight').length,
        transitBoardings: transitRides.filter((ride) => ride.kind === 'board').length, transitUnmatchedLegs }, sourceAssignments: assignments, sourceActivities: activities };
    days.set(weekday, result);
    return result;
  };
}

/**
 * Typical opening hours (seconds since midnight) for places with no published schedule, by kind.
 * Weekday = 0 Monday ... 6 Sunday. BU dining halls serve roughly 7 AM-9 PM on weekdays and from
 * brunch at weekends; libraries 8 AM-midnight; FitRec-style gyms 6 AM-11 PM. Assumptions, labelled.
 */
function typicalWindows(kind: string | undefined, weekday: number): [number, number][] {
  const h = (hour: number) => hour * 3600;
  const weekend = weekday >= 5;
  switch (kind) {
    case 'dining':
      return weekend ? [[h(10), h(20)]] : [[h(7), h(21)]];
    case 'library':
      return weekend ? [[h(10), h(22)]] : [[h(8), h(24)]];
    case 'gym':
      return weekend ? [[h(8), h(22)]] : [[h(6), h(23)]];
    default:
      return [];
  }
}

/** Monday-first weekday (0 = Monday) of an ISO date, as a calendar date (no timezone shift). */
function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

/** The nearest dated entry on the same weekday, within four weeks of `date`. */
function sameWeekdayWindows(hours: { date: string | null; windows: [number, number][] }[], date: string, weekday: number): [number, number][] {
  const target = Date.parse(`${date}T12:00:00Z`);
  let best: { gap: number; windows: [number, number][] } | null = null;
  for (const entry of hours) {
    if (!entry.date || isoWeekday(entry.date) !== weekday) continue;
    const gap = Math.abs(Date.parse(`${entry.date}T12:00:00Z`) - target);
    if (gap <= 28 * 86400000 && (!best || gap < best.gap)) best = { gap, windows: entry.windows };
  }
  return best?.windows ?? [];
}

/** Published availability is strict by default. Estimated callers may explicitly request
 * nearest-week or typical-kind assumptions; those windows never establish published hours. */
export function venueWindows(data: CampusData, location: string, kind: string | undefined, weekday: number,
  options: { estimatedFallback?: boolean } = {}): [number, number][] {
  const date = dateForWeekday(data, weekday);
  const hours = data.locations[location]?.hours ?? [];
  const selected = openingHoursForDate(hours, date, weekday);
  if (selected.length) return selected.flatMap((entry) => entry.windows);
  if (!options.estimatedFallback || data.locations[location]?.hoursStatus === 'restricted') return [];
  if (hours.length) return sameWeekdayWindows(hours, date, weekday);
  return typicalWindows(kind, weekday);
}
