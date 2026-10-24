// The only door pages use to get or change data. Today it answers from fixtures held in memory;
// when /server exists, each function becomes a fetch to the same-named endpoint.

import { useCallback, useEffect, useState } from 'react';
import { config } from '../config';
import * as fx from './fixtures';
import { campusGeo } from './campusGeo';
import type {
  ApplicationStatus,
  CampusEvent,
  CampusLocation,
  ClubApplication,
  DataSource,
  EventImpactData,
  EventMapStatus,
  Session,
  SimulationSettings,
  StatRange,
} from './types';
import type { ClubDetails, NotificationPrefs, Profile } from './types';
import type { AdminSettings } from './types';

const LATENCY_MS = 150;
const later = <T,>(value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), LATENCY_MS));

/** The simulation's event bundle, built by map-client/scripts/build-event-impact.mjs and served with the map's data. */
interface EventBundle extends EventImpactData {
  events: { id: string; name: string; start: string; end: string | null; organizer: string | null; locationId: string | null;
    locationName: string | null; roomCode: string | null; sourceUrl: string; status: EventMapStatus }[];
}
let eventBundle: Promise<EventBundle> | null = null;
function loadEventBundle(): Promise<EventBundle> {
  eventBundle ??= fetch(config.eventImpactUrl).then(async (response) => {
    if (!response.ok) throw new Error(`Campus events are unavailable right now (${response.status}).`);
    const bundle = (await response.json()) as EventBundle & { schemaVersion?: number };
    if (bundle.schemaVersion !== 1 || !Array.isArray(bundle.events)) throw new Error('Campus events data has an unsupported format.');
    return bundle;
  });
  // A failed load can be retried by the page's "Try again".
  eventBundle.catch(() => { eventBundle = null; });
  return eventBundle;
}

// Mutable copies, so changes made in the UI stick for the session.
let simulation = structuredClone(fx.simulationSettings);
let applications = structuredClone(fx.clubApplications);
let clubs = structuredClone(fx.clubs);
let sources = structuredClone(fx.dataSources);
let imports = structuredClone(fx.calendarImports);
let schedule = structuredClone(fx.schedule);
let suggestions = structuredClone(fx.suggestions);

let profile = structuredClone(fx.profile);
let calendarConnection = structuredClone(fx.calendarConnection);
let notificationPrefs = structuredClone(fx.notificationPrefs);
let adminSettings = structuredClone(fx.adminSettings);

export const api = {
  // Student
  getSession: (): Promise<Session> => later(fx.session),
  getLocations: () => later(fx.locations),
  getSchedule: () => later(schedule),
  getPlaceForecasts: () => later(fx.placeForecasts),
  getHourlyForecasts: () => later(fx.hourlyForecasts),
  /** Place positions and walking distances, generated from the map's bundled routes. */
  getCampusGeo: () => later(campusGeo),
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
  /** Public Terrier Central events from the saved scrape, with whether each one can change map crowding. */
  getCampusEvents: (): Promise<CampusEvent[]> =>
    loadEventBundle().then((bundle) =>
      bundle.events.map((e) => ({
        id: e.id,
        title: e.name,
        locationId: e.locationId,
        venue: e.locationName,
        start: e.start,
        end: e.end,
        organizer: e.organizer,
        clubId: null,
        source: 'terrier-central' as const,
        sourceUrl: e.sourceUrl,
        mapStatus: e.status,
      })),
    ),
  /** Simulated hourly crowding per place, without events and with each date's events. */
  getEventImpact: (): Promise<EventImpactData> => loadEventBundle().then((bundle) => structuredClone(bundle)),
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
