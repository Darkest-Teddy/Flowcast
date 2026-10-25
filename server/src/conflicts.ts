// What else is happening on a date, for organizers picking one: published venue events (games,
// concerts) with how far they are from a chosen place, and where the date falls in the academic
// calendar (classes, a holiday, the study period, final exams, a break). Club events are added from
// the dashboard snapshot and the database by the router.
import { academicPeriodFor } from '../../map-client/src/sim/conditions';
import type { AcademicCalendar } from '../../map-client/src/data/academicCalendar';
import type { CampusLocation } from '../../map-client/src/sim/playback';
import { metresBetween, VENUE_RADIUS_M } from './eventSlots';
import type { VenueCalendar } from './chatData';

export interface ConflictFacts {
  date: string;
  weekday: number;
  academic: { period: string; label: string };
  venueEvents: { name: string; venue: string; kind: string; start: string; end: string | null; metres: number | null; nearby: boolean }[];
  /** The place the distances are measured from, by name. */
  near: string | null;
  venueWindow: { from: string; to: string } | null;
}

const bostonDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

export function conflictFacts(date: string, nearId: string | null, src: { venues: VenueCalendar | null; calendar: AcademicCalendar | undefined; locations: CampusLocation[] }): ConflictFacts {
  const near = nearId ? src.locations.find((l) => l.id === nearId) ?? null : null;
  const venues = new Map((src.venues?.venues ?? []).map((v) => [v.id, v]));
  const venueEvents = (src.venues?.events ?? []).filter((e) => bostonDate.format(new Date(e.start)) === date).map((e) => {
    const v = venues.get(e.venueId);
    const metres = near && v?.position ? metresBetween(near.position, v.position) : null;
    return { name: e.name, venue: v?.name ?? e.venueId, kind: e.kind, start: e.start, end: e.end, metres, nearby: metres !== null && metres <= VENUE_RADIUS_M };
  }).sort((a, b) => a.start.localeCompare(b.start));
  return {
    date, weekday: (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7,
    academic: academicPeriodFor(date, src.calendar),
    venueEvents, near: near?.name ?? null, venueWindow: src.venues?.window ?? null,
  };
}
