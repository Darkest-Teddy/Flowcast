// The only data door for dashboard pages; dashboard state comes from the server.
import { useCallback, useEffect, useState } from 'react';
import { sourcesFromCampusBundle } from './sourceCatalog';
import { studySpots } from './studySpots';
import type { StudyHoursByLocation } from '../lib/studyFinder';
import type { VenueCalendar } from '../lib/morningBrief';
import { auth } from '../auth/client';
import { config } from '../config';
import { createDashboardClient } from './realData';
import { agentConfigured, askAgentWithRetry, type AgentResult, type AgentMessage } from '@map/askClient';
import { bostonClock } from '../lib/askRouting';
import { eventSlotsQuery, parseEventSlots, type EventPlan } from '../lib/eventSlots';
import { parseChatResponse, parseDirectoryResponse, type ChatResult, type DirectoryResult } from '../lib/chatParse';
import type { PersonalSchedule } from '@map/personalSchedule';
import type { ClassDirectory } from '../../../map-client/src/classSearch';
import type { CampusData as CampusBundle } from '../../../map-client/src/data/campusData';
import type { ClassFinderData } from '../lib/classFinder';
import { effectiveMeetingIntervals } from '@map/data/academicCalendar';
import type { CampusData } from '@map/data/campusData';
import type { ClassMeeting } from '../lib/freeClassrooms';
import type { ChatRequest } from '@map/chatContract';
import type {
  AdminSettings, AdminUser, AgentBrain, ApplicationStatus, CalendarConnection, CalendarImport,
  CampusEvent, CampusLocation, ClubApplication, ClubDetails, CrowdAnswer, CrowdReportSummary, DataSource, EventImpactData,
  NotificationPrefs, Profile, ScheduleItem, ScheduleImportState, SchedulePreview, SimulationSettings, StatRange, Suggestion, WeekStat,
  ClubAnnouncement, ClubMeetingsPublic, ClubNotification, ConflictReport, MeetingInput, MemberAvailability, OfficerMeeting, OrgMe,
  AttendanceReport, CheckinCode, ClubMembers, ClubOfficer, ClubProfile, ClubStats, CohostInvite, Fair, MeetingTask, MeetingWeather, VenueEvent,
} from './types';

const copy = <T,>(value: T): Promise<T> => Promise.resolve(structuredClone(value));
const unsupported = <T,>(action: string): Promise<T> => Promise.reject(new Error(`${action} is unavailable: no connected backend supports this operation.`));
const dashboard = createDashboardClient(undefined, () => auth.headers());
export function resetAccountData() {
  dashboard.reset();
  try { window.sessionStorage.removeItem('flowcast.askChat.v1'); } catch { /* Storage may be disabled. */ }
}
async function clubs() {
  const [data, me] = await Promise.all([dashboard.getPublic(), dashboard.getMe()]);
  return data.clubs.map((club) => ({ ...club, following: me.following.includes(club.id) }));
}

/** A chat answer can take several tool calls; the server has its own model timeout (504) inside this. */
const CHAT_TIMEOUT_MS = 60_000;

/** One POST /api/chat. Never throws: failures come back as typed errors. */
async function postChat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResult> {
  const timeout = AbortSignal.timeout(CHAT_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
      signal: combined,
    });
    const body: unknown = await response.json().catch((error: unknown) => {
      if (combined.aborted) throw error;
      return null;
    });
    return parseChatResponse(response.status, body, response.headers.get('Retry-After'), config.mapUrl);
  } catch {
    if (signal?.aborted) return { ok: false, error: { kind: 'aborted', message: 'Stopped.' } };
    if (timeout.aborted) return { ok: false, error: { kind: 'timeout', message: 'The answer took too long.' } };
    return { ok: false, error: { kind: 'network', message: 'Couldn’t reach the Ask server.' } };
  }
}

/** Waits `ms`, or resolves false early when `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const id = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(true); }, ms);
    const stop = () => { clearTimeout(id); resolve(false); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/** The published class schedule and its sidecar, loaded once per page load (campus-data.json is ~3 MB). */
