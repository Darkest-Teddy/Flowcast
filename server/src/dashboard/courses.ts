// The published BU catalog, as a searchable list of course sections, and the expansion of a chosen
// set of sections into dated schedule items.
//
// Everything here comes from the committed campus snapshot (map-client/public/data/campus-data.json),
// which records each meeting's course code, section, building, room and weekly time pattern with the
// BU page it was read from. Nothing is invented: a section with no published meeting pattern is not
// offered, and a building the map doesn't know keeps an empty locationId rather than a guessed one.
//
// Dates follow the same rules the map uses (map-client/src/data/academicCalendar.ts): a meeting runs
// only inside its own published validity range, and for the course prefixes BU's semester calendar
// covers, only between the term's first and last class day, skipping suspended days and running the
// substituted weekday's timetable on a substitute day. Prefixes the calendar excludes (LAW, MED and
// the other professional schools) keep their published weekly pattern across the whole window.

import { z } from 'zod';
import type { CampusData, SourceMeeting } from '../../../map-client/src/data/campusData';
import type { Course, CourseMeetingSlot, CourseSearchResult, CourseSection, ScheduleItem } from '../../../web/src/data/types';
import { ScheduleError, scheduleWindow } from './schedule';

/** Most courses returned for one search. The picker narrows by refining the query, not by scrolling. */
export const SEARCH_LIMIT = 40;
/** Sections one person may hold at once: more than any real course load, small enough to bound work. */
export const MAX_SECTIONS = 30;
const DAY = 86400;

export const courseSelectionRequest = z.object({
  sections: z.array(z.string().min(1).max(220)).max(MAX_SECTIONS),
}).strict();

/** The key the picker round-trips. Course code and section together identify one offering. */
export const sectionKey = (courseCode: string, section: string) => `${courseCode}|${section}`;

interface IndexedSlot extends CourseMeetingSlot {
  validFrom?: string;
  validTo?: string;
}

interface IndexedSection {
  key: string;
  courseCode: string;
  title: string;
  section: string;
  slots: IndexedSlot[];
  sourceUrl: string;
  /** True when BU's semester calendar governs this course's prefix. */
  calendarApplies: boolean;
  /** Lowercased "cas cs 112 introduction to computer science" for substring matching. */
  haystack: string;
}

interface TermCalendar {
  classesStart: string;
  classesEnd: string;
  suspended: Set<string>;
  /** Date to the weekday whose class timetable the registrar runs that day. */
  substitutions: Map<string, number>;
}

export interface CourseIndex {
  term: string;
  sections: Map<string, IndexedSection>;
  /** Sections in display order: by course code, then section. */
  ordered: IndexedSection[];
  calendar: TermCalendar | null;
}

/**
 * A meeting's `startSec`/`endSec` are seconds into the simulation's reference week, so the weekday is
 * already folded in. Peel it back out to a plain time of day.
 */
function slotOf(meeting: SourceMeeting, interval: SourceMeeting['intervals'][number], locationId: string): IndexedSlot | null {
  const startSec = interval.startSec - interval.weekday * DAY;
  const endSec = interval.endSec - interval.weekday * DAY;
  if (!Number.isInteger(interval.weekday) || interval.weekday < 0 || interval.weekday > 6) return null;
  if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
  if (startSec < 0 || endSec <= startSec || endSec > DAY) return null;
  return {
    weekday: interval.weekday,
    startSec,
    endSec,
    locationId,
    buildingCode: meeting.buildingCode ?? null,
    roomCode: meeting.roomCode || null,
    roomCapacity: meeting.roomCapacity ?? null,
    validFrom: meeting.validFrom,
    validTo: meeting.validTo,
  };
}

function termCalendar(campus: CampusData): TermCalendar | null {
  const term = campus.academicCalendar?.terms?.find((t) => t.term === campus.term.toUpperCase());
  if (!term?.classesStart || !term.classesEnd) return null;
  return {
    classesStart: term.classesStart,
    classesEnd: term.classesEnd,
    suspended: new Set(term.suspendedDates ?? []),
    substitutions: new Map((term.substitutions ?? []).map((s) => [s.date, s.scheduleWeekday])),
  };
}

/**
 * Group every published meeting into one entry per course section. A section that meets in more than
 * one room keeps all of its slots; a section with no usable slot is dropped rather than offered as an
 * empty choice.
 */
export function buildCourseIndex(campus: CampusData): CourseIndex {
  const applicable = new Set(campus.academicCalendar?.applicableCoursePrefixes ?? []);
  const sections = new Map<string, IndexedSection>();
  for (const [locationId, location] of Object.entries(campus.locations ?? {})) {
    for (const meeting of location.meetings ?? []) {
      if (meeting.calendarRestricted) continue; // Its times are not published to students.
      const key = sectionKey(meeting.courseCode, meeting.section);
      let entry = sections.get(key);
      if (!entry) {
        entry = {
          key,
          courseCode: meeting.courseCode,
          title: meeting.title,
          section: meeting.section,
          slots: [],
          sourceUrl: meeting.sourceUrl,
          calendarApplies: applicable.has(meeting.courseCode.split(' ')[0]),
          haystack: `${meeting.courseCode} ${meeting.title}`.toLowerCase(),
        };
        sections.set(key, entry);
      }
      for (const interval of meeting.intervals ?? []) {
        const slot = slotOf(meeting, interval, locationId);
        if (slot) entry.slots.push(slot);
      }
    }
  }
  for (const [key, entry] of sections) if (!entry.slots.length) sections.delete(key);
  for (const entry of sections.values()) {
    entry.slots.sort((a, b) => a.weekday - b.weekday || a.startSec - b.startSec);
  }
  const ordered = [...sections.values()].sort((a, b) =>
    a.courseCode.localeCompare(b.courseCode) || a.section.localeCompare(b.section));
  return { term: campus.term, sections, ordered, calendar: termCalendar(campus) };
}

