// The only door pages use to get or change data. Today it answers from fixtures held in memory;
// when /server exists, each function becomes a fetch to the same-named endpoint.

import { useCallback, useEffect, useState } from 'react';
import * as fx from './fixtures';
import type {
  ApplicationStatus,
  CampusLocation,
  ClubApplication,
  CourseOffering,
  DataSource,
  MyCourse,
  ScheduleItem,
  Session,
  SimulationSettings,
  StatRange,
  Weekday,
} from './types';
import type { ClubDetails, NotificationPrefs, Profile } from './types';
import type { AdminSettings } from './types';
import type { Persona } from '../lib/personaShared';
import { getMyPersonaId, getPersonas as getStoredPersonas, removePersona as removeStoredPersona, setMyPersonaId, upsertPersona } from '../lib/personaStore';

const LATENCY_MS = 150;
const later = <T,>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), LATENCY_MS));

// Mutable copies, so changes made in the UI stick for the session.
let simulation = structuredClone(fx.simulationSettings);
let applications = structuredClone(fx.clubApplications);
let clubs = structuredClone(fx.clubs);
let sources = structuredClone(fx.dataSources);
let imports = structuredClone(fx.calendarImports);
let schedule = structuredClone(fx.schedule);
let suggestions = structuredClone(fx.suggestions);
let myCourses = structuredClone(fx.myCourses);

let profile = structuredClone(fx.profile);
let calendarConnection = structuredClone(fx.calendarConnection);
let notificationPrefs = structuredClone(fx.notificationPrefs);
let adminSettings = structuredClone(fx.adminSettings);

const WEEKDAY_JS_INDEX: Record<Weekday, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const WEEKDAY_BY_JS_INDEX: Weekday[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COURSE_WINDOW_DAYS = 14; // how far ahead a course's meetings are generated/kept
const EXAM_RE = /\bexam\b/i;
// "CAS CS 112", "ENG BE 704", "CS 112": one or two 2-4 letter codes, then a course number.
const COURSE_CODE_RE = /\b([A-Z]{2,4}(?:\s+[A-Z]{2,4})?\s+\d{2,4}[A-Z]?)\b/;

function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'course';
}
function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Best-effort match of free text (an .ics LOCATION, say) to a known campus location. */
function matchLocation(text: string | null): string | null {
  if (!text) return null;
  const hay = text.toLowerCase();
  const hit = fx.locations.find((l) => hay.includes(l.short.toLowerCase()) || hay.includes(l.name.toLowerCase()));
  return hit?.id ?? null;
}

type CoursePattern = Pick<MyCourse, 'id' | 'code' | 'days' | 'startTime' | 'endTime' | 'locationId'>;

/** Every meeting of a course's weekly pattern that falls in the next `COURSE_WINDOW_DAYS` days. */
function occurrencesForCourse(course: CoursePattern): ScheduleItem[] {
  const [sh, sm] = course.startTime.split(':').map(Number);
  const [eh, em] = course.endTime.split(':').map(Number);
  const items: ScheduleItem[] = [];
  for (let i = 0; i < COURSE_WINDOW_DAYS; i++) {
    const day = new Date();
    day.setDate(day.getDate() + i);
    if (!course.days.some((d) => WEEKDAY_JS_INDEX[d] === day.getDay())) continue;
    const start = new Date(day);
    start.setHours(sh, sm, 0, 0);
    const end = new Date(day);
    end.setHours(eh, em, 0, 0);
    items.push({ id: `course-${course.id}-${start.toISOString()}`, title: course.code, locationId: course.locationId, start: start.toISOString(), end: end.toISOString(), source: 'course', courseId: course.id });
  }
  return items;
}

/** Replaces a course's generated meetings after it's added or edited. */
function regenerate(course: CoursePattern) {
  schedule = [...schedule.filter((s) => s.courseId !== course.id), ...occurrencesForCourse(course)];
}

