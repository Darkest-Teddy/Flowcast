// The extra datasets the chat tools (chatTools.ts) answer from, loaded once at startup and cut
// down to what the tools need: aggregates and schedules only. Never kept here: individual
// Bluebikes rides, source URL lists of records, raw caches, or anything about one person.
//
// Every file is optional: a missing or unreadable file leaves its part null (or empty) and the
// directory reports it as not loaded, so one bad file never stops the server.

import type { AcademicCalendar } from '../../map-client/src/data/academicCalendar';
import type { CampusData } from '../../map-client/src/data/campusData';
import { parseFireNetwork, type FireNetwork, type FireNetworkJson } from '../../map-client/src/sim/fireResponse';
import type { Modifier } from '../../map-client/src/sim/behavior';
import type { Scenario } from '../../map-client/src/sim/scenarios';

/** Public source pages recorded in the repo (data files and data-pipeline/*.py constants). */
export const SOURCE_URLS = {
  classSchedule: 'https://www.bu.edu/academics/', // data-pipeline/crawl_campus_catalog.py
  academicCalendar: 'https://www.bu.edu/reg/calendars/semester/', // scrape_academic_calendar.py
  dining: 'https://www.bu.edu/dining/where-to-eat/', // scrape_dining.py
  libraryHours: 'https://www.bu.edu/library/visit-study/hours/', // scrape_libraries.py
  libraryGateCounts: 'https://public.tableau.com/views/GateCountsbyTimeofDay/STHLibraryCountsandQuestionsbyTimeofDay.csv?:showVizHome=no',
  fitrec: 'https://www.bu.edu/fitrec/peak-quiet-hours/', // campus-data fitrecUsage.sourceUrl
  terrierCentral: 'https://terriercentral.bu.edu/events', // scrape_events.py
  housing: 'https://www.bu.edu/housing/undergrad-housing/residences/', // scrape_housing.py
  cdsEnrollment: 'https://www.bu.edu/asir/files/2026/05/CDS-2025-2026-B.pdf', // scrape_population.py
  cdsHousing: 'https://www.bu.edu/asir/files/2026/05/CDS-2025-2026-F.pdf',
  factSheet: 'https://www.bu.edu/asir/files/2026/06/G3b-Fact-Sheet-FY2026.pdf',
  bluebikes: 'https://bluebikes.com/system-data', // scrape_bluebikes.py
  mbtaGtfs: 'https://cdn.mbta.com/MBTA_GTFS.zip', // transit-schedule.json sourceUrl
  shuttleGtfs: 'https://api.transloc.com/gtfs/bu.zip', // shuttle-schedule.json sourceUrl
  warrenEpnf: 'https://www.bu.edu/community/files/2024/02/Warren-Towers-EPNF.pdf', // pedestrian counts
  bfd: 'https://www.boston.gov/departments/fire-operations/fire-department-phone-numbers-and-locations', // fire-response.json sourceUrl
  parking: 'https://www.bu.edu/parking/', // fetch_parking.py
  osm: 'https://www.openstreetmap.org/copyright', // parking.json sources
} as const;

export interface ImpactGathering {
  eventId: string; name: string; locationId: string; startSec: number; endSec: number;
  attendees: number; capacity: number; roomCode: string | null; endEstimated: boolean;
}
export interface EventImpact {
  referenceWeekStart: string;
  attendanceProbability: number;
  measure: string;
  assumptions: string[];
  places: { id: string; name: string; short: string; kind: string; campus: string; capacity: number }[];
  /** Weekday → place id → 24 hourly mean simulated head counts, without events. */
  baseline: Record<string, Record<string, number[]>>;
  /** Date → that day's simulated campus events and the places they changed. */
  dates: Record<string, { weekday: number; projected: boolean; occupancy: Record<string, number[]>; gatherings: ImpactGathering[] }>;
}

export interface VenueEvent {
  name: string; venueId: string; kind: string; setup: string | null; start: string; end: string | null;
  /** Published attendance (box scores), only for games that were played. */
  attendance: number | null; status: string | null; soldOut: boolean | null;
}
export interface VenueCalendar {
  window: { from: string; to: string };
  venues: { id: string; name: string; locationId: string | null; position: [number, number] | null; capacities: Record<string, number>; defaultSetup: string | null }[];
  events: VenueEvent[];
}

