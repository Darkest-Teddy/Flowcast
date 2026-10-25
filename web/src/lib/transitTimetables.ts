// Loads the map's published timetables for the departure planner (served from map-client/public,
// see vite.config.ts) and, for a trip about to leave, polls MBTA predictions for it.
import { useEffect, useState } from 'react';
import type { PublishedScheduleData } from '../../../map-client/src/transit/publishedSchedule';
import { campusRoutes, campusStops } from '../data/campusStops';
import type { LiveDeparture, Timetable, TransitContext, TransitOption } from './transitDeparture';

const SOURCES: { operator: Timetable['operator']; url: string }[] = [
  { operator: 'mbta', url: '/data/transit-schedule.json' },
  { operator: 'bu-shuttle', url: '/data/shuttle-schedule.json' },
];

async function loadTimetable(url: string): Promise<PublishedScheduleData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Published timetable unavailable (${response.status})`);
  const data = await response.json();
  // Feed coverage is checked per class date by the planner, which says which timetables it left out.
  if (data?.schemaVersion !== 1 || !Array.isArray(data.trips) || !data.stops || data.dates?.length !== 7 || !data.feed) {
    throw new Error('Unsupported published timetable');
  }
  return data;
}

let loading: Promise<{ timetables: Timetable[]; failed: Timetable['operator'][] }> | null = null;
function loadAll() {
  loading ??= Promise.all(SOURCES.map(({ operator, url }) => loadTimetable(url).then((schedule) => ({ operator, schedule }), () => operator)))
    .then((rows) => ({
      timetables: rows.filter((row): row is Timetable => typeof row !== 'string'),
      failed: rows.filter((row): row is Timetable['operator'] => typeof row === 'string'),
    }));
  return loading;
}

export interface CampusTransit { context: TransitContext | undefined; failed: Timetable['operator'][]; loading: boolean }

/** The published timetables with the bundled stop walks; `context` stays undefined until they load. */
export function useCampusTransit(): CampusTransit {
  const [state, setState] = useState<CampusTransit>({ context: undefined, failed: [], loading: true });
  useEffect(() => {
    let live = true;
    void loadAll().then(({ timetables, failed }) => {
      if (!live) return;
      setState({ context: timetables.length ? { timetables, stops: campusStops, routes: campusRoutes } : undefined, failed, loading: false });
    });
    return () => { live = false; };
  }, []);
  return state;
}

const MBTA_API = 'https://api-v3.mbta.com';
const MBTA_KEY = import.meta.env.VITE_MBTA_API_KEY as string | undefined;
const LIVE_POLL_MS = 60_000;
/** Predictions are only asked for a departure this soon; later ones stay timetable times. */
const LIVE_WINDOW_MS = 60 * 60_000;

/** MBTA predictions for one stop, route and direction, stamped with when they were received. */
async function fetchMbtaDepartures(stop: string, route: string, direction: 0 | 1): Promise<LiveDeparture[]> {
  const query = new URLSearchParams({ 'filter[stop]': stop, 'filter[route]': route, 'filter[direction_id]': String(direction),
    'fields[prediction]': 'departure_time,direction_id' });
  if (MBTA_KEY) query.set('api_key', MBTA_KEY);
  const response = await fetch(`${MBTA_API}/predictions?${query}`);
  if (!response.ok) throw new Error(`MBTA predictions returned ${response.status}`);
  const json = await response.json() as { data: { attributes: { departure_time: string | null }; relationships: { trip?: { data: { id: string } | null } } }[] };
  // Predictions carry no observation time of their own: their age is the age of this response.
  const observedAt = Date.now();
  return json.data.flatMap((row) => {
    const time = row.attributes.departure_time ? Date.parse(row.attributes.departure_time) : NaN;
    const trip = row.relationships.trip?.data?.id;
    return Number.isFinite(time) ? [{ trip, route, direction, stop, time, observedAt }] : [];
  });
}

/** Live predictions for the planned MBTA departure when it leaves within the hour; empty otherwise. */
export function useLiveDepartures(option: TransitOption | null | undefined, now: number): LiveDeparture[] {
  const key = option && option.operator === 'mbta' && option.departure - now <= LIVE_WINDOW_MS
    ? `${option.boardStop.id}|${option.route}|${option.direction}` : null;
  const [live, setLive] = useState<{ key: string; rows: LiveDeparture[] } | null>(null);
  useEffect(() => {
    if (!key) return;
    const [stop, route, direction] = key.split('|');
    let active = true;
    const poll = () => fetchMbtaDepartures(stop, route, Number(direction) as 0 | 1)
      .then((rows) => { if (active) setLive({ key, rows }); }, () => undefined); // a failed poll leaves timetable times
    void poll();
    const timer = window.setInterval(poll, LIVE_POLL_MS);
    return () => { active = false; window.clearInterval(timer); };
  }, [key]);
  return live && live.key === key ? live.rows : [];
}