/**
 * Looks up a course code pulled from free text (an .ics SUMMARY) against the real catalog. When a
 * course has several sections, prefers the one whose meeting days overlap the text's own parsed
 * days, so an import lands on the right section rather than just the first one alphabetically.
 */
function findCatalogMatch(title: string, observedDays: Set<Weekday>): CourseOffering | null {
  const codeMatch = COURSE_CODE_RE.exec(title);
  if (!codeMatch) return null;
  const code = normalizeCode(codeMatch[1]);
  const candidates = fx.courseCatalog.filter((o) => normalizeCode(o.code) === code);
  if (!candidates.length) return null;
  return candidates.reduce((best, c) => {
    const overlap = c.days.filter((d) => observedDays.has(d)).length;
    const bestOverlap = best.days.filter((d) => observedDays.has(d)).length;
    return overlap > bestOverlap ? c : best;
  });
}

type PlannedCourse = Omit<MyCourse, 'addedAt'> & { alreadyAdded: boolean };

/**
 * Groups parsed .ics occurrences into one planned course per distinct title, tries to recognize
 * each against the real catalog by code, and drops exam blocks. Pure (no mutation), so the preview
 * step and the actual commit always agree on what an import will produce.
 */
function planCourseImport(occurrences: { title: string; location: string | null; start: string; end: string }[]): PlannedCourse[] {
  const groups = new Map<string, { title: string; location: string | null; meetings: { start: Date; end: Date }[] }>();
  for (const occ of occurrences) {
    if (EXAM_RE.test(occ.title)) continue;
    const key = occ.title.trim().toLowerCase();
    const meeting = { start: new Date(occ.start), end: new Date(occ.end) };
    const g = groups.get(key);
    if (g) g.meetings.push(meeting);
    else groups.set(key, { title: occ.title, location: occ.location, meetings: [meeting] });
  }

  const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const planned: PlannedCourse[] = [];
  const seenIds = new Set<string>();
  for (const g of groups.values()) {
    const observedDays = new Set(g.meetings.map((m) => WEEKDAY_BY_JS_INDEX[m.start.getDay()]));
    const match = findCatalogMatch(g.title, observedDays);
    const id = match ? match.id : `ics:${slugify(g.title)}`;
    if (seenIds.has(id)) continue;
    seenIds.add(id);
    const alreadyAdded = myCourses.some((c) => c.id === id);

    if (match) {
      planned.push({ id: match.id, code: match.code, title: match.title, section: match.section, instructor: match.instructor, days: match.days, startTime: match.startTime, endTime: match.endTime, locationId: match.locationId, source: 'ics', alreadyAdded });
    } else {
      const first = g.meetings.slice().sort((a, b) => a.start.getTime() - b.start.getTime())[0];
      const locationId = matchLocation(g.location) ?? fx.session.user.homeLocationId ?? fx.locations[0].id;
      planned.push({ id, code: g.title, title: g.title, days: [...observedDays], startTime: clock(first.start), endTime: clock(first.end), locationId, source: 'ics', alreadyAdded });
    }
  }
  return planned;
}

