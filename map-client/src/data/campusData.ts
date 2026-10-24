import type { FitrecUsage } from './fitrecUsage';
import type { AcademicCalendar } from './academicCalendar';

export interface Evidence {
  id: string;
  label: string;
  value: number;
  unit: string;
  basis: string;
  publishedAt: string | null;
  sourceUrl: string;
  note: string | null;
}

export interface SourceMeeting {
  buildingCode?: string;
  id: string;
  courseCode: string;
  title: string;
  section: string;
  sourceSectionKey?: string;
  roomCode: string;
  intervals: { weekday: number; startSec: number; endSec: number }[];
  roomCapacity: number | null;
  notes: string | null;
  calendarRestricted: boolean;
  validFrom?: string;
  validTo?: string;
  sharedKey: string | null;
  sourceUrl: string;
}

export interface OpeningHours {
  date: string | null;
  weekday?: number; // Monday = 0; absent on unverified undated snapshots
  validFrom?: string;
  validTo?: string;
  windows: [number, number][]; // local seconds; overnight closing may exceed 86400
  text: string;
  sourceUrl: string;
  qualifier: string | null;
  serviceSourceUrls?: string[];
}

export function openingHoursForDate(hours: OpeningHours[], date: string, weekday: number): OpeningHours[] {
  const exact = hours.filter(entry => entry.date === date);
  if (exact.length) return exact;
  return hours.filter(entry => entry.date === null && entry.weekday === weekday
    && (!entry.validFrom || date >= entry.validFrom)
    && (!entry.validTo || date <= entry.validTo));
}

export const CARRY_FORWARD_DAYS = 7;

/**
 * Dated service hours from the same weekday one week away, used only when `date` falls past the
 * venue's published dated horizon (before its first or after its last dated entry). Dates inside the
 * published range keep their strict meaning: an omitted day is not reopened. Exact-date and valid
 * weekly entries always take precedence, so known closures are never overridden.
 */
export function carriedForwardHours(hours: OpeningHours[], date: string, weekday: number): OpeningHours[] {
  if (openingHoursForDate(hours, date, weekday).length) return [];
  const dated = hours.filter((entry): entry is OpeningHours & { date: string } => entry.date !== null).map(entry => entry.date).sort();
  if (!dated.length || (date >= dated[0] && date <= dated.at(-1)!)) return [];
  const target = Date.parse(`${date}T12:00:00Z`);
  for (const offset of [-CARRY_FORWARD_DAYS, CARRY_FORWARD_DAYS]) {
    const sourceDate = new Date(target + offset * 86400000).toISOString().slice(0, 10);
    const entries = hours.filter(entry => entry.date === sourceDate);
    if (entries.length) return entries.map(entry => ({ ...entry,
      qualifier: `Carried forward from published hours for ${sourceDate}; ${date} is past the published schedule horizon.${entry.qualifier ? ` ${entry.qualifier}` : ''}` }));
  }
  return [];
}

export interface SourceLocation {
  id: string;
  buildingCodes: string[];
  meetings: SourceMeeting[];
  evidence: Evidence[];
  hours: OpeningHours[];
  hoursStatus?: 'published' | 'unknown' | 'restricted';
  hoursReason?: string;
}

export interface SourceEvent {
  id: string;
  name: string;
  start: string;
  end: string | null;
  locationId: string | null;
  locationName: string | null;
  registrationCount: number | null;
  sourceUrl: string;
}

export interface CourseComponentRule {
  status: 'resolved' | 'unresolved';
  components: { id: string; sections: string[] }[];
  dependencies: { section: string; requires: { component: string; sections: string[] }[] }[];
  sourceUrls: string[];
  notes: string[];
  mappedCoverage: Record<string, string[]>;
  mappedCourse: boolean;
  hasCompleteMappedOption: boolean;
  reason: string | null;
  classificationBasis?: string;
}
export interface CampusData {
  academicCalendar?: AcademicCalendar;
  fitrecUsage?: FitrecUsage;
  catalogCourseCodes?: string[];
  catalogCourseCoverage?: {
    courseCodes: string[];
    courseGroups: string[][];
    basis: string;
    excludedCalendarRestrictedRows: number;
    excludedUnscheduledOrNonphysicalRows: number;
    sourceUrls: string[];
  };
  courseComponentRules?: Record<string, CourseComponentRule>;
  schemaVersion: 1;
  term: string;
  collectedAt: string;
  referenceWeekStart: string;
  coverage: {
    coursePages: number;
    uniqueCourses: number;
    sourceMeetings: number;
    mappedMeetings: number;
    calendarRestrictedMeetings: number;
    mappedLocations: number;
    unmappedBuildings: { code: string; meetingCount: number }[];
    eventCount: number;
    mappedEvents: number;
  };
  locations: Record<string, SourceLocation>;
  events: SourceEvent[];
  libraryHistory: {
    name: string;
    observationPeriod: string;
    countingMethod: string;
    patronCounts: { weekday: number; timeLocal: string; value: number }[];
    sectionObservations: number;
    sourceUrl: string;
  };
  signals: Evidence[];
  assumptions: string[];
  inputFiles: { path: string; sha256: string }[];
}

export async function loadCampusData(url = '/data/campus-data.json'): Promise<CampusData> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Campus snapshot unavailable (${response.status})`);
  const data: CampusData = await response.json();
  if (data.schemaVersion !== 1 || !data.locations || !data.coverage || !Array.isArray(data.events)) {
    throw new Error('Campus snapshot has an unsupported format');
  }
  return data;
}

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export function dateForWeekday(data: CampusData, weekday: number): string {
  const date = new Date(`${data.referenceWeekStart}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + weekday);
  return date.toISOString().slice(0, 10);
}

export function meetingActiveOnDate(meeting: SourceMeeting, date: string): boolean {
  return !meeting.calendarRestricted && (!meeting.validFrom || date >= meeting.validFrom)
    && (!meeting.validTo || date <= meeting.validTo);
}