export interface BikeDock {
  id: string; name: string; short: string; campus: string; near: string; position: [number, number];
  capacity: number | null;
  /** Average rides docked / undocked per hour (summed from 15-minute bins) on the profiled weekday. */
  arrivals: number[]; departures: number[];
}
export interface Bikes {
  month: string; weekday: string; profileDates: string[];
  /** Rides that started or ended at a BU-area dock, per profiled date. */
  ridesPerDay: Record<string, number>;
  docks: BikeDock[];
}

export interface TransitStop {
  id: string; name: string; kind: 'station' | 'bus' | 'shuttle'; position: [number, number];
}
/** One scheduled departure: seconds since the service day's midnight, route index, direction. */
export type Departure = [number, number, 0 | 1];
export interface Transit {
  stops: TransitStop[];
  routes: { id: string; name: string; directions: [string, string] | null; operator: 'mbta' | 'bu-shuttle' }[];
  /** Stop id → weekday → departures sorted by time. */
  departures: Map<string, Departure[][]>;
  mbtaFeed: string; shuttleFeed: string;
  dates: string[];
  priorDepartures: Map<string, Departure[]>;
  shuttleNote: string | null;
}

export interface ValidationMetricRow { day: string; id: string; value: number }
export interface Validation {
  generated: string;
  metrics: ValidationMetricRow[];
  observationSources: { title: string; period: string | null; url: string | null }[];
  transitSeries: number;
  pedestrianSeries: number;
}

export interface ParkingLot {
  id: string; name: string; kind: string; operator: string | null; bu: boolean; campus: string | null;
  position: [number, number]; capacity: number | null; capacityBasis: string; eventParking: boolean;
}

export interface PopulationFile {
  students: { reportingPeriod: string; total: number; undergraduate: number; graduate: number; cohorts: { level: string; attendance: string; headcount: number }[] };
  housing: { degreeSeekingUndergraduateResidentPercent: number; estimatedUndergraduateResidents: number; estimateBasis: string; residenceCapacity: number };
  employees: { reportingPeriod: string; total: number; charlesRiver: number; medical: number; scope: string };
  campusStudentFte: { reportingPeriod: string; charlesRiver: number; medical: number };
  limitations: string[];
  residentialAvailability?: { locationId: string; displayName: string; value: number; note: string; components?: { name: string; capacity: number | null; status: string; relocatedStudents?: number }[] }[];
  campusResidentMinimums?: { campus: string; students: number; validFrom: string; validTo: string; note: string }[];
}

export interface ChatFacts {
  eventImpact: EventImpact | null;
  venues: VenueCalendar | null;
  bikes: Bikes | null;
  transit: Transit | null;
  population: PopulationFile | null;
  validation: Validation | null;
  scenarios: Scenario[];
  /** behavior.json modifiers (conditions and calibration), as published in the file. */
  modifiers: Modifier[];
  /** behavior.json, for target labels. */
  behaviorFile: unknown;
  fire: FireNetwork | null;
  parking: ParkingLot[];
  calendar: AcademicCalendar | undefined;
  /** School of Theology Library historical patron counts (campus bundle libraryHistory). */
  libraryHistory: { name: string; observationPeriod: string; countingMethod: string; patronCounts: { weekday: number; timeLocal: string; value: number }[] } | null;
}

type Read = (relPath: string) => unknown;

/** Reads one file, or null when it is missing or can't be parsed (logged by name only). */
function optional<T>(read: Read, path: string, build: (raw: any) => T): T | null {
  try {
    return build(read(path));
  } catch (error) {
    console.warn(`chat data: ${path} not loaded (${error instanceof Error ? error.name : 'unknown'})`);
    return null;
  }
}

const hourly = (bins: number[], binSeconds: number): number[] => {
  const per = Math.max(1, Math.round(3600 / binSeconds));
  return Array.from({ length: 24 }, (_, h) => Math.round(bins.slice(h * per, (h + 1) * per).reduce((a, b) => a + b, 0) * 100) / 100);
};

