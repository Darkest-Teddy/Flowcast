import { dateForWeekday, openingHoursForDate, WEEKDAYS, type CampusData, type SourceMeeting } from '../data/campusData';
import type { Agent, CampusLocation, DayData, Trip } from './playback';

const DAY = 86400;
const WALK_SPEED = 1.4;
const weeklyCache = new WeakMap<DayData, WeakMap<CampusData, (weekday: number) => SourceDay>>();
const HOME_BREAK = 15 * 60;
const OFF_CAMPUS_BREAK = 30 * 60;
export const MODELED_OFF_CAMPUS_MEAL_SHARE = 0.35;
const MAX_GATEWAY_WALK_METRES = 2000;
const ARRIVAL_LEAD = { minimum: 2 * 60, spread: 10 * 60 };
const RESIDENT_ACTIVITIES = [
  { kind: 'dining', at: 8, spread: 2, minutes: 25, probability: 0.45 },
  { kind: 'dining', at: 12, spread: 2, minutes: 35, probability: 0.75 },
  { kind: 'library', at: 14, spread: 5, minutes: 75, probability: 0.55 },
  { kind: 'dining', at: 18, spread: 3, minutes: 40, probability: 0.7 },
  { kind: 'gym', at: 17, spread: 5, minutes: 55, probability: 0.25 },
] as const;

type Route = { path: [number, number][]; cumulative: number[] };
interface Stop {
  location: string;
  start: number;
  end: number;
  meeting?: SourceMeeting;
  attendanceLimit?: number;
  activity?: 'dining' | 'library' | 'gym' | 'off-campus-meal';
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
  weeklyEnrolledStudents: number;
  weeklyEnrollments: number;
  unassignedStudents: number;
  eligibleWeeklySections: number;
  campusAccessTrips: number;
  modeledActivities: number;
  modeledOffCampusMeals: number;
  unavailableActivities: number;
  assumptions: string[];
}

