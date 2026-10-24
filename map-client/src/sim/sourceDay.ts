import { dateForWeekday, WEEKDAYS, type CampusData, type SourceMeeting } from '../data/campusData';
import type { Agent, CampusLocation, DayData, Trip } from './playback';

const DAY = 86400;
const WALK_SPEED = 1.4;
const HOME_BREAK = 15 * 60;

type Route = { path: [number, number][]; cumulative: number[] };
interface Stop {
  location: string;
  start: number;
  end: number;
  meeting?: SourceMeeting;
  attendanceLimit?: number;
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
  assumptions: string[];
}

export interface SourceDay extends DayData {
  sourceStats: SourceDayStats;
  sourceAssignments: SourceAssignment[];
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

/** Use source times for a fictional cohort; published seats never become attendance. */
export function buildSourceDay(base: DayData, data: CampusData, weekday: number): SourceDay {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Weekday must be Monday=0 through Sunday=6');
  const locations = new Map(base.locations.map((location) => [location.id, location]));
  for (const agent of base.agents) {
    if (!locations.has(agent.home)) throw new Error(`Student ${agent.id} has an unknown home ${agent.home}`);
  }
  const stats: SourceDayStats = {
    eligibleMeetings: 0, assignedClasses: 0, scheduledStudents: 0, skippedCalendar: 0,
    sharedCandidatesSuppressed: 0, unroutableCandidates: 0, unroutableTrips: 0, invalidRoutes: 0, composedRoutes: 0, composedTrips: 0, capacityLimitedCandidates: 0,
    assumptions: [
      'Students and attendance are synthetic; published classes supply places and fixed times, not enrollment.',
      'Each student keeps its demo home and selects up to three feasible published classes.',
      'Walking uses bundled pedestrian routes at an assumed 1.4 m/s; missing direct pairs may concatenate compatible existing routes.',
      'Synthetic attendance is bounded by published room seats; an unknown room uses a conservative 24-student model limit. These limits do not establish enrollment.',
      'Meals, study, and gym visits use illustrative preferences. Undated hours are not treated as verified opening hours.',
      'Date-limited class notes require review and are excluded from representative-week expansion.',
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
  const duration = (from: string, to: string): number => {
    if (from === to) return 0;
    const route = routeBetween(from, to);
    return route ? route.cumulative[route.cumulative.length - 1] / WALK_SPEED : Infinity;
  };
  const date = dateForWeekday(data, weekday);
  const isOpen = (locationId: string, start: number, end: number): boolean => {
    const hours = data.locations[locationId]?.hours.filter((entry) => entry.date === date) ?? [];
    if (!hours.length) return true;
    return hours.some((entry) => entry.windows.some(([opens, closes]) => opens <= start && end <= closes));
  };

  const allCandidates: Stop[] = [];
  const candidateKeys = new Map<string, Stop>();
  const orderedLocations = Object.values(data.locations).sort((a, b) => a.id.localeCompare(b.id));
  for (const source of orderedLocations) {
    if (!locations.has(source.id)) continue;
    for (const meeting of [...source.meetings].sort((a, b) => a.id.localeCompare(b.id))) {
      const intervals = meeting.intervals.filter((interval) => interval.weekday === weekday);
      if (meeting.calendarRestricted) {
        if (intervals.length) stats.skippedCalendar++;
        continue;
      }
      for (const interval of intervals) {
        const start = interval.startSec - weekday * DAY, end = interval.endSec - weekday * DAY;
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end > DAY) continue;
        const key = `${meeting.sharedKey ?? meeting.id}:${start}:${end}`;
        if (candidateKeys.has(key)) {
          stats.sharedCandidatesSuppressed++;
          const existing = candidateKeys.get(key)!;
          const limit = Number.isFinite(meeting.roomCapacity) && meeting.roomCapacity !== null ? Math.max(0, Math.floor(meeting.roomCapacity)) : 24;
          existing.attendanceLimit = Math.min(existing.attendanceLimit!, limit);
          continue;
        }
        const attendanceLimit = Number.isFinite(meeting.roomCapacity) && meeting.roomCapacity !== null ? Math.max(0, Math.floor(meeting.roomCapacity)) : 24;
        const candidate = { location: source.id, start, end, meeting, attendanceLimit };
        candidateKeys.set(key, candidate);
        allCandidates.push(candidate);
      }
    }
  }
  stats.eligibleMeetings = allCandidates.length;
  const byCampus = new Map<string, Stop[]>();
  for (const candidate of allCandidates) {
    const campus = campusOf(locations.get(candidate.location)!);
    const list = byCampus.get(campus) ?? [];
    list.push(candidate);
    byCampus.set(campus, list);
  }
  const trips: Trip[] = [];
  const assignments: SourceAssignment[] = [];

  function feasible(stops: Stop[], home: string): boolean {
    let from = home, freeAt = 0;
    for (const stop of stops) {
      const travel = duration(from, stop.location);
      if (!Number.isFinite(travel)) {
        stats.unroutableCandidates++;
        return false;
      }
      if (freeAt + travel > stop.start || !isOpen(stop.location, stop.start, stop.end)) return false;
      from = stop.location;
      freeAt = stop.end;
    }
    return freeAt + duration(from, home) <= DAY;
  }

  function travel(agent: Agent, from: string, to: string, depart: number): number {
    if (from === to) return depart;
    const route = routeBetween(from, to);
    if (!route) {
      stats.unroutableTrips++;
      return Infinity;
    }
    const timestamps = route.cumulative.map((distance) => depart + distance / WALK_SPEED);
    if (depart < 0 || timestamps[timestamps.length - 1] > DAY) {
      stats.unroutableTrips++;
      return Infinity;
    }
    if (composed.has(`${from}>${to}`)) stats.composedTrips++;
    trips.push({ agent: agent.id, from, to, path: route.path, timestamps });
    return timestamps[timestamps.length - 1];
  }

  const attendance = new Map<Stop, number>();
  const planningOrder = [...base.agents].sort((a, b) => fraction(`attendance:${weekday}:${a.id}`) - fraction(`attendance:${weekday}:${b.id}`) || a.id.localeCompare(b.id));
  for (const agent of planningOrder) {
    const home = locations.get(agent.home)!;
    const seed = `source-day-v1:${agent.id}:${weekday}`;
    const candidates = (byCampus.get(campusOf(home)) ?? [])
      .map((candidate) => ({ candidate, rank: fraction(`${seed}:class:${candidate.meeting!.id}`) }))
      .sort((a, b) => a.rank - b.rank || a.candidate.meeting!.id.localeCompare(b.candidate.meeting!.id));
    let stops: Stop[] = [];
    const courses = new Set<string>();
    const classLimit = 2 + Math.floor(fraction(`${seed}:class-count`) * 2);
    for (const { candidate } of candidates) {
      if (courses.has(candidate.meeting!.courseCode)) continue;
      if ((attendance.get(candidate) ?? 0) >= candidate.attendanceLimit!) { stats.capacityLimitedCandidates++; continue; }
      const proposed = [...stops, candidate].sort((a, b) => a.start - b.start || a.location.localeCompare(b.location));
      if (!feasible(proposed, agent.home)) continue;
      stops = proposed;
      courses.add(candidate.meeting!.courseCode);
      attendance.set(candidate, (attendance.get(candidate) ?? 0) + 1);
      if (courses.size >= classLimit) break;
    }
    if (stops.length) stats.scheduledStudents++;
    for (const stop of stops) {
      assignments.push({ agentId: agent.id, meetingId: stop.meeting!.id, courseCode: stop.meeting!.courseCode,
        locationId: stop.location, startSec: stop.start, endSec: stop.end });
      stats.assignedClasses++;
    }

    const optional: { name: string; kind: CampusLocation['kind']; start: number; duration: number; probability: number }[] = [
      { name: 'lunch', kind: 'dining', start: 12 * 3600, duration: 30 * 60, probability: 1 },
      { name: 'study', kind: 'library', start: 15 * 3600, duration: 60 * 60, probability: 0.65 },
      { name: 'dinner', kind: 'dining', start: 18 * 3600, duration: 35 * 60, probability: 1 },
      { name: 'gym', kind: 'gym', start: 19.5 * 3600, duration: 45 * 60, probability: 0.25 },
    ];
    for (const activity of optional) {
      if (fraction(`${seed}:${activity.name}:attendance`) >= activity.probability) continue;
      const start = activity.start + Math.floor((fraction(`${seed}:${activity.name}:time`) - 0.5) * 40 * 60);
      const choices = base.locations.filter((location) => location.kind === activity.kind && campusOf(location) === campusOf(home))
        .map((location) => ({ location, rank: fraction(`${seed}:${activity.name}:${location.id}`) }))
        .sort((a, b) => a.rank - b.rank || a.location.id.localeCompare(b.location.id));
      for (const { location } of choices) {
        const stop: Stop = { location: location.id, start, end: start + activity.duration };
        const proposed = [...stops, stop].sort((a, b) => a.start - b.start || a.location.localeCompare(b.location));
        if (feasible(proposed, agent.home)) {
          stops = proposed;
          break;
        }
      }
    }

    let from = agent.home, freeAt = 0;
    for (const stop of stops) {
      const viaHome = duration(from, agent.home) + duration(agent.home, stop.location);
      if (from !== agent.home && freeAt + viaHome + HOME_BREAK <= stop.start) {
        freeAt = travel(agent, from, agent.home, freeAt);
        from = agent.home;
      }
      const depart = stop.start - duration(from, stop.location);
      const arrival = travel(agent, from, stop.location, depart);
      if (!Number.isFinite(arrival)) break;
      from = stop.location;
      freeAt = stop.end;
    }
    if (from !== agent.home) travel(agent, from, agent.home, freeAt);
  }
  return { ...base, day: WEEKDAYS[weekday], trips, sourceStats: stats, sourceAssignments: assignments };
}
