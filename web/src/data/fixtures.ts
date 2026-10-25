// Sample data standing in for the server. Pages never import this file directly: they go through
// api.ts, so swapping in real endpoints changes nothing on screen.

import type {
  AdminUser,
  CalendarImport,
  CampusEvent,
  CampusLocation,
  Club,
  ClubApplication,
  CourseOffering,
  DataSource,
  HourlyForecast,
  MyCourse,
  PlaceForecast,
  ScheduleItem,
  Session,
  SimulationSettings,
  Suggestion,
  WeekStat,
} from './types';
import type { CalendarConnection, ClubDetails, NotificationPrefs, Profile } from './types';
import type { AdminSettings, AgentBrain } from './types';
// The real BU published course catalog (data-pipeline/build_course_catalog.py), not illustrative
// data: thousands of scraped course sections with real codes, titles, instructors and meeting
// times. Re-run that script against a fresh data-pipeline/output/catalog.json to update these.
import rawCourseCatalog from './courseCatalog.json';
// Campus buildings that host classes but aren't in `locations` below, minted by the same script
// from the catalog's own building names -- never guessed.
import rawCourseLocations from './courseLocations.json';

const today = new Date();
const iso = (dayOffset: number, h: number, m = 0) => {
  const d = new Date(today);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
};
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

export const locations: CampusLocation[] = [
  { id: 'warren', name: 'Warren Towers', short: 'Warren Towers', kind: 'dorm', capacity: 1800 },
  { id: 'myles', name: 'Myles Standish Hall', short: 'Myles', kind: 'dorm', capacity: 750 },
  { id: 'stuvi', name: 'Student Village', short: 'StuVi', kind: 'dorm', capacity: 950 },
  { id: 'cas', name: 'College of Arts and Sciences', short: 'CAS', kind: 'classroom', capacity: 900 },
  { id: 'cds', name: 'Computing & Data Sciences', short: 'CDS', kind: 'classroom', capacity: 600 },
  { id: 'questrom', name: 'Questrom School of Business', short: 'Questrom', kind: 'classroom', capacity: 700 },
  { id: 'epic', name: 'Engineering Product Innovation Center', short: 'EPIC', kind: 'classroom', capacity: 300 },
  { id: 'mugar', name: 'Mugar Memorial Library', short: 'Mugar', kind: 'library', capacity: 800 },
  { id: 'pardee', name: 'Pardee Management Library', short: 'Pardee', kind: 'library', capacity: 250 },
  { id: 'sel', name: 'Science & Engineering Library', short: 'SEL', kind: 'library', capacity: 300 },
  { id: 'gsu', name: 'George Sherman Union', short: 'GSU', kind: 'dining', capacity: 600 },
  { id: 'warren-dining', name: 'Warren Towers Dining Hall', short: 'Warren Dining', kind: 'dining', capacity: 500 },
  { id: 'agganis', name: 'Agganis Arena', short: 'Agganis', kind: 'venue', capacity: 6300 },
  { id: 'nickerson', name: 'Nickerson Field', short: 'Nickerson', kind: 'venue', capacity: 10000 },
  ...(rawCourseLocations as unknown as CampusLocation[]),
];

export const session: Session = {
  user: { id: 'u-andres', name: 'Andres Lopez', email: 'andres@bu.edu', homeLocationId: 'warren' },
  roles: ['student', 'clubOfficer', 'admin'],
  officerOfClubId: 'robotics',
  calendarConnected: true,
  calendarSyncedAt: minutesAgo(4),
  onboarded: true,
};

