// Exam-season mode for the Study page: BU's Study Period and final exams, read from the
// Registrar's calendar in campus-data.json the same way the simulation reads it
// (map-client/src/sim/conditions.ts academicPeriodFor). During those dates the page ranks libraries
// by their projected crowd and lists classrooms with no published class in the next hours.
//
// Honesty rules: hourly crowd figures are the typical-week projection for this weekday (the
// dashboard's forecasts are not rebuilt with exam conditions); how much busier libraries get in
// exam season is the conditions model's stated assumption (behavior.json), quoted, never applied to
// invent a percentage. A classroom is "no published class", never "available" or "unlocked": exam
// rooms are not published per room and building access is unknown.

import { academicPeriodFor } from '../../../map-client/src/sim/conditions';
import { meetingIntervalsOn } from '../../../map-client/src/data/academicCalendar';
import type { AcademicCalendar } from '../../../map-client/src/data/academicCalendar';
import type { CampusData as CampusBundle } from '../../../map-client/src/data/campusData';
import { floorFor } from '../../../map-client/src/classSearch';
import type { CampusGeo, CampusLocation, HourlyForecast } from '../data/types';
import { studyOpenAt, studyWalkMinutes, type StudyHoursByLocation } from './studyFinder';

const DAY_MS = 86_400_000;
const noon = (date: string) => Date.parse(`${date}T12:00:00Z`);
const daysBetween = (a: string, b: string) => Math.round((noon(b) - noon(a)) / DAY_MS);

export interface ExamWindow {
  term: string;
  /** First day of the Study Period (or of exams when no Study Period is published). */
  start: string;
  /** Last exam day. */
  end: string;
  studyStart: string | null;
  examsStart: string | null;
}

export type ExamSeason =
  | { mode: 'active'; phase: 'reading-period' | 'finals'; label: string; window: ExamWindow }
  | { mode: 'upcoming'; window: ExamWindow; daysAway: number }
  | { mode: 'off' };

