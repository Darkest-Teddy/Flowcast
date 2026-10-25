// Class finder: where a course meets, as a building and a floor (never a room as a destination).
// Shared by the web's Home search and Ask fallback and by the Ask server's find_course tool, so
// every surface matches courses and reads floors the same way. Reads only the published class
// schedule (campus-data.json locations[].meetings) and the class-directory.json sidecar (building
// names/addresses and published instructors).

import { courseCodeMatches, courseMentions } from './insights';
import type { SourceMeeting } from './data/campusData';

/** class-directory.json (data-pipeline/build_class_directory.py). */
export interface ClassDirectory {
  buildings: Record<string, { name: string; address: string | null }>;
  /** Published instructor text by meeting id. */
  instructors: Record<string, string>;
  buildingsSourceUrl?: string | null;
  basis?: string;
}

// ---------------------------------------------------------------- floors

export type FloorLevel = 'basement' | 'ground' | 'floor';

export interface RoomFloor {
  level: FloorLevel | null;
  /** Floor number for level 'floor' (1 = first floor); null otherwise. */
  floor: number | null;
  /** "2nd floor", "Basement", "Ground floor", or "room L240" when the number doesn't say. */
  label: string;
}

/**
 * Buildings tall enough that four-digit room numbers carry a two-digit floor ("1526" = 15th floor).
 * CDS is 19 storeys, the Law Tower 18, the Medical Campus Instructional Building 14.
 */
export const TALL_BUILDINGS: ReadonlySet<string> = new Set(['CDS', 'LAW', 'INS']);

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

/**
 * The floor a BU room number points to. The leading digit(s) give the floor: "211" → 2nd floor,
 * "B12"/"B-12" → basement, "G10" → ground floor, "1150" → 11th floor in a tall building (else the
 * first digit), letter suffixes ("114A", "212X4") are ignored. Anything else ("L240", "AUD", "05")
 * gives no floor and reads "room <number>".
 */
export function roomFloor(roomCode: string, opts: { tall?: boolean } = {}): RoomFloor {
  const raw = roomCode.trim();
  const room = raw.toUpperCase().replace(/^(?:ROOM|RM\.?)\s*/, '').replace(/[\s.-]+/g, '');
  const unclear: RoomFloor = { level: null, floor: null, label: `room ${raw || 'not published'}` };
  if (/^(?:B|LL)\d{1,3}[A-Z]{0,2}\d?$/.test(room)) return { level: 'basement', floor: null, label: 'Basement' };
  if (/^G\d{1,3}[A-Z]{0,2}\d?$/.test(room)) return { level: 'ground', floor: null, label: 'Ground floor' };
  const digits = /^(\d+)(?:[A-Z]+\d*)?$/.exec(room)?.[1];
  if (!digits || digits.startsWith('0')) return unclear;
  const floorOf = (n: number): RoomFloor => ({ level: 'floor', floor: n, label: `${ordinal(n)} floor` });
  if (digits.length === 3) return floorOf(Number(digits[0]));
  if (digits.length === 4) return floorOf(opts.tall ? Number(digits.slice(0, 2)) : Number(digits[0]));
  return unclear;
}

/** roomFloor with the building's height rule applied. */
export const floorFor = (buildingCode: string | undefined, roomCode: string) =>
  roomFloor(roomCode, { tall: !!buildingCode && TALL_BUILDINGS.has(buildingCode.toUpperCase()) });

// ---------------------------------------------------------------- queries

export interface ClassQuery {
  /** Compact code from courseMentions ("cs112" or "cascs112"), or null for a title search. */
  code: string | null;
  /** Section named after the code ("A1"), upper case. */
  section: string | null;
  /** Title-search words (for "intro to CS"); empty when a code was given. */
  words: string[];
}

const STOP = new Set(['a', 'an', 'and', 'the', 'to', 'of', 'in', 'for', 'on', 'at', 'is', 'my', 'where', 'what', 'when', 'which',
  'does', 'do', 'class', 'classes', 'course', 'courses', 'meet', 'meets', 'meeting', 'room', 'floor', 'building', 'find', 'show', 'me',
  'lecture', 'section', 'sec', 'lab', 'discussion', 'held', 'taught']);
/** Short forms students type that aren't prefixes of the title word. */
const ALIASES: Record<string, string[]> = {
  stats: ['statistics', 'statistical'], orgo: ['organic'], cs: ['computer', 'science'], ds: ['data', 'science'],
  econ: ['economics', 'economic'], poli: ['political'], psych: ['psychology'], bio: ['biology', 'biological'], chem: ['chemistry'],
  calc: ['calculus'], lin: ['linear'], alg: ['algebra'], prob: ['probability'], comp: ['computer', 'computing', 'computation'],
};

