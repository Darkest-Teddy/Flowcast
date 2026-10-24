// Shapes the web app reads. The server will serve these same shapes; until it exists, api.ts answers
// from fixtures.ts so pages can be built now and switched over without changes.

export type Role = 'student' | 'clubOfficer' | 'admin';

export interface User {
  id: string;
  name: string;
  email: string;
  homeLocationId: string | null;
}

export interface Session {
  user: User;
  roles: Role[];
  officerOfClubId: string | null;
  calendarConnected: boolean;
  calendarSyncedAt: string | null; // ISO
  onboarded: boolean;
}

export type LocationKind = 'dorm' | 'classroom' | 'library' | 'dining' | 'gym' | 'venue';

export interface CampusLocation {
  id: string;
  name: string;
  short: string;
  kind: LocationKind;
  capacity: number;
}

export type EventSource = 'calendar' | 'club' | 'habit' | 'suggested';

export interface ScheduleItem {
  id: string;
  title: string;
  locationId: string;
  start: string; // ISO
  end: string; // ISO
  source: EventSource;
  clubId?: string;
  note?: string;
  accepted?: boolean; // a suggested item the person added to their day
}

export interface PlaceForecast {
  locationId: string;
  at: string; // ISO time the person will be there
  share: number; // predicted occupancy / capacity
}

export interface HourlyForecast {
  locationId: string;
  day: string; // ISO date
  hours: { hour: number; share: number }[];
}

export interface Suggestion {
  id: string;
  text: string;
  actionLabel: string;
  scheduleItemId?: string; // the suggested schedule item this would confirm
}

export type StatRange = '7d' | '30d';

export interface WeekStat {
  id: string;
  label: string;
  value: string;
  detail: string;
  series: number[];
  axis: [string, string];
  highlightIndex: number;
}

export interface Club {
  id: string;
  name: string;
  verified: boolean;
  members: number;
  following: boolean;
  description: string;
}

export interface CampusEvent {
  id: string;
  title: string;
  locationId: string;
  start: string; // ISO
  clubId: string | null; // null for university events
  source: 'club-ics' | 'university' | 'manual';
}

export type ApplicationStatus = 'pending' | 'approved' | 'rejected';

export interface ClubApplication {
  id: string;
  clubName: string;
  officerName: string;
  officerEmail: string;
  listingUrl: string;
  description: string;
  submittedAt: string; // ISO
  status: ApplicationStatus;
  checks: { id: string; label: string; passed: boolean | null }[];
  reviewNote?: string; // admin's note when approving or rejecting
  reviewedAt?: string; // ISO
}

export interface CalendarImport {
  id: string;
  clubId: string;
  fileName: string;
  importedAt: string; // ISO
  eventCount: number;
  error: string | null;
}

export type SourceHealth = 'healthy' | 'attention' | 'failing' | 'off';
export type SourceGroup = 'prebuilt' | 'people' | 'live';

export interface DataSource {
  id: string;
  name: string;
  via: string; // where it comes from: API host, scrape, upload
  feeds: string; // what it powers, in plain words
  group: SourceGroup;
  health: SourceHealth;
  statusText: string;
  updatedAt: string | null; // ISO
  size: string | null;
  action: string; // label of the main button
  settings: { key: string; label: string; value: string; secret?: boolean }[];
}

export type Weather = 'live' | 'clear' | 'rain' | 'snow' | 'heatwave';
export type Lighting = 'dawn' | 'day' | 'dusk' | 'night';

export interface SimEvent {
  id: string;
  title: string;
  locationId: string;
  when: string; // plain words, e.g. "Fri 7:00 PM" or "Now"
  kind: 'scheduled' | 'instant';
  enabled: boolean;
}

export interface SimulationSettings {
  playbackSpeed: number; // 1 = live clock
  paused: boolean;
  weather: Weather;
  lighting: Lighting;
  layers: { transit: boolean; traffic: boolean; perfMonitor: boolean };
  population: { agents: number; includeCalendars: boolean; includeClubEvents: boolean };
  brain: { useJev: boolean; fallbackMs: number };
  events: SimEvent[];
  clock?: string; // simulated time of day "HH:MM" after a jump; absent while following the real clock
}

// Agent brain (admin): fixed rules plus the questions sent to Jev, TypeSafe's decision model.
export interface BrainRule {
  id: string;
  when: string;
  then: string;
}

export interface JevQuestion {
  id: string;
  question: string;
  answer: 'yesNo' | 'choice';
  options: string[];
  askedWhen: string;
}

export interface BrainUsageEstimate {
  id: string;
  label: string;
  value: string;
  detail: string;
}

export interface AgentBrain {
  rules: BrainRule[];
  questions: JevQuestion[];
  usage: BrainUsageEstimate[]; // placeholder estimates, not measured
}

// Admin settings
export interface TeamAdmin {
  id: string;
  name: string;
  email: string;
}

export interface AdminSettings {
  admins: TeamAdmin[];
  oauth: { verified: boolean; userCap: number; usersConnected: number; scope: string; consoleUrl: string };
  retention: 'semester' | '30d' | '90d' | 'forever';
  personaProfiles: number;
}

export interface AdminUser {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  calendarConnected: boolean;
  joinedAt: string; // ISO
}

export interface Profile {
  name: string;
  homeLocationId: string | null;
  lunchTime: string; // "HH:MM", 24-hour
  dinnerTime: string; // "HH:MM", 24-hour
  studySpotId: string | null;
  avatarSwatch: number; // index into the theme swatches
}

export interface GoogleCalendar {
  id: string;
  name: string;
  detail: string; // plain words, e.g. "12 events this week"
  read: boolean; // whether Flowcast reads it
}

export interface CalendarConnection {
  connected: boolean;
  email: string | null;
  syncedAt: string | null; // ISO
  calendars: GoogleCalendar[];
}

export interface NotificationPrefs {
  packedRoute: boolean;
  clubEvents: boolean;
  scheduleChanges: boolean;
}

export interface ClubDetails extends Club {
  listingUrl: string;
  officers: string[];
  verifiedAt: string | null; // ISO
  followers: number;
}