export const schedule: ScheduleItem[] = [
  { id: 's1', title: 'CS 132', locationId: 'cas', start: iso(0, 9, 5), end: iso(0, 9, 55), source: 'calendar' },
  { id: 's2', title: 'Lunch', locationId: 'gsu', start: iso(0, 12, 0), end: iso(0, 12, 40), source: 'suggested', note: 'Warren Dining is predicted 88% full at 12:20' },
  { id: 's3', title: 'DS 340', locationId: 'cds', start: iso(0, 14, 30), end: iso(0, 15, 45), source: 'calendar' },
  { id: 's4', title: 'Robotics Club build night', locationId: 'epic', start: iso(0, 18, 0), end: iso(0, 20, 0), source: 'club', clubId: 'robotics' },
  { id: 's5', title: 'Study', locationId: 'mugar', start: iso(0, 20, 15), end: iso(0, 22, 0), source: 'habit' },
  { id: 's6', title: 'CS 132', locationId: 'cas', start: iso(2, 9, 5), end: iso(2, 9, 55), source: 'calendar' },
  { id: 's7', title: 'DS 340', locationId: 'cds', start: iso(2, 14, 30), end: iso(2, 15, 45), source: 'calendar' },
];

export const courseCatalog: CourseOffering[] = rawCourseCatalog as unknown as CourseOffering[];

export const myCourses: MyCourse[] = [];

export const placeForecasts: PlaceForecast[] = [
  { locationId: 'warren-dining', at: iso(0, 12, 20), share: 0.88 },
  { locationId: 'mugar', at: iso(0, 20, 15), share: 0.64 },
  { locationId: 'cds', at: iso(0, 14, 30), share: 0.38 },
  { locationId: 'epic', at: iso(0, 18, 0), share: 0.51 },
];

const curve = (peaks: number[]) => peaks.map((share, i) => ({ hour: 8 + i, share }));
export const hourlyForecasts: HourlyForecast[] = [
  { locationId: 'gsu', day: iso(0, 0), hours: curve([0.12, 0.22, 0.35, 0.62, 0.94, 0.81, 0.44, 0.33, 0.41, 0.58, 0.72, 0.4, 0.18, 0.08]) },
  { locationId: 'warren-dining', day: iso(0, 0), hours: curve([0.3, 0.2, 0.15, 0.4, 0.88, 0.7, 0.25, 0.15, 0.2, 0.55, 0.8, 0.5, 0.2, 0.1]) },
  { locationId: 'mugar', day: iso(0, 0), hours: curve([0.08, 0.15, 0.25, 0.32, 0.3, 0.38, 0.45, 0.5, 0.48, 0.52, 0.6, 0.66, 0.64, 0.4]) },
  { locationId: 'cds', day: iso(0, 0), hours: curve([0.2, 0.45, 0.55, 0.6, 0.35, 0.5, 0.58, 0.38, 0.3, 0.2, 0.15, 0.1, 0.08, 0.05]) },
];

export const suggestions: Suggestion[] = [
  { id: 'g1', text: 'Warren Dining will be packed at 12:20. GSU at 12:00 is 61% full and on your way to CDS.', actionLabel: 'Add to my day', scheduleItemId: 's2' },
];

export const weekStats: WeekStat[] = [
  { id: 'classes', label: 'Classes', value: '14', detail: '2 more than last week', series: [4, 5, 3, 5, 2, 0, 0], axis: ['Mon', 'Sun'], highlightIndex: 2 },
  { id: 'club-events', label: 'Club events', value: '5', detail: 'From 3 clubs you follow', series: [1, 1, 2, 0, 1, 0, 0], axis: ['Mon', 'Sun'], highlightIndex: 2 },
  { id: 'avoided', label: 'Crowds avoided', value: '3', detail: 'Suggestions you took', series: [1, 0, 2, 0, 0, 0, 0], axis: ['Mon', 'Sun'], highlightIndex: 2 },
  { id: 'busiest', label: 'Busiest hour', value: '12–1 PM', detail: 'Across campus today', series: [2, 4, 7, 10, 7, 5, 3], axis: ['9 AM', '9 PM'], highlightIndex: 3 },
];