/** Split a search into a course code (+ section) or title words. */
export function parseClassQuery(query: string): ClassQuery {
  const mention = courseMentions(query)[0];
  if (mention) {
    const rest = query.toLowerCase().slice(mention.at + mention.len);
    const section = /^[\s,·:-]*(?:sec(?:tion)?\.?\s*)?([a-z]{1,2}\d{1,2}|[a-z]{2}|\d{2})\b/.exec(rest)?.[1];
    return { code: mention.code, section: section ? section.toUpperCase() : null, words: [] };
  }
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w && !STOP.has(w));
  return { code: null, section: null, words };
}

/** Whether a question is about where/when a course meets (and not, say, a walk between two classes). */
export function isClassQuestion(query: string): boolean {
  if (/\bhow far\b|\bdistance\b|\bwalk(ing)?\b|\bfar apart\b/i.test(query)) return false;
  return courseMentions(query).length === 1 && /\bwhere\b|\bwhen\b|\bmeet|\bfloor\b|\bbuilding\b|\broom\b|\bfind\b|\bwhich\b/i.test(query);
}

// ---------------------------------------------------------------- matching

export interface ClassPlace {
  locationId: string;
  buildingCode: string;
  roomCode: string;
  floor: RoomFloor;
  /** Published weekly times, seconds from Monday 00:00 (weekday 0 = Monday). */
  times: { weekday: number; startSec: number; endSec: number }[];
}

export interface ClassSection {
  section: string;
  instructor: string | null;
  /** One entry per building and room the section meets in (a lecture and a lab can differ). */
  places: ClassPlace[];
  /** Published notes restrict the dates (e.g. only some weeks); times may not apply every week. */
  restricted: boolean;
}

export interface ClassResult {
  courseCode: string;
  title: string;
  sourceUrl: string;
  sections: ClassSection[];
}

export interface ClassSearch {
  query: ClassQuery;
  results: ClassResult[];
  /** The section asked for was found and the results hold only it. */
  sectionMatched: boolean;
}

type Row = { locationId: string; meeting: SourceMeeting };

const titleWords = (title: string) => title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** How well title-search words match a course; null when one doesn't match at all. */
function titleScore(words: string[], courseCode: string, title: string): number | null {
  const [school = '', dept = '', number = ''] = courseCode.toLowerCase().split(/\s+/);
  const tw = titleWords(title);
  let score = 0;
  let titleHits = 0;
  let numberHit = false;
  const inTitle = (needle: string) => tw.some((t) => (needle.length >= 3 ? t.startsWith(needle) : t === needle));
  for (const w of words) {
    const alias = !!ALIASES[w] && ALIASES[w].every(inTitle);
    if (w === dept || w === school) score += alias ? 3 : 2;
    else if (inTitle(w) || alias) { score += 2; titleHits++; }
    else if (/^\d{3}$/.test(w) && w === number) { score += 3; numberHit = true; }
    else return null;
  }
  return titleHits || numberHit ? score : null;
}

const sameTimes = (a: ClassPlace['times'], b: ClassPlace['times']) =>
  a.length === b.length && a.every((t, i) => t.startSec === b[i].startSec && t.endSec === b[i].endSec);

function group(rows: Row[], directory?: ClassDirectory): ClassResult[] {
  const courses = new Map<string, { title: string; sourceUrl: string; sections: Map<string, ClassSection> }>();
  for (const { locationId, meeting } of rows) {
    const course = courses.get(meeting.courseCode) ?? { title: meeting.title, sourceUrl: meeting.sourceUrl, sections: new Map<string, ClassSection>() };
    courses.set(meeting.courseCode, course);
    const section: ClassSection = course.sections.get(meeting.section)
      ?? { section: meeting.section, instructor: null, places: [], restricted: false };
    course.sections.set(meeting.section, section);
    section.instructor ??= directory?.instructors[meeting.id] ?? null;
    section.restricted ||= meeting.calendarRestricted;
    const buildingCode = meeting.buildingCode ?? '';
    const times = [...meeting.intervals].sort((a, b) => a.startSec - b.startSec);
    const place = section.places.find((p) => p.locationId === locationId && p.roomCode === meeting.roomCode);
    if (!place) section.places.push({ locationId, buildingCode, roomCode: meeting.roomCode, floor: floorFor(buildingCode, meeting.roomCode), times });
    else if (!sameTimes(place.times, times)) {
      place.times = [...place.times, ...times.filter((t) => !place.times.some((p) => p.startSec === t.startSec))].sort((a, b) => a.startSec - b.startSec);
    }
  }
  const sectionOrder = (a: ClassSection, b: ClassSection) => a.section.localeCompare(b.section, 'en', { numeric: true });
  return [...courses].map(([courseCode, c]) => ({ courseCode, title: c.title, sourceUrl: c.sourceUrl, sections: [...c.sections.values()].sort(sectionOrder) }));
}

