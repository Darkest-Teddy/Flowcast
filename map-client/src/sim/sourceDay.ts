import { dateForWeekday, meetingActiveOnDate, openingHoursForDate, WEEKDAYS, type CampusData, type SourceMeeting } from '../data/campusData';
import { courseLevel, countsTowardDegreeLoad, eligibleStudentLevels } from './courseEligibility';
import type { Agent, CampusLocation, DayData, EstimatedActivityProfile, Trip } from './playback';

const DAY = 86400;
const WALK_SPEED = 1.4;
const weeklyCache = new WeakMap<DayData, WeakMap<CampusData, (weekday: number) => SourceDay>>();
const HOME_BREAK = 15 * 60;
const OFF_CAMPUS_BREAK = 30 * 60;
export const MODELED_OFF_CAMPUS_MEAL_SHARE = 0.35;
const MAX_GATEWAY_WALK_METRES = 2000;
const OPTIONAL_CAPACITY_BUCKET_SECONDS = 60;
const SOURCE_COVERED_ESTIMATED_ACTIVITY_FACTOR = 0.15;
const ESTIMATED_TIME_ATTEMPTS = 3;
const COURSE_CANDIDATE_ATTEMPTS = 96;
const AFFINITY_ATTEMPT_SHARE = 0.65;
const ARRIVAL_LEAD = { minimum: 2 * 60, spread: 10 * 60 };
const RESIDENT_ACTIVITIES = [
  { kind: 'dining', at: 8, spread: 2, minutes: 25, probability: 0.45 },
  { kind: 'dining', at: 12, spread: 2, minutes: 35, probability: 0.75 },
  { kind: 'library', at: 14, spread: 5, minutes: 75, probability: 0.55 },
  { kind: 'dining', at: 18, spread: 3, minutes: 40, probability: 0.7 },
  { kind: 'gym', at: 17, spread: 5, minutes: 55, probability: 0.25 },
] as const;

const estimatedProfile = (location: CampusLocation): EstimatedActivityProfile | undefined => location.estimatedProfile;

type Route = { path: [number, number][]; cumulative: number[] };
interface Stop {
  location: string;
  start: number;
  end: number;
  meeting?: SourceMeeting;
  attendanceLimit?: number;
  activity?: 'dining' | 'library' | 'gym' | 'off-campus-meal' | 'estimated';
  estimatedProfile?: EstimatedActivityProfile;
}

export interface SourceAssignment {
  agentId: string;
  meetingId: string;
  courseCode: string;
  locationId: string;
  startSec: number;
  endSec: number;
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
  estimatedLocationCounts: Record<string, number>;
  assumptions: string[];
}

export interface SourceActivity {
  agentId: string;
  locationId: string;
  startSec: number;
  endSec: number;
  kind: 'dining' | 'library' | 'gym' | 'off-campus-meal' | 'estimated';
  estimated?: true;
  purpose?: EstimatedActivityProfile['purpose'];
  basis?: string;
  confidence?: 'low';
  note?: string;
  proxy?: string;
}

export interface SourceDay extends DayData {
  sourceStats: SourceDayStats;
  sourceAssignments: SourceAssignment[];
  sourceActivities: SourceActivity[];
}