export const monthStats: WeekStat[] = [
  { id: 'classes', label: 'Classes', value: '58', detail: 'Same as the month before', series: [4, 5, 3, 5, 2, 0, 0, 4, 5, 3, 5, 2, 0, 0, 4, 5, 3, 5, 2, 0, 0, 4, 5, 3, 5, 2, 0, 0, 4, 5], axis: ['30 days ago', 'Today'], highlightIndex: 29 },
  { id: 'club-events', label: 'Club events', value: '19', detail: 'From 3 clubs you follow', series: [1, 0, 2, 0, 1, 0, 0, 1, 1, 1, 0, 2, 0, 0, 0, 1, 2, 0, 1, 0, 0, 1, 1, 2, 0, 1, 0, 0, 1, 0], axis: ['30 days ago', 'Today'], highlightIndex: 29 },
  { id: 'avoided', label: 'Crowds avoided', value: '11', detail: 'Suggestions you took', series: [0, 1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 1, 0, 2, 0, 0, 0, 0, 0, 1], axis: ['30 days ago', 'Today'], highlightIndex: 29 },
  { id: 'busiest', label: 'Busiest hour', value: '12–1 PM', detail: 'Across campus, last 30 days', series: [3, 4, 6, 10, 8, 5, 3], axis: ['9 AM', '9 PM'], highlightIndex: 3 },
];

export const clubs: Club[] = [
  { id: 'robotics', name: 'Robotics Club', verified: true, members: 84, following: true, description: 'Build nights, competitions and a lot of soldering.' },
  { id: 'bu-ds', name: 'BU Data Science', verified: true, members: 212, following: true, description: 'Talks, workshops and Kaggle nights.' },
  { id: 'splash', name: 'Splash 2026', verified: true, members: 40, following: true, description: 'The fall activities fair team.' },
  { id: 'climbing', name: 'Climbing Club', verified: true, members: 130, following: false, description: 'Weekly trips and a bouldering crew.' },
  { id: 'chess', name: 'Chess Club', verified: true, members: 56, following: false, description: 'Casual games every Thursday at GSU.' },
];

export const campusEvents: CampusEvent[] = [
  { id: 'e1', title: 'Splash 2026', locationId: 'nickerson', start: iso(3, 11), clubId: 'splash', source: 'club-ics' },
  { id: 'e2', title: 'BU Data Science talk', locationId: 'cds', start: iso(1, 18, 30), clubId: 'bu-ds', source: 'club-ics' },
  { id: 'e3', title: 'Hockey vs. BC', locationId: 'agganis', start: iso(2, 19), clubId: null, source: 'university' },
  { id: 'e4', title: 'Robotics Club build night', locationId: 'epic', start: iso(0, 18), clubId: 'robotics', source: 'club-ics' },
  { id: 'e5', title: 'Chess night', locationId: 'gsu', start: iso(1, 19), clubId: 'chess', source: 'club-ics' },
];

export const clubApplications: ClubApplication[] = [
  {
    id: 'app1', clubName: 'BU Film Society', officerName: 'Maya Chen', officerEmail: 'mchen@bu.edu',
    listingUrl: 'https://bu.campuslabs.com/engage/organization/film-society', description: 'Weekly screenings and a spring short-film festival.',
    submittedAt: minutesAgo(95), status: 'pending',
    checks: [
      { id: 'email', label: 'Officer uses a bu.edu email', passed: true },
      { id: 'listing', label: 'Club appears on BU Engage', passed: true },
      { id: 'officer', label: 'Officer is listed on the club page', passed: null },
    ],
  },
  {
    id: 'app2', clubName: 'Quantum Computing Society', officerName: 'Liam Ortiz', officerEmail: 'lortiz@gmail.com',
    listingUrl: '', description: 'Reading group for quantum algorithms.',
    submittedAt: minutesAgo(240), status: 'pending',
    checks: [
      { id: 'email', label: 'Officer uses a bu.edu email', passed: false },
      { id: 'listing', label: 'Club appears on BU Engage', passed: false },
      { id: 'officer', label: 'Officer is listed on the club page', passed: null },
    ],
  },
  {
    id: 'app3', clubName: 'Taiwanese Student Association', officerName: 'Jenny Wu', officerEmail: 'jwu@bu.edu',
    listingUrl: 'https://bu.campuslabs.com/engage/organization/tsa', description: 'Night markets, cultural events and food.',
    submittedAt: minutesAgo(30), status: 'pending',
    checks: [
      { id: 'email', label: 'Officer uses a bu.edu email', passed: true },
      { id: 'listing', label: 'Club appears on BU Engage', passed: true },
      { id: 'officer', label: 'Officer is listed on the club page', passed: true },
    ],
  },
];

