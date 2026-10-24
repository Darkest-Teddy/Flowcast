import { crowdFor } from '@theme/tokens';
import { locationName } from '../../data/api';
import type {
  CampusEvent,
  CampusLocation,
  Club,
  HourlyForecast,
  LocationKind,
  PlaceForecast,
  ScheduleItem,
} from '../../data/types';
import { formatDayTime, formatHour, formatPercent, formatTime } from '../../lib/format';

export interface CampusData {
  locations: CampusLocation[];
  schedule: ScheduleItem[];
  events: CampusEvent[];
  clubs: Club[];
  hourly: HourlyForecast[];
  places: PlaceForecast[];
}

export interface SearchResult {
  id: string;
  kind: 'Place' | 'Your day' | 'Event' | 'Club';
  title: string;
  detail: string;
  to: string;
}

const kindLabel: Record<LocationKind, string> = {
  dorm: 'Residence hall',
  classroom: 'Academic building',
  library: 'Library',
  dining: 'Dining hall',
  gym: 'Gym',
  venue: 'Venue',
};

const describe = (share: number) => `${formatPercent(share)} ${crowdFor(share).label.toLowerCase()}`;

/** Plain substring search over places, the person's day, events and clubs. */
export function searchCampus(query: string, d: CampusData): SearchResult[] {
  const q = query.toLowerCase();
  const has = (...fields: (string | undefined)[]) => fields.some((f) => f?.toLowerCase().includes(q));
  const results: SearchResult[] = [];

  for (const loc of d.locations) {
    if (!has(loc.name, loc.short)) continue;
    const forecast = d.hourly.some((h) => h.locationId === loc.id);
    results.push({ id: `place-${loc.id}`, kind: 'Place', title: loc.name, detail: kindLabel[loc.kind], to: forecast ? `/forecasts?place=${loc.id}` : '/forecasts' });
  }
  for (const item of d.schedule) {
    if (!has(item.title, locationName(d.locations, item.locationId, false))) continue;
    results.push({ id: `day-${item.id}`, kind: 'Your day', title: item.title, detail: formatDayTime(item.start), to: '/schedule' });
  }
  for (const ev of d.events) {
    if (!has(ev.title, ev.venue ?? '', ev.organizer ?? '')) continue;
    results.push({ id: `event-${ev.id}`, kind: 'Event', title: ev.title, detail: formatDayTime(ev.start), to: `/event-impact?date=${ev.start.slice(0, 10)}` });
  }
  for (const club of d.clubs) {
    if (!club.verified || !has(club.name, club.description)) continue;
    results.push({ id: `club-${club.id}`, kind: 'Club', title: club.name, detail: `${club.members} members`, to: '/clubs' });
  }
  return results;
}

/** A short answer from the forecasts, for "Ask Flowcast". Until the model is served, it reads the same data the pages show. */
export function answerQuestion(query: string, d: CampusData): string {
  const q = query.toLowerCase();
  const bySpecificity = [...d.locations].sort((a, b) => b.name.length - a.name.length);
  const loc =
    bySpecificity.find((l) => q.includes(l.name.toLowerCase()) || q.includes(l.short.toLowerCase())) ??
    bySpecificity.find((l) => q.includes(l.id));
  if (!loc) return 'Name a place and Flowcast will tell you how busy it gets, for example “when is Mugar quiet?”';

  const hourly = d.hourly.find((h) => h.locationId === loc.id);
  if (hourly && hourly.hours.length) {
    const nowHour = new Date().getHours();
    const ahead = hourly.hours.filter((h) => h.hour >= nowHour);
    const hours = ahead.length ? ahead : hourly.hours;
    const quiet = hours.reduce((a, b) => (b.share < a.share ? b : a));
    const busy = hours.reduce((a, b) => (b.share > a.share ? b : a));
    const when = ahead.length ? 'for the rest of today' : 'today';
    return `${loc.short} is quietest at ${formatHour(quiet.hour)} (${describe(quiet.share)}) and busiest at ${formatHour(busy.hour)} (${describe(busy.share)}) ${when}.`;
  }

  const place = d.places.find((p) => p.locationId === loc.id);
  if (place) return `${loc.short} is predicted to be ${describe(place.share)} at ${formatTime(place.at)}.`;
  return `There is no forecast for ${loc.name} yet.`;
}