export interface SourceActivity {
  agentId: string;
  locationId: string;
  startSec: number;
  endSec: number;
  kind: 'dining' | 'library' | 'gym' | 'off-campus-meal';
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
    composedRoutes: 0, composedTrips: 0, capacityLimitedCandidates: 0,
    weeklyEnrolledStudents: 0, weeklyEnrollments: 0, unassignedStudents: 0, eligibleWeeklySections: 0, campusAccessTrips: 0, modeledActivities: 0, modeledOffCampusMeals: 0, unavailableActivities: 0,
    assumptions: [
      'Enrollment is synthetic and fixed for the whole reference week; published classes supply places, times, and seat upper bounds, not actual enrollment.',
      'Modeled course loads are 1–2 for part-time students, 3–4 for full-time graduate students, and 4–5 for full-time undergraduates; only mapped, reachable, mutually feasible weekly sections are assigned. Linked lecture/lab requirements are unknown.',
      'Unknown room capacity uses a conservative 24-student cap; cross-listed shared occurrences share the same seat pool.',
      'Walking follows compatible bundled pedestrian routes at each student’s stable modeled speed (default 1.4 m/s).',
      'Campus gateway access walks are capped at 2 km; sections requiring longer or unavailable gateway paths are not assigned when campus gateway data exist.',
      'Off-campus students use a stable modeled campus gateway on saved transit-stop walking geometry; only the campus access leg is shown, not an observed commute or transit boarding. Arrival leads vary by 2–12 minutes.',
      'Mapped residents may take probability-bounded modeled meal, study, and gym trips, including weekends; these are synthetic preferences, not observed attendance. Feasible home breaks and waits fill gaps.',
      'Off-campus students may leave via their gateway during a gap that permits access walks and at least 30 minutes off-campus; campus waiting remains modeled when a departure does not fit.',
      'Optional visits use published hours for the exact date (closures override), else the same weekday from the nearest published week, else typical hours for the venue kind. Undated hours do not imply availability. Published classes retain their own source times.',
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
  const accessRoute = (agent: Agent, location: string): Route | undefined => {
    const gate = gateFor(agent);
    if (!gate) return undefined;
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
  const accessDuration = (agent: Agent, location: string) => (accessRoute(agent, location)?.cumulative.at(-1) ?? (gateFor(agent) ? Infinity : 0)) / speed(agent);
  type WeeklyStop = Stop & { weekday: number; pool: string };
  type Section = { id: string; course: string; campus: string; stops: WeeklyStop[] };
  const sections = new Map<string, Section>();
  const limits = new Map<string, number>();
  const used = new Map<string, number>();
  const occurrences = new Set<string>();
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
  const isOpen = (stop: WeeklyStop) => !!stop.meeting || stop.location === 'off-campus'
    || optionalWindows(stop.location, stop.weekday).some(([opens, closes]) => opens <= stop.start && stop.end <= closes);
  for (const source of Object.values(data.locations).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!locations.has(source.id)) continue;
    for (const meeting of [...source.meetings].sort((a, b) => a.id.localeCompare(b.id))) {
      if (meeting.calendarRestricted) { stats.skippedCalendar++; continue; }
      const id = `${meeting.courseCode}:${meeting.section}`;
      const section = sections.get(id) ?? { id, course: meeting.courseCode, campus: campusOf(locations.get(source.id)!), stops: [] };
      for (const interval of meeting.intervals) {
        const weekday = interval.weekday, start = interval.startSec - weekday * DAY, end = interval.endSec - weekday * DAY;
        if (weekday < 0 || weekday > 6 || start < 0 || start >= end || end > DAY || !Number.isFinite(start + end)) continue;
        const pool = `${meeting.sharedKey ?? meeting.id}:${weekday}:${start}:${end}`;
        const limit = meeting.roomCapacity !== null && Number.isFinite(meeting.roomCapacity) ? Math.max(0, Math.floor(meeting.roomCapacity)) : 24;
        limits.set(pool, Math.min(limits.get(pool) ?? Infinity, limit));
        if (occurrences.has(pool)) stats.sharedCandidatesSuppressed++;
        occurrences.add(pool);
        if (!section.stops.some((stop) => stop.pool === pool)) section.stops.push({ location: source.id, start, end, weekday, meeting, pool });
      }
      if (section.stops.length) sections.set(id, section);
    }
  }
  // Cross-listed aliases with identical weekly occurrences represent one section.
  const signatures = new Set<string>();
  const byCampus = new Map<string, Section[]>();
  for (const section of sections.values()) {
    section.stops.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
    const signature = section.stops.map((stop) => stop.pool).sort().join('|');
    if (signatures.has(signature)) continue;
    signatures.add(signature);
    const list = byCampus.get(section.campus) ?? [];
    list.push(section); byCampus.set(section.campus, list);
  }
  stats.eligibleWeeklySections = signatures.size;
  function feasible(stops: WeeklyStop[], agent: Agent): boolean {
    let previous: WeeklyStop | undefined;
    for (const stop of stops) {
      if (!isOpen(stop)) return false;
      if (!previous || previous.weekday !== stop.weekday) {
        if (previous && previous.end + (offCampus(agent) ? accessDuration(agent, previous.location) : duration(previous.location, agent.home, agent)) > DAY) return false;
        if ((offCampus(agent) ? accessDuration(agent, stop.location) : duration(agent.home, stop.location, agent)) > stop.start) { stats.unroutableCandidates++; return false; }
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
    return !previous || previous.end + (offCampus(agent) ? accessDuration(agent, previous.location) : duration(previous.location, agent.home, agent)) <= DAY;
  }
  const enrollment = new Map<string, WeeklyStop[]>();
  const order = [...base.agents].sort((a, b) => fraction(`weekly:${a.id}`) - fraction(`weekly:${b.id}`) || a.id.localeCompare(b.id));
  for (const agent of order) {
    const campus = agent.campus ?? campusOf(locations.get(agent.home)!);
    const candidates = byCampus.get(campus) ?? [];
    let stops: WeeklyStop[] = [];
    const courses = new Set<string>();
    const profile = agent as Agent & { attendance?: string; studentLevel?: string };
    const minimum = profile.attendance === 'part-time' ? 1 : profile.studentLevel === 'graduate' ? 3 : 4;
    const target = minimum + Math.floor(fraction(`${agent.id}:course-count`) * 2);
    const tested = new Set<string>();
    const startIndex = Math.floor(fraction(`${agent.id}:weekly-start`) * candidates.length);
    const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
    let stride = 1 + Math.floor(fraction(`${agent.id}:weekly-stride`) * Math.max(1, candidates.length - 1));
    while (candidates.length && gcd(stride, candidates.length) !== 1) stride++;
    for (let attempt = 0; attempt < 96 && candidates.length && courses.size < target; attempt++) {
      const index = (startIndex + attempt * stride) % candidates.length;
      const section = candidates[index];
      if (section.stops.some((stop) => (used.get(stop.pool) ?? 0) >= limits.get(stop.pool)!)) {
        candidates[index] = candidates[candidates.length - 1]; candidates.pop();
        stats.capacityLimitedCandidates++; continue;
      }
      if (tested.has(section.id) || courses.has(section.course)) continue;
      tested.add(section.id);
      const proposed = [...stops, ...section.stops].sort((a, b) => a.weekday - b.weekday || a.start - b.start);
      if (!feasible(proposed, agent)) continue;
      stops = proposed; courses.add(section.course);
      for (const stop of section.stops) used.set(stop.pool, (used.get(stop.pool) ?? 0) + 1);
    }
    if (courses.size) stats.weeklyEnrolledStudents++;
    stats.weeklyEnrollments += courses.size;
    enrollment.set(agent.id, stops);
  }
  stats.unassignedStudents = base.agents.length - stats.weeklyEnrolledStudents;
  const days = new Map<number, SourceDay>();
  return (weekday) => {
    const cached = days.get(weekday);
    if (cached) return cached;
    const trips: Trip[] = [];
    const stays: { agent: string; location: string; start: number; end: number }[] = [];
    const assignments: SourceAssignment[] = [];
    const activities: SourceActivity[] = [];
    let composedTrips = 0, scheduledStudents = 0, campusAccessTrips = 0, modeledActivities = 0, modeledOffCampusMeals = 0, unavailableActivities = 0;
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
    for (const agent of base.agents) {
      let stops = enrollment.get(agent.id)!.filter((stop) => stop.weekday === weekday);
      const fixedClasses = stops.length;
      if (!offCampus(agent)) {
        for (const [index, activity] of RESIDENT_ACTIVITIES.entries()) {
          const seed = `${agent.id}:${weekday}:activity:${index}`;
          if (fraction(`${seed}:attend`) >= activity.probability) continue;
          const start = (activity.at + fraction(`${seed}:time`) * activity.spread) * 3600;
          const offCampusMeal = activity.kind === 'dining' && fraction(`${seed}:off-campus`) < MODELED_OFF_CAMPUS_MEAL_SHARE;
          if (offCampusMeal) {
            const stop: WeeklyStop = { location: 'off-campus', start, end: start + activity.minutes * 60, weekday, pool: '', activity: 'off-campus-meal' };
            const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
            if (accessRoute(agent, agent.home) && feasible(proposed, agent)) {
              stops = proposed; modeledActivities++; modeledOffCampusMeals++;
            } else unavailableActivities++;
            continue;
          }
          const candidates: { stop: WeeklyStop; proposed: WeeklyStop[]; weight: number }[] = [];
          for (const location of base.locations) {
            if (location.kind !== activity.kind || campusOf(location) !== campusOf(locations.get(agent.home)!)) continue;
            const stop: WeeklyStop = { location: location.id, start, end: start + activity.minutes * 60, weekday, pool: '', activity: activity.kind };
            if (!isOpen(stop)) continue;
            const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
            if (!feasible(proposed, agent)) continue;
            const index = proposed.indexOf(stop);
            const origin = proposed[index - 1]?.location ?? agent.home;
            const destination = proposed[index + 1]?.location ?? agent.home;
            const travelTime = duration(origin, location.id, agent) + duration(location.id, destination, agent);
            candidates.push({ stop, proposed, weight: Math.sqrt(Math.max(1, location.capacity)) / (300 + travelTime) });
          }
          const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
          let choice = fraction(`${seed}:venue`) * totalWeight;
          const selected = candidates.find(candidate => { choice -= candidate.weight; return choice < 0; });
          if (selected) { stops = selected.proposed; modeledActivities++; }
          else unavailableActivities++;
        }
      }
      const home = offCampus(agent) ? 'off-campus' : agent.home;
      if (!stops.length) { stay(agent, home, 0, DAY); continue; }
      if (fixedClasses) scheduledStudents++;
      let from = home, freeAt = 0;
      for (const stop of stops) {
        if (home === 'off-campus' && from !== 'off-campus' && accessRoute(agent, from) && accessRoute(agent, stop.location)
          && freeAt + accessDuration(agent, from) + accessDuration(agent, stop.location) + OFF_CAMPUS_BREAK <= stop.start) {
          freeAt = travel(agent, from, 'off-campus', freeAt); from = 'off-campus';
        }
        if (from === 'off-campus' && home !== 'off-campus'
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
          const viaHome = home === 'off-campus' ? Infinity : duration(from, home, agent) + duration(home, stop.location, agent);
          if (from !== home && freeAt + viaHome + HOME_BREAK <= stop.start) {
            freeAt = travel(agent, from, home, freeAt); from = home;
          }
          const depart = stop.start - duration(from, stop.location, agent);
          stay(agent, from, freeAt, depart);
          travel(agent, from, stop.location, depart);
        }
        stay(agent, stop.location, stop.start, stop.end);
        if (stop.meeting) assignments.push({ agentId: agent.id, meetingId: stop.meeting!.id, courseCode: stop.meeting!.courseCode,
          locationId: stop.location, startSec: stop.start, endSec: stop.end });
        if (stop.activity) activities.push({ agentId: agent.id, locationId: stop.location, startSec: stop.start, endSec: stop.end, kind: stop.activity });
        from = stop.location; freeAt = stop.end;
      }
      if (home !== 'off-campus' || accessRoute(agent, from)) freeAt = travel(agent, from, home, freeAt);
      stay(agent, home, freeAt, DAY);
    }
    const result: SourceDay = { ...base, day: WEEKDAYS[weekday], trips, stays,
      sourceStats: { ...stats, eligibleMeetings: [...occurrences].filter((key) => Number(key.split(':').at(-3)) === weekday).length,
        assignedClasses: assignments.length, scheduledStudents, composedTrips, campusAccessTrips, modeledActivities, modeledOffCampusMeals, unavailableActivities }, sourceAssignments: assignments, sourceActivities: activities };
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

/**
 * When a venue is open on a reference-week day (seconds since midnight), for optional visits.
 * 1. Published hours for that exact date (a dated closure means closed).
 * 2. Otherwise the same weekday's published hours from the nearest dated week: dining menus were
 *    scraped for Oct 24-30 while the reference week is Oct 19-25.
 * 3. A venue with no published hours at all gets typical hours for its kind.
 * Restricted venues are handled by the caller.
 */
export function venueWindows(data: CampusData, location: string, kind: string | undefined, weekday: number): [number, number][] {
  const date = dateForWeekday(data, weekday);
  const hours = data.locations[location]?.hours ?? [];
  const selected = openingHoursForDate(hours, date, weekday);
  if (selected.length) return selected.flatMap((entry) => entry.windows);
  if (hours.length) return sameWeekdayWindows(hours, date, weekday);
  return typicalWindows(kind, weekday);
}
