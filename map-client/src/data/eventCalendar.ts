// Event venues near the map, their published calendar, each event's public popularity (Google
// Trends, built offline) and the walks event visitors take. Built by the data pipeline:
//   data-pipeline/scrape_venue_events.py -> event-calendar.json
//   data-pipeline/event_popularity.py    -> event-popularity.json
//   data-pipeline/build_visitor_routes.py -> event-visitor-routes.json
// All three are optional extras: the map runs without any of them (no venue events, or every event
// on its kind's prior when only the popularity file is missing).

export type EventKind =
  | 'bu-hockey' | 'bu-womens-hockey' | 'bu-basketball' | 'bu-womens-basketball' | 'bu-soccer' | 'bu-lacrosse'
  | 'bu-field-hockey' | 'bu-sport' | 'concert' | 'comedy' | 'pwhl' | 'family' | 'mlb' | 'ceremony' | 'theatre'
  | 'campus' | 'other';

export interface EventVenue {
  id: string;
  name: string;
  address?: string;
  position: [number, number];
  /** Campus location id when the venue is one of the simulation's places (Agganis Arena). */
  locationId: string | null;
  capacities: Record<string, number | null>;
  defaultSetup: string;
  capacitySource?: string;
  capacityUrl?: string;
  nearestStations?: string[];
}

export interface CalendarEvent {
  id: string;
  venueId: string;
  name: string;
  kind: EventKind;
  setup: string | null;
  /** ISO with Boston's offset. */
  start: string;
  end: string | null;
  doors?: string | null;
  timeTbd?: boolean;
  performers?: string[];
  opponent?: string | null;
  opponentRank?: number | null;
  trendsTerms?: string[];
  soldOut?: boolean | null;
  /** Published attendance (past events only). */
  attendance?: number | null;
  attendanceSource?: string | null;
  source: string;
  sourceUrl: string;
  fetchedAt?: string;
}

export interface EventCalendarData {
  schemaVersion: number;
  generatedAt: string;
  venues: EventVenue[];
  events: CalendarEvent[];
  sources?: { id: string; url: string; fetchedAt: string; ok: boolean; count: number; error?: string }[];
  notes?: string[];
}

export interface TermScore {
  term: string;
  /** TD Garden = 100 in the same window. */
  score: number | null;
  peakScore: number | null;
  /** Daily 0-100 values from the request (relative to that request's busiest day). */
  series: number[];
  anchorSeries: number[];
  via: string;
  dates?: [string, string];
  url?: string;
  queriedAt?: string;
}

export interface EventPopularity {
  eventId: string;
  kind: EventKind | null;
  group: string;
  terms: string[];
  window: { from: string; to: string };
  source: 'trends' | 'prior';
  score: number | null;
  /** The term the score rests on (a game's opponent; else the biggest term). */
  scoreTerm?: string;
  termScores?: TermScore[];
  reason?: string;
}

export interface PopularityCalibration {
  referenceScore: number;
  fit: { base: number; elasticity: number; residualSd: number; n: number } | null;
  points: { eventId: string; score: number; fill: number; attendance: number; capacity: number; source: string | null }[];
}

export interface EventPopularityData {
  schemaVersion: number;
  generatedAt: string;
  builtFor: string;
  geo: string;
  geoLabel: string;
  windowDays: number;
  anchor: { term: string; ladder: string[] };
  method: string[];
  counts: { trends: number; prior: number };
  rateLimited?: boolean;
  calibration: Record<string, PopularityCalibration>;
  events: Record<string, EventPopularity>;
}

export interface VisitorOrigin {
  id: string;
  kind: 'transit' | 'parking' | 'rideshare';
  name: string;
  position: [number, number];
  capacity: number | null;
  door: string;
  metres: number;
  /** Origin to door, [lng, lat] points; `cumulative` metres along it. */
  path: [number, number][];
  cumulative: number[];
}

export interface VisitorRoutesData {
  schemaVersion: number;
  generatedAt: string;
  source: string;
  venues: Record<string, { name: string; osm: string; doors: { name: string; position: [number, number] }[]; origins: VisitorOrigin[] }>;
}

export interface EventSources {
  calendar: EventCalendarData | null;
  popularity: EventPopularityData | null;
  routes: VisitorRoutesData | null;
}

async function optionalJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** The three venue-event files, fetched once; any that's missing or broken is null. */
export async function loadEventSources(base = '/data'): Promise<EventSources> {
  const [calendar, popularity, routes] = await Promise.all([
    optionalJson<EventCalendarData>(`${base}/event-calendar.json`),
    optionalJson<EventPopularityData>(`${base}/event-popularity.json`),
    optionalJson<VisitorRoutesData>(`${base}/event-visitor-routes.json`),
  ]);
  return { calendar: calendar?.events ? calendar : null, popularity: popularity?.events ? popularity : null, routes: routes?.venues ? routes : null };
}