const publicSlot = ({ validFrom: _f, validTo: _t, ...slot }: IndexedSlot): CourseMeetingSlot => slot;
const publicSection = (s: IndexedSection): CourseSection =>
  ({ key: s.key, section: s.section, slots: s.slots.map(publicSlot), sourceUrl: s.sourceUrl });

/**
 * Courses whose code or title contains every whitespace-separated term of the query. An empty query
 * returns the first page of the catalog so the picker opens with something to look at. `total` counts
 * every matching section, including those past the course limit, so the UI can say what it hid.
 */
export function searchCourses(index: CourseIndex, query: string | undefined, limit = SEARCH_LIMIT): CourseSearchResult {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const byCourse = new Map<string, Course>();
  let total = 0;
  for (const entry of index.ordered) {
    if (terms.length && !terms.every((t) => entry.haystack.includes(t))) continue;
    total++;
    const existing = byCourse.get(entry.courseCode);
    if (existing) { existing.sections.push(publicSection(entry)); continue; }
    if (byCourse.size >= limit) continue;
    byCourse.set(entry.courseCode, { courseCode: entry.courseCode, title: entry.title, sections: [publicSection(entry)] });
  }
  return { term: index.term, total, courses: [...byCourse.values()] };
}

/**
 * Exactly the named sections, grouped like a search result. The picker uses this to show what an
 * account already saved without having to find it in the catalog first. Keys that no longer match a
 * published section are skipped: a section withdrawn since the pick should disappear, not error.
 */
export function coursesForKeys(index: CourseIndex, keys: string[]): CourseSearchResult {
  const byCourse = new Map<string, Course>();
  let total = 0;
  for (const key of [...new Set(keys)]) {
    const entry = index.sections.get(key);
    if (!entry) continue;
    total++;
    const course = byCourse.get(entry.courseCode);
    if (course) course.sections.push(publicSection(entry));
    else byCourse.set(entry.courseCode, { courseCode: entry.courseCode, title: entry.title, sections: [publicSection(entry)] });
  }
  return { term: index.term, total, courses: [...byCourse.values()] };
}

/** The UTC instant of a Boston wall-clock time, honouring the offset in force at that moment. */
export function bostonInstant(day: string, secondsOfDay: number): number {
  const naive = Date.parse(`${day}T00:00:00Z`) + secondsOfDay * 1000;
  // Resolve the offset at roughly the target instant, then correct. A second pass settles DST edges.
  let utc = naive;
  for (let pass = 0; pass < 2; pass++) {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' })
      .formatToParts(new Date(utc)).find((p) => p.type === 'timeZoneName')!.value;
    utc = naive - Number(name.replace('GMT', '')) * 3600000;
  }
  return utc;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** Weekday of a calendar date with Monday = 0, read from a midday instant so offsets can't shift it. */
const weekdayOf = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7;

/**
 * Every dated meeting of the chosen sections that falls inside the 120-day schedule window.
 * Throws when a key names no published section, so a stale pick fails loudly instead of vanishing.
 */
export function expandSections(index: CourseIndex, keys: string[], now = new Date()): { items: ScheduleItem[]; windowStart: string; windowEnd: string } {
  const unique = [...new Set(keys)];
  const chosen = unique.map((key) => {
    const entry = index.sections.get(key);
    if (!entry) throw new ScheduleError(`No published section matches ${key}.`);
    return entry;
  });
  const { windowStart, windowEnd } = scheduleWindow(now);
  const from = Date.parse(windowStart);
  const until = Date.parse(windowEnd);
  const calendar = index.calendar;

  const items: ScheduleItem[] = [];
  for (let at = Date.parse(`${isoDay(from)}T12:00:00Z`); at < until + DAY * 1000; at += DAY * 1000) {
    const day = isoDay(at);
    const plainWeekday = weekdayOf(day);
    const inTerm = calendar ? day >= calendar.classesStart && day <= calendar.classesEnd && !calendar.suspended.has(day) : false;
    const termWeekday = calendar?.substitutions.get(day) ?? plainWeekday;
    for (const entry of chosen) {
      // Courses the semester calendar covers run only on term days; the rest keep their weekly pattern.
      if (entry.calendarApplies && calendar && !inTerm) continue;
      const weekday = entry.calendarApplies && calendar ? termWeekday : plainWeekday;
      for (const slot of entry.slots) {
        if (slot.weekday !== weekday) continue;
        if (slot.validFrom && day < slot.validFrom) continue;
        if (slot.validTo && day > slot.validTo) continue;
        const start = bostonInstant(day, slot.startSec);
        const end = bostonInstant(day, slot.endSec);
        if (start < from || start >= until || end <= start) continue;
        const room = [slot.buildingCode, slot.roomCode].filter(Boolean).join(' ');
        items.push({
          id: `course:${entry.key}:${day}:${slot.startSec}`,
          title: `${entry.courseCode} ${entry.section}`,
          locationId: slot.locationId,
          locationText: room || undefined,
          start: new Date(start).toISOString(),
          end: new Date(end).toISOString(),
          source: 'course',
          note: entry.title,
        });
      }
    }
  }
  items.sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  return { items, windowStart, windowEnd };
}