/**
 * Courses matching a search: a code ("CS 112", "cs112", "CAS CS 112"), a code and section
 * ("CS 112 A1"), or title words ("intro to CS"). Codes without a school can name several courses
 * (CAS BI 515 and WED BI 515); all are returned, the one with most sections first. A section that
 * the course doesn't have is ignored (it may be a word, not a section).
 */
export function findClasses(query: string, meetings: Row[], directory?: ClassDirectory, limit = 5): ClassSearch {
  const q = parseClassQuery(query);
  let rows: Row[];
  let ranked: ClassResult[];
  if (q.code) {
    rows = meetings.filter(({ meeting }) => courseCodeMatches(q.code!, meeting.courseCode));
    ranked = group(rows, directory).sort((a, b) => b.sections.length - a.sections.length || a.courseCode.localeCompare(b.courseCode));
  } else {
    if (!q.words.length || q.words.join('').length < 3) return { query: q, results: [], sectionMatched: false };
    const scores = new Map<string, number | null>();
    rows = meetings.filter(({ meeting }) => {
      if (!scores.has(meeting.courseCode)) scores.set(meeting.courseCode, titleScore(q.words, meeting.courseCode, meeting.title));
      return scores.get(meeting.courseCode) !== null;
    });
    const num = (code: string) => Number(code.match(/\d+/)?.[0] ?? 9999);
    ranked = group(rows, directory).sort((a, b) => (scores.get(b.courseCode) ?? 0) - (scores.get(a.courseCode) ?? 0)
      || num(a.courseCode) - num(b.courseCode) || b.sections.length - a.sections.length || a.courseCode.localeCompare(b.courseCode));
  }
  let sectionMatched = false;
  if (q.section) {
    const withSection = ranked.map((c) => ({ ...c, sections: c.sections.filter((s) => s.section === q.section) })).filter((c) => c.sections.length);
    if (withSection.length) { ranked = withSection; sectionMatched = true; }
  }
  return { query: q, results: ranked.slice(0, limit), sectionMatched };
}

// ---------------------------------------------------------------- wording

const DAY = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function clock(sec: number): { text: string; meridiem: 'AM' | 'PM' } {
  const minutes = Math.round((((sec % 86400) + 86400) % 86400) / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return { text: `${h % 12 || 12}:${String(m).padStart(2, '0')}`, meridiem: h < 12 ? 'AM' : 'PM' };
}

/** "Tue, Thu 12:30–1:45 PM" (times sharing a slot are joined; others separated by "; "). */
export function formatClassTimes(times: ClassPlace['times']): string {
  if (!times.length) return 'times not published';
  const slots = new Map<string, Set<number>>();
  for (const t of times) {
    const day = Math.floor(t.startSec / 86400);
    const start = clock(t.startSec);
    const end = clock(t.endSec);
    const key = start.meridiem === end.meridiem ? `${start.text}–${end.text} ${end.meridiem}` : `${start.text} ${start.meridiem}–${end.text} ${end.meridiem}`;
    slots.set(key, (slots.get(key) ?? new Set()).add(day));
  }
  return [...slots].map(([slot, days]) => `${[...days].sort().map((d) => DAY[d] ?? '?').join(', ')} ${slot}`).join('; ');
}

/** "CAS · College of Arts & Sciences, 685-725 Commonwealth Avenue"; falls back to the map's name. */
export function buildingLabel(buildingCode: string, directory?: ClassDirectory, fallbackName?: string): string {
  const entry = directory?.buildings[buildingCode];
  const name = entry?.name ?? fallbackName;
  const text = [name, entry?.address].filter(Boolean).join(', ');
  return buildingCode ? (text ? `${buildingCode} · ${text}` : buildingCode) : text || 'building not published';
}

/** "Basement (room B18)" / "2nd floor (room 211)" / "room L240". */
export const floorText = (place: Pick<ClassPlace, 'floor' | 'roomCode'>) =>
  place.floor.level ? `${place.floor.label} (room ${place.roomCode})` : place.floor.label;