/** Each term's exam season (Study Period through the last exam), in date order. */
export function examWindows(calendar: AcademicCalendar | undefined): ExamWindow[] {
  return (calendar?.terms ?? []).flatMap((term) => {
    const study = term.events.filter((e) => e.kind === 'study').flatMap((e) => [e.start, e.end]).sort();
    const exams = term.events.filter((e) => e.kind === 'exams').flatMap((e) => [e.start, e.end]).sort();
    if (!exams.length) return [];
    return [{ term: term.term, start: study[0] ?? exams[0], end: exams.at(-1)!, studyStart: study[0] ?? null, examsStart: exams[0] }];
  }).sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Exam-season state on a Boston calendar date: active during the Study Period and finals (the
 * conditions model's 'reading-period' and 'finals'), upcoming within `hintDays` before it, else off.
 */
export function examSeasonFor(date: string, calendar: AcademicCalendar | undefined, hintDays = 14): ExamSeason {
  const { period, label } = academicPeriodFor(date, calendar);
  const windows = examWindows(calendar);
  if (period === 'reading-period' || period === 'finals') {
    const window = windows.find((w) => w.start <= date && date <= w.end);
    if (window) return { mode: 'active', phase: period, label, window };
  }
  const next = windows.find((w) => w.start > date);
  if (next) {
    const daysAway = daysBetween(date, next.start);
    if (daysAway <= hintDays) return { mode: 'upcoming', window: next, daysAway };
  }
  return { mode: 'off' };
}

// ---------------------------------------------------------------- the conditions model's assumption

export interface ExamLibraryAssumption {
  phase: 'reading-period' | 'finals';
  /** Multiplier on how many students choose a library visit. */
  visits: number | null;
  /** Multiplier on how long each visit lasts. */
  stay: number | null;
  note: string | null;
  sourceUrl: string | null;
}

interface BehaviorModifier {
  id: string;
  when?: { period?: string[] };
  effects?: { target: string; op: string; value: number }[];
  provenance?: { note?: string; source?: string };
}

/** The library effects of the exam-period modifier in behavior.json, as stated there. */
export function examLibraryAssumption(behavior: { modifiers?: BehaviorModifier[] } | null | undefined, phase: 'reading-period' | 'finals'): ExamLibraryAssumption {
  const modifier = behavior?.modifiers?.find((m) => m.when?.period?.includes(phase) && m.effects?.some((e) => e.target.startsWith('activity.@library.')));
  const factor = (field: string) => {
    const effect = modifier?.effects?.find((e) => e.target === `activity.@library.${field}` && e.op === 'mul');
    return effect && Number.isFinite(effect.value) ? effect.value : null;
  };
  return { phase, visits: factor('probability'), stay: factor('minutes'), note: modifier?.provenance?.note ?? null, sourceUrl: modifier?.provenance?.source ?? null };
}

// ---------------------------------------------------------------- libraries

export interface ExamLibrary {
  locationId: string;
  name: string;
  /** Published hours say open now: true, false, or null when unpublished. */
  open: boolean | null;
  /** Typical-week projected share now, and the highest over the next hours (null when not projected). */
  now: number | null;
  peak: number | null;
  peakHour: number | null;
  walk: number | null;
}

/**
 * Libraries ranked for exam season: open ones first, then the lowest typical-week projection over
 * the next `hoursAhead` hours (the quietest pick when everywhere fills), then the shorter walk.
 */
export function rankExamLibraries(input: {
  locations: CampusLocation[];
  forecasts: HourlyForecast[];
  hours: StudyHoursByLocation;
  geo: CampusGeo;
  from: string;
  now: number;
  day: string;
  hour: number;
  hoursAhead?: number;
}): ExamLibrary[] {
  const ahead = input.hoursAhead ?? 3;
  const rows = input.locations.filter((l) => l.kind === 'library').map((l): ExamLibrary => {
    const forecast = input.forecasts.find((f) => f.locationId === l.id && f.day === input.day);
    const window = forecast?.hours.filter((h) => h.hour >= input.hour && h.hour < input.hour + ahead && Number.isFinite(h.share)) ?? [];
    const peak = window.length ? window.reduce((a, b) => (b.share > a.share ? b : a)) : null;
    return {
      locationId: l.id,
      name: l.name,
      open: studyOpenAt(input.hours[l.id], input.now),
      now: forecast?.hours.find((h) => h.hour === input.hour)?.share ?? null,
      peak: peak?.share ?? null,
      peakHour: peak?.hour ?? null,
      walk: input.from ? studyWalkMinutes(input.geo, input.locations, input.from, l.id) : null,
    };
  });
  const openRank = (o: boolean | null) => (o === true ? 0 : o === null ? 1 : 2);
  return rows.sort((a, b) => openRank(a.open) - openRank(b.open)
    || (a.peak ?? Infinity) - (b.peak ?? Infinity)
    || (a.walk ?? Infinity) - (b.walk ?? Infinity)
    || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- classrooms

export interface QuietRoom {
  roomCode: string;
  floor: string;
  seats: number | null;
  /** Seconds since midnight of the next published class that day, or null for none. */
  nextClassAt: number | null;
}

export interface QuietBuilding {
  locationId: string;
  name: string;
  buildingCode: string;
  walk: number | null;
  /** Rooms with published classes this term and none in the window. */
  rooms: QuietRoom[];
  /** Rooms with a published class in the window. */
  busyRooms: number;
}

/**
 * Buildings with classrooms that have no published class from `seconds` for `hoursAhead` hours on
 * `date`, using the term's class dates (none after the last day of classes). Rooms whose published
 * meetings have restricted or unpublished dates are left out: whether they meet can't be told.
 */
export function roomsWithoutPublishedClass(input: {
  data: CampusBundle;
  locations: CampusLocation[];
  geo: CampusGeo;
  from: string;
  date: string;
  weekday: number;
  seconds: number;
  hoursAhead?: number;
}): QuietBuilding[] {
  const start = input.weekday * 86400 + input.seconds;
  const end = start + (input.hoursAhead ?? 3) * 3600;
  const dayEnd = (input.weekday + 1) * 86400;
  const byId = new Map(input.locations.map((l) => [l.id, l]));
  const out: QuietBuilding[] = [];
  for (const [locationId, source] of Object.entries(input.data.locations)) {
    const location = byId.get(locationId);
    if (!location || !source.meetings?.length || location.kind === 'dorm') continue;
    const rooms = new Map<string, { buildingCode: string; seats: number | null; busy: boolean; unknown: boolean; next: number }>();
    for (const meeting of source.meetings) {
      const code = meeting.buildingCode ?? source.buildingCodes[0] ?? '';
      const room = rooms.get(`${code} ${meeting.roomCode}`) ?? { buildingCode: code, seats: null, busy: false, unknown: false, next: Infinity };
      rooms.set(`${code} ${meeting.roomCode}`, room);
      if (meeting.roomCapacity !== null) room.seats = Math.max(room.seats ?? 0, meeting.roomCapacity);
      if (meeting.calendarRestricted) { room.unknown = true; continue; }
      for (const iv of meetingIntervalsOn(meeting, input.data, input.date, input.weekday)) {
        if (iv.startSec < end && iv.endSec > start) room.busy = true;
        else if (iv.startSec >= end && iv.startSec < dayEnd) room.next = Math.min(room.next, iv.startSec);
      }
    }
    const quiet = [...rooms].filter(([, r]) => !r.busy && !r.unknown);
    if (!quiet.length) continue;
    const codes = [...new Set(quiet.map(([, r]) => r.buildingCode))];
    out.push({
      locationId,
      name: location.name,
      buildingCode: codes.join('/'),
      walk: input.from ? studyWalkMinutes(input.geo, input.locations, input.from, locationId) : null,
      rooms: quiet.map(([key, r]) => {
        const roomCode = key.slice(r.buildingCode.length + 1);
        return { roomCode, floor: floorFor(r.buildingCode, roomCode).label, seats: r.seats, nextClassAt: Number.isFinite(r.next) ? r.next - input.weekday * 86400 : null };
      }).sort((a, b) => (b.nextClassAt ?? Infinity) - (a.nextClassAt ?? Infinity) || (b.seats ?? 0) - (a.seats ?? 0) || a.roomCode.localeCompare(b.roomCode)),
      busyRooms: [...rooms.values()].filter((r) => r.busy).length,
    });
  }
  return out.sort((a, b) => (a.walk ?? Infinity) - (b.walk ?? Infinity) || b.rooms.length - a.rooms.length || a.name.localeCompare(b.name));
}

/** "Fri, Dec 11" for an ISO date. */
export function formatExamDate(date: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(noon(date)));
}
