// Boston wall-clock helpers and published-hours lookups shared by the Home cards (tonight, the
// morning brief, events in your gaps). Published hours only: a place or day without published
// hours is unknown (null), never guessed from another day.
import { entriesFor, studyOpenAt, type StudyHoursByLocation } from './studyFinder';

export const MINUTE = 60_000;
const clockFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

/** Boston date, minutes after midnight and weekday (0 = Monday). */
export function bostonLocal(at: number): { day: string; minutes: number; weekday: number } {
  const parts = clockFormat.formatToParts(at);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return { day, minutes: +get('hour') * 60 + +get('minute'), weekday: weekdayOf(day) };
}

/** Weekday of a YYYY-MM-DD date, 0 = Monday (the published-hours convention). */
export const weekdayOf = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

/** The YYYY-MM-DD date `offset` days from `day`. */
export const addDays = (day: string, offset: number) => new Date(Date.parse(`${day}T12:00:00Z`) + offset * 86400_000).toISOString().slice(0, 10);

/** Epoch ms of a Boston wall-clock time (`minutes` after midnight; may exceed 24 h) on `day`. */
export function bostonWallTime(day: string, minutes: number): number {
  // Wall-clock minutes as if Boston were UTC; start from EST and correct by the offset in effect.
  const target = Date.parse(`${day}T00:00:00Z`) / MINUTE + minutes;
  let guess = (target + 5 * 60) * MINUTE;
  for (let i = 0; i < 3; i++) {
    const local = bostonLocal(guess);
    const diff = target - (Date.parse(`${local.day}T00:00:00Z`) / MINUTE + local.minutes);
    if (!diff) break;
    guess += diff * MINUTE;
  }
  return guess;
}

/**
 * When the place next closes after `from` by its published hours, scanning up to `capMinutes`
 * (5-minute steps, then minute by minute). Null when it is still open at the end of the scan, or
 * `from` itself if it is not open then.
 */
export function openUntil(source: StudyHoursByLocation[string] | undefined, from: number, capMinutes: number): number | null {
  let minutes = 0;
  while (minutes < capMinutes && studyOpenAt(source, from + minutes * MINUTE) === true && studyOpenAt(source, from + Math.min(capMinutes, minutes + 5) * MINUTE - 1) === true) minutes += 5;
  while (minutes < capMinutes && studyOpenAt(source, from + (minutes + 1) * MINUTE - 1) === true) minutes++;
  return minutes >= capMinutes ? null : from + minutes * MINUTE;
}

/**
 * The published closing time on a Boston date, in seconds after that midnight (past 86400 when it
 * closes after midnight). `closed` when the date is published with no opening; null when nothing
 * is published for the date.
 */
export function closingOn(source: StudyHoursByLocation[string] | undefined, day: string): number | 'closed' | null {
  if (!source || source.hoursStatus === 'restricted') return null;
  const entries = entriesFor(source.hours, day, weekdayOf(day));
  if (!entries.length) return null;
  const ends = entries.flatMap((entry) => entry.windows.map(([, end]) => end));
  return ends.length ? Math.max(...ends) : 'closed';
}

/** The first published source link for a place's hours, if any. */
export const hoursSource = (source: StudyHoursByLocation[string] | undefined) => source?.hours.find((h) => h.sourceUrl)?.sourceUrl ?? null;