export const calendarImports: CalendarImport[] = [
  { id: 'imp1', clubId: 'robotics', fileName: 'robotics-fall.ics', importedAt: minutesAgo(60 * 26), eventCount: 9, error: null },
  { id: 'imp2', clubId: 'robotics', fileName: 'robotics-comp.ics', importedAt: minutesAgo(155), eventCount: 0, error: 'Line 41: event has no start time (DTSTART).' },
];

export const dataSources: DataSource[] = [
  {
    id: 'osm', name: 'OpenStreetMap', via: 'Overpass API, cached on disk', feeds: 'Buildings and walkways', group: 'prebuilt',
    health: 'healthy', statusText: 'Healthy', updatedAt: minutesAgo(190), size: '15 places, 4,812 path points', action: 'Refresh',
    settings: [{ key: 'endpoint', label: 'Endpoint', value: 'https://overpass-api.de/api/interpreter' }, { key: 'bbox', label: 'Area', value: '42.3455, -71.1225 to 42.3560, -71.0925' }],
  },
  {
    id: 'catalog', name: 'BU course catalog', via: 'Public Schedule of Classes scrape', feeds: 'Class times and rooms', group: 'prebuilt',
    health: 'off', statusText: 'Not set up', updatedAt: null, size: null, action: 'Set up',
    settings: [{ key: 'term', label: 'Term', value: 'Fall 2026' }],
  },
  {
    id: 'population', name: 'Synthetic population', via: 'Schedule generator, seed 7', feeds: 'Agent schedules', group: 'prebuilt',
    health: 'attention', statusText: 'Placeholder data', updatedAt: minutesAgo(40), size: '300 agents, Wednesday only', action: 'Rebuild',
    settings: [{ key: 'agents', label: 'Agents', value: '300' }, { key: 'seed', label: 'Seed', value: '7' }],
  },
  {
    id: 'forecast', name: 'Crowd forecast model', via: 'Trained on the simulated week', feeds: 'Predicted % full', group: 'prebuilt',
    health: 'off', statusText: 'Not trained', updatedAt: null, size: null, action: 'Train',
    settings: [{ key: 'window', label: 'Time window', value: '15 minutes' }],
  },
  {
    id: 'gcal', name: 'Google Calendar', via: 'Google sign-in, read-only calendar access', feeds: 'Real student schedules', group: 'people',
    health: 'attention', statusText: '12 of 100 users (app not yet verified by Google)', updatedAt: minutesAgo(4), size: '12 students', action: 'Configure',
    settings: [{ key: 'clientId', label: 'OAuth client ID', value: '', secret: true }, { key: 'scope', label: 'Permission', value: 'calendar.readonly' }],
  },
  {
    id: 'club-ics', name: 'Club calendars', via: '.ics files from verified clubs', feeds: 'Club events', group: 'people',
    health: 'failing', statusText: '1 import failed', updatedAt: minutesAgo(155), size: '3 clubs, 18 events', action: 'View errors',
    settings: [{ key: 'autoPublish', label: 'Publish imports automatically', value: 'Yes' }],
  },
  {
    id: 'profiles', name: 'Profiles', via: 'Entered in Flowcast', feeds: 'Dorm, habits, avatar', group: 'people',
    health: 'healthy', statusText: 'Healthy', updatedAt: minutesAgo(1), size: '27 profiles', action: 'View',
    settings: [],
  },
  {
    id: 'weather', name: 'Open-Meteo', via: 'api.open-meteo.com', feeds: 'Live weather', group: 'live',
    health: 'healthy', statusText: 'Healthy', updatedAt: minutesAgo(2), size: null, action: 'Configure',
    settings: [{ key: 'interval', label: 'Check every', value: '10 minutes' }],
  },
  {
    id: 'mbta', name: 'MBTA', via: 'api-v3.mbta.com', feeds: 'Green Line and buses', group: 'live',
    health: 'healthy', statusText: 'Healthy', updatedAt: minutesAgo(0.25), size: null, action: 'Configure',
    settings: [{ key: 'apiKey', label: 'API key', value: '', secret: true }],
  },
  {
    id: 'shuttle', name: 'BU Shuttle', via: 'TransLoc relay', feeds: 'Shuttle positions', group: 'live',
    health: 'healthy', statusText: 'Healthy', updatedAt: minutesAgo(0.2), size: null, action: 'Configure',
    settings: [],
  },
  {
    id: 'jev', name: 'Jev', via: 'TypeSafe decision model', feeds: 'Agent judgment calls', group: 'live',
    health: 'off', statusText: 'No API key', updatedAt: null, size: null, action: 'Add key',
    settings: [{ key: 'apiKey', label: 'API key', value: '', secret: true }, { key: 'model', label: 'Model', value: 'jev-1.13' }],
  },
  {
    id: 'tiles', name: 'Map tiles', via: 'Mapbox with a token, OpenFreeMap without', feeds: 'Base map', group: 'live',
    health: 'healthy', statusText: 'Using OpenFreeMap', updatedAt: null, size: null, action: 'Configure',
    settings: [{ key: 'mapboxToken', label: 'Mapbox token', value: '', secret: true }],
  },
];

