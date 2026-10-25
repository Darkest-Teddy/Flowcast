// The only data door for dashboard pages; dashboard state comes from the server.
import { useCallback, useEffect, useState } from 'react';
import { createDashboardClient } from './realData';
import { agentConfigured, askAgentWithRetry, type AgentResult, type AgentMessage } from '@map/askClient';
import { bostonClock } from '../lib/askRouting';
import type {
  AdminSettings, AdminUser, AgentBrain, ApplicationStatus, CalendarConnection, CalendarImport,
  CampusEvent, CampusLocation, ClubApplication, ClubDetails, DataSource, EventImpactData,
  NotificationPrefs, Profile, ScheduleItem, SimulationSettings, StatRange, Suggestion, WeekStat,
} from './types';

const copy = <T,>(value: T): Promise<T> => Promise.resolve(structuredClone(value));
const unsupported = <T,>(action: string): Promise<T> => Promise.reject(new Error(`${action} is unavailable: no connected backend supports this operation.`));
const dashboard = createDashboardClient();
const disconnected = (): CalendarConnection => ({ connected: false, email: null, syncedAt: null, calendars: [] });
async function clubs() {
  const [data, me] = await Promise.all([dashboard.getPublic(), dashboard.getMe()]);
  return data.clubs.map((club) => ({ ...club, following: me.following.includes(club.id) }));
}

export const api = {
  getSession: () => dashboard.getMe().then((data) => data.session),
  getLocations: () => dashboard.getPublic().then((data) => data.locations),
  getSchedule: (): Promise<ScheduleItem[]> => copy([]),
  getPlaceForecasts: () => dashboard.getPublic().then((data) => data.places),
  getHourlyForecasts: () => dashboard.getPublic().then((data) => data.hourly),
  getCampusGeo: () => dashboard.getPublic().then((data) => data.geo),
  getSuggestions: (): Promise<Suggestion[]> => copy([]),
  acceptSuggestion: (_id: string): Promise<Suggestion[]> => unsupported('Schedule suggestions'),
  async askCampus(question: string, at: Date, signal?: AbortSignal, onWarming?: (retryAfterSec: number) => void, history?: AgentMessage[]): Promise<AgentResult> {
    if (!(await agentConfigured())) return { ok: false, error: { kind: 'notConfigured', message: 'Ask is not configured on the server.' } };
    const { weekday, time } = bostonClock(at);
    return askAgentWithRetry({ question: question.trim().slice(0, 300), weekday, time, campus: 'charles-river', history }, signal, { onWarming });
  },
  getWeekStats: (_range: StatRange = '7d'): Promise<WeekStat[]> => copy([]),
  getCampusEvents: (): Promise<CampusEvent[]> => dashboard.getPublic().then((data) => data.events),
  getEventImpact: (): Promise<EventImpactData> => dashboard.getPublic().then((data) => data.impact),
  getClubs: clubs,
  async setFollowing(clubId: string, following: boolean) {
    await dashboard.mutate<string[]>(`/following/${encodeURIComponent(clubId)}`, 'PUT', { following });
    return clubs();
  },
  getProfile: () => dashboard.getMe().then((data) => data.profile),
  updateProfile: (patch: Partial<Profile>) => dashboard.mutate<Profile>('/profile', 'PATCH', patch),
  getCalendarConnection: () => copy(disconnected()),
  setCalendarRead: (_calendarId: string, _read: boolean): Promise<CalendarConnection> => unsupported('Calendar selection'),
  syncCalendars: (): Promise<CalendarConnection> => unsupported('Calendar sync'),
  disconnectCalendar: (): Promise<CalendarConnection> => unsupported('Calendar disconnection'),
  connectCalendar: (): Promise<CalendarConnection> => unsupported('Google Calendar connection'),
  getNotificationPrefs: () => dashboard.getMe().then((data) => data.notificationPrefs),
  updateNotificationPrefs: (patch: Partial<NotificationPrefs>) => dashboard.mutate<NotificationPrefs>('/preferences', 'PATCH', patch),
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
  getCalendarImports: (_clubId: string): Promise<CalendarImport[]> => copy([]),
  uploadClubCalendar: (_clubId: string, _fileName: string, _eventCount: number): Promise<CalendarImport> => unsupported('Club calendar upload'),
  submitClubApplication: (_input: Pick<ClubApplication, 'clubName' | 'officerName' | 'officerEmail' | 'listingUrl' | 'description'>): Promise<ClubApplication> => unsupported('Club application submission'),
  getDataSources: (): Promise<DataSource[]> => copy([]),
  updateDataSource: (_id: string, _patch: Partial<DataSource>): Promise<DataSource> => unsupported('Data source updates'),
  testDataSource: (_id: string, _settings: DataSource['settings']): Promise<{ ok: boolean; message: string }> => unsupported('Data source connection test'),
  getSimulation: (): Promise<SimulationSettings> => unsupported('Shared simulation settings'),
  updateSimulation: (_patch: Partial<SimulationSettings>): Promise<SimulationSettings> => unsupported('Shared simulation updates'),
  getPlaybackSpeeds: (): Promise<number[]> => copy([]),
  getClubApplications: (): Promise<ClubApplication[]> => copy([]),
  setApplicationStatus: (_id: string, _status: ApplicationStatus, _note?: string): Promise<ClubApplication> => unsupported('Club application review'),
  getAdminUsers: (): Promise<AdminUser[]> => copy([]),
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