export function buildTransit(transitJson: any, mbta: any, shuttle: any): Transit {
  // A historic BU baseline is not evidence for current departures.
  if (!shuttle?.dates?.every((d: string) => mbta.dates?.includes(d)
      && shuttle.feed?.start <= d.replaceAll('-', '') && d.replaceAll('-', '') <= shuttle.feed?.end)) shuttle = null;
  const routes: Transit['routes'] = (transitJson.routes ?? []).map((r: any) => ({
    id: String(r.id), name: String(r.longName ?? r.name ?? r.id),
    directions: Array.isArray(r.directions) && r.directions.length === 2 ? [String(r.directions[0]), String(r.directions[1])] : null,
    operator: 'mbta' as const,
  }));
  const routeIndex = new Map(routes.map((r, i) => [r.id, i]));
  const routeOf = (id: string, operator: 'mbta' | 'bu-shuttle') => {
    let i = routeIndex.get(id);
    if (i === undefined) {
      i = routes.length;
      routes.push({ id, name: operator === 'bu-shuttle' ? `BU Shuttle ${id}` : id, directions: null, operator });
      routeIndex.set(id, i);
    }
    return i;
  };
  const stops: TransitStop[] = (transitJson.stops ?? []).map((s: any) => ({ id: String(s.id), name: String(s.name), kind: s.kind === 'station' ? 'station' : 'bus', position: s.position }));
  // An MBTA schedule stop (platform) belongs to the map stop that lists it, or names it as mapStopId.
  const platformOf = new Map<string, string>();
  for (const s of transitJson.stops ?? []) for (const p of s.platforms ?? []) platformOf.set(String(p), String(s.id));
  for (const [id, s] of Object.entries<any>(mbta.stops ?? {})) if (s.mapStopId && !platformOf.has(id)) platformOf.set(id, String(s.mapStopId));
  const departures = new Map<string, Departure[][]>();
  const priorDepartures = new Map<string, Departure[]>();
  const add = (stop: string, weekday: number, dep: Departure) => {
    // Weekday -1 is the schedule's prior date (only for service past its midnight): not a reference-week day.
    if (weekday === -1) {
      const rows = priorDepartures.get(stop) ?? []; rows.push(dep); priorDepartures.set(stop, rows); return;
    }
    if (!(weekday >= 0 && weekday <= 6)) return;
    let days = departures.get(stop);
    if (!days) departures.set(stop, (days = Array.from({ length: 7 }, () => [])));
    days[weekday].push(dep);
  };
  for (const trip of mbta.trips ?? []) {
    const r = routeOf(String(trip.route), 'mbta');
    // A trip's last stop has no departure worth showing.
    for (const st of (trip.stops ?? []).slice(0, -1)) {
      const mapStop = platformOf.get(String(st.stop));
      if (!mapStop) continue;
      for (const w of trip.weekdays ?? []) add(mapStop, w, [st.departure, r, trip.direction === 1 ? 1 : 0]);
    }
  }
  for (const [id, s] of Object.entries<any>(shuttle?.stops ?? {})) {
    if (s?.name && Array.isArray(s.position)) stops.push({ id, name: String(s.name), kind: 'shuttle', position: s.position });
  }
  for (const trip of shuttle?.trips ?? []) {
    const r = routeOf(String(trip.route), 'bu-shuttle');
    for (const st of (trip.stops ?? []).slice(0, -1)) for (const w of trip.weekdays ?? []) add(String(st.stop), w, [st.departure, r, trip.direction === 1 ? 1 : 0]);
  }
  for (const days of departures.values()) for (const d of days) d.sort((a, b) => a[0] - b[0]);
  return {
    stops, routes, departures, priorDepartures,
    dates: mbta.dates?.length === 7 && mbta.dates.every((d: string) => mbta.feed?.start <= d.replaceAll('-', '') && d.replaceAll('-', '') <= mbta.feed?.end) ? mbta.dates : [],
    mbtaFeed: String(mbta.feed?.version ?? 'MBTA GTFS'),
    shuttleFeed: String(shuttle?.feed?.version ?? 'BU Shuttle GTFS'),
    shuttleNote: Array.isArray(shuttle?.assumptions) ? String(shuttle.assumptions[0]) : null,
  };
}