export const simulationSettings: SimulationSettings = {
  playbackSpeed: 1,
  paused: false,
  weather: 'live',
  lighting: 'day',
  layers: { transit: true, traffic: true, perfMonitor: false },
  population: { agents: 300, includeCalendars: true, includeClubEvents: true },
  brain: { useJev: false, fallbackMs: 1500 },
  events: [
    { id: 'hockey', title: 'Hockey vs. BC', locationId: 'agganis', when: 'Fri 7:00 PM', kind: 'scheduled', enabled: true },
    { id: 'splash', title: 'Splash', locationId: 'nickerson', when: 'Sat 11:00 AM', kind: 'scheduled', enabled: true },
    { id: 'dining-closed', title: 'Warren Dining closed', locationId: 'warren-dining', when: 'All day', kind: 'scheduled', enabled: false },
    { id: 'fire-drill', title: 'Fire drill', locationId: 'cds', when: 'Now', kind: 'instant', enabled: false },
  ],
};

export const playbackSpeeds = [1, 30, 120, 600];

export const adminUsers: AdminUser[] = [
  { id: 'u-andres', name: 'Andres Lopez', email: 'andres@bu.edu', roles: ['student', 'clubOfficer', 'admin'], calendarConnected: true, joinedAt: minutesAgo(600) },
  { id: 'u-jose', name: 'Jose Ramirez', email: 'jose@bu.edu', roles: ['student', 'admin'], calendarConnected: true, joinedAt: minutesAgo(580) },
  { id: 'u-maya', name: 'Maya Chen', email: 'mchen@bu.edu', roles: ['student'], calendarConnected: false, joinedAt: minutesAgo(95) },
  { id: 'u-sam', name: 'Sam Patel', email: 'spatel@bu.edu', roles: ['student'], calendarConnected: true, joinedAt: minutesAgo(45) },
];

export const profile: Profile = {
  name: 'Andres Lopez',
  homeLocationId: 'warren',
  lunchTime: '12:15',
  dinnerTime: '18:30',
  studySpotId: 'mugar',
  avatarSwatch: 0,
};

