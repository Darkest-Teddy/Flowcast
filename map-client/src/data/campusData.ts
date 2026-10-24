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
  id: string;
  courseCode: string;
  title: string;
  section: string;
  roomCode: string;
  intervals: { weekday: number; startSec: number; endSec: number }[];
  roomCapacity: number | null;
  notes: string | null;
  calendarRestricted: boolean;
  sharedKey: string | null;
  sourceUrl: string;
}

export interface OpeningHours {
  date: string | null;
  windows: [number, number][]; // local seconds; overnight closing may exceed 86400
  text: string;
  sourceUrl: string;
  qualifier: string | null;
}

export interface SourceLocation {
  id: string;
  buildingCodes: string[];
  meetings: SourceMeeting[];
  evidence: Evidence[];
  hours: OpeningHours[];
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

export interface CampusData {
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