export const api = {
  // Student
  getSession: (): Promise<Session> => later(fx.session),
  getCourseCatalog: (): Promise<CourseOffering[]> => later(fx.courseCatalog),
  getMyCourses: (): Promise<MyCourse[]> => later(myCourses),
  /** Adds a catalog offering: records it under "my courses" and generates its upcoming meetings. */
  addCourse(offeringId: string) {
    if (!myCourses.some((c) => c.id === offeringId)) {
      const o = fx.courseCatalog.find((c) => c.id === offeringId);
      if (!o) return Promise.reject(new Error(`No course offering with id ${offeringId}`));
      const course: MyCourse = { id: o.id, code: o.code, title: o.title, section: o.section, instructor: o.instructor, days: o.days, startTime: o.startTime, endTime: o.endTime, locationId: o.locationId, source: 'catalog', addedAt: new Date().toISOString() };
      myCourses = [...myCourses, course];
      regenerate(course);
    }
    return later({ myCourses, schedule });
  },
  /**
   * Edits any added course in place -- its own meeting pattern, not just a note -- and regenerates
   * its upcoming meetings from the new pattern. Works the same whether it came from the catalog or
   * an .ics import.
   */
  updateCourse(courseId: string, patch: Partial<Pick<MyCourse, 'code' | 'title' | 'section' | 'instructor' | 'days' | 'startTime' | 'endTime' | 'locationId'>>) {
    const existing = myCourses.find((c) => c.id === courseId);
    if (!existing) return Promise.reject(new Error(`No course with id ${courseId}`));
    if (patch.days && !patch.days.length) return Promise.reject(new Error('A course needs at least one meeting day.'));
    const updated: MyCourse = { ...existing, ...patch };
    myCourses = myCourses.map((c) => (c.id === courseId ? updated : c));
    regenerate(updated);
    return later({ myCourses, schedule });
  },
  /** Drops a course, whether it came from the catalog or an .ics import, and its generated meetings. */
  removeCourse(courseId: string) {
    myCourses = myCourses.filter((c) => c.id !== courseId);
    schedule = schedule.filter((s) => s.courseId !== courseId);
    return later({ myCourses, schedule });
  },
  /** The window newly-added or imported courses' meetings are generated into, for the ics preview step. */
  getCourseImportWindow(): { start: Date; end: Date } {
    const start = new Date();
    const end = new Date();
    end.setDate(end.getDate() + COURSE_WINDOW_DAYS);
    return { start, end };
  },
  /**
   * What importing these parsed .ics occurrences would add, without changing anything yet: one
   * planned course per distinct class, recognized against the real catalog where possible, exam
   * blocks already dropped. Shows the student exactly what `addCoursesFromIcs` will commit.
   */
  previewCourseImport: (occurrences: { title: string; location: string | null; start: string; end: string }[]): Promise<PlannedCourse[]> =>
    later(planCourseImport(occurrences)),
  /**
   * Commits meetings already parsed and expanded on the client (see lib/ics.ts): groups same-titled
   * meetings into one course each, tries to recognize each one against the real course catalog by
   * its code (using the catalog's own days/time/room/instructor when it matches a section, since
   * that's more reliable than a personal calendar export), and adds the result to the schedule.
   * Exam blocks are dropped rather than treated as a weekly class pattern.
   */
  addCoursesFromIcs(occurrences: { title: string; location: string | null; start: string; end: string }[]) {
    const planned = planCourseImport(occurrences).filter((p) => !p.alreadyAdded);
    const added: MyCourse[] = planned.map(({ alreadyAdded: _alreadyAdded, ...course }) => ({ ...course, addedAt: new Date().toISOString() }));
    myCourses = [...myCourses, ...added];
    for (const course of added) regenerate(course);
    return later({ addedCount: added.length, myCourses, schedule });
  },
  // Personas (join by QR -> /join). Uniquely among this file's state, these read/write straight
  // to localStorage (see lib/personaStore.ts) instead of an in-memory fixture, because map-client
  // reads that same storage to put the persona on the live map -- see that file for why this is
  // same-browser only, not true cross-device sync, until /server exists.
  getMyPersona(): Promise<Persona | null> {
    const id = getMyPersonaId();
    return later(id ? (getStoredPersonas().find((p) => p.id === id) ?? null) : null);
  },
  createPersona(input: Omit<Persona, 'id' | 'createdAt'>): Promise<Persona> {
    const persona: Persona = { ...input, id: `persona-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, createdAt: new Date().toISOString() };
    upsertPersona(persona);
    setMyPersonaId(persona.id);
    return later(persona);
  },
  updateMyPersona(patch: Partial<Omit<Persona, 'id' | 'createdAt'>>): Promise<Persona> {
    const id = getMyPersonaId();
    const current = id ? getStoredPersonas().find((p) => p.id === id) : undefined;
    if (!current) return Promise.reject(new Error('No persona to update yet -- create one first.'));
    const updated: Persona = { ...current, ...patch };
    upsertPersona(updated);
    return later(updated);
  },
  deleteMyPersona(): Promise<void> {
    const id = getMyPersonaId();
    if (id) removeStoredPersona(id);
    return later(undefined);
  },
  getLocations: () => later(fx.locations),
  getSchedule: () => later(schedule),
  getPlaceForecasts: () => later(fx.placeForecasts),
  getHourlyForecasts: () => later(fx.hourlyForecasts),
  getSuggestions: () => later(suggestions),
  /** Confirms a suggestion: its suggested schedule item becomes part of the day. Returns what's left. */
  acceptSuggestion(id: string) {
    const accepted = suggestions.find((g) => g.id === id);
    if (accepted?.scheduleItemId) {
      schedule = schedule.map((s) => (s.id === accepted.scheduleItemId ? { ...s, accepted: true } : s));
    }
    suggestions = suggestions.filter((g) => g.id !== id);
    return later(suggestions);
  },
  getWeekStats: (range: StatRange = '7d') => later(range === '30d' ? fx.monthStats : fx.weekStats),
  getCampusEvents: () => later(fx.campusEvents),
  getClubs: () => later(clubs),
  setFollowing(clubId: string, following: boolean) {
    clubs = clubs.map((c) => (c.id === clubId ? { ...c, following } : c));
    return later(clubs);
  },

  // Account
  getProfile: () => later(profile),
  updateProfile(patch: Partial<Profile>) {
    profile = { ...profile, ...patch };
    return later(profile);
  },
  getCalendarConnection: () => later(calendarConnection),
  setCalendarRead(calendarId: string, read: boolean) {
    calendarConnection = {
      ...calendarConnection,
      calendars: calendarConnection.calendars.map((c) => (c.id === calendarId ? { ...c, read } : c)),
    };
    return later(calendarConnection);
  },
  syncCalendars() {
    calendarConnection = { ...calendarConnection, syncedAt: new Date().toISOString() };
    return later(calendarConnection);
  },
  disconnectCalendar() {
    calendarConnection = { connected: false, email: null, syncedAt: null, calendars: [] };
    return later(calendarConnection);
  },
  connectCalendar() {
    calendarConnection = { ...structuredClone(fx.calendarConnection), syncedAt: new Date().toISOString() };
    return later(calendarConnection);
  },
  getNotificationPrefs: () => later(notificationPrefs),
  updateNotificationPrefs(patch: Partial<NotificationPrefs>) {
    notificationPrefs = { ...notificationPrefs, ...patch };
    return later(notificationPrefs);
  },
  /** Everything Flowcast keeps about the signed-in person, as one JSON-friendly object. */
  exportMyData: () =>
    later({
      exportedAt: new Date().toISOString(),
      account: { name: fx.session.user.name, email: fx.session.user.email },
      profile,
      calendars: calendarConnection.calendars.filter((c) => c.read).map((c) => c.name),
      events: fx.schedule
        .filter((s) => s.source === 'calendar')
        .map((s) => ({ title: s.title, start: s.start, end: s.end, locationId: s.locationId })),
    }),
  deleteMyData() {
    profile = { ...structuredClone(fx.profile), homeLocationId: null, studySpotId: null };
    calendarConnection = { connected: false, email: null, syncedAt: null, calendars: [] };
    return later(true);
  },

  // Club officers
  getClubDetails(clubId: string) {
    const club = clubs.find((c) => c.id === clubId);
    if (!club) return Promise.reject(new Error(`No club with id ${clubId}`));
    const extra = fx.clubDetails[clubId] ?? { listingUrl: '', officers: [], verifiedAt: null, followers: club.members };
    const details: ClubDetails = { ...club, ...extra };
    return later(details);
  },
  getCalendarImports: (clubId: string) => later(imports.filter((i) => i.clubId === clubId)),
  uploadClubCalendar(clubId: string, fileName: string, eventCount: number) {
    const entry = { id: `imp${Date.now()}`, clubId, fileName, importedAt: new Date().toISOString(), eventCount, error: null };
    imports = [entry, ...imports];
    return later(entry);
  },
  submitClubApplication(input: Pick<ClubApplication, 'clubName' | 'officerName' | 'officerEmail' | 'listingUrl' | 'description'>) {
    const app: ClubApplication = {
      ...input,
      id: `app${Date.now()}`,
      submittedAt: new Date().toISOString(),
      status: 'pending',
      checks: [
        { id: 'email', label: 'Officer uses a bu.edu email', passed: input.officerEmail.endsWith('@bu.edu') },
        { id: 'listing', label: 'Club appears on BU Engage', passed: null },
        { id: 'officer', label: 'Officer is listed on the club page', passed: null },
      ],
    };
    applications = [app, ...applications];
    return later(app);
  },

  // Admin
  getDataSources: () => later(sources),
  updateDataSource(id: string, patch: Partial<DataSource>) {
    sources = sources.map((s) => (s.id === id ? { ...s, ...patch } : s));
    return later(sources.find((s) => s.id === id)!);
  },
  /** Try a source with the given (possibly unsaved) settings. Nothing is stored. */
  testDataSource(id: string, settings: DataSource['settings']): Promise<{ ok: boolean; message: string }> {
    const missing = settings.find((f) => f.secret && !f.value.trim());
    const result =
      id === 'tiles' && missing
        ? { ok: true, message: 'Connected to OpenFreeMap. Add a Mapbox token to use Mapbox tiles instead.' }
        : missing
          ? { ok: false, message: `Couldn't connect: the ${missing.label.replace(/^[A-Z](?=[a-z])/, (c) => c.toLowerCase())} is missing.` }
          : { ok: true, message: `Connected in ${120 + Math.round(Math.random() * 200)} ms.` };
    return new Promise((resolve) => setTimeout(() => resolve(result), LATENCY_MS * 5));
  },
  getSimulation: () => later(simulation),
  updateSimulation(patch: Partial<SimulationSettings>) {
    simulation = { ...simulation, ...patch };
    return later(simulation);
  },
  getPlaybackSpeeds: () => later(fx.playbackSpeeds),
  getClubApplications: () => later(applications),
  setApplicationStatus(id: string, status: ApplicationStatus, note?: string) {
    const reviewed = status === 'pending' ? { reviewNote: undefined, reviewedAt: undefined } : { reviewNote: note || undefined, reviewedAt: new Date().toISOString() };
    applications = applications.map((a) => (a.id === id ? { ...a, status, ...reviewed } : a));
    return later(applications.find((a) => a.id === id)!);
  },
  getAdminUsers: () => later(fx.adminUsers),
  /** Put the shared map back to its starting settings (used by the live demo). */
  resetSimulation() {
    simulation = structuredClone(fx.simulationSettings);
    return later(simulation);
  },
  getAgentBrain: () => later(fx.agentBrain),
  getAdminSettings: () => later(adminSettings),
  updateAdminSettings(patch: Partial<AdminSettings>) {
    adminSettings = { ...adminSettings, ...patch };
    return later(adminSettings);
  },
  /** Deletes every persona profile, habit and synced calendar. Accounts stay. */
  deletePersonaData() {
    adminSettings = { ...adminSettings, personaProfiles: 0 };
    return later(adminSettings);
  },
};

/** Load something from the api, with loading/error state and a way to reload or replace it. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    load()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(reload, [reload]);
  return { data, error, loading, reload, setData };
}

/** Look up a location by id from a loaded list; pages use this to turn ids into names. */
export function locationName(list: CampusLocation[] | null, id: string, short = true): string {
  const loc = list?.find((l) => l.id === id);
  return loc ? (short ? loc.short : loc.name) : id;
}
