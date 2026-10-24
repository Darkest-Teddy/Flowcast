// Published MBTA service at the campus gateway stops, indexed for the student planner.
//
// The planner uses this to put commuting students on real scheduled trips: inbound riders step
// off a trip at its published arrival time, and outbound riders wait at the stop for the next
// published departure. Times come from the saved GTFS timetable (transit-schedule.json); no
// headway, trip or stop is invented. The BU Shuttle has no machine-readable timetable, so it is
// not part of this service.
import type { PublishedScheduleData } from '../transit/publishedSchedule';

const DAY = 86400;

/**
 * Share of commuting students who arrive by public transit. Boston University's Charles River
 * Campus Institutional Master Plan 2013-2023 (Section 8.4, BU statistics from December 2010)
 * reports 31.5% of commuters to the campus, employees and students together, travelling by
 * public transportation. It is the only published BU mode split we have; it is not a
 * student-only or per-campus measurement, so it is an explicit model parameter.
 */
export const TRANSIT_COMMUTER_SHARE = 0.315;
export const TRANSIT_SHARE_SOURCE = 'https://www.bu.edu/community/files/2012/09/BU-IMP-1-17-13.pdf';
/** Seconds from a vehicle's published arrival until the rider starts walking from the stop. */
export const ALIGHT_SECONDS = 30;
/** Longest modeled wait at a stop for the published departure home. */
export const MAX_STOP_WAIT_SECONDS = 30 * 60;
/** An inbound rider will not take a trip arriving earlier than this before they need to leave the stop. */
export const MAX_EARLY_ARRIVAL_SECONDS = 60 * 60;
/** A route direction needs at least this many published trips a week at a stop to be someone's commute. */
export const MIN_WEEKLY_TRIPS = 35;
/** The opposite-direction stop used for the trip home must be within this walk of the arrival stop. */
export const MAX_STOP_PAIR_METRES = 400;
/**
 * MBTA Service Delivery Policy (December 2025), Appendix B peak maximum loads: Green Line
 * Type 7/8/9 light rail 100 per car (two-car trains assumed), New Flyer 40-ft bus 54. Modeled
 * students alone must never exceed these; other riders are not modeled.
 */
export const VEHICLE_PEAK_MAX_LOAD = { subway: 200, bus: 54 } as const;
export const VEHICLE_LOAD_SOURCE = 'https://cdn.mbta.com/sites/default/files/2026-01/20260128_Service%20Delivery%20Policy_December%202025.pdf';

export const routeKind = (route: string): 'subway' | 'bus' => (route.startsWith('Green-') ? 'subway' : 'bus');

export interface StopService { route: string; direction: 0 | 1; weeklyTrips: number }

/** Published visits of one route direction to one map stop on one weekday, sorted by time. */
export interface StopVisits { arrivals: number[]; departures: number[]; trips: string[] }

export interface TransitService {
  /** The timetable's own reference week, for provenance. */
  readonly referenceWeekStart: string;
  readonly sourceUrl: string;
  services(stop: string): StopService[];
  visits(stop: string, route: string, direction: 0 | 1, weekday: number): StopVisits | undefined;
}

const cache = new WeakMap<PublishedScheduleData, TransitService>();

/** Index published trips by map stop. Only same-service-day times before midnight are used. */
export function createTransitService(schedule: PublishedScheduleData): TransitService {
  const cached = cache.get(schedule);
  if (cached) return cached;
  const rows = new Map<string, { arrival: number; departure: number; trip: string }[]>();
  const weekly = new Map<string, Map<string, StopService>>();
  for (const trip of schedule.trips) {
    const seen = new Set<string>();
    for (const call of trip.stops) {
      const stop = schedule.stops[call.stop]?.mapStopId;
      if (!stop || seen.has(stop) || !(call.arrival <= call.departure) || call.departure >= DAY || call.arrival < 0) continue;
      seen.add(stop);
      const serviceKey = `${trip.route}|${trip.direction}`;
      const services = weekly.get(stop) ?? new Map<string, StopService>();
      const service = services.get(serviceKey) ?? { route: trip.route, direction: trip.direction, weeklyTrips: 0 };
      service.weeklyTrips += trip.weekdays.length;
      services.set(serviceKey, service); weekly.set(stop, services);
      for (const weekday of trip.weekdays) {
        const key = `${stop}|${trip.route}|${trip.direction}|${weekday}`;
        const list = rows.get(key) ?? [];
        list.push({ arrival: call.arrival, departure: call.departure, trip: trip.id });
        rows.set(key, list);
      }
    }
  }
  const visits = new Map<string, StopVisits>();
  for (const [key, list] of rows) {
    list.sort((a, b) => a.arrival - b.arrival || a.trip.localeCompare(b.trip));
    visits.set(key, { arrivals: list.map((row) => row.arrival), departures: list.map((row) => row.departure), trips: list.map((row) => row.trip) });
  }
  const service: TransitService = {
    referenceWeekStart: schedule.referenceWeekStart,
    sourceUrl: schedule.sourceUrl,
    services: (stop) => [...(weekly.get(stop)?.values() ?? [])].sort((a, b) => a.route.localeCompare(b.route) || a.direction - b.direction),
    visits: (stop, route, direction, weekday) => visits.get(`${stop}|${route}|${direction}|${weekday}`),
  };
  cache.set(schedule, service);
  return service;
}

/** Index of the last value <= target in an ascending array, or -1. */
export function lastAtOrBefore(values: number[], target: number): number {
  let lo = 0, hi = values.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (values[mid] <= target) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found;
}