function fraction(key: string): number {
  let value = 2166136261;
  for (let index = 0; index < key.length; index++) value = Math.imul(value ^ key.charCodeAt(index), 16777619);
  return (value >>> 0) / 4294967296;
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

/** Cached synthetic weekly enrollment; source seats are upper bounds, never actual enrollment. */
export function buildSourceDay(base: DayData, data: CampusData, weekday: number): SourceDay {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Weekday must be Monday=0 through Sunday=6');
  let cache = weeklyCache.get(base);
  if (!cache) { cache = new WeakMap(); weeklyCache.set(base, cache); }
  let makeDay = cache.get(data);
  if (!makeDay) { makeDay = buildWeek(base, data); cache.set(data, makeDay); }
  return makeDay(weekday);
}

function buildWeek(base: DayData, data: CampusData): (weekday: number) => SourceDay {
  const locations = new Map(base.locations.map((location) => [location.id, location]));
  for (const agent of base.agents) {
    if (agent.home !== 'off-campus' && !locations.has(agent.home)) throw new Error(`Student ${agent.id} has an unknown home ${agent.home}`);
  }
  const stats: SourceDayStats = {
    eligibleMeetings: 0, assignedClasses: 0, scheduledStudents: 0, skippedCalendar: 0,
    sharedCandidatesSuppressed: 0, unroutableCandidates: 0, unroutableTrips: 0, invalidRoutes: 0,
    composedRoutes: 0, composedTrips: 0, capacityLimitedCandidates: 0, roomCapacityLimitedCandidates: 0, excludedNonDegreeSections: 0, affinityCourseEnrollments: 0,
    weeklyEnrolledStudents: 0, weeklyEnrollments: 0, unassignedStudents: 0, eligibleWeeklySections: 0, campusAccessTrips: 0, modeledActivities: 0, modeledOffCampusMeals: 0, unavailableActivities: 0, optionalCapacityRejected: 0, estimatedActivities: 0, estimatedLocationCounts: {},
    assumptions: [
      'Enrollment is synthetic and fixed for the whole reference week; published classes supply places, times, and seat upper bounds, not actual enrollment.',
      'Default course eligibility follows BU’s published numeric guide: 100–399 undergraduate, 400–599 undergraduate/graduate, 600–999 graduate; MED MD and graduate-school prefixes use graduate defaults. This is not a prerequisite or individual-permission checker.',
      'Nondegree 0xx and PDP offerings remain visible in source data but are omitted from modeled degree-course enrollment; noncredit attendance is unknown.',
      'Each student has a stable synthetic school affinity weighted by eligible section seats. The planner prefers that school for target minus one courses, allowing cross-school electives and feasible fallback. This is a model preference, not an observed major.',
      'Modeled course loads are 1–2 for part-time students, 3–4 for full-time graduate students, and 4–5 for full-time undergraduates; only mapped, reachable, mutually feasible weekly sections are assigned. Linked lecture/lab requirements are unknown.',
      'Concurrent published meetings share one physical building-code/room-code seat pool, including partial time overlaps. Conflicting catalog entries reduce modeled attendance rather than shifting source times or enlarging room capacity.',
      'Unknown room capacity uses a conservative 24-student cap; cross-listed shared occurrences share the same seat pool.',
      'Walking follows compatible bundled pedestrian routes at each student’s stable modeled speed (default 1.4 m/s).',
      'Campus gateway access walks are capped at 2 km; sections requiring longer or unavailable gateway paths are not assigned when campus gateway data exist.',
      'Off-campus students prefer a stable modeled campus gateway, using a compatible saved gateway when the preferred path is unavailable or over 2 km; only the campus access leg is shown, not an observed commute or transit boarding. Arrival leads vary by 2–12 minutes.',
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
  const routes = new Map<string, Route>();
  const adjacent = new Map<string, { to: string; route: Route }[]>();
  const endpoints = new Map<string, [number, number]>();
  const near = (a: [number, number], b: [number, number]) => Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111320) <= 1;
  for (const [key, route] of Object.entries(base.walkRoutes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const [from, to] = key.split('>');
    const origin = locations.get(from), destination = locations.get(to);
    if (!origin || !destination || campusOf(origin) !== campusOf(destination) || !validRoute(route)
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
    if (!origin || !destination || campusOf(origin) !== campusOf(destination)) return undefined;
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
      ? accessRoute(agent, from === 'off-campus' ? to : from) : routeBetween(from, to);
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
  const gateFor = (agent: Agent): string | undefined => {
    const gates = gatesByCampus.get(agent.campus ?? (locations.has(agent.home) ? campusOf(locations.get(agent.home)!) : 'charles-river')) ?? [];
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
  const accessRoute = (agent: Agent, location: string): Route | undefined => {
    const preferred = gateFor(agent);
    if (!preferred) return undefined;
    const key = `${preferred}>${location}`;
    if (accessCache.has(key)) return accessCache.get(key);
    let route = routeFromGate(preferred, location);
    if (!route) {
      const target = locations.get(location);
      const campus = agent.campus ?? (locations.has(agent.home) ? campusOf(locations.get(agent.home)!) : 'charles-river');
      if (target && campusOf(target) === campus) for (const gate of gatesByCampus.get(campus) ?? []) {
        if (gate === preferred) continue;
        const alternative = routeFromGate(gate, location);
        if (alternative && (!route || alternative.cumulative.at(-1)! < route.cumulative.at(-1)!)) route = alternative;
      }
    }
    accessCache.set(key, route); return route;
  };
  const accessDuration = (agent: Agent, location: string) => (accessRoute(agent, location)?.cumulative.at(-1) ?? (gateFor(agent) ? Infinity : 0)) / speed(agent);
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
  for (const source of Object.values(data.locations).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!locations.has(source.id)) continue;
    for (const meeting of [...source.meetings].sort((a, b) => a.id.localeCompare(b.id))) {
      if (meeting.calendarRestricted) { stats.skippedCalendar++; continue; }
      const id = meeting.sourceSectionKey ?? `${meeting.courseCode}:${meeting.section}`;
      if (!countsTowardDegreeLoad(meeting.courseCode)) { excludedNonDegree.add(id); continue; }
      const section: Section = sections.get(id) ?? { id, course: meeting.courseCode, campus: campusOf(locations.get(source.id)!), stops: [], aliases: [] };
      for (const interval of meeting.intervals) {
        if (!meetingActiveOnDate(meeting, dates[interval.weekday])) continue;
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
  const byCampus = new Map<string, Section[]>();
  for (const section of sections.values()) {
    section.stops.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
    const signature = section.stops.map((stop) => stop.pool).sort().join('|');
    const canonical = signatures.get(signature);
    if (canonical) { canonical.aliases.push(section); continue; }
    section.aliases = [section]; signatures.set(signature, section);
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
        if (previous && previous.end + (previous.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, previous.location) : duration(previous.location, agent.home, agent)) > DAY) return false;
        if ((stop.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, stop.location) : duration(agent.home, stop.location, agent)) > stop.start) { stats.unroutableCandidates++; return false; }
      } else {
        const walk = duration(previous.location, stop.location, agent);
        if (!Number.isFinite(walk)) stats.unroutableCandidates++;
        if (previous.end + walk > stop.start) return false;
        if (!previous.meeting && previous.location !== 'off-campus') {
          const homeTime = offCampus(agent) ? Infinity : duration(previous.location, agent.home, agent) + duration(agent.home, stop.location, agent) + HOME_BREAK;
          if (previous.end + homeTime > stop.start && !isOpen({ ...previous, end: stop.start - walk })) return false;
        }
      }
      previous = stop;
    }
    return !previous || previous.end + (previous.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, previous.location) : duration(previous.location, agent.home, agent)) <= DAY;
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
  const enrollment = new Map<string, WeeklyStop[]>();
  const fullSections = new Set<Section>();
  const order = [...base.agents].sort((a, b) => fraction(`weekly:${a.id}`) - fraction(`weekly:${b.id}`) || a.id.localeCompare(b.id));
  for (const agent of order) {
    const campus = agent.campus ?? campusOf(locations.get(agent.home)!);
    const index = indexFor(campus, agent.studentLevel);
    let schoolChoice = fraction(`${agent.id}:academic-affinity`) * index.weights.reduce((sum, [, weight]) => sum + weight, 0);
    const affinity = index.weights.find(([, weight]) => { schoolChoice -= weight; return schoolChoice < 0; })?.[0] ?? 'unknown';
    let stops: WeeklyStop[] = [];
    const courses = new Set<string>();
    let courseCount = 0, attempts = 0;
    const minimum = agent.attendance === 'part-time' ? 1 : agent.studentLevel === 'graduate' ? 3 : 4;
    const target = minimum + Math.floor(fraction(`${agent.id}:course-count`) * 2);
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
        const proposed = [...stops, ...alias.stops].sort((a, b) => a.weekday - b.weekday || a.start - b.start);
        if (!feasible(proposed, agent)) continue;
        stops = proposed; courseCount++;
        for (const other of section.aliases) courses.add(other.course);
        if (schoolOf(alias.course) === affinity) stats.affinityCourseEnrollments++;
        for (const stop of alias.stops) {
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
  function presenceKeys(agent: Agent, stops: WeeklyStop[]): Set<number> {
    const keys = new Set<number>();
    const add = (location: string, start: number, end: number) => {
      const index = resourceIndex.get(location);
      if (index === undefined || end <= start) return;
      for (let minute = Math.floor(start / OPTIONAL_CAPACITY_BUCKET_SECONDS); minute < Math.ceil(end / OPTIONAL_CAPACITY_BUCKET_SECONDS); minute++) {
        keys.add(index * bucketsPerDay + minute);
      }
    };
    const home = offCampus(agent) ? 'off-campus' : agent.home;
    let from = home, freeAt = 0;
    for (const stop of stops) {
      if (home === 'off-campus' && from !== 'off-campus' && stop.location === 'off-campus' && accessRoute(agent, from)) {
        freeAt += accessDuration(agent, from); from = 'off-campus';
      }
      if (home === 'off-campus' && from !== 'off-campus' && accessRoute(agent, from) && accessRoute(agent, stop.location)
        && freeAt + accessDuration(agent, from) + accessDuration(agent, stop.location) + OFF_CAMPUS_BREAK <= stop.start) {
        freeAt += accessDuration(agent, from); from = 'off-campus';
      }
      if (from !== home && home !== 'off-campus'
        && freeAt + duration(from, home, agent) + duration(home, stop.location, agent) + HOME_BREAK <= stop.start) {
        freeAt += duration(from, home, agent); from = home;
      }
      if (from === stop.location) add(from, freeAt, stop.start);
      else if (from === 'off-campus') {
        const walk = accessDuration(agent, stop.location);
        const lead = stop.meeting ? Math.min(stop.start - walk, ARRIVAL_LEAD.minimum + fraction(`${agent.id}:${stop.weekday}:arrival-lead`) * ARRIVAL_LEAD.spread) : 0;
        if (accessRoute(agent, stop.location)) add(stop.location, Math.max(freeAt, stop.start - walk - lead) + walk, stop.start);
      } else add(from, freeAt, stop.start - duration(from, stop.location, agent));
      add(stop.location, stop.start, stop.end);
      from = stop.location; freeAt = stop.end;
    }
    return keys;
  }
  const days = new Map<number, SourceDay>();
  return (weekday) => {
    const cached = days.get(weekday);
    if (cached) return cached;
    const trips: Trip[] = [];
    const stays: { agent: string; location: string; start: number; end: number }[] = [];
    const assignments: SourceAssignment[] = [];
    const activities: SourceActivity[] = [];
    let composedTrips = 0, scheduledStudents = 0, campusAccessTrips = 0, modeledActivities = 0, modeledOffCampusMeals = 0, unavailableActivities = 0, optionalCapacityRejected = 0, estimatedActivities = 0;
    const estimatedLocationCounts: Record<string, number> = {};
    const stay = (agent: Agent, location: string, start: number, end: number) => {
      if (end > start) stays.push({ agent: agent.id, location, start, end });
    };
    const travel = (agent: Agent, from: string, to: string, depart: number): number => {
      if (from === to) return depart;
      let route: Route;
      if (from === 'off-campus' || to === 'off-campus') {
        const inward = accessRoute(agent, from === 'off-campus' ? to : from)!;
        if (from === 'off-campus') route = inward;
        else { const length = inward.cumulative.at(-1)!; route = { path: [...inward.path].reverse(), cumulative: [...inward.cumulative].reverse().map(d => length - d) }; }
        campusAccessTrips++;
      } else route = routeBetween(from, to)!;
      const timestamps = route.cumulative.map((distance) => depart + distance / speed(agent));
      if (composed.has(`${from}>${to}`)) composedTrips++;
      trips.push({ agent: agent.id, from, to, path: route.path, timestamps });
      return timestamps[timestamps.length - 1];
    };
    const capacityLedger = new Int32Array(resourceLocations.length * bucketsPerDay);
    const baselinePresence = new Map<string, Set<number>>();
    for (const agent of base.agents) {
      const keys = presenceKeys(agent, enrollment.get(agent.id)!.filter(stop => stop.weekday === weekday));
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
      const capacityFor = (proposed: WeeklyStop[]): Set<number> | undefined => {
        const keys = presenceKeys(agent, proposed);
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
      const classStart = stops[0]?.start ?? DAY;
      const classEnd = stops.at(-1)?.end ?? 0;
      const estimates: { proposed: WeeklyStop[]; keys: Set<number>; location: string; weight: number }[] = [];
      const sourceCovered = enrollment.get(agent.id)!.length > 0;
      for (const location of base.locations) {
        const profile = estimatedProfile(location);
        if (!profile || campusOf(location) !== campus || (profile.studentLevel !== 'any' && agent.studentLevel !== profile.studentLevel)
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
          const keys = capacityFor(proposed);
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
        reserve(estimate.keys); stops = estimate.proposed; estimatedActivities++; modeledActivities++;
        estimatedLocationCounts[estimate.location] = (estimatedLocationCounts[estimate.location] ?? 0) + 1;
      }
      if (resident || fixedClasses > 1) {
        for (const [index, activity] of RESIDENT_ACTIVITIES.entries()) {
          const seed = `${agent.id}:${weekday}:activity:${index}`;
          if (fraction(`${seed}:attend`) >= activity.probability) continue;
          const start = (activity.at + fraction(`${seed}:time`) * activity.spread) * 3600;
          if (!resident && (start < classStart || start + activity.minutes * 60 > classEnd)) continue;
          const offCampusMeal = activity.kind === 'dining' && fraction(`${seed}:off-campus`) < MODELED_OFF_CAMPUS_MEAL_SHARE;
          if (offCampusMeal) {
            const stop: WeeklyStop = { location: 'off-campus', start, end: start + activity.minutes * 60, weekday, pool: '', activity: 'off-campus-meal' };
            const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
            const keys = (agent.home === 'off-campus' || accessRoute(agent, agent.home)) && feasible(proposed, agent) ? capacityFor(proposed) : undefined;
            if (keys) {
              reserve(keys); stops = proposed; modeledActivities++; modeledOffCampusMeals++;
            } else unavailableActivities++;
            continue;
          }
          const candidates: { stop: WeeklyStop; proposed: WeeklyStop[]; weight: number; keys: Set<number> }[] = [];
          for (const location of base.locations) {
            if (location.kind !== activity.kind || campusOf(location) !== campus) continue;
            const stop: WeeklyStop = { location: location.id, start, end: start + activity.minutes * 60, weekday, pool: '', activity: activity.kind };
            if (!isOpen(stop)) continue;
            const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
            if (!feasible(proposed, agent)) continue;
            const keys = capacityFor(proposed);
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
          if (selected) { reserve(selected.keys); stops = selected.proposed; modeledActivities++; }
          else unavailableActivities++;
        }
      }
      const home = offCampus(agent) ? 'off-campus' : agent.home;
      if (!stops.length) { stay(agent, home, 0, DAY); continue; }
      if (fixedClasses) scheduledStudents++;
      let from = home, freeAt = 0;
      for (const stop of stops) {
        if (home === 'off-campus' && from !== 'off-campus' && stop.location === 'off-campus' && accessRoute(agent, from)) {
          freeAt = travel(agent, from, 'off-campus', freeAt); from = 'off-campus';
        }
        if (home === 'off-campus' && from !== 'off-campus' && accessRoute(agent, from) && accessRoute(agent, stop.location)
          && freeAt + accessDuration(agent, from) + accessDuration(agent, stop.location) + OFF_CAMPUS_BREAK <= stop.start) {
          freeAt = travel(agent, from, 'off-campus', freeAt); from = 'off-campus';
        }
        if (from !== home && home !== 'off-campus'
          && freeAt + duration(from, home, agent) + duration(home, stop.location, agent) + HOME_BREAK <= stop.start) {
          freeAt = travel(agent, from, home, freeAt); from = home;
        }
        if (from === stop.location) stay(agent, from, freeAt, stop.start);
        else if (from === 'off-campus') {
          const access = accessRoute(agent, stop.location);
          const walk = accessDuration(agent, stop.location);
          const lead = stop.meeting ? Math.min(stop.start - walk, ARRIVAL_LEAD.minimum + fraction(`${agent.id}:${weekday}:arrival-lead`) * ARRIVAL_LEAD.spread) : 0;
          const depart = Math.max(freeAt, stop.start - walk - lead);
          if (access) {
            stay(agent, from, freeAt, depart);
            const arrived = travel(agent, from, stop.location, depart);
            stay(agent, stop.location, arrived, stop.start);
          } else stay(agent, from, freeAt, stop.start);
        } else {
          const depart = stop.start - duration(from, stop.location, agent);
          stay(agent, from, freeAt, depart);
          travel(agent, from, stop.location, depart);
        }
        stay(agent, stop.location, stop.start, stop.end);
        if (stop.meeting) assignments.push({ agentId: agent.id, meetingId: stop.meeting!.id, courseCode: stop.meeting!.courseCode,
          locationId: stop.location, startSec: stop.start, endSec: stop.end });
        if (stop.activity) activities.push({ agentId: agent.id, locationId: stop.location, startSec: stop.start, endSec: stop.end, kind: stop.activity,
          ...(stop.estimatedProfile ? { estimated: true as const, purpose: stop.estimatedProfile.purpose, basis: stop.estimatedProfile.basis,
            confidence: stop.estimatedProfile.confidence, note: stop.estimatedProfile.note, proxy: stop.estimatedProfile.proxy } : {}) });
        from = stop.location; freeAt = stop.end;
      }
      if (home !== 'off-campus' || accessRoute(agent, from)) freeAt = travel(agent, from, home, freeAt);
      stay(agent, home, freeAt, DAY);
    }
    const result: SourceDay = { ...base, day: WEEKDAYS[weekday], trips, stays,
      sourceStats: { ...stats, eligibleMeetings: [...occurrences].filter((key) => Number(key.split(':').at(-3)) === weekday).length,
        assignedClasses: assignments.length, scheduledStudents, composedTrips, campusAccessTrips, modeledActivities, modeledOffCampusMeals, unavailableActivities, optionalCapacityRejected, estimatedActivities, estimatedLocationCounts }, sourceAssignments: assignments, sourceActivities: activities };
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