/** Loads every chat dataset. `read` takes a repo-relative path. */
export function loadChatFacts(read: Read, campus: CampusData, population: unknown): ChatFacts {
  const behavior = optional(read, 'map-client/public/data/behavior.json', (raw) => raw as { modifiers?: Modifier[]; validation?: { generated: string; metrics: Record<string, number> } });
  const observations = optional(read, 'map-client/public/data/calibration-observations.json', (raw) => raw);
  return {
    eventImpact: optional(read, 'map-client/public/data/event-impact.json', (raw): EventImpact => {
      if (!raw?.dates || !raw?.baseline || !Array.isArray(raw.places)) throw new TypeError('event-impact shape');
      return {
        referenceWeekStart: raw.referenceWeekStart, attendanceProbability: raw.attendanceProbability, measure: raw.measure,
        assumptions: raw.assumptions ?? [], places: raw.places, baseline: raw.baseline, dates: raw.dates,
      };
    }),
    venues: optional(read, 'map-client/public/data/event-calendar.json', (raw): VenueCalendar => ({
      window: raw.window,
      venues: (raw.venues ?? []).map((v: any) => ({ id: v.id, name: v.name, locationId: v.locationId ?? null,
        position: Array.isArray(v.position) && v.position.length === 2 ? [Number(v.position[0]), Number(v.position[1])] as [number, number] : null, capacities: v.capacities ?? {}, defaultSetup: v.defaultSetup ?? null })),
      events: (raw.events ?? []).map((e: any): VenueEvent => ({
        name: String(e.name), venueId: String(e.venueId), kind: String(e.kind), setup: e.setup ?? null, start: String(e.start), end: e.end ?? null,
        attendance: typeof e.attendance === 'number' && e.status === 'final' ? e.attendance : null, status: e.status ?? null, soldOut: e.soldOut ?? null,
      })),
    })),
    bikes: optional(read, 'map-client/public/data/bikes.json', (raw): Bikes => ({
      month: raw.month, weekday: raw.weekday, profileDates: raw.profileDates ?? [], ridesPerDay: raw.ridesPerDay ?? {},
      // Only the docks and their averaged profiles: the ride records (trips) are never kept.
      docks: (raw.stations ?? []).map((s: any): BikeDock => ({
        id: s.id, name: s.name, short: s.short ?? s.name, campus: s.campus, near: s.near, position: s.position, capacity: s.capacity ?? null,
        arrivals: hourly(s.profile?.arrivals ?? [], raw.binSeconds ?? 900), departures: hourly(s.profile?.departures ?? [], raw.binSeconds ?? 900),
      })),
    })),
    transit: optional(read, 'map-client/public/data/transit.json', (transitJson) => buildTransit(
      transitJson,
      read('map-client/public/data/transit-schedule.json'),
      optional(read, 'map-client/public/data/shuttle-schedule.json', (raw) => raw),
    )),
    population: optional(read, 'map-client/public/data/population.json', () => {
      const p = population as PopulationFile;
      if (!p?.students || !p?.housing) throw new TypeError('population shape');
      return p;
    }),
    validation: behavior?.validation ? {
      generated: behavior.validation.generated,
      metrics: Object.entries(behavior.validation.metrics).map(([key, value]) => {
        const [day, id] = key.split(' · ');
        return { day, id, value };
      }),
      observationSources: ((observations as any)?.sources ?? []).map((s: any) => ({ title: String(s.title), period: s.period ?? null, url: typeof s.url === 'string' && /^https:\/\//.test(s.url) ? s.url : null })),
      transitSeries: ((observations as any)?.transit ?? []).length,
      pedestrianSeries: ((observations as any)?.pedestrian ?? []).length,
    } : null,
    scenarios: optional(read, 'map-client/public/data/scenarios.json', (raw) => (Array.isArray(raw?.scenarios) ? raw.scenarios as Scenario[] : [])) ?? [],
    modifiers: behavior?.modifiers ?? [],
    behaviorFile: behavior,
    fire: optional(read, 'map-client/public/data/fire-response.json', (raw) => parseFireNetwork(raw as FireNetworkJson)),
    parking: optional(read, 'map-client/public/data/parking.json', (raw) => (raw.lots ?? []).map((l: any): ParkingLot => ({
      id: l.id, name: l.name, kind: l.kind, operator: l.operator ?? null, bu: l.bu === true, campus: l.campus ?? null, position: l.position,
      capacity: typeof l.capacity === 'number' ? l.capacity : null, capacityBasis: String(l.capacityBasis ?? 'unknown'), eventParking: l.eventParking === true,
    }))) ?? [],
    calendar: campus.academicCalendar,
    libraryHistory: (campus as { libraryHistory?: ChatFacts['libraryHistory'] }).libraryHistory ?? null,
  };
}