export const calendarConnection: CalendarConnection = {
  connected: true,
  email: 'andres@bu.edu',
  syncedAt: minutesAgo(4),
  calendars: [
    { id: 'cal-classes', name: 'Classes', detail: '14 events this week', read: true },
    { id: 'cal-work', name: 'Work shifts', detail: '3 events this week', read: true },
    { id: 'cal-personal', name: 'Personal', detail: '6 events this week', read: false },
    { id: 'cal-holidays', name: 'Holidays in the United States', detail: '1 event this week', read: false },
  ],
};

export const notificationPrefs: NotificationPrefs = {
  packedRoute: true,
  clubEvents: true,
  scheduleChanges: false,
};

export const clubDetails: Record<string, Omit<ClubDetails, keyof Club>> = {
  robotics: {
    listingUrl: 'https://bu.campuslabs.com/engage/organization/robotics',
    officers: ['Andres Lopez', 'Priya Nair'],
    verifiedAt: minutesAgo(60 * 24 * 12),
    followers: 61,
  },
};

export const agentBrain: AgentBrain = {
  rules: [
    { id: 'class', when: 'Class starts within 20 minutes', then: 'Go to class' },
    { id: 'sleep', when: 'It is past the agent’s bedtime', then: 'Go home to their dorm' },
    { id: 'meal', when: 'Hungry and it’s meal time', then: 'Go to eat' },
    { id: 'crowded', when: 'Preferred dining hall is over 85% full and the agent avoids crowds', then: 'Go to the next-nearest dining hall' },
    { id: 'rain', when: 'Raining and the destination is outdoors', then: 'Pick an indoor alternative' },
    { id: 'club', when: 'A followed club has an event starting within 30 minutes', then: 'Go to the event' },
  ],
  questions: [
    { id: 'eat', question: 'Where should I eat?', answer: 'choice', options: ['GSU', 'Warren Dining', 'Marciano', 'Skip the meal'], askedWhen: 'Meal time with more than one dining hall in reach' },
    { id: 'rain', question: 'Stay in during the rain?', answer: 'yesNo', options: ['Yes', 'No'], askedWhen: 'Rain starts and the next stop is outdoors but not a class' },
    { id: 'free-hour', question: 'What should I do with a free hour?', answer: 'choice', options: ['Study at a library', 'Go back to the dorm', 'Get food', 'Go to the gym'], askedWhen: 'A gap of an hour or more between classes' },
  ],
  usage: [
    { id: 'decisions', label: 'Decisions per simulated day', value: '≈ 4,200', detail: '300 agents, about 14 each' },
    { id: 'jev-calls', label: 'Sent to Jev', value: '≈ 1,100', detail: 'About a quarter are judgment calls' },
    { id: 'latency', label: 'Typical answer time', value: '≈ 600 ms', detail: 'Rules take over after the timeout' },
    { id: 'cost', label: 'Cost per simulated day', value: '≈ $0.40', detail: 'At the hackathon credit rate' },
  ],
};

export const adminSettings: AdminSettings = {
  admins: [
    { id: 'u-andres', name: 'Andres Lopez', email: 'andres@bu.edu' },
    { id: 'u-jose', name: 'Jose Ramirez', email: 'jose@bu.edu' },
    { id: 'u-priya', name: 'Priya Nair', email: 'pnair@bu.edu' },
    { id: 'u-ethan', name: 'Ethan Brooks', email: 'ebrooks@bu.edu' },
    { id: 'u-sofia', name: 'Sofia Alvarez', email: 'salvarez@bu.edu' },
  ],
  oauth: {
    verified: false,
    userCap: 100,
    usersConnected: 12,
    scope: 'calendar.readonly',
    consoleUrl: 'https://console.cloud.google.com/apis/credentials/consent',
  },
  retention: 'semester',
  personaProfiles: 27,
};