let classFinderLoad: Promise<ClassFinderData & { data: CampusBundle }> | null = null;
function loadClassFinder() {
  classFinderLoad ??= Promise.all([
    fetch('/data/campus-data.json').then((r) => { if (!r.ok) throw new Error('The published class schedule could not be loaded.'); return r.json() as Promise<CampusBundle>; }),
    fetch('/data/class-directory.json').then((r) => (r.ok ? r.json() as Promise<ClassDirectory> : { buildings: {}, instructors: {} }), () => ({ buildings: {}, instructors: {} })),
  ]).then(([data, directory]) => {
    if (!data.locations || typeof data.locations !== 'object') throw new Error('The published class schedule is unavailable.');
    const meetings = Object.entries(data.locations).flatMap(([locationId, l]) => (l.meetings ?? []).map((meeting) => ({ locationId, meeting })));
    return { meetings, directory, data };
  });
  classFinderLoad.catch(() => { classFinderLoad = null; });
  return classFinderLoad;
}

export const api = {
  /** Published class meetings with building names/addresses and instructors, for class search. */
  getClassFinder: (): Promise<ClassFinderData> => loadClassFinder().then(({ meetings, directory }) => ({ meetings, directory })),
  /** The simulation's behaviour modifiers (behavior.json), for quoting exam-season assumptions. */
  async getBehaviorModifiers(): Promise<{ modifiers?: { id: string; when?: { period?: string[] }; effects?: { target: string; op: string; value: number }[]; provenance?: { note?: string; source?: string } }[] }> {
    const response = await fetch('/data/behavior.json');
    if (!response.ok) throw new Error('The conditions model could not be loaded.');
    return response.json();
  },
  /** The campus bundle (academic calendar, class meetings) for exam-season mode. */
  getCampusBundle: (): Promise<CampusBundle> => loadClassFinder().then(({ data }) => data),
  getStudySpots: () => copy(studySpots),
  /** Venue events near campus (Red Sox, Agganis, MGM Music Hall, BU home games) as published, with venue capacities. */
  async getVenueCalendar(): Promise<VenueCalendar> {
    const response = await fetch('/data/event-calendar.json');
    if (!response.ok) throw new Error('The venue event calendar could not be loaded.');
    const data = await response.json();
    if (!Array.isArray(data?.venues) || !Array.isArray(data?.events)) throw new Error('The venue event calendar is unavailable.');
    return { venues: data.venues, events: data.events, referenceEvents: Array.isArray(data.referenceEvents) ? data.referenceEvents : [] };
  },
  /** Published hours for every mapped place (dining halls, libraries, FitRec...), as the study finder reads them. */
  async getPlaceHours(): Promise<StudyHoursByLocation> {
    const response = await fetch('/data/campus-data.json');
    if (!response.ok) throw new Error('Published opening hours could not be loaded.');
    const data = await response.json();
    if (!data.locations || typeof data.locations !== 'object') throw new Error('Published hours are unavailable.');
    return Object.fromEntries(Object.entries(data.locations as Record<string, { hours?: StudyHoursByLocation[string]['hours']; hoursStatus?: string }>)
      .map(([id, location]) => [id, { hours: location.hours ?? [], hoursStatus: location.hoursStatus }]));
  },
  async getStudyHours(): Promise<StudyHoursByLocation> {
    const response = await fetch('/data/campus-data.json');
    if (!response.ok) throw new Error('Published study-space hours could not be loaded.');
    const data = await response.json();
    if (!data.locations || typeof data.locations !== 'object') throw new Error('Published hours are unavailable.');
    return Object.fromEntries(studySpots.map(spot => {
      const location = data.locations[spot.locationId];
      return [spot.locationId, { hours: location?.hours ?? [], hoursStatus: location?.hoursStatus }];
    }));
  },
  /** Published class meetings by room, on the reference week's actual class days (term dates, holidays and substituted days applied). */
  async getClassMeetings(): Promise<ClassMeeting[]> {
    const response = await fetch('/data/campus-data.json');
    if (!response.ok) throw new Error('The published class schedule could not be loaded.');
    const data = await response.json() as CampusData;
    if (!data.locations || typeof data.locations !== 'object') throw new Error('The published class schedule is unavailable.');
    return Object.entries(data.locations).flatMap(([locationId, location]) => (location.meetings ?? []).flatMap((meeting) => {
      const intervals = effectiveMeetingIntervals(meeting, data).map(({ startSec, endSec }) => ({ startSec, endSec }));
      return intervals.length ? [{ locationId, roomCode: meeting.roomCode, seats: meeting.roomCapacity, intervals }] : [];
    }));
  },
  getSession: () => dashboard.getMe().then((data) => data.session),
  getLocations: () => dashboard.getPublic().then((data) => data.locations),
  getSchedule: (): Promise<ScheduleItem[]> => dashboard.request<ScheduleImportState>('/schedule').then((state) => state.items),
  getScheduleImport: () => dashboard.request<ScheduleImportState>('/schedule'),
  previewSchedule: (fileName: string, content: string) => dashboard.request<SchedulePreview>('/schedule/preview', 'POST', { fileName, content }),
  importSchedule: (fileName: string, items: ScheduleItem[]) => dashboard.mutate<ScheduleImportState>('/schedule', 'PUT', { fileName, items }),
  clearSchedule: () => dashboard.mutate<ScheduleImportState>('/schedule', 'DELETE'),
  getPlaceForecasts: () => dashboard.getPublic().then((data) => data.places),
  getHourlyForecasts: () => dashboard.getPublic().then((data) => data.hourly),
  getBestTimes: () => dashboard.getPublic().then((data) => data.bestTimes ?? []),
  /** Rooms and evenings for a club event (GET /api/dashboard/event-slots). Reads schedules and model figures; never books. */
  getEventSlots: (plan: EventPlan) => dashboard.request<unknown>(`/event-slots?${eventSlotsQuery(plan)}`).then(parseEventSlots),
  getCampusGeo: () => dashboard.getPublic().then((data) => data.geo),
  /** Anonymous "Was it busy?" counts for the last week (public read). Shown beside projections, never fed into them. */
  async getCrowdReports(): Promise<CrowdReportSummary> {
    const response = await fetch('/api/dashboard/crowd-reports', { cache: 'no-store', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Student crowd reports are unavailable.');
    return response.json();
  },
  /** Adds one anonymous count for this place and Boston hour. `at` (when the student was there) is rounded to the hour by the server. */
  reportCrowd: (locationId: string, answer: CrowdAnswer, at?: number) =>
    dashboard.request<void>('/crowd-reports', 'POST', { locationId, answer, ...(at === undefined ? {} : { at: new Date(at).toISOString() }) }),
  getSuggestions: (): Promise<Suggestion[]> => unsupported('Personalized suggestions'),
  acceptSuggestion: (_id: string): Promise<Suggestion[]> => unsupported('Schedule suggestions'),
  async askCampus(question: string, at: Date, signal?: AbortSignal, onWarming?: (retryAfterSec: number) => void, history?: AgentMessage[], personalSchedule?: PersonalSchedule): Promise<AgentResult> {
    if (!(await agentConfigured())) return { ok: false, error: { kind: 'notConfigured', message: 'Ask is not configured on the server.' } };
    const { weekday, time } = bostonClock(at);
    return askAgentWithRetry({ question: question.trim().slice(0, 300), weekday, time, campus: 'charles-river', history, personalSchedule }, signal, { onWarming });
  },
  /**
   * One turn of the Ask chat (POST /api/chat; shapes in map-client/src/chatContract.ts). While the
   * server is still simulating the day (503 with Retry-After) it calls `onWarming` and asks again
   * after the wait, up to twice. Schedule context is supplied per request. Resolves to a typed error, never rejects.
   */
  async chat(request: ChatRequest, signal?: AbortSignal, onWarming?: (retryAfterSec: number) => void): Promise<ChatResult> {
    let result = await postChat(request, signal);
    for (let attempt = 0; attempt < 2 && !result.ok && result.error.kind === 'warming'; attempt++) {
      onWarming?.(result.error.retryAfter ?? 10);
      if (!(await pause((result.error.retryAfter ?? 10) * 1000, signal))) return { ok: false, error: { kind: 'aborted', message: 'Stopped.' } };
      result = await postChat(request, signal);
    }
    return result;
  },
  /** What the chat can answer from (GET /api/chat/directory). Works without an OpenAI key. Never rejects. */
  async chatDirectory(signal?: AbortSignal): Promise<DirectoryResult> {
    try {
      const response = await fetch('/api/chat/directory', { headers: { Accept: 'application/json' }, signal: signal ?? AbortSignal.timeout(10_000) });
      const body: unknown = await response.json().catch(() => null);
      return parseDirectoryResponse(response.status, body);
    } catch {
      return { ok: false, error: { kind: 'unreachable', message: 'The Ask server isn’t running.' } };
    }
  },
  getWeekStats: (_range: StatRange = '7d'): Promise<WeekStat[]> => unsupported('Measured weekly activity statistics'),
  getCampusEvents: (): Promise<CampusEvent[]> => dashboard.getPublic().then((data) => data.events),
  getEventImpact: (): Promise<EventImpactData> => dashboard.getPublic().then((data) => data.impact),
  getClubs: clubs,
  async setFollowing(clubId: string, following: boolean) {
    await dashboard.mutate<string[]>(`/following/${encodeURIComponent(clubId)}`, 'PUT', { following });
    return clubs();
  },
  getProfile: () => dashboard.getMe().then((data) => data.profile),
  updateProfile: (patch: Partial<Profile>) => dashboard.mutate<Profile>('/profile', 'PATCH', patch),
  getCalendarConnection: (): Promise<CalendarConnection> => unsupported('Google Calendar connection status'),
  setCalendarRead: (_calendarId: string, _read: boolean): Promise<CalendarConnection> => unsupported('Calendar selection'),
  syncCalendars: (): Promise<CalendarConnection> => unsupported('Calendar sync'),
  disconnectCalendar: (): Promise<CalendarConnection> => unsupported('Calendar disconnection'),
  connectCalendar: (): Promise<CalendarConnection> => unsupported('Google Calendar connection'),
  getNotificationPrefs: () => dashboard.getMe().then((data) => data.notificationPrefs),
  updateNotificationPrefs: (patch: Partial<NotificationPrefs>) => dashboard.mutate<NotificationPrefs>('/preferences', 'PATCH', patch),

  // Student organizations (server/src/dashboard/orgs.ts).
  getOrgMe: () => dashboard.request<OrgMe>('/orgs/me'),
  getClubMeetings: () => dashboard.request<ClubMeetingsPublic>('/club-meetings'),
  setRsvp: (eventId: string, going: boolean) => dashboard.request<{ eventId: string; going: boolean; count: number }>(`/rsvps/${encodeURIComponent(eventId)}`, 'PUT', { going }),
  setSharingFreeTime: (clubId: string, share: boolean) => dashboard.request<{ clubId: string; share: boolean }>(`/clubs/${encodeURIComponent(clubId)}/share-availability`, 'PUT', { share }),
  getClubNotifications: () => dashboard.request<{ enabled: boolean; items: ClubNotification[] }>('/notifications'),
  markClubNotificationsRead: () => dashboard.request<void>('/notifications/read', 'POST'),
  requestOfficerRole: (clubId: string, officerName: string, note: string) => dashboard.request<ClubApplication>('/officer-requests', 'POST', { clubId, officerName, note }),
  postClubMeeting: (clubId: string, input: MeetingInput) => dashboard.request<OfficerMeeting>(`/clubs/${encodeURIComponent(clubId)}/meetings`, 'POST', input),
  updateClubMeeting: (clubId: string, id: string, patch: Partial<MeetingInput> & { cancelled?: boolean }) => dashboard.request<OfficerMeeting>(`/clubs/${encodeURIComponent(clubId)}/meetings/${id}`, 'PATCH', patch),
  postClubAnnouncement: (clubId: string, body: string) => dashboard.request<{ ok: true }>(`/clubs/${encodeURIComponent(clubId)}/announcements`, 'POST', { body }),
  getClubAnnouncements: (clubId: string) => dashboard.request<ClubAnnouncement[]>(`/clubs/${encodeURIComponent(clubId)}/announcements`),
  getMemberAvailability: (clubId: string) => dashboard.request<MemberAvailability>(`/clubs/${encodeURIComponent(clubId)}/availability`),
  getConflicts: (date: string, near: string | null) => dashboard.request<ConflictReport>(`/conflicts?${new URLSearchParams({ date, ...(near ? { near } : {}) })}`),
  postClubSeries: (clubId: string, input: MeetingInput, repeatUntil: string | null) => dashboard.request<OfficerMeeting & { series?: OfficerMeeting[] }>(`/clubs/${encodeURIComponent(clubId)}/meetings`, 'POST', { ...input, repeatUntil }),
  updateClubMeetingScope: (clubId: string, id: string, patch: Partial<MeetingInput> & { cancelled?: boolean }, scope: 'one' | 'series') => dashboard.request<OfficerMeeting>(`/clubs/${encodeURIComponent(clubId)}/meetings/${id}`, 'PATCH', { ...patch, scope }),
  getCheckinCode: (clubId: string, meetingId: string) => dashboard.request<CheckinCode>(`/clubs/${encodeURIComponent(clubId)}/meetings/${meetingId}/checkin`),
  checkIn: (meetingId: string, code: string) => dashboard.request<{ meetingId: string; title: string; clubId: string; clubName: string }>('/checkins', 'POST', { meetingId, code }),
  getAttendance: (clubId: string) => dashboard.request<AttendanceReport>(`/clubs/${encodeURIComponent(clubId)}/attendance`),
  getClubOfficers: (clubId: string) => dashboard.request<ClubOfficer[]>(`/clubs/${encodeURIComponent(clubId)}/officers`),
  addClubOfficer: (clubId: string, email: string, title: string) => dashboard.request<{ ok: true }>(`/clubs/${encodeURIComponent(clubId)}/officers`, 'POST', { email, title }),
  setOfficerTitle: (clubId: string, accountId: string, title: string) => dashboard.request<{ ok: true }>(`/clubs/${encodeURIComponent(clubId)}/officers/${accountId}`, 'PATCH', { title }),
  removeClubOfficer: (clubId: string, accountId: string) => dashboard.request<void>(`/clubs/${encodeURIComponent(clubId)}/officers/${accountId}`, 'DELETE'),
  getClubMembers: (clubId: string) => dashboard.request<ClubMembers>(`/clubs/${encodeURIComponent(clubId)}/members`),
  setNameVisible: (clubId: string, visible: boolean) => dashboard.request<{ clubId: string; visible: boolean }>(`/clubs/${encodeURIComponent(clubId)}/visibility`, 'PUT', { visible }),
  getMyClubExtras: () => dashboard.request<{ visibleTo: string[]; checkedIn: string[] }>('/clubs-me'),
  getClubStats: (clubId: string) => dashboard.request<ClubStats>(`/clubs/${encodeURIComponent(clubId)}/stats`),
  setClubProfile: (clubId: string, profile: ClubProfile) => dashboard.request<ClubProfile>(`/clubs/${encodeURIComponent(clubId)}/profile`, 'PUT', profile),
  getClubProfiles: () => dashboard.request<Record<string, ClubProfile>>('/club-profiles'),
  inviteCohost: (clubId: string, meetingId: string, cohostClubId: string) => dashboard.request<{ ok: true }>(`/clubs/${encodeURIComponent(clubId)}/meetings/${meetingId}/cohosts`, 'POST', { clubId: cohostClubId }),
  getCohostInvites: (clubId: string) => dashboard.request<CohostInvite[]>(`/clubs/${encodeURIComponent(clubId)}/cohost-invites`),
  answerCohostInvite: (inviteId: string, accept: boolean) => dashboard.request<OfficerMeeting>(`/cohost-invites/${inviteId}`, 'POST', { accept }),
  getMeetingTasks: (clubId: string, meetingId: string) => dashboard.request<MeetingTask[]>(`/clubs/${encodeURIComponent(clubId)}/meetings/${meetingId}/tasks`),
  addMeetingTasks: (clubId: string, meetingId: string, body: { template: true } | { label: string; daysBefore: number }) => dashboard.request<MeetingTask[]>(`/clubs/${encodeURIComponent(clubId)}/meetings/${meetingId}/tasks`, 'POST', body),
  setTaskDone: (clubId: string, taskId: string, done: boolean) => dashboard.request<{ ok: true }>(`/clubs/${encodeURIComponent(clubId)}/tasks/${taskId}`, 'PATCH', { done }),
  deleteTask: (clubId: string, taskId: string) => dashboard.request<void>(`/clubs/${encodeURIComponent(clubId)}/tasks/${taskId}`, 'DELETE'),
  getFairs: () => dashboard.request<Fair[]>('/fairs'),
  createFair: (input: Omit<Fair, 'id' | 'tables'>) => dashboard.request<{ id: string }>('/fairs', 'POST', input),
  setFairTable: (fairId: string, clubId: string, table: string, note: string) => dashboard.request<{ ok: true }>(`/fairs/${fairId}/tables/${encodeURIComponent(clubId)}`, 'PUT', { table, note }),
  getVenueEvents: (from: string, to: string) => dashboard.request<{ events: VenueEvent[]; window: { from: string; to: string } | null; source: string }>(`/venue-events?${new URLSearchParams({ from, to })}`),
  getMeetingWeather: (start: string, end: string) => dashboard.request<MeetingWeather>(`/weather?${new URLSearchParams({ start, end })}`),
  getMemberAvailabilityWith: (clubId: string, withClub: string | null) => dashboard.request<MemberAvailability>(`/clubs/${encodeURIComponent(clubId)}/availability${withClub ? `?${new URLSearchParams({ with: withClub })}` : ''}`),
  /** A subscribable calendar of a club's meetings (no sign-in needed, so calendar apps can fetch it). */
  clubCalendarUrl: (clubId: string) => `${window.location.origin}/api/dashboard/clubs/${encodeURIComponent(clubId)}/calendar.ics`,
  exportMyData: () => dashboard.request<Record<string, unknown>>('/export'),
  async deleteMyData() {
    await dashboard.mutate('/me', 'DELETE');
    return true;
  },
  async getClubDetails(clubId: string): Promise<ClubDetails> {
    const club = (await clubs()).find((c) => c.id === clubId);
    if (!club) throw new Error(`No published organizer with id ${clubId}`);
    return { ...club, listingUrl: '', officers: [], verifiedAt: null, followers: null };
  },
  getCalendarImports: (_clubId: string): Promise<CalendarImport[]> => unsupported('Club calendar import history'),
  uploadClubCalendar: (_clubId: string, _fileName: string, _eventCount: number): Promise<CalendarImport> => unsupported('Club calendar upload'),
  async getDataSources(): Promise<DataSource[]> {
    const response = await fetch('/data/campus-data.json');
    if (!response.ok) throw new Error('The deployed campus source inventory could not be loaded.');
    return sourcesFromCampusBundle(await response.json());
  },
  updateDataSource: (_id: string, _patch: Partial<DataSource>): Promise<DataSource> => unsupported('Data source updates'),
  testDataSource: (_id: string, _settings: DataSource['settings']): Promise<{ ok: boolean; message: string }> => unsupported('Data source connection test'),
  getSimulation: (): Promise<SimulationSettings> => unsupported('Shared simulation settings'),
  updateSimulation: (_patch: Partial<SimulationSettings>): Promise<SimulationSettings> => unsupported('Shared simulation updates'),
  getPlaybackSpeeds: (): Promise<number[]> => unsupported('Shared playback controls'),
  getClubApplications: () => dashboard.request<ClubApplication[]>('/admin/officer-requests'),
  setApplicationStatus: (id: string, status: ApplicationStatus, note?: string) => dashboard.request<ClubApplication>(`/admin/officer-requests/${id}`, 'POST', { status, ...(note ? { note } : {}) }),
  getAdminUsers: (): Promise<AdminUser[]> => unsupported('Administrative user directory'),
  resetSimulation: (): Promise<SimulationSettings> => unsupported('Shared simulation reset'),
  getAgentBrain: (): Promise<AgentBrain> => unsupported('Agent administration'),
  getAdminSettings: (): Promise<AdminSettings> => unsupported('Admin settings'),
  updateAdminSettings: (_patch: Partial<AdminSettings>): Promise<AdminSettings> => unsupported('Admin settings updates'),
  deletePersonaData: (): Promise<AdminSettings> => unsupported('Shared persona deletion'),
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
