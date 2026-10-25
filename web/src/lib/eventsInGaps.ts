// Campus events that fit the student's free time: the event starts inside one of their free
// windows (between imported classes, or before the first / after the last one) today or in the
// coming week, the walk there on the saved routes gets them in by the start, and, when a class
// follows, they can stay a while and still make it with the walk back and the buffer. Followed
// clubs come first. Pure: Home's "Happening on campus" marks and filters by it.
//
// Only where and when count here: registration counts are never treated as attendance, and an
// event without a mapped building (or without a saved walking route) is never marked.
import type { CampusEvent, CampusGeo, CampusLocation, ScheduleItem } from '../data/types';
import { addDays, bostonLocal, bostonWallTime, MINUTE } from './placeHours';
import { studyWalkMinutes } from './studyFinder';

/** Free time is looked for between these Boston wall-clock times each day. */
export const FREE_DAY: [number, number] = [8 * 60, 23 * 60];
/** A free window shorter than this isn't one. */
export const MIN_FREE_MINUTES = 20;
/** Events farther than this on foot from where the window starts aren't marked. */
export const MAX_EVENT_WALK = 20;
/** You must be able to stay at least this long before leaving for the next class. */
export const MIN_MINUTES_THERE = 15;
/** Assumed length of an event that publishes no end time. */
const DEFAULT_EVENT_MINUTES = 60;

export interface FreeWindow {
  day: string;
  start: number;
  end: number;
  /** Where the student is when the window starts: the class before it, else home. */
  from: string | null;
  /** The class that ends the window, or null when it runs to the end of the day. */
  next: ScheduleItem | null;
}

export interface EventFit {
  event: CampusEvent;
  window: FreeWindow;
  walkThere: number;
  walkBack: number | null;
  /** Leave the event by this time to make the next class (null when no class follows). */
  leaveBy: number | null;
  /** Minutes you can be there, from the start until the event ends or you must leave. */
  minutesThere: number;
  followed: boolean;
}

const valid = (s: ScheduleItem) => Number.isFinite(Date.parse(s.start)) && Date.parse(s.end) > Date.parse(s.start);

/** Free windows from now through the next `days` Boston days, around the imported classes. */
export function freeWindows({ schedule, now, homeLocationId, days = 7 }: { schedule: ScheduleItem[]; now: number; homeLocationId: string | null; days?: number }): FreeWindow[] {
  const items = schedule.filter(valid).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  const today = bostonLocal(now).day;
  const windows: FreeWindow[] = [];
  for (let offset = 0; offset < days; offset++) {
    const day = addDays(today, offset);
    const dayStart = Math.max(now, bostonWallTime(day, FREE_DAY[0])), dayEnd = bostonWallTime(day, FREE_DAY[1]);
    if (dayStart >= dayEnd) continue;
    const classes = items.filter((s) => bostonLocal(Date.parse(s.start)).day === day);
    let cursor = dayStart;
    let from: string | null = homeLocationId;
    // A class in progress (or one that started before the day's window) moves the cursor past it.
    for (const item of classes) {
      const start = Date.parse(item.start), end = Date.parse(item.end);
      if (start - cursor >= MIN_FREE_MINUTES * MINUTE) windows.push({ day, start: cursor, end: Math.min(start, dayEnd), from, next: item });
      if (end > cursor) { cursor = end; from = item.locationId || null; }
    }
    if (dayEnd - cursor >= MIN_FREE_MINUTES * MINUTE) windows.push({ day, start: cursor, end: dayEnd, from, next: null });
  }
  return windows.filter((w) => w.end > w.start);
}

/** The events that fit a free window, followed clubs first, then by start time. */
export function eventsInGaps({ events, windows, followedClubIds, geo, locations, bufferMinutes = 5, now }: {
  events: CampusEvent[]; windows: FreeWindow[]; followedClubIds: Iterable<string>; geo: CampusGeo; locations: CampusLocation[]; bufferMinutes?: number; now: number;
}): EventFit[] {
  const followed = new Set(followedClubIds);
  const buffer = Math.max(0, bufferMinutes);
  const fits: EventFit[] = [];
  for (const event of events) {
    const start = Date.parse(event.start);
    if (!Number.isFinite(start) || start < now || !event.locationId) continue;
    const window = windows.find((w) => start >= w.start && start < w.end);
    if (!window || !window.from) continue;
    const walkThere = studyWalkMinutes(geo, locations, window.from, event.locationId);
    if (walkThere === null || walkThere > MAX_EVENT_WALK || window.start + walkThere * MINUTE > start) continue;
    const parsedEnd = event.end ? Date.parse(event.end) : NaN;
    const end = Number.isFinite(parsedEnd) && parsedEnd > start ? parsedEnd : start + DEFAULT_EVENT_MINUTES * MINUTE;
    let walkBack: number | null = null, leaveBy: number | null = null;
    if (window.next) {
      walkBack = studyWalkMinutes(geo, locations, event.locationId, window.next.locationId);
      if (walkBack === null) continue;
      leaveBy = Date.parse(window.next.start) - (buffer + walkBack) * MINUTE;
    }
    const minutesThere = Math.floor((Math.min(end, leaveBy ?? end) - start) / MINUTE);
    if (minutesThere < MIN_MINUTES_THERE) continue;
    fits.push({ event, window, walkThere, walkBack, leaveBy, minutesThere, followed: !!event.clubId && followed.has(event.clubId) });
  }
  return fits.sort((a, b) => Number(b.followed) - Number(a.followed) || Date.parse(a.event.start) - Date.parse(b.event.start) || a.event.id.localeCompare(b.event.id));
}
