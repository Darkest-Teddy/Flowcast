// Class search for students: "CS 112", "cs112 a1", "intro to CS" → the building (code, name,
// address) and the floor read from the room number, with days, times, section, published
// instructor and the walk from where the student is. Matching and floor rules live in
// map-client/src/classSearch.ts, shared with the Ask server's find_course tool.

import {
  buildingLabel,
  findClasses,
  floorText,
  formatClassTimes,
  isClassQuestion,
  type ClassDirectory,
  type ClassPlace,
  type ClassSection,
} from '../../../map-client/src/classSearch';
import type { SourceMeeting } from '../../../map-client/src/data/campusData';
import type { CampusGeo, CampusLocation, ScheduleItem } from '../data/types';
import { placeAt, walkBetween, type PlaceRef, type Walk } from './insights';

/** The published schedule as the class search reads it (api.getClassFinder). */
export interface ClassFinderData {
  meetings: { locationId: string; meeting: SourceMeeting }[];
  directory: ClassDirectory;
}

export interface ClassFinderContext {
  locations: CampusLocation[];
  geo: CampusGeo;
  schedule: ScheduleItem[];
  homeLocationId: string | null;
}

/** One section meeting place, ready to show. */
export interface ClassRow {
  id: string;
  courseCode: string;
  section: string;
  title: string;
  /** "CAS · College of Arts & Sciences, 685-725 Commonwealth Avenue" */
  building: string;
  /** "Basement (room B18)", "2nd floor (room 211)" or "room L240". */
  floor: string;
  /** "Tue, Thu 5:00–6:15 PM" */
  times: string;
  instructor: string | null;
  walk: Walk | null;
  locationId: string;
  datesVary: boolean;
}

export interface ClassFinderResult {
  rows: ClassRow[];
  /** Courses matched (several for "intro to CS" or a code shared by two schools). */
  courses: { courseCode: string; title: string; sections: number; sourceUrl: string }[];
  /** Sections not shown as rows. */
  moreSections: number;
  from: PlaceRef | null;
  sectionAsked: string | null;
  sectionFound: boolean;
}

export const FLOOR_NOTE = 'Floors are read from the room number (leading digit; B = basement), not a floor plan. Times are the published weekly schedule.';

const walkText = (w: Walk | null, from: PlaceRef | null) =>
  !w || !from ? null : w.meters === 0 ? `you are in ${from.label}` : `${w.basis === 'route' ? '' : '~'}${w.minutes} min walk from ${from.label}`;

/** "CAS · …, 685-725 Commonwealth Avenue · Basement (room B18) · Tue, Thu 5:00–6:15 PM · Instructor: Narayanan · 6 min walk from Warren Towers" */
export function classRowDetail(row: ClassRow, from: PlaceRef | null): string {
  return [row.building, row.floor, row.times, row.instructor ? `Instructor: ${row.instructor}` : '', row.datesVary ? 'dates vary, check the course page' : '', walkText(row.walk, from) ?? '']
    .filter(Boolean).join(' · ');
}

/** Rows for a search, at most `maxRows` section meeting places; the course with most sections first. */
export function findClassRows(query: string, data: ClassFinderData, ctx: ClassFinderContext, now: Date, maxRows = 6): ClassFinderResult {
  const search = findClasses(query, data.meetings, data.directory);
  const from = placeAt({ locations: ctx.locations, schedule: ctx.schedule, hourly: [], geo: ctx.geo, homeLocationId: ctx.homeLocationId }, now);
  const name = (id: string) => ctx.locations.find((l) => l.id === id)?.name;
  const toRow = (courseCode: string, title: string, s: ClassSection, p: ClassPlace, k: number): ClassRow => ({
    id: `class-${courseCode}-${s.section}-${k}`,
    courseCode,
    section: s.section,
    title,
    building: buildingLabel(p.buildingCode, data.directory, name(p.locationId)),
    floor: floorText(p),
    times: formatClassTimes(p.times),
    instructor: s.instructor,
    walk: from ? walkBetween(from.locationId, p.locationId, ctx.geo) : null,
    locationId: p.locationId,
    datesVary: s.restricted,
  });
  const all = search.results.flatMap((c) => c.sections.flatMap((s) => s.places.map((p, k) => toRow(c.courseCode, c.title, s, p, k))));
  // Several courses (a title search): show each course's first sections rather than one course's many.
  const perCourse = search.results.length > 1 ? Math.max(1, Math.floor(maxRows / search.results.length)) : maxRows;
  const rows = search.results.flatMap((c) => all.filter((r) => r.courseCode === c.courseCode).slice(0, perCourse)).slice(0, maxRows);
  const shownSections = new Set(rows.map((r) => `${r.courseCode} ${r.section}`));
  const totalSections = search.results.reduce((n, c) => n + c.sections.length, 0);
  return {
    rows,
    courses: search.results.map((c) => ({ courseCode: c.courseCode, title: c.title, sections: c.sections.length, sourceUrl: c.sourceUrl })),
    moreSections: totalSections - shownSections.size,
    from,
    sectionAsked: search.query.section,
    sectionFound: search.sectionMatched,
  };
}

export { isClassQuestion };

/** Ask Flowcast's on-device sentence for a class question: building and floor first. */
export function classAnswerText(result: ClassFinderResult, query: string): string {
  if (!result.rows.length) return `Flowcast found no published class meeting for “${query.trim()}” in a mapped building. Try a code like CAS CS 112.`;
  if (result.courses.length > 1) {
    return `That matches ${result.courses.length} courses: ${result.courses.map((c) => `${c.courseCode} (${c.title})`).join(', ')}. Which one do you mean?`;
  }
  const first = result.rows[0];
  const buildings = [...new Set(result.rows.map((r) => r.building))];
  const sectionNote = result.sectionAsked && !result.sectionFound ? ` Section ${result.sectionAsked} isn’t in the published schedule; showing all sections.` : '';
  const where = result.rows.length === 1 || buildings.length === 1
    ? `${first.courseCode} ${first.section} meets in ${first.building}, ${first.floor.replace(/^room/, 'in room')}: ${first.times}.`
    : `${first.courseCode} meets in ${buildings.length} buildings; section ${first.section} is in ${first.building}, ${first.floor.replace(/^room/, 'in room')}: ${first.times}.`;
  const w = first.walk;
  const walk = !w || !result.from ? ''
    : w.meters === 0 ? ` That’s the building you’re in (${result.from.label}).`
    : ` It’s ${w.basis === 'route' ? 'a' : 'about a'} ${w.minutes}-minute walk from ${result.from.label}.`;
  return `${where}${walk}${sectionNote}`;
}
