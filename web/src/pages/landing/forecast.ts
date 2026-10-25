// The landing page's numbers: one day of the simulation's hourly crowding, read from the same
// event-impact data the Event impact page uses.

import type { EventImpactData, ImpactPlace } from '../../data/types';

/** The hours the dashboard forecasts, 7 AM to 11 PM. */
export const FIRST_HOUR = 7;
export const LAST_HOUR = 23;
export const HOURS = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => FIRST_HOUR + i);

/** The landing page shows the Tuesday of the simulated reference week (Monday = 0). */
export const LANDING_WEEKDAY = 1;

export interface DayForecast {
  /** "2026-10-27". */
  date: string;
  /** Every place the data covers. */
  places: ImpactPlace[];
  place: (id: string) => ImpactPlace | undefined;
  /** Share of capacity (0–1+) at an hour of the day, or null when the place isn't simulated. */
  share: (id: string, hour: number) => number | null;
}

const utc = (date: string) => new Date(`${date}T12:00:00Z`);

export function addDays(date: string, days: number): string {
  const d = utc(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "Tuesday, October 27". */
export const longDate = (date: string) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(utc(date));

/** "Tuesday". */
export const weekdayName = (date: string) => new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'UTC' }).format(utc(date));

/** "7 AM", "12 PM". */
export function hourLabel(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  return `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * A weekday of the reference week, with that date's events where the data has them (a date's
 * occupancy lists only the places its events changed; the rest follow the weekday baseline).
 */
export function dayForecast(data: EventImpactData, weekday = LANDING_WEEKDAY): DayForecast {
  const date = addDays(data.referenceWeekStart, weekday);
  const baseline = data.baseline[String(weekday)] ?? {};
  const changed = data.dates[date]?.occupancy ?? {};
  const places = new Map(data.places.map((p) => [p.id, p]));
  return {
    date,
    places: data.places,
    place: (id) => places.get(id),
    share(id, hour) {
      const place = places.get(id);
      const counts = changed[id] ?? baseline[id];
      const count = counts?.[hour];
      if (!place || !Number.isFinite(place.capacity) || place.capacity <= 0 ||
          count == null || !Number.isFinite(count) || count < 0) return null;
      return count / place.capacity;
    },
  };
}

/** The busiest and quietest hours of a place's day (first one wins a tie). */
export function peaks(day: DayForecast, id: string, hours = HOURS) {
  const available = hours.filter(hour => day.share(id, hour) != null);
  let busiest: number | null = available[0] ?? null;
  let quietest: number | null = available[0] ?? null;
  for (const hour of available) {
    if (busiest == null || day.share(id, hour)! > day.share(id, busiest)!) busiest = hour;
    if (quietest == null || day.share(id, hour)! < day.share(id, quietest)!) quietest = hour;
  }
  return { busiest, quietest };
}

/** "Fri, Oct 30". */
export const shortDate = (date: string) =>
  new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(utc(date));

/** "2:15 PM" for seconds since midnight. */
export function clockLabel(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m ? hourLabel(h).replace(' ', `:${String(m).padStart(2, '0')} `) : hourLabel(h);
}

export interface EventExample {
  date: string;
  name: string;
  venue: ImpactPlace;
  startSec: number;
  /** The hour the venue changes most, and its share of capacity without and with the event. */
  hour: number;
  before: number;
  after: number;
}

/** The best-attended simulated event of the reference week, and what it does to its venue. */
export function eventExample(data: EventImpactData): EventExample | null {
  let best: { date: string; weekday: number; gathering: EventImpactData['dates'][string]['gatherings'][number] } | null = null;
  for (let weekday = 0; weekday < 7; weekday++) {
    const date = addDays(data.referenceWeekStart, weekday);
    for (const gathering of data.dates[date]?.gatherings ?? []) {
      if (!best || gathering.attendees > best.gathering.attendees) best = { date, weekday, gathering };
    }
  }
  if (!best) return null;
  const venue = data.places.find((p) => p.id === best.gathering.locationId);
  const before = data.baseline[String(best.weekday)]?.[venue?.id ?? ''];
  const after = data.dates[best.date]?.occupancy[venue?.id ?? ''];
  if (!venue || !before || !after || !Number.isFinite(venue.capacity) || venue.capacity <= 0) return null;
  const available = HOURS.filter(h => Number.isFinite(before[h]) && before[h] >= 0 && Number.isFinite(after[h]) && after[h] >= 0);
  if (!available.length) return null;
  let hour = available[0];
  for (const h of available) if (after[h] - before[h] > after[hour] - before[hour]) hour = h;
  return {
    date: best.date,
    name: best.gathering.name,
    venue,
    startSec: best.gathering.startSec,
    hour,
    before: (before[hour] ?? 0) / venue.capacity,
    after: (after[hour] ?? 0) / venue.capacity,
  };
}

/** The biggest places of a kind ('dining', 'library', 'gym'), by capacity, that have any hour of data. */
export function placesOfKind(day: DayForecast, kind: string, count = 4): ImpactPlace[] {
  return day.places
    .filter((p) => p.kind === kind && HOURS.some((h) => day.share(p.id, h) != null))
    .sort((a, b) => b.capacity - a.capacity)
    .slice(0, count);
}

