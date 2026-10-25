import type { CampusEvent, CampusGeo, CampusLocation } from '../data/types';
import { studyWalkMinutes } from './studyFinder';

// "Find meetings": club and organization events from the published Terrier Central listings, with
// where they are and how far a walk. A listing that spans several days (a weekly meeting published
// as one date range) says which dates it runs between but not which weekdays, so it is shown as a
// series and never expanded into guessed dates.

export interface MeetingItem {
  event: CampusEvent;
  /** The mapped building's name, or null when the venue isn't on the map (or is hidden). */
  building: string | null;
  kind: 'once' | 'series';
  /** Walking minutes from the person's home building, or null when unknown. */
  walk: number | null;
}

export interface MeetingFilter {
  query: string;
  /** Club ids the person follows; with onlyFollowing, only their events. */
  following: readonly string[];
  onlyFollowing: boolean;
  /** Days ahead to include; null for every upcoming listing. */
  withinDays: number | null;
  now: number;
  home: string | null;
}

const DAY = 86_400_000;
const bostonDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });

/** A listing whose end falls on a later Boston date than its start, by more than a night, is a series. */
export function meetingKind(event: Pick<CampusEvent, 'start' | 'end'>): 'once' | 'series' {
  if (!event.end) return 'once';
  const days = (Date.parse(`${bostonDate.format(new Date(event.end))}T12:00:00Z`) - Date.parse(`${bostonDate.format(new Date(event.start))}T12:00:00Z`)) / DAY;
  return days > 1 ? 'series' : 'once';
}

export function findMeetings(events: readonly CampusEvent[], locations: readonly CampusLocation[], geo: CampusGeo, f: MeetingFilter): MeetingItem[] {
  const names = new Map(locations.map((l) => [l.id, l.name]));
  const words = f.query.toLowerCase().split(/\s+/).filter(Boolean);
  const horizon = f.withinDays === null ? Infinity : f.now + f.withinDays * DAY;
  const items = events.flatMap((event): MeetingItem[] => {
    const start = Date.parse(event.start);
    if (!Number.isFinite(start)) return [];
    const kind = meetingKind(event);
    // Single events without an end are taken to last two hours for "still upcoming".
    const end = event.end ? Date.parse(event.end) : start + 2 * 3_600_000;
    if (end <= f.now || start > horizon) return [];
    if (f.onlyFollowing && !(event.clubId && f.following.includes(event.clubId))) return [];
    const building = event.locationId ? names.get(event.locationId) ?? null : null;
    const text = `${event.title} ${event.organizer ?? ''} ${event.venue ?? ''} ${building ?? ''}`.toLowerCase();
    if (!words.every((w) => text.includes(w))) return [];
    const walk = f.home && event.locationId ? studyWalkMinutes(geo, [...locations], f.home, event.locationId) : null;
    return [{ event, building, kind, walk }];
  });
  // One-off meetings by start time first, then series by club name.
  return items.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'once' ? -1 : 1)
    || (a.kind === 'once' ? Date.parse(a.event.start) - Date.parse(b.event.start) : (a.event.organizer ?? '').localeCompare(b.event.organizer ?? ''))
    || a.event.title.localeCompare(b.event.title));
}

const icsStamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

/** A one-event .ics file for a single meeting; null for a series, whose weekdays aren't published. */
export function meetingIcs(item: MeetingItem, now = Date.now()): string | null {
  if (item.kind !== 'once') return null;
  const start = Date.parse(item.event.start);
  const end = item.event.end ? Date.parse(item.event.end) : start + 2 * 3_600_000;
  const where = [item.event.venue, item.building].filter(Boolean).join(', ');
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Flowcast//Club meetings//EN', 'BEGIN:VEVENT',
    `UID:${icsText(item.event.id)}@flowcast`, `DTSTAMP:${icsStamp(now)}`, `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
    `SUMMARY:${icsText(item.event.title)}`,
    ...(where ? [`LOCATION:${icsText(where)}`] : []),
    ...(item.event.sourceUrl ? [`URL:${item.event.sourceUrl}`] : []),
    `DESCRIPTION:${icsText(`${item.event.organizer ? `${item.event.organizer}. ` : ''}From BU's published event listing; check it for changes.`)}`,
    'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}
