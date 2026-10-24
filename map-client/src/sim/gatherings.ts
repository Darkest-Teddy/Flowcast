// Gathering events (plan Section 5.6): a public campus event at a mapped venue draws students who
// are free for its whole time window. Real dates inside the representative week play as-is; any
// other week's events are projected onto the same weekday and clock time and labelled as such.
import type { CampusData, SourceEvent } from '../data/campusData';

const DAY = 86400;

/** Share of eligible students who choose to attend. Plan default (Section 5.6); a tunable assumption, not a measurement. */
export const GATHERING_ATTENDANCE_PROBABILITY = 0.25;
/** Events without a published end use the plan's default gathering duration. */
export const DEFAULT_GATHERING_SECONDS = 120 * 60;
/** Longer listings are usually multi-day spans or recurring series; they are not expanded into assumed occurrences. */
export const MAX_GATHERING_SECONDS = 6 * 3600;

export interface Gathering {
  id: string;
  eventId: string;
  name: string;
  locationId: string;
  /** Boston calendar date the event is published for. */
  date: string;
  /** Seconds since local midnight on the simulated day. */
  startSec: number;
  endSec: number;
  /** True when the event's own date is outside the representative week. */
  projected: boolean;
  endEstimated: boolean;
  attendanceProbability: number;
  /** Room seats when the event names a room: published, else the model's conservative 24-seat default. Null for whole-venue events. */
  roomSeats: number | null;
  roomCode: string | null;
  sourceUrl: string;
}

/** Unknown rooms use the same conservative cap as unknown classrooms. */
export const UNKNOWN_ROOM_SEATS = 24;

export type GatheringExclusion = 'location-unmapped' | 'multi-day' | 'invalid-time';

/** A gathering after planning: how many simulated students it drew, against its venue's capacity. */
export interface GatheringOutcome extends Gathering {
  attendees: number;
  capacity: number;
}

export const GATHERING_ASSUMPTIONS = [
  `Campus events are Gathering scenarios (plan Section 5.6): ${Math.round(GATHERING_ATTENDANCE_PROBABILITY * 100)}% of students who are free for the whole event, on that campus, and can walk there and back in time choose to attend. This is a tunable assumption, not observed attendance; registration counts are never used as attendance.`,
  'Event attendance is capped by the named room’s published seats (24 when the room is unlisted) or, for whole-venue events, by the venue’s modeled capacity; capacities are never enlarged. Dining, library, gym and estimated venues also share their existing minute-by-minute capacity with other visits.',
  'A published event time grants access to its venue for that window, even where general opening hours are unknown or restricted. Events without a published end last 120 minutes; listings over 6 hours (multi-day spans or recurring series) are not simulated.',
  'Events dated outside the representative week are projected onto the same weekday and clock time of that week, using its classes and opening hours.',
  'Commuters only attend on days they already have mapped classes; each student attends at most one event per day. Class times are never moved for an event.',
];

/** Local clock seconds from an ISO timestamp that already carries Boston's offset. */
function localSeconds(iso: string): number {
  const match = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(iso);
  if (!match) return NaN;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] ?? 0);
}

export function addDays(date: string, days: number): string {
  const day = new Date(`${date}T12:00:00Z`);
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
}

/** Monday of the week containing `date` (Monday = 0, matching the simulation's weekdays). */
export function mondayOf(date: string): string {
  const weekday = (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(date, -weekday);
}

export function weekdayOf(date: string): number {
  return (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7;
}

/** Why an event cannot change the map, or null when it can. */
export function gatheringExclusion(event: SourceEvent): GatheringExclusion | null {
  if (!event.locationId) return 'location-unmapped';
  const start = Date.parse(event.start);
  const end = event.end ? Date.parse(event.end) : start + DEFAULT_GATHERING_SECONDS * 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(localSeconds(event.start))) return 'invalid-time';
  if ((end - start) / 1000 > MAX_GATHERING_SECONDS) return 'multi-day';
  return null;
}

/** Simulated gatherings for one Boston date; events are placed by their own local start date. */
export function gatheringsOnDate(data: CampusData, date: string): Gathering[] {
  const weekStart = data.referenceWeekStart;
  const projected = date < weekStart || date > addDays(weekStart, 6);
  const out: Gathering[] = [];
  for (const event of data.events) {
    if (event.start.slice(0, 10) !== date || gatheringExclusion(event)) continue;
    const startSec = localSeconds(event.start);
    const seconds = event.end ? (Date.parse(event.end) - Date.parse(event.start)) / 1000 : DEFAULT_GATHERING_SECONDS;
    out.push({
      id: `${event.id}@${date}`, eventId: event.id, name: event.name, locationId: event.locationId!, date,
      // An evening event that runs past midnight is clipped to the simulated day.
      startSec, endSec: Math.min(DAY, startSec + seconds), projected, endEstimated: !event.end,
      attendanceProbability: GATHERING_ATTENDANCE_PROBABILITY, sourceUrl: event.sourceUrl,
      roomCode: event.roomCode ?? null,
      roomSeats: event.roomCode ? event.roomCapacity ?? UNKNOWN_ROOM_SEATS : null,
    });
  }
  return out.filter((g) => g.endSec > g.startSec).sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id));
}

/** Gatherings for one simulated weekday of the week starting `weekStart` (default: the representative week). */
export function gatheringsForWeekday(data: CampusData, weekday: number, weekStart = data.referenceWeekStart): Gathering[] {
  return gatheringsOnDate(data, addDays(weekStart, weekday));
}
