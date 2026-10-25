import { carriedForwardHours, CARRY_FORWARD_DAYS, dateForWeekday, openingHoursForDate, WEEKDAYS, type CampusData, type SourceMeeting } from '../data/campusData';
import { fitrecVisitStart } from '../data/fitrecUsage';
import { effectiveMeetingIntervals } from '../data/academicCalendar';
import { courseLevel, countsTowardDegreeLoad, eligibleStudentLevels } from './courseEligibility';
import { GATHERING_ASSUMPTIONS, gatheringsOnDate, weekdayOf, type Gathering, type GatheringOutcome } from './gatherings';
import { dayBehavior, type ActivitySpec, type BehaviorModel, type DayBehavior, type LegacyBehavior, type ResolvedParams } from './behavior';
import type { DayConditions } from './conditions';
import type { OutdoorFile } from './outdoor';
import type { Agent, CampusLocation, DayData, EstimatedActivityProfile, StayPurpose, TransitRide, Trip } from './playback';
import { ALIGHT_SECONDS, lastAtOrBefore, MAX_EARLY_ARRIVAL_SECONDS, MAX_STOP_PAIR_METRES, MAX_STOP_WAIT_SECONDS, MIN_WEEKLY_TRIPS,
  routeKind, TRANSIT_COMMUTER_SHARE, VEHICLE_PEAK_MAX_LOAD, type TransitService } from './transitService';

const DAY = 86400;
const WALK_SPEED = 1.4;
const NO_TRANSIT = {};
const weeklyCache = new WeakMap<DayData, WeakMap<CampusData, WeakMap<object, (weekday: number, eventDate: string | null, behavior?: DayBehavior) => SourceDay>>>();
/** Built days kept per weekly plan; event dates add variants, and each day holds every student's trips. */
const CACHED_DAYS = 4;
const HOME_BREAK = 15 * 60;
const OFF_CAMPUS_BREAK = 30 * 60;
export const MODELED_OFF_CAMPUS_MEAL_SHARE = 0.35;
const MAX_GATEWAY_WALK_METRES = 2000;
/** Distance decay for choosing a walk-in access point near the destination (uncalibrated). */
export const WALK_IN_DECAY_METRES = 250;
const WALK_IN_CLUSTER_METRES = 150;
const OPTIONAL_CAPACITY_BUCKET_SECONDS = 60;
const SOURCE_COVERED_ESTIMATED_ACTIVITY_FACTOR = 0.15;
const ESTIMATED_TIME_ATTEMPTS = 3;
const COURSE_CANDIDATE_ATTEMPTS = 96;
const AFFINITY_ATTEMPT_SHARE = 0.65;
const COMPONENT_BUNDLE_SEARCH_LIMIT = 48;
const COMPONENT_OPTIONS_PER_COMPONENT = 12;
const UNMAPPED_ACADEMIC_MINUTES = 120;
/** Share of uncovered-course academic blocks spent off the map (online, other campuses, home). Uncalibrated. */
export const OFF_MAP_ACADEMIC_SHARE = 0.1;
const CAMPUS_STUDY_HOURS: [number, number] = [8 * 3600, 22 * 3600];
export const MODELED_ACTIVITY_SHOULDER_SHARE = 0.25;
const ARRIVAL_LEAD = { minimum: 2 * 60, spread: 10 * 60 };
type FreeTimeActivity = { kind: 'dining' | 'library' | 'gym' | 'off-campus-outing'; at: number; spread: number;
  shoulder: readonly [number, number]; minutes: number; probability: number };
const BREAKFAST: FreeTimeActivity = { kind: 'dining', at: 8, spread: 2, shoulder: [7, 11], minutes: 25, probability: 0.45 };
const LUNCH: FreeTimeActivity = { kind: 'dining', at: 12, spread: 2, shoulder: [10.5, 16], minutes: 35, probability: 0.75 };
const AFTERNOON_STUDY: FreeTimeActivity = { kind: 'library', at: 14, spread: 5, shoulder: [8, 22], minutes: 75, probability: 0.55 };
const DINNER: FreeTimeActivity = { kind: 'dining', at: 18, spread: 3, shoulder: [16, 22], minutes: 40, probability: 0.7 };
const WORKOUT: FreeTimeActivity = { kind: 'gym', at: 17, spread: 5, shoulder: [6, 22], minutes: 55, probability: 0.25 };
const EVENING_STUDY: FreeTimeActivity = { kind: 'library', at: 19.5, spread: 2.5, shoulder: [18, 22.5], minutes: 90, probability: 0.25 };
/** Monday=0 … Sunday=6. Uncalibrated scenario menus: weekday study rhythm, Friday/Saturday nights
 * out, late weekend brunch, a Sunday afternoon/evening study peak, and more daytime weekend workouts. */
const FREE_TIME_ACTIVITIES: readonly (readonly FreeTimeActivity[])[] = (() => {
  const weekday: FreeTimeActivity[] = [BREAKFAST, LUNCH, AFTERNOON_STUDY, DINNER, WORKOUT, EVENING_STUDY];
  const friday: FreeTimeActivity[] = [BREAKFAST, LUNCH, { ...AFTERNOON_STUDY, spread: 3, shoulder: [9, 18], probability: 0.4 }, DINNER, WORKOUT,
    { kind: 'off-campus-outing', at: 19.5, spread: 2, shoulder: [18, 21], minutes: 150, probability: 0.35 }];
  const saturday: FreeTimeActivity[] = [
    { kind: 'dining', at: 10.5, spread: 2.5, shoulder: [9, 14], minutes: 45, probability: 0.7 },
    { kind: 'library', at: 13, spread: 4, shoulder: [10, 21], minutes: 90, probability: 0.3 },
    { kind: 'gym', at: 11, spread: 5, shoulder: [8, 20], minutes: 60, probability: 0.35 },
    { kind: 'dining', at: 17.5, spread: 2, shoulder: [16.5, 20], minutes: 40, probability: 0.65 },
    { kind: 'off-campus-outing', at: 19.5, spread: 2, shoulder: [11, 21], minutes: 150, probability: 0.45 },
  ];
  const sunday: FreeTimeActivity[] = [
    { kind: 'dining', at: 11, spread: 2.5, shoulder: [10, 14], minutes: 45, probability: 0.7 },
    { kind: 'library', at: 13, spread: 5, shoulder: [10, 20], minutes: 120, probability: 0.5 },
    { kind: 'gym', at: 11, spread: 5, shoulder: [8, 20], minutes: 60, probability: 0.3 },
    { kind: 'dining', at: 17, spread: 2.5, shoulder: [16.5, 20.5], minutes: 40, probability: 0.65 },
    { ...EVENING_STUDY, at: 19, spread: 2.5, probability: 0.3 },
  ];
  return [weekday, weekday, weekday, weekday, friday, saturday, sunday];
})();
/** Stable personal habits. A `share` of students are regulars whose probability is multiplied by
 * `high`; everyone else gets the multiplier that keeps the population mean unchanged (before the
 * 100% cap). Uncalibrated scenario assumptions, not observed individual behavior. */
export const HABIT_TRAITS: Record<string, { share: number; high: number }> = {
  breakfast: { share: 0.45, high: 1.9 },
  gym: { share: 0.3, high: 3 },
  library: { share: 0.5, high: 1.6 },
  'off-campus-outing': { share: 0.5, high: 1.6 },
  'off-campus-meal': { share: 0.35, high: 2 },
};
/** Weight multiplier for each student's stable favourite dining hall, library and gym. */
export const FAVORITE_VENUE_WEIGHT = 5;
/** Seconds added to a venue's round-trip walk before dividing, so a venue next door isn't infinitely attractive. */
export const VENUE_TRAVEL_OFFSET_SECONDS = 300;
/**
 * How strongly an open venue with room draws a student: its seats over the travel it costs. Weights
 * grow in proportion to capacity, so at equal travel every seat is equally likely to be picked and a
 * 40-seat café gets the same expected demand per seat as an 800-seat library. (A square-root rule
 * gave small venues several times more demand per seat, filling them for hours.) A model assumption.
 */
export const venueWeight = (capacity: number, travelSeconds: number): number =>
  Math.max(1, capacity) / (VENUE_TRAVEL_OFFSET_SECONDS + travelSeconds);
/** Share of visits at a student's usual time, jittered by up to ±HABIT_TIME_JITTER_MINUTES. */
export const HABITUAL_TIME_SHARE = 0.7;
const HABIT_TIME_JITTER_MINUTES = 20;
export const habitSlot = (activity: { kind: string; at: number }): string =>
  activity.kind === 'dining' ? activity.at < 10 ? 'breakfast' : activity.at < 15 ? 'midday' : 'dinner' : activity.kind;
export function habitMultiplier(agentId: string, slot: string): number {
  const trait = HABIT_TRAITS[slot];
  if (!trait) return 1;
  return fraction(`${agentId}:habit:${slot}`) < trait.share ? trait.high : (1 - trait.share * trait.high) / (1 - trait.share);
}
export const freeTimeActivities = (weekday: number): readonly FreeTimeActivity[] => FREE_TIME_ACTIVITIES[weekday] ?? [];

// ── Conditions engine hook (sim/conditions.ts, sim/behavior.ts) ──────────────────────────────
// The constants above as behaviour parameters. With no conditions, none of this runs; with
// conditions but no behaviour file, every parameter equals these values and the day is unchanged.
const LEGACY_ACTIVITY_IDS: readonly (readonly string[])[] = (() => {
  const weekday = ['breakfast', 'lunch', 'day-study', 'dinner', 'workout', 'evening-study'];
  const friday = ['breakfast', 'lunch', 'day-study', 'dinner', 'workout', 'night-out'];
  return [weekday, weekday, weekday, weekday, friday, ['brunch', 'day-study', 'workout', 'dinner', 'night-out'],
    ['brunch', 'day-study', 'workout', 'dinner', 'evening-study']];
})();
export const LEGACY_BEHAVIOR: LegacyBehavior = Object.freeze({
  scalars: {
    classAttendance: 1, arrivalLeadMinMinutes: ARRIVAL_LEAD.minimum / 60, arrivalLeadSpreadMinutes: ARRIVAL_LEAD.spread / 60,
    homeBreakMinutes: HOME_BREAK / 60, commuterOffCampusGapMinutes: OFF_CAMPUS_BREAK / 60, offCampusMealShare: MODELED_OFF_CAMPUS_MEAL_SHARE,
    shoulderShare: MODELED_ACTIVITY_SHOULDER_SHARE, walkSpeedFactor: 1, walkSpeedSpread: 0, postClassLingerMinutes: 0, visitLengthSpread: 0,
    gapPlacement: 0, commuterMinClasses: 2, commuterActivityWindowMinutes: 0, unmappedAcademicMinutes: UNMAPPED_ACADEMIC_MINUTES,
    offMapAcademicShare: OFF_MAP_ACADEMIC_SHARE, habitualTimeShare: HABITUAL_TIME_SHARE, favoriteVenueWeight: FAVORITE_VENUE_WEIGHT,
    awayShareResidents: 0, awayShareCommuters: 0, eventAttendanceFactor: 1, commuterOutdoorFactor: 1,
  },
  menus: FREE_TIME_ACTIVITIES.map((menu, day) => menu.map((activity, index): ActivitySpec => ({ id: LEGACY_ACTIVITY_IDS[day][index], ...activity }))),
  habits: Object.fromEntries(Object.entries(HABIT_TRAITS).map(([slot, trait]) => [slot, { ...trait }])),
});
/** Conditioned start: shoulder share and (optionally) bell-shaped core arrivals; equals sampleActivityStart at base values. */
function tunedActivityStart(seed: string, activity: Omit<ActivitySpec, 'id'>, params: ResolvedParams): number {
  if (fraction(`${seed}:shoulder`) < params.scalars.shoulderShare) {
    return (activity.shoulder[0] + fraction(`${seed}:shoulder-time`) * (activity.shoulder[1] - activity.shoulder[0])) * 3600;
  }
  const u = fraction(`${seed}:time`), bell = activity.bell ?? 0;
  const draw = bell > 0 ? (1 - bell) * u + bell * (u + fraction(`${seed}:time-2`) + fraction(`${seed}:time-3`)) / 3 : u;
  return (activity.at + draw * activity.spread) * 3600;
}
/** habitualStart with the day's parameters (identical at base values). */
function tunedHabitualStart(agentId: string, slot: string, seed: string, activity: Omit<ActivitySpec, 'id'>, params: ResolvedParams): number {
  if (fraction(`${seed}:habitual-time`) >= params.scalars.habitualTimeShare) return tunedActivityStart(seed, activity, params);
  const usual = tunedActivityStart(`${agentId}:usual-time:${slot}`, activity, params);
  const jittered = usual + (fraction(`${seed}:habit-jitter`) * 2 - 1) * HABIT_TIME_JITTER_MINUTES * 60;
  const earliest = Math.min(activity.shoulder[0], activity.at) * 3600, latest = Math.max(activity.shoulder[1], activity.at + activity.spread) * 3600;
  return Math.max(earliest, Math.min(latest, jittered));
}
/** habitMultiplier with persona-adjusted regular shares: the student's own share decides whether they
 * are a regular, the population share keeps everyone else's multiplier mean-preserving (identical at base). */
function tunedHabitMultiplier(agentId: string, slot: string, own: ResolvedParams, population: ResolvedParams): number {
  const trait = own.habits[slot], everyone = population.habits[slot] ?? trait;
  if (!trait) return 1;
  if (fraction(`${agentId}:habit:${slot}`) < trait.share) return trait.high;
  return everyone.share < 1 ? Math.max(0, (1 - everyone.share * everyone.high) / (1 - everyone.share)) : 1;
}
/** Habit slot of a menu activity; river visits have their own (sitters and runners). */
const tunedSlot = (activity: Omit<ActivitySpec, 'id'>): string =>
  activity.kind === 'outdoor' ? activity.spot === 'loop' ? 'river-loop' : 'river-lawn' : habitSlot(activity);
/** The nearest start in a free gap of the day's plan (with a walking margin), inside the activity's broad window. */
function placeInGap(stops: readonly Stop[], start: number, seconds: number, shoulder: readonly [number, number]): number {
  const margin = 10 * 60;
  const busy = stops.map(stop => [stop.start - margin, stop.end + margin] as const);
  if (!busy.some(([from, to]) => start < to && start + seconds > from)) return start;
  let best = start, bestGap = Infinity, cursor = Math.max(0, shoulder[0] * 3600);
  const limit = Math.min(DAY, shoulder[1] * 3600 + seconds);
  for (const [from, to] of [...busy, [limit, limit] as const].sort((a, b) => a[0] - b[0])) {
    const gapEnd = Math.min(from, limit);
    if (gapEnd - cursor >= seconds) {
      const placed = Math.min(Math.max(start, cursor), gapEnd - seconds);
      if (Math.abs(placed - start) < bestGap) { bestGap = Math.abs(placed - start); best = placed; }
    }
    cursor = Math.max(cursor, to);
  }
  return best;
}
// ─────────────────────────────────────────────────────────────────────────────────────────────

const HOME_PURPOSE: StayPurpose = Object.freeze({ kind: 'home', fixed: false });
const WAIT_FOR_CLASS: StayPurpose = Object.freeze({ kind: 'wait', fixed: false, before: 'class' });
const WAIT_FOR_ACTIVITY: StayPurpose = Object.freeze({ kind: 'wait', fixed: false, before: 'activity' });

/** Weekday rows may set their own participant limit; the minimum applies when rows disagree. */
export const dailyParticipantLimit = (profile: EstimatedActivityProfile, weekday: number): number => {
  const overrides = profile.weekdayWindows.filter(row => row.weekday === weekday && row.dailyParticipants !== undefined).map(row => row.dailyParticipants!);
  return overrides.length ? Math.min(...overrides) : profile.dailyParticipants;
};
const estimatedProfile = (location: CampusLocation): EstimatedActivityProfile | undefined => location.estimatedProfile;

type Route = { path: [number, number][]; cumulative: number[] };
interface Stop {
  location: string;
  start: number;
  end: number;
  meeting?: SourceMeeting;
  attendanceLimit?: number;
  activity?: SourceActivity['kind'];
  estimatedProfile?: EstimatedActivityProfile;
  gathering?: Gathering;
  component?: string;
  unmappedAcademic?: true;
}

export interface SourceAssignment {
  agentId: string;
  meetingId: string;
  courseCode: string;
  locationId: string;
  startSec: number;
  endSec: number;
  component?: string;
}

export interface SourceDayStats {
  eligibleMeetings: number;
  assignedClasses: number;
  scheduledStudents: number;
  skippedCalendar: number;
  sharedCandidatesSuppressed: number;
  unroutableCandidates: number;
  unroutableTrips: number;
  invalidRoutes: number;
  composedRoutes: number;
  composedTrips: number;
  capacityLimitedCandidates: number;
  roomCapacityLimitedCandidates: number;
  excludedNonDegreeSections: number;
  affinityCourseEnrollments: number;
  excludedIncompleteComponentCourses: number;
  componentBundleRejectedCandidates: number;
  linkedCourseEnrollments: number;
  modeledDegreeCourseSlots: number;
  mappedCourseSlotTargets: number;
  unmappedCourseSlotTargets: number;
  mappedCourseCoverage: Record<'undergraduate' | 'graduate', { mappedOfferings: number; totalOfferings: number; fraction: number }>;

  weeklyEnrolledStudents: number;
  weeklyEnrollments: number;
  unassignedStudents: number;
  eligibleWeeklySections: number;
  campusAccessTrips: number;
  modeledActivities: number;
  modeledOffCampusMeals: number;
  modeledOffCampusOutings: number;
  unavailableActivities: number;
  optionalCapacityRejected: number;
  /** Students whose class arrival waits and post-class lingering were shortened because the building's classroom seats were full. */
  classroomWaitsShortened: number;
  estimatedActivities: number;
  unmappedAcademicBlocks: number;
  behaviorRejectedCandidates: number;
  optionalTravelRejectedCandidates: number;
  estimatedLocationCounts: Record<string, number>;
  /** Commuters assigned a published MBTA commute (stable for the week). */
  transitCommuters: number;
  transitAlightings: number;
  transitBoardings: number;
  /** Rider legs at their own stop with no published trip fitting the itinerary (walked from the stop). Legs
   * whose destination needs a different stop within the 2 km access limit are walked from that stop. */
  transitUnmatchedLegs: number;
  assumptions: string[];
}

export interface SourceActivity {
  agentId: string;
  locationId: string;
  startSec: number;
  endSec: number;
  kind: 'dining' | 'library' | 'gym' | 'off-campus-meal' | 'off-campus-outing' | 'estimated' | 'unmapped-academic' | 'gathering' | 'outdoor';
  estimated?: true;
  purpose?: EstimatedActivityProfile['purpose'] | 'unmapped-academic';
  basis?: string;
  confidence?: 'low';
  note?: string;
  proxy?: string;
  /** Gathering visits: the source event and whether its date was projected onto this weekday. */
  eventId?: string;
  projected?: boolean;
}

export interface SourceDay extends DayData {
  transitRides: TransitRide[];
  sourceStats: SourceDayStats;
  sourceAssignments: SourceAssignment[];
  sourceActivities: SourceActivity[];
  /** Date whose campus events were simulated, or null for the no-event baseline. */
  eventDate: string | null;
  gatherings: GatheringOutcome[];
}

function fraction(key: string): number {
  let value = 2166136261;
  for (let index = 0; index < key.length; index++) value = Math.imul(value ^ key.charCodeAt(index), 16777619);
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13; value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

/** Scenario arrival distribution; known venue hours and itinerary constraints still decide admission. */
export function sampleActivityStart(seed: string, activityIndex: number, weekday = 0): number {
  const activity = freeTimeActivities(weekday)[activityIndex];
  if (!activity) throw new Error('Unknown activity index');
  if (fraction(`${seed}:shoulder`) < MODELED_ACTIVITY_SHOULDER_SHARE) {
    return (activity.shoulder[0] + fraction(`${seed}:shoulder-time`) * (activity.shoulder[1] - activity.shoulder[0])) * 3600;
  }
  return (activity.at + fraction(`${seed}:time`) * activity.spread) * 3600;
}

/** Most visits happen near a student's usual time for that slot; the rest use a fresh daily draw. */
export function habitualStart(agentId: string, slot: string, seed: string, activityIndex: number, weekday: number): number {
  if (fraction(`${seed}:habitual-time`) >= HABITUAL_TIME_SHARE) return sampleActivityStart(seed, activityIndex, weekday);
  const activity = freeTimeActivities(weekday)[activityIndex];
  const usual = sampleActivityStart(`${agentId}:usual-time:${slot}`, activityIndex, weekday);
  const jittered = usual + (fraction(`${seed}:habit-jitter`) * 2 - 1) * HABIT_TIME_JITTER_MINUTES * 60;
  const earliest = Math.min(activity.shoulder[0], activity.at) * 3600, latest = Math.max(activity.shoulder[1], activity.at + activity.spread) * 3600;
  return Math.max(earliest, Math.min(latest, jittered));
}

export function sampleMappedCourseLoad(agentId: string, degreeSlots: number, coverage: number): number {
  let mapped = 0;
  for (let slot = 0; slot < degreeSlots; slot++) if (fraction(`${agentId}:mapped-course-slot:${slot}`) < coverage) mapped++;
  return mapped;
}

function straightLineMetres(a: [number, number], b: [number, number]): number {
  const radians = Math.PI / 180;
  const dlat = (b[1] - a[1]) * radians, dlng = (b[0] - a[0]) * radians;
  const h = Math.sin(dlat / 2) ** 2 + Math.cos(a[1] * radians) * Math.cos(b[1] * radians) * Math.sin(dlng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
}

function campusOf(location: CampusLocation): string {
  return location.campus ?? 'charles-river';
}

function validRoute(route: Route): boolean {
  return route.path.length >= 2 && route.cumulative.length === route.path.length
    && route.cumulative[0] === 0
    && route.path.every((point) => point.length === 2 && point.every(Number.isFinite))
    && route.cumulative.every((distance, index) => Number.isFinite(distance) && distance >= 0
      && (index === 0 || distance >= route.cumulative[index - 1]));
}

/**
 * Cached synthetic weekly enrollment; source seats are upper bounds, never actual enrollment.
 * With a published `transit` timetable, a modeled share of commuters ride real scheduled trips
 * to and from their gateway stop; without it every gateway is only a walking access point.
 * Without `eventDate` this is the no-event baseline. With it, that Boston date's mapped campus
 * events run as Gathering scenarios on this weekday (the date must fall on the same weekday).
 */
export function buildSourceDay(base: DayData, data: CampusData, weekday: number, transit?: TransitService,
  options: { eventDate?: string | null; conditions?: DayConditions; model?: BehaviorModel } = {}): SourceDay {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new Error('Weekday must be Monday=0 through Sunday=6');
  const eventDate = options.eventDate ?? null;
  if (eventDate !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate) || weekdayOf(eventDate) !== weekday)) {
    throw new Error(`Event date ${eventDate} does not fall on weekday ${weekday}`);
  }
  // Conditions engine hook: `conditions` (sim/conditions.ts) change people's timelines through
  // sim/behavior.ts; without them the day is exactly the unconditioned model.
  if (options.conditions && options.conditions.weekday !== weekday) throw new Error('Conditions describe a different weekday');
  let cache = weeklyCache.get(base);
  if (!cache) { cache = new WeakMap(); weeklyCache.set(base, cache); }
  let byTransit = cache.get(data);
  if (!byTransit) { byTransit = new WeakMap(); cache.set(data, byTransit); }
  let makeDay = byTransit.get(transit ?? NO_TRANSIT);
  if (!makeDay) { makeDay = buildWeek(base, data, transit); byTransit.set(transit ?? NO_TRANSIT, makeDay); }
  return makeDay(weekday, eventDate, options.conditions ? dayBehavior(options.conditions, options.model, LEGACY_BEHAVIOR) : undefined);
}

/** Conditioned days kept per week (most recent first); the unconditioned days are kept as before. */
const CONDITIONED_DAYS_KEPT = 4;

function buildWeek(base: DayData, data: CampusData, transit?: TransitService): (weekday: number, eventDate: string | null, behavior?: DayBehavior) => SourceDay {
  const locations = new Map(base.locations.map((location) => [location.id, location]));
  for (const agent of base.agents) {
    if (agent.home !== 'off-campus' && !locations.has(agent.home)) throw new Error(`Student ${agent.id} has an unknown home ${agent.home}`);
  }
  const stats: SourceDayStats = {
    eligibleMeetings: 0, assignedClasses: 0, scheduledStudents: 0, skippedCalendar: 0,
    sharedCandidatesSuppressed: 0, unroutableCandidates: 0, unroutableTrips: 0, invalidRoutes: 0,
    composedRoutes: 0, composedTrips: 0, capacityLimitedCandidates: 0, roomCapacityLimitedCandidates: 0, excludedNonDegreeSections: 0, affinityCourseEnrollments: 0, excludedIncompleteComponentCourses: 0, componentBundleRejectedCandidates: 0, linkedCourseEnrollments: 0, modeledDegreeCourseSlots: 0, mappedCourseSlotTargets: 0, unmappedCourseSlotTargets: 0,
    mappedCourseCoverage: { undergraduate: { mappedOfferings: 0, totalOfferings: 0, fraction: 1 }, graduate: { mappedOfferings: 0, totalOfferings: 0, fraction: 1 } },
    weeklyEnrolledStudents: 0, weeklyEnrollments: 0, unassignedStudents: 0, eligibleWeeklySections: 0, campusAccessTrips: 0, modeledActivities: 0, modeledOffCampusMeals: 0, modeledOffCampusOutings: 0, unavailableActivities: 0, optionalCapacityRejected: 0, classroomWaitsShortened: 0, estimatedActivities: 0, unmappedAcademicBlocks: 0, behaviorRejectedCandidates: 0, optionalTravelRejectedCandidates: 0, estimatedLocationCounts: {},
    transitCommuters: 0, transitAlightings: 0, transitBoardings: 0, transitUnmatchedLegs: 0,
    assumptions: [
      'Enrollment is synthetic and fixed for the whole reference week; published classes supply places, times, and seat upper bounds, not actual enrollment.',
      'Default course eligibility follows BU’s published numeric guide: 100–399 undergraduate, 400–599 undergraduate/graduate, 600–999 graduate; MED MD and graduate-school prefixes use graduate defaults. This is not a prerequisite or individual-permission checker.',
      'Each uncovered course slot may reserve one stable 120-minute weekday academic/study block, subject to route and schedule feasibility. 90% of blocks are placed on campus when feasible (an open library within its capacity, or an academic building where the student has mapped classes, on a day it has classes, 08–22; commuters only on their own class days); the rest, and any that do not fit, are spent off the map. These are explicit uncalibrated estimates, not published courses or observed location histories.',
      'Class arrivals use stable 2–12-minute leads when gaps permit. Home breaks require home dwell at least 15 minutes and at least their extra walking detour. Optional added walking cannot exceed the activity duration.',
      'Gateway changes reserve a straight-line distance/speed lower bound in off-map time in addition to meals/breaks; no route or transport mode outside the saved network is asserted.',
      'Only the eligible mapped/full canonical course-offering coverage fraction of each synthetic degree load is targeted on the map, sampled stably per student. This is an offering-coverage proxy, not measured enrollment; uncovered study remains unknown rather than redistributed to mapped classrooms.',
      'Nondegree 0xx and PDP offerings remain visible in source data but are omitted from modeled degree-course enrollment; noncredit attendance is unknown.',
      'Explicit linked lecture, discussion, and lab requirements are admitted atomically as one degree course. Missing mapped components or unresolved source requirements exclude that course; unknown relationships are not invented.',
      'Each student has a stable synthetic school affinity weighted by eligible section seats. The planner prefers that school for target minus one courses, allowing cross-school electives and feasible fallback. This is a model preference, not an observed major.',
      'Modeled course loads are 1–2 for part-time students, 3–4 for full-time graduate students, and 4–5 for full-time undergraduates; only mapped, reachable, mutually feasible weekly sections are assigned. Linked lecture/lab requirements are unknown.',
      'Concurrent published meetings share one physical building-code/room-code seat pool, including partial time overlaps. Conflicting catalog entries reduce modeled attendance rather than shifting source times or enlarging room capacity.',
      'Unknown room capacity uses a conservative 24-student cap; cross-listed shared occurrences share the same seat pool.',
      'Walking follows compatible bundled pedestrian routes at each student’s stable modeled speed (default 1.4 m/s).',
      'Campus gateway access walks are capped at 2 km; sections requiring longer or unavailable gateway paths are not assigned when campus gateway data exist.',
      'Commuters who walk in choose a campus access point per destination, weighted by exp(-walk distance / 250 m) and shared across stop IDs within 150 m of each other, so they approach from the side nearest where they are going instead of crossing campus; the per-student draw is stable. Transit commuters keep their published-service stop. Only the campus access leg is shown, not an observed commute. Arrival leads vary by 2–12 minutes.',
      'Optional arrival times retain their core windows with a 25% broad-day shoulder. Monday–Thursday: breakfast 07–11, lunch 10:30–16, study 08–22, dinner 16–22, gym 06–22, and a 25% evening library session 18–22:30. Friday trims afternoon study and adds a 35% night out off campus. Saturday and Sunday use a late brunch (09–14), dinner 16:30–20:30, more daytime gym visits, a 45% Saturday outing, and a Sunday afternoon/evening study peak. These are uncalibrated behavior assumptions, not fitted occupancy percentages; published service hours still govern admission.',
      `Venue hours for dates past a venue's published dated horizon repeat that venue's published hours for the same weekday ${CARRY_FORWARD_DAYS} days earlier or later. Dates inside the published range, exact-date closures, and valid weekly schedules are never overridden.`,
      'Students have stable, uncalibrated habits: regular gym-goers (30%), breakfast eaters (45%), library users (50%), outing-goers (50%) and frequent off-campus eaters (35%) have higher daily probabilities while the rest have lower ones, keeping population means unchanged before the 100% cap. Each student also favours one home-relative dining hall, library and gym (5× venue weight) and makes 70% of visits within 20 minutes of a personal usual time.',
      'Resident nights out and weekend outings use physical gateway walks and off-campus stays; no destination, off-map route, or observed social behavior is asserted. Infeasible outings are skipped.',
      'Residents, including those whose homes are outside the map, may take probability-bounded modeled meal, study, and gym trips, including weekends; these are synthetic preferences, not observed attendance. Feasible home breaks and waits fill gaps.',
      'Commuter optional visits are confined to days with published classes and intervals between their first and last class; no extra campus days are assumed.',
      'Off-campus students may leave via their gateway during a gap that permits access walks and at least 30 minutes off-campus; campus waiting remains modeled when a departure does not fit.',
      'Optional visits require published exact-date or valid weekly opening hours; exact-date closures override weekly schedules. Missing or undated hours do not imply availability. Published classes retain their own source times.',
      'Explicit low-confidence scenario profiles may supply estimated academic, research, community, arena, or rowing activities. These use existing students, never published enrollment; source-unassigned students receive priority and source-covered students have a 15% relative participation weight.',
      'Estimated availability never overrides known dated/weekly closures. Restricted arena/rowing profiles describe purpose-specific student participants, not public access. At most one estimated activity is added per student per day.',
      'Optional presence, including waits, reserves conservative minute buckets within existing venue capacities, classroom buildings included (their deduplicated classroom seats). Published class presence is reserved first and never trimmed.',
      'Waiting before a class and lingering after one count against the building’s classroom seats. When a building’s seats are already full, a student (in a stable hashed order) arrives with the minimum lead and leaves when class ends, or walks on right after class and waits at the next class’s building; waits that remain unavoidable (consecutive classes in one building, a full next building) are kept and can exceed the seats.',
      'Open, reachable optional venues are selected with weight capacity / (300 s + round-trip walk), so demand per seat is equal at equal travel; these are modeled capacity/distance weights, not observed preferences. Unavailable venues receive no overflow traffic.',
      `A modeled ${Math.round(MODELED_OFF_CAMPUS_MEAL_SHARE * 100)}% share of attempted resident meals (an uncalibrated model parameter) uses physical gateway walks and off-campus stays; no restaurant, off-map route, or observed meal behavior is asserted. Infeasible meals are skipped.`,
      'Date-limited class notes are excluded. Undated opening-hour snapshots are not authoritative.',
      'Late-night snacks are not modeled. A dining hall, library or gym that is open only outside the modeled visit windows of its kind on a day (After Hours at West Campus opens at 22:30 Monday–Thursday, after modeled dinners end at 22:00) is marked not modeled for that day rather than shown as empty.',
    ],
  };
  if (transit) stats.assumptions.push(
    `With the published MBTA timetable loaded, a stable ${Math.round(TRANSIT_COMMUTER_SHARE * 1000) / 10}% of commuting students ride transit: the public-transportation share of all Charles River Campus commuters (employees and students) in BU's 2013–2023 Institutional Master Plan, Section 8.4 (December 2010 data). It is not a student-only or per-campus measurement.`,
    `Riders use one gateway stop for the week, chosen in proportion to published weekly trips of each route direction stopping there (at least ${MIN_WEEKLY_TRIPS}), and return from the nearest stop within ${MAX_STOP_PAIR_METRES} m served the other way. Each walk onto campus starts ${ALIGHT_SECONDS} s after a published arrival (at most ${MAX_EARLY_ARRIVAL_SECONDS / 60} min early); each walk off campus ends with a wait of at most ${MAX_STOP_WAIT_SECONDS / 60} min for a published departure. Legs no published trip fits are walked from the stop and counted as unmatched.`,
    `MBTA times are the saved GTFS reference week of ${transit.referenceWeekStart}, aligned to the scenario by weekday. BU Shuttle times are TransLoc's recorded current schedules inside captured windows and BU's 2024–25 TransLoc GTFS baseline elsewhere; shuttle lines are loops, so riders go home onward round the same line. Origins, transfers and the off-map part of each journey are unknown. Non-riders do not walk in from Green Line platforms.`,
  );
  const routes = new Map<string, Route>();
  const adjacent = new Map<string, { to: string; route: Route }[]>();
  const endpoints = new Map<string, [number, number]>();
  const near = (a: [number, number], b: [number, number]) => Math.hypot(
    (a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 111320) <= 1;
  for (const [key, route] of Object.entries(base.walkRoutes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const [from, to] = key.split('>');
    const origin = locations.get(from), destination = locations.get(to);
    if (!origin || !destination || !validRoute(route)
      || (endpoints.has(from) && !near(endpoints.get(from)!, route.path[0]))
      || (endpoints.has(to) && !near(endpoints.get(to)!, route.path[route.path.length - 1]))) {
      stats.invalidRoutes++;
      continue;
    }
    if (!endpoints.has(from)) endpoints.set(from, route.path[0]);
    if (!endpoints.has(to)) endpoints.set(to, route.path[route.path.length - 1]);
    routes.set(key, route);
    const list = adjacent.get(from) ?? [];
    list.push({ to, route });
    adjacent.set(from, list);
  }
  const composed = new Set<string>(), missing = new Set<string>();
  const routeBetween = (from: string, to: string): Route | undefined => {
    const origin = locations.get(from), destination = locations.get(to);
    if (!origin || !destination) return undefined;
    const key = `${from}>${to}`;
    if (routes.has(key)) return routes.get(key);
    if (missing.has(key)) return undefined;
    const costs = new Map([[from, 0]]), previous = new Map<string, { from: string; route: Route }>();
    const visited = new Set<string>();
    while (true) {
      let current: string | undefined;
      for (const node of costs.keys()) {
        if (!visited.has(node) && (current === undefined || costs.get(node)! < costs.get(current)!)) current = node;
      }
      if (current === undefined || current === to) break;
      visited.add(current);
      // Conditions engine hook: outdoor spots are destinations only, never shortcuts between places.
      for (const edge of (outdoorIds.size && current !== from && outdoorIds.has(current) ? [] : adjacent.get(current) ?? [])) {
        const cost = costs.get(current)! + edge.route.cumulative[edge.route.cumulative.length - 1];
        if (cost < (costs.get(edge.to) ?? Infinity)) {
          costs.set(edge.to, cost);
          previous.set(edge.to, { from: current, route: edge.route });
        }
      }
    }
    if (!previous.has(to)) { missing.add(key); return undefined; }
    const legs: Route[] = [];
    let current = to;
    while (current !== from) {
      const step = previous.get(current)!;
      legs.unshift(step.route);
      current = step.from;
    }
    const path: [number, number][] = [], cumulative: number[] = [];
    let offset = 0;
    for (const leg of legs) {
      if (path.length && !near(path[path.length - 1], leg.path[0])) { missing.add(key); return undefined; }
      for (let index = path.length ? 1 : 0; index < leg.path.length; index++) {
        path.push(leg.path[index]);
        cumulative.push(offset + leg.cumulative[index]);
      }
      offset += leg.cumulative[leg.cumulative.length - 1];
    }
    const route = { path, cumulative };
    routes.set(key, route);
    composed.add(key);
    stats.composedRoutes++;
    return route;
  };
  // ── Conditions engine hook: outdoor spots by the river (sim/outdoor.ts) join the walk network as
  // leaf nodes through their connectors, which start exactly at a location's saved walk endpoint.
  const outdoorIds = new Set<string>();
  const outdoorLocations: CampusLocation[] = [];
  let outdoorSource: OutdoorFile | undefined;
  const injectOutdoor = (file: OutdoorFile) => {
    if (outdoorSource) return;
    outdoorSource = file;
    for (const spot of file.spots) {
      if (locations.has(spot.id)) continue;
      const location: CampusLocation = { id: spot.id, name: spot.name, short: spot.name, kind: 'outdoor', position: spot.position,
        capacity: spot.kind === 'loop' ? 400 : Math.max(50, Math.round((spot.areaSquareMetres ?? 2000) / 10)), building: spot.id, campus: spot.campus };
      locations.set(spot.id, location);
      let linked = false;
      for (const connector of spot.connectors) {
        const anchor = endpoints.get(connector.location);
        const inward: Route = { path: connector.path, cumulative: connector.cumulative };
        if (!anchor || !validRoute(inward) || !near(anchor, inward.path[0]) || (endpoints.has(spot.id) && !near(endpoints.get(spot.id)!, inward.path.at(-1)!))) continue;
        endpoints.set(spot.id, inward.path.at(-1)!);
        const length = inward.cumulative.at(-1)!;
        const outward: Route = { path: [...inward.path].reverse(), cumulative: [...inward.cumulative].reverse().map(distance => length - distance) };
        routes.set(`${connector.location}>${spot.id}`, inward); routes.set(`${spot.id}>${connector.location}`, outward);
        const from = adjacent.get(connector.location) ?? []; from.push({ to: spot.id, route: inward }); adjacent.set(connector.location, from);
        const back = adjacent.get(spot.id) ?? []; back.push({ to: connector.location, route: outward }); adjacent.set(spot.id, back);
        linked = true;
      }
      if (linked) { outdoorIds.add(spot.id); outdoorLocations.push(location); } else locations.delete(spot.id);
    }
  };
  /** Outdoor spots a free-time visit may use: lawns and riverbanks to sit, or the river path loop. */
  const outdoorCandidates = (spot: 'lawn' | 'loop' | undefined): CampusLocation[] => outdoorLocations.filter(location => {
    const kind = outdoorSource?.spots.find(row => row.id === location.id)?.kind;
    return spot === 'loop' ? kind === 'loop' : kind !== 'loop';
  });
  const baseSpeed = (agent: Agent): number => {
    const value = (agent as Agent & { walkSpeed?: number }).walkSpeed;
    return value === undefined ? WALK_SPEED : Math.max(1.1, Math.min(1.6, Number.isFinite(value) ? value : WALK_SPEED));
  };
  // ── Conditions engine hook: the conditioned day being planned (set only while one is built) ──
  type TunedDay = { behavior: DayBehavior; weekday: number; legacy: Set<string>; params: Map<string, ResolvedParams>; speeds: Map<string, number>;
    gatheringSeats: Map<string, number> };
  let tuned: TunedDay | undefined;
  /** The student's day parameters, or undefined for today's rules (no conditions, or a fallback student). */
  const tunedParams = (agent: Agent): ResolvedParams | undefined => {
    if (!tuned || tuned.legacy.has(agent.id)) return undefined;
    let params = tuned.params.get(agent.id);
    if (!params) { params = tuned.behavior.paramsOf(agent); tuned.params.set(agent.id, params); }
    return params;
  };
  const tunedSpeed = (agent: Agent, day: TunedDay): number => {
    const cached = day.speeds.get(agent.id);
    if (cached !== undefined) return cached;
    const params = tunedParams(agent), legacy = baseSpeed(agent);
    let value = legacy;
    if (params && (params.scalars.walkSpeedFactor !== 1 || params.scalars.walkSpeedSpread !== 0)) {
      const z = (fraction(`${agent.id}:walk-speed:1`) + fraction(`${agent.id}:walk-speed:2`) + fraction(`${agent.id}:walk-speed:3`) - 1.5) * 2;
      value = Math.max(0.9, Math.min(1.9, legacy * params.scalars.walkSpeedFactor + params.scalars.walkSpeedSpread * z));
    }
    day.speeds.set(agent.id, value);
    return value;
  };
  const speed = (agent: Agent): number => tuned ? tunedSpeed(agent, tuned) : baseSpeed(agent);
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  const offCampus = (agent: Agent) => agent.home === 'off-campus' || (agent as Agent & { residency?: string }).residency === 'commuter';
  const duration = (from: string, to: string, agent: Agent): number => {
    if (from === to) return 0;
    const route = from === 'off-campus' || to === 'off-campus'
      ? accessRoute(agent, from === 'off-campus' ? to : from, from === 'off-campus' ? 'in' : 'out') : routeBetween(from, to);
    return route ? route.cumulative[route.cumulative.length - 1] / speed(agent) : Infinity;
  };
  const gateways = new Map<string, Map<string, Route>>();
  for (const [key, route] of Object.entries(base.stopRoutes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    const [stop, location] = key.split('>');
    if (!locations.has(location) || !validRoute(route) || route.cumulative.at(-1)! <= 0) continue;
    const endpoint = endpoints.get(location);
    if (endpoint && !near(endpoint, route.path.at(-1)!)) continue;
    const links = gateways.get(stop) ?? new Map<string, Route>();
    if (links.size && !near(links.values().next().value!.path[0], route.path[0])) continue;
    links.set(location, route); gateways.set(stop, links);
  }
  const gatesByCampus = new Map<string, string[]>();
  for (const [gate, links] of gateways) {
    const campus = campusOf(locations.get(links.keys().next().value!)!);
    const list = gatesByCampus.get(campus) ?? []; list.push(gate); gatesByCampus.set(campus, list);
  }
  const gateCache = new Map<string, Route | undefined>();
  const gatePoint = (gate: string): [number, number] => gateways.get(gate)!.values().next().value!.path[0];
  const agentCampus = (agent: Agent): string => {
    const campus = agent.home === 'off-campus' ? agent.academicCampus ?? agent.campus : agent.campus;
    return campus ?? (locations.has(agent.home) ? campusOf(locations.get(agent.home)!) : 'charles-river');
  };
  // With a published timetable, Green Line platforms are reached by train only; people walking
  // in from off the map use the street-side stops as access points instead.
  const isStation = (gate: string) => gate.startsWith('place-');
  const walkInGates = new Map<string, string[]>();
  for (const [campus, gates] of gatesByCampus) {
    const plain = transit ? gates.filter((gate) => !isStation(gate)) : gates;
    walkInGates.set(campus, plain.length ? plain : gates);
  }
  // A transit commute: arrive at one stop in one direction, go home from the nearest stop the
  // same route serves the other way (the same station for the T, across the street for a bus).
  type Commute = { inGate: string; outGate: string; route: string; inDirection: 0 | 1; outDirection: 0 | 1; weight: number };
  const commutesByCampus = new Map<string, Commute[]>();
  if (transit) for (const [campus, gates] of gatesByCampus) {
    const options: Commute[] = [];
    const serves = (gate: string, route: string, direction: number) => transit.services(gate)
      .some((service) => service.route === route && service.direction === direction && service.weeklyTrips >= MIN_WEEKLY_TRIPS);
    for (const gate of [...gates].sort()) for (const service of transit.services(gate)) {
      if (service.weeklyTrips < MIN_WEEKLY_TRIPS) continue;
      // A loop (every BU Shuttle line) runs one way: the trip home is the same line, onward round the loop.
      const opposite = (1 - service.direction) as 0 | 1;
      const back = gates.some((other) => serves(other, service.route, opposite)) ? opposite : service.direction;
      let partner: string | undefined, best = Infinity;
      for (const other of [...gates].sort()) {
        if (!serves(other, service.route, back)) continue;
        const distance = straightLineMetres(gatePoint(gate), gatePoint(other));
        if (distance < best) { best = distance; partner = other; }
      }
      if (partner && best <= MAX_STOP_PAIR_METRES) options.push({ inGate: gate, outGate: partner, route: service.route,
        inDirection: service.direction, outDirection: back, weight: service.weeklyTrips });
    }
    if (options.length) commutesByCampus.set(campus, options);
  }
  const commuteCache = new Map<string, Commute | null>();
  /** Stable for the week: a modeled share of commuters ride, weighted by published service at each stop. */
  const commuteOf = (agent: Agent): Commute | undefined => {
    if (!transit || agent.residency !== 'commuter') return undefined;
    let commute = commuteCache.get(agent.id);
    if (commute === undefined) {
      commute = null;
      if (fraction(`${agent.id}:transit-commute`) < TRANSIT_COMMUTER_SHARE) {
        const options = commutesByCampus.get(agentCampus(agent)) ?? [];
        let choice = fraction(`${agent.id}:transit-service`) * options.reduce((sum, option) => sum + option.weight, 0);
        commute = options.find((option) => (choice -= option.weight) < 0) ?? null;
      }
      commuteCache.set(agent.id, commute);
    }
    return commute ?? undefined;
  };
  type Leg = 'in' | 'out';
  // Walk-in access points are chosen per destination with a walking-distance decay: people arriving
  // from off the map approach from the side nearest where they are going instead of crossing campus.
  const walkInChoices = new Map<string, { gate: string; cumulative: number }[]>();
  const walkInChoicesFor = (campus: string, location: string) => {
    const key = `${campus}>${location}`;
    let choices = walkInChoices.get(key);
    if (!choices) {
      choices = [];
      let total = 0;
      const gates = [...(walkInGates.get(campus) ?? [])].sort();
      for (const gate of gates) {
        const route = routeFromGate(gate, location);
        if (!route) continue;
        // Several stop IDs at one corner are one way onto campus, not several.
        const neighbours = gates.filter(other => straightLineMetres(gatePoint(gate), gatePoint(other)) <= WALK_IN_CLUSTER_METRES).length;
        total += Math.exp(-route.cumulative.at(-1)! / WALK_IN_DECAY_METRES) / neighbours;
        choices.push({ gate, cumulative: total });
      }
      for (const choice of choices) choice.cumulative /= total || 1;
      walkInChoices.set(key, choices);
    }
    return choices;
  };
  const gateFor = (agent: Agent, leg: Leg, location?: string): string | undefined => {
    const commute = commuteOf(agent);
    if (commute) return leg === 'in' ? commute.inGate : commute.outGate;
    const campus = agentCampus(agent);
    const draw = fraction(`${agent.id}:campus-gateway`);
    const choices = location && locations.has(location) ? walkInChoicesFor(campus, location) : [];
    if (choices.length) return (choices.find(choice => draw < choice.cumulative) ?? choices.at(-1)!).gate;
    const gates = walkInGates.get(campus) ?? [];
    return gates[Math.floor(draw * gates.length)];
  };
  const routeFromGate = (gate: string, location: string): Route | undefined => {
    const key = `${gate}>${location}`;
    if (gateCache.has(key)) return gateCache.get(key);
    const links = gateways.get(gate)!;
    let best = links.get(location);
    if (best && best.cumulative.at(-1)! > MAX_GATEWAY_WALK_METRES) best = undefined;
    if (!best) for (const [via, leg] of links) {
      const onward = routeBetween(via, location);
      if (!onward || !near(leg.path.at(-1)!, onward.path[0])) continue;
      const offset = leg.cumulative.at(-1)!;
      const candidate = { path: [...leg.path, ...onward.path.slice(1)], cumulative: [...leg.cumulative, ...onward.cumulative.slice(1).map(d => d + offset)] };
      if (candidate.cumulative.at(-1)! <= MAX_GATEWAY_WALK_METRES && (!best || candidate.cumulative.at(-1)! < best.cumulative.at(-1)!)) best = candidate;
    }
    gateCache.set(key, best); return best;
  };
  const accessCache = new Map<string, Route | undefined>();
  const accessRoute = (agent: Agent, location: string, leg: Leg): Route | undefined => {
    const preferred = gateFor(agent, leg, location);
    if (!preferred) return undefined;
    const key = `${preferred}>${location}`;
    if (accessCache.has(key)) return accessCache.get(key);
    let route = routeFromGate(preferred, location);
    if (!route) {
      const target = locations.get(location);
      if (target) for (const gate of walkInGates.get(campusOf(target)) ?? []) {
        if (gate === preferred) continue;
        const alternative = routeFromGate(gate, location);
        if (alternative && (!route || alternative.cumulative.at(-1)! < route.cumulative.at(-1)!)) route = alternative;
      }
    }
    accessCache.set(key, route); return route;
  };
  const accessDuration = (agent: Agent, location: string, leg: Leg) => (accessRoute(agent, location, leg)?.cumulative.at(-1) ?? Infinity) / speed(agent);
  type WeeklyStop = Stop & { weekday: number; pool: string; room?: string; roomSlots?: number[] };
  type Section = { id: string; course: string; campus: string; stops: WeeklyStop[]; aliases: Section[] };
  const sections = new Map<string, Section>();
  const limits = new Map<string, number>();
  const used = new Map<string, number>();
  const occurrences = new Set<string>();
  const rooms = new Map<string, { knownLimit?: number; boundaries: Set<number>; stops: WeeklyStop[] }>();
  const physicalRoom = (source: CampusData['locations'][string], meeting: SourceMeeting): string => {
    const building = meeting.buildingCode || (source.buildingCodes.length === 1 ? source.buildingCodes[0] : undefined);
    const identity = building ? `code:${building.trim().toUpperCase()}` : `mapped:${locations.get(source.id)!.building || source.id}`;
    return `${identity}:room:${meeting.roomCode.trim().toUpperCase() || `unresolved:${meeting.sharedKey ?? meeting.id}`}`;
  };

  const dates = Array.from({ length: 7 }, (_, day) => dateForWeekday(data, day));
  const openingCache = new Map<string, [number, number][]>();
  const optionalWindows = (location: string, weekday: number): [number, number][] => {
    if (data.locations[location]?.hoursStatus === 'restricted') return [];
    const key = `${location}:${weekday}`;
    const cached = openingCache.get(key);
    if (cached) return cached;
    const windows = venueWindows(data, location, locations.get(location)?.kind, weekday, { carryForward: true });
    openingCache.set(key, windows); return windows;
  };
  const isOpen = (stop: WeeklyStop): boolean => {
    // Conditions engine hook: river spots are open air (daylight limits come from the activity windows).
    if (stop.meeting || stop.location === 'off-campus' || stop.activity === 'outdoor') return true;
    // The event's published time is the access evidence; planning keeps attendance inside it.
    if (stop.gathering) return stop.gathering.startSec <= stop.start && stop.end <= stop.gathering.endSec;
    if (stop.estimatedProfile) {
      const profile = stop.estimatedProfile;
      const source = data.locations[stop.location];
      if (source?.hoursStatus === 'restricted' && profile.purpose !== 'arena' && profile.purpose !== 'rowing') return false;
      if (!profile.weekdayWindows.some(row => row.weekday === stop.weekday && row.windows.some(([start, end]) => start <= stop.start && stop.end <= end))) return false;
      const known = openingHoursForDate(source?.hours ?? [], dates[stop.weekday], stop.weekday);
      return !known.length || known.some(entry => entry.windows.some(([start, end]) => start <= stop.start && stop.end <= end));
    }
    if (stop.unmappedAcademic && locations.get(stop.location)?.kind === 'classroom') {
      return classDays(stop.location).has(stop.weekday) && CAMPUS_STUDY_HOURS[0] <= stop.start && stop.end <= CAMPUS_STUDY_HOURS[1];
    }
    return optionalWindows(stop.location, stop.weekday).some(([opens, closes]) => opens <= stop.start && stop.end <= closes);
  };
  let classDayIndex: Map<string, Set<number>> | undefined;
  /** Weekdays with published classes in a building; academic buildings are only used for study on those days. */
  const classDays = (location: string): Set<number> => {
    if (!classDayIndex) {
      classDayIndex = new Map();
      for (const section of sections.values()) for (const stop of section.stops) {
        const days = classDayIndex.get(stop.location) ?? new Set<number>(); days.add(stop.weekday); classDayIndex.set(stop.location, days);
      }
    }
    return classDayIndex.get(location) ?? new Set();
  };
  const excludedNonDegree = new Set<string>();
  const componentRules = data.courseComponentRules ?? {};
  const incompleteCourses = new Set(Object.entries(componentRules).filter(([, rule]) =>
    rule.status !== 'resolved' || !rule.hasCompleteMappedOption || !rule.components.length).map(([course]) => course));
  stats.excludedIncompleteComponentCourses = [...incompleteCourses].filter(course => componentRules[course].mappedCourse).length;

  for (const source of Object.values(data.locations).sort((a, b) => a.id.localeCompare(b.id))) {
    if (!locations.has(source.id)) continue;
    for (const meeting of [...source.meetings].sort((a, b) => a.id.localeCompare(b.id))) {
      if (meeting.calendarRestricted) { stats.skippedCalendar++; continue; }
      if (incompleteCourses.has(meeting.courseCode)) continue;
      const id = meeting.sourceSectionKey ?? `${meeting.courseCode}:${meeting.section}`;
      if (!countsTowardDegreeLoad(meeting.courseCode)) { excludedNonDegree.add(id); continue; }
      const section: Section = sections.get(id) ?? { id, course: meeting.courseCode, campus: campusOf(locations.get(source.id)!), stops: [], aliases: [] };
      for (const interval of effectiveMeetingIntervals(meeting, data)) {
        const weekday = interval.weekday, start = interval.startSec - weekday * DAY, end = interval.endSec - weekday * DAY;
        if (weekday < 0 || weekday > 6 || start < 0 || start >= end || end > DAY || !Number.isFinite(start + end)) continue;
        const pool = `${meeting.sharedKey ?? meeting.id}:${weekday}:${start}:${end}`;
        const limit = meeting.roomCapacity !== null && Number.isFinite(meeting.roomCapacity) ? Math.max(0, Math.floor(meeting.roomCapacity)) : 24;
        limits.set(pool, Math.min(limits.get(pool) ?? Infinity, limit));
        if (occurrences.has(pool)) stats.sharedCandidatesSuppressed++;
        occurrences.add(pool);
        const room = physicalRoom(source, meeting);
        const roomState = rooms.get(room) ?? { boundaries: new Set<number>(), stops: [] };
        if (meeting.roomCapacity !== null && Number.isFinite(meeting.roomCapacity)) {
          roomState.knownLimit = Math.min(roomState.knownLimit ?? Infinity, Math.max(0, Math.floor(meeting.roomCapacity)));
        }
        roomState.boundaries.add(weekday * DAY + start); roomState.boundaries.add(weekday * DAY + end);
        if (!section.stops.some((stop) => stop.pool === pool)) {
          const stop = { location: source.id, start, end, weekday, meeting, pool, room };
          section.stops.push(stop); roomState.stops.push(stop);
        }
        rooms.set(room, roomState);
      }
      if (section.stops.length) sections.set(id, section);
    }
  }
  // Exact boundary segments share seats across partially overlapping section patterns.
  const roomSlotLimits: number[] = [];
  for (const room of rooms.values()) {
    const boundaries = [...room.boundaries].sort((a, b) => a - b);
    const indices = new Map(boundaries.map((time, index) => [time, index]));
    const offset = roomSlotLimits.length;
    for (let index = 1; index < boundaries.length; index++) roomSlotLimits.push(room.knownLimit ?? 24);
    for (const stop of room.stops) {
      const first = indices.get(stop.weekday * DAY + stop.start)!;
      const last = indices.get(stop.weekday * DAY + stop.end)!;
      stop.roomSlots = Array.from({ length: last - first }, (_, index) => offset + first + index);
    }
  }
  const roomAttendance = new Int32Array(roomSlotLimits.length);
  // Cross-listed aliases with identical weekly occurrences represent one section.
  const signatures = new Map<string, Section>();
  const canonicalForAlias = new Map<string, Section>();
  const sectionsByCode = new Map<string, Section[]>();
  const byCampus = new Map<string, Section[]>();
  for (const section of sections.values()) {
    section.stops.sort((a, b) => a.weekday - b.weekday || a.start - b.start);
    const labelKey = `${section.course}:${section.stops[0].meeting!.section.trim().toUpperCase()}`;
    const sameLabel = sectionsByCode.get(labelKey) ?? [];
    sameLabel.push(section); sectionsByCode.set(labelKey, sameLabel);
    const signature = section.stops.map((stop) => stop.pool).sort().join('|');
    const canonical = signatures.get(signature);
    if (canonical) { canonical.aliases.push(section); canonicalForAlias.set(section.id, canonical); continue; }
    section.aliases = [section]; signatures.set(signature, section); canonicalForAlias.set(section.id, section);
    const list = byCampus.get(section.campus) ?? [];
    list.push(section); byCampus.set(section.campus, list);
  }
  stats.eligibleWeeklySections = signatures.size;
  stats.excludedNonDegreeSections = excludedNonDegree.size;
  function feasible(stops: WeeklyStop[], agent: Agent): boolean {
    let previous: WeeklyStop | undefined;
    for (const stop of stops) {
      if (!isOpen(stop)) return false;
      if (!previous || previous.weekday !== stop.weekday) {
        if (previous && previous.end + (previous.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, previous.location, 'out') : duration(previous.location, agent.home, agent)) > DAY) return false;
        if ((stop.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, stop.location, 'in') : duration(agent.home, stop.location, agent)) > stop.start) { stats.unroutableCandidates++; return false; }
      } else {
        const walk = duration(previous.location, stop.location, agent);
        if (!Number.isFinite(walk)) stats.unroutableCandidates++;
        if (previous.end + walk > stop.start) return false;

      }
      previous = stop;
    }
    return !previous || previous.end + (previous.location === agent.home ? 0 : offCampus(agent) ? accessDuration(agent, previous.location, 'out') : duration(previous.location, agent.home, agent)) <= DAY;
  }
  const schoolOf = (course: string) => /^([A-Z]{2,5})\s/.exec(course)?.[1] ?? 'unknown';
  const eligibleAliases = (section: Section, level: Agent['studentLevel']) => section.aliases.filter(alias =>
    !level || eligibleStudentLevels(alias.course).includes(level));
  const selectAlias = (section: Section, agent: Agent, school: string): Section | undefined => eligibleAliases(section, agent.studentLevel)
    .sort((a, b) => Number(schoolOf(b.course) === school) - Number(schoolOf(a.course) === school)
      || Number(courseLevel(b.course) === agent.studentLevel) - Number(courseLevel(a.course) === agent.studentLevel)
      || a.id.localeCompare(b.id))[0];
  type CandidateIndex = { all: Section[]; schools: Map<string, Section[]>; weights: [string, number][] };
  const candidateIndices = new Map<string, CandidateIndex>();
  const indexFor = (campus: string, level: Agent['studentLevel']): CandidateIndex => {
    const key = `${campus}:${level ?? 'unknown'}`;
    const cached = candidateIndices.get(key);
    if (cached) return cached;
    const all = (byCampus.get(campus) ?? []).filter(section => eligibleAliases(section, level).length);
    const schools = new Map<string, Section[]>(), weights = new Map<string, number>();
    for (const section of all) {
      const aliases = eligibleAliases(section, level);
      const uniqueSchools = new Set(aliases.map(alias => schoolOf(alias.course)));
      const seats = Math.min(...section.stops.map(stop => limits.get(stop.pool)!));
      for (const school of uniqueSchools) {
        const list = schools.get(school) ?? []; list.push(section); schools.set(school, list);
        weights.set(school, (weights.get(school) ?? 0) + seats / uniqueSchools.size);
      }
    }
    const index = { all, schools, weights: [...weights] };
    candidateIndices.set(key, index); return index;
  };
  const catalogGroups = data.catalogCourseCoverage?.courseGroups ?? data.catalogCourseCodes?.map(code => [code]);
  const mappedCodes = new Set([...sections.values()].map(section => section.course));
  if (catalogGroups) for (const level of ['undergraduate', 'graduate'] as const) {
    const eligibleGroups = catalogGroups.map(group => group.filter(code => countsTowardDegreeLoad(code) && eligibleStudentLevels(code).includes(level))).filter(group => group.length);
    const mappedOfferings = eligibleGroups.filter(group => group.some(code => mappedCodes.has(code))).length;
    stats.mappedCourseCoverage[level] = { mappedOfferings, totalOfferings: eligibleGroups.length,
      fraction: eligibleGroups.length ? mappedOfferings / eligibleGroups.length : 0 };
  }
  type Admission = { section: Section; alias: Section; component?: string };
  const sectionCode = (alias: Section) => alias.stops[0].meeting!.section.trim().toUpperCase();
  const sectionFull = (section: Section) => section.stops.some(stop => (used.get(stop.pool) ?? 0) >= limits.get(stop.pool)!
    || stop.roomSlots!.some(slot => roomAttendance[slot] >= roomSlotLimits[slot]));
  const bundleFor = (section: Section, alias: Section, agent: Agent, existing: WeeklyStop[]): Admission[] | undefined => {
    const rule = componentRules[alias.course];
    if (!rule) return [{ section, alias }];
    const anchor = rule.components.find(component => component.sections.includes(sectionCode(alias)));
    if (!anchor) return undefined;
    const selected = new Map<string, Admission>([[anchor.id, { section, alias, component: anchor.id }]]);
    const dependenciesFit = () => rule.dependencies.every(dependency => ![...selected.values()].some(choice => sectionCode(choice.alias) === dependency.section)
      || dependency.requires.every(requirement => !selected.has(requirement.component)
        || requirement.sections.includes(sectionCode(selected.get(requirement.component)!.alias))));
    const options = new Map(rule.components.map(component => [component.id, component.sections.flatMap(code =>
      (sectionsByCode.get(`${alias.course}:${code}`) ?? []).map(choice =>
        ({ alias: choice, section: canonicalForAlias.get(choice.id)!, component: component.id })))
      .filter(choice => !agent.studentLevel || eligibleStudentLevels(choice.alias.course).includes(agent.studentLevel))]));
    const missing = rule.components.filter(component => component.id !== anchor.id)
      .sort((a, b) => options.get(a.id)!.length - options.get(b.id)!.length);
    let searched = 0;
    const search = (index: number): Admission[] | undefined => {
      if (!dependenciesFit()) return undefined;
      if (index === missing.length) {
        const chosen = [...selected.values()];
        return feasible([...existing, ...chosen.flatMap(choice => choice.alias.stops)].sort((a, b) => a.weekday - b.weekday || a.start - b.start), agent) ? chosen : undefined;
      }
      const component = missing[index], candidates = options.get(component.id)!;
      const start = Math.floor(fraction(`${agent.id}:${alias.course}:${component.id}:component-choice`) * candidates.length);
      for (let attempt = 0; attempt < Math.min(candidates.length, COMPONENT_OPTIONS_PER_COMPONENT) && searched < COMPONENT_BUNDLE_SEARCH_LIMIT; attempt++, searched++) {
        const choice = candidates[(start + attempt) % candidates.length];
        if (sectionFull(choice.section) || [...selected.values()].some(other => other.section === choice.section)) continue;
        selected.set(component.id, choice);
        if (dependenciesFit() && feasible([...existing, ...[...selected.values()].flatMap(row => row.alias.stops)].sort((a, b) => a.weekday - b.weekday || a.start - b.start), agent)) {
          const result = search(index + 1);
          if (result) return result;
        }
        selected.delete(component.id);
      }
      return undefined;
    };
    return search(0);
  };
  const enrollment = new Map<string, WeeklyStop[]>();
  const unmappedLoads = new Map<string, number>();
  const fullSections = new Set<Section>();
  const order = [...base.agents].sort((a, b) => fraction(`weekly:${a.id}`) - fraction(`weekly:${b.id}`) || a.id.localeCompare(b.id));
  for (const agent of order) {
    const campus = agent.academicCampus ?? agent.campus ?? campusOf(locations.get(agent.home)!);
    const index = indexFor(campus, agent.studentLevel);
    let schoolChoice = fraction(`${agent.id}:academic-affinity`) * index.weights.reduce((sum, [, weight]) => sum + weight, 0);
    const affinity = index.weights.find(([, weight]) => { schoolChoice -= weight; return schoolChoice < 0; })?.[0] ?? 'unknown';
    let stops: WeeklyStop[] = [];
    const courses = new Set<string>();
    let courseCount = 0, attempts = 0;
    const minimum = agent.attendance === 'part-time' ? 1 : agent.studentLevel === 'graduate' ? 3 : 4;
    const degreeTarget = minimum + Math.floor(fraction(`${agent.id}:course-count`) * 2);
    const coverage = agent.studentLevel ? stats.mappedCourseCoverage[agent.studentLevel].fraction : 1;
    const target = sampleMappedCourseLoad(agent.id, degreeTarget, coverage);
    stats.modeledDegreeCourseSlots += degreeTarget; stats.mappedCourseSlotTargets += target;
    stats.unmappedCourseSlotTargets += degreeTarget - target;
    unmappedLoads.set(agent.id, degreeTarget - target);
    const tested = new Set<Section>();
    const scan = (candidates: Section[], limit: number, budget: number, phase: string) => {
      const startIndex = Math.floor(fraction(`${agent.id}:weekly-start:${phase}`) * candidates.length);
      const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
      let stride = 1 + Math.floor(fraction(`${agent.id}:weekly-stride:${phase}`) * Math.max(1, candidates.length - 1));
      while (candidates.length && gcd(stride, candidates.length) !== 1) stride++;
      for (let attempt = 0; attempt < budget && candidates.length && courseCount < limit; attempt++, attempts++) {
        const position = (startIndex + attempt * stride) % candidates.length;
        const section = candidates[position];
        const poolFull = section.stops.some(stop => (used.get(stop.pool) ?? 0) >= limits.get(stop.pool)!);
        const roomFull = section.stops.some(stop => stop.roomSlots!.some(slot => roomAttendance[slot] >= roomSlotLimits[slot]));
        if (fullSections.has(section) || poolFull || roomFull) {
          candidates[position] = candidates[candidates.length - 1]; candidates.pop(); fullSections.add(section);
          if (poolFull) stats.capacityLimitedCandidates++;
          else if (roomFull) stats.roomCapacityLimitedCandidates++;
          continue;
        }
        if (tested.has(section)) continue;
        tested.add(section);
        const alias = selectAlias(section, agent, affinity)!;
        if (courses.has(alias.course) || section.aliases.some(other => courses.has(other.course))) continue;
        const bundle = bundleFor(section, alias, agent, stops);
        if (!bundle) { stats.componentBundleRejectedCandidates++; continue; }
        const componentStops = bundle.flatMap(choice => choice.alias.stops.map(stop => choice.component ? { ...stop, component: choice.component } : stop));
        const proposed = [...stops, ...componentStops].sort((a, b) => a.weekday - b.weekday || a.start - b.start);
        if (!feasible(proposed, agent)) continue;
        stops = proposed; courseCount++;
        for (const choice of bundle) for (const other of choice.section.aliases) courses.add(other.course);
        if (componentRules[alias.course]) stats.linkedCourseEnrollments++;
        if (schoolOf(alias.course) === affinity) stats.affinityCourseEnrollments++;
        for (const stop of componentStops) {
          used.set(stop.pool, (used.get(stop.pool) ?? 0) + 1);
          for (const slot of stop.roomSlots!) roomAttendance[slot]++;
        }
      }
    };
    scan(index.schools.get(affinity) ?? [], Math.max(0, target - 1), Math.floor(COURSE_CANDIDATE_ATTEMPTS * AFFINITY_ATTEMPT_SHARE), 'affinity');
    scan(index.all, target, COURSE_CANDIDATE_ATTEMPTS - attempts, 'elective-fallback');
    if (courseCount) stats.weeklyEnrolledStudents++;
    stats.weeklyEnrollments += courseCount;
    enrollment.set(agent.id, stops);
  }
  stats.unassignedStudents = base.agents.length - stats.weeklyEnrolledStudents;
  // Predict the same waits as the emitter; reserve complete presence, not just planned activity time.
  const resourceLocations = base.locations.filter(location => ['dining', 'library', 'gym'].includes(location.kind) || estimatedProfile(location));
  const resourceIndex = new Map(resourceLocations.map((location, index) => [location.id, index]));
  const bucketsPerDay = DAY / OPTIONAL_CAPACITY_BUCKET_SECONDS;
  type PlannedStay = { location: string; start: number; end: number; purpose: StayPurpose };
  const purposeCache = new WeakMap<WeeklyStop, StayPurpose>();
  /** Purpose of time spent at a planned stop itself. */
  const stopPurpose = (stop: WeeklyStop): StayPurpose => {
    const cached = purposeCache.get(stop);
    if (cached) return cached;
    let purpose: StayPurpose;
    if (stop.meeting) purpose = { kind: 'class', fixed: true, meetingId: stop.meeting.id, courseCode: stop.meeting.courseCode };
    else if (stop.estimatedProfile) purpose = { kind: 'estimated', fixed: false, purpose: stop.estimatedProfile.purpose };
    else if (stop.gathering) purpose = { kind: 'gathering', fixed: false, eventId: stop.gathering.eventId };
    else if (stop.activity && stop.activity !== 'estimated' && stop.activity !== 'gathering') purpose = { kind: stop.activity, fixed: false };
    else throw new Error('Planned stop has neither a meeting nor an activity');
    purposeCache.set(stop, purpose); return purpose;
  };
  const waitFor = (stop: WeeklyStop): StayPurpose => stop.meeting ? WAIT_FOR_CLASS : WAIT_FOR_ACTIVITY;
  type PlannedMove = { from: string; to: string; route: Route; depart: number; arrive: number };
  type DayPlan = { stays: PlannedStay[]; moves: PlannedMove[]; walkingSeconds: number; rides: Omit<TransitRide, 'agent'>[]; unmatchedLegs: number };
  const reversed = new WeakMap<Route, Route>();
  const movementRoute = (agent: Agent, from: string, to: string): Route | undefined => {
    if (from !== 'off-campus' && to !== 'off-campus') return routeBetween(from, to);
    const inward = accessRoute(agent, from === 'off-campus' ? to : from, from === 'off-campus' ? 'in' : 'out');
    if (!inward || from === 'off-campus') return inward;
    let outward = reversed.get(inward);
    if (!outward) {
      const length = inward.cumulative.at(-1)!;
      outward = { path: [...inward.path].reverse(), cumulative: [...inward.cumulative].reverse().map(distance => length - distance) };
      reversed.set(inward, outward);
    }
    return outward;
  };
  /**
   * The published arrival a rider steps off before walking in. Prefers the last vehicle that lets
   * them start walking by `wanted` (at most an hour early), else the first one that still makes
   * `latest`. `fits` rejects starts whose earlier arrival would break a venue's hours.
   */
  // Modeled students using each published trip today (alighting plus boarding, so the vehicle's
  // simultaneous student load can never exceed it). Reset per day; committed per student.
  let tripLoad = new Map<string, number>();
  const tripHasRoom = (trip: string, route: string) => (tripLoad.get(trip) ?? 0) < VEHICLE_PEAK_MAX_LOAD[routeKind(route)];
  const matchAlighting = (commute: Commute, weekday: number, earliest: number, wanted: number, latest: number,
    fits: (walkStart: number) => boolean) => {
    const visits = transit!.visits(commute.inGate, commute.route, commute.inDirection, weekday, 'alight');
    if (!visits) return undefined;
    const low = Math.max(earliest, wanted - MAX_EARLY_ARRIVAL_SECONDS);
    const usable = (index: number) => {
      const start = visits.arrivals[index] + ALIGHT_SECONDS;
      return start >= low - 1e-7 && start <= latest + 1e-7 && tripHasRoom(visits.trips[index], commute.route) && fits(start);
    };
    const before = lastAtOrBefore(visits.arrivals, wanted - ALIGHT_SECONDS);
    for (let index = before; index >= 0 && visits.arrivals[index] + ALIGHT_SECONDS >= low - 1e-7; index--) if (usable(index)) return { visits, index };
    for (let index = before + 1; index < visits.arrivals.length && visits.arrivals[index] + ALIGHT_SECONDS <= latest + 1e-7; index++) if (usable(index)) return { visits, index };
    return undefined;
  };
  // Students whose class waits are changed today because a classroom building's seats are full (see
  // buildDay): 1 = minimum arrival lead and no lingering; 2 = also walk on right after class and wait
  // at the next class's building instead of the last one.
  let compactArrivals = new Map<string, 1 | 2>();
  const planDay = (agent: Agent, stops: WeeklyStop[]): DayPlan | undefined => {
    const stays: PlannedStay[] = [], moves: PlannedMove[] = [];
    const compact = compactArrivals.get(agent.id) ?? 0;
    const rides: DayPlan['rides'] = [];
    let unmatchedLegs = 0;
    const commute = commuteOf(agent);
    const weekday = stops[0]?.weekday ?? 0;
    const home = offCampus(agent) ? 'off-campus' : agent.home;
    let from = home, freeAt = 0, notBeforeDeparture = 0, walkingSeconds = 0, valid = true;
    // Conditions engine hook: day parameters (undefined = today's constants) and post-class lingering.
    const params = tunedParams(agent);
    const offCampusBreak = params ? params.scalars.commuterOffCampusGapMinutes * 60 : OFF_CAMPUS_BREAK;
    const homeBreak = params ? params.scalars.homeBreakMinutes * 60 : HOME_BREAK;
    const arrivalLead = params ? { minimum: params.scalars.arrivalLeadMinMinutes * 60, spread: params.scalars.arrivalLeadSpreadMinutes * 60 } : ARRIVAL_LEAD;
    let lingerUntil = 0;
    let currentBasis: WeeklyStop | undefined;
    let outside: { point: [number, number]; arrived: number; dwell: number } | undefined;
    /** Only a stop's own [start, end) carries its purpose (passed explicitly). Gap and lingering time
     * is home at home, otherwise a non-fixed wait before `next`; it never inherits the prior stop's
     * class or activity. The only next-less lingering is off-map gateway transfer time before going home. */
    const addStay = (location: string, start: number, end: number, basis?: WeeklyStop, purpose?: StayPurpose, next?: WeeklyStop) => {
      if (end <= start) return;
      if (start < 0 || end > DAY || (basis && !basis.meeting && !isOpen({ ...basis, start, end }))) { valid = false; return; }
      stays.push({ location, start, end, purpose: purpose ?? (location === home ? HOME_PURPOSE : next ? waitFor(next) : WAIT_FOR_ACTIVITY) });
    };
    const offReady = (destination: string): number => {
      if (!outside) return freeAt;
      const gate = accessRoute(agent, destination, 'in')?.path[0];
      return gate ? outside.arrived + outside.dwell + straightLineMetres(outside.point, gate) / speed(agent) : Infinity;
    };
    const move = (destination: string, depart: number): boolean => {
      if (destination === from) return true;
      const route = movementRoute(agent, from, destination);
      if (!route || depart < freeAt - 1e-7 || (from === 'off-campus' && depart < offReady(destination) - 1e-7)) return false;
      const seconds = route.cumulative.at(-1)! / speed(agent), arrive = depart + seconds;
      if (!Number.isFinite(arrive) || depart < 0 || arrive > DAY) return false;
      if (seconds > 0) { moves.push({ from, to: destination, route, depart, arrive }); walkingSeconds += seconds; }
      else if (straightLineMetres(route.path[0], route.path.at(-1)!) > 1) return false;
      if (destination === 'off-campus') outside = { point: route.path.at(-1)!, arrived: arrive, dwell: 0 };
      else if (from === 'off-campus') outside = undefined;
      from = destination; freeAt = arrive; currentBasis = undefined; notBeforeDeparture = arrive; lingerUntil = 0;
      return true;
    };
    for (const stop of stops) {
      if (home === 'off-campus' && from !== 'off-campus' && stop.location === 'off-campus') {
        if (!move('off-campus', freeAt)) return undefined;
      }
      if (home === 'off-campus' && from !== 'off-campus' && stop.location !== 'off-campus') {
        const out = accessRoute(agent, from, 'out'), inward = accessRoute(agent, stop.location, 'in');
        if (out && inward) {
          const transfer = straightLineMetres(out.path[0], inward.path[0]) / speed(agent);
          if (freeAt + accessDuration(agent, from, 'out') + offCampusBreak + transfer + accessDuration(agent, stop.location, 'in') <= stop.start) {
            if (!move('off-campus', freeAt)) return undefined;
            outside!.dwell = offCampusBreak;
          }
        }
      }
      if (home !== 'off-campus' && from !== home) {
        const toHome = duration(from, home, agent), homeToNext = duration(home, stop.location, agent);
        const extra = Math.max(0, toHome + homeToNext - duration(from, stop.location, agent));
        const dwell = Math.max(homeBreak, extra);
        const departHomeward = from === 'off-campus' ? Math.max(freeAt, offReady(home)) : Math.max(freeAt, lingerUntil);
        if (departHomeward + toHome + dwell + homeToNext <= stop.start) {
          addStay(from, freeAt, departHomeward, currentBasis);
          if (!move(home, departHomeward)) return undefined;
          notBeforeDeparture = freeAt + dwell;
        }
      }
      if (from === stop.location) addStay(from, freeAt, stop.start, currentBasis, undefined, stop);
      else {
        const walk = duration(from, stop.location, agent);
        const latest = stop.start - walk;
        const earliest = Math.max(freeAt, notBeforeDeparture, from === 'off-campus' ? offReady(stop.location) : 0, Math.min(lingerUntil, latest));
        const desiredLead = !stop.meeting ? 0 : compact ? arrivalLead.minimum
          : arrivalLead.minimum + fraction(`${agent.id}:${stop.weekday}:${stop.meeting.id}:arrival-lead`) * arrivalLead.spread;
        let depart = compact === 2 && locations.get(from)?.kind === 'classroom' ? earliest : Math.max(earliest, latest - desiredLead);
        if (depart > latest + 1e-7) return undefined;
        let ride: DayPlan['rides'][number] | undefined;
        const gate = from === 'off-campus' && commute ? movementRoute(agent, from, stop.location)?.path[0] : undefined;
        if (commute && gate) {
          // Riders arrive on a published trip; walking starts once they are off it.
          const onPlatform = straightLineMetres(gate, gatePoint(commute.inGate)) <= 1;
          const fits = (start: number) => !!stop.meeting || start + walk >= stop.start
            || isOpen({ ...stop, start: start + walk, end: stop.start });
          const match = onPlatform ? matchAlighting(commute, weekday, earliest, depart, latest, fits) : undefined;
          if (match) {
            depart = match.visits.arrivals[match.index] + ALIGHT_SECONDS;
            ride = { kind: 'alight', trip: match.visits.trips[match.index], route: commute.route, direction: commute.inDirection,
              stop: commute.inGate, time: match.visits.arrivals[match.index], position: gate };
          } else if (onPlatform) unmatchedLegs++;
        }
        addStay(from, freeAt, depart, currentBasis, undefined, stop);
        if (!move(stop.location, depart)) return undefined;
        if (ride) rides.push(ride);
        addStay(stop.location, freeAt, stop.start, stop, waitFor(stop));
      }
      addStay(stop.location, stop.start, stop.end, stop, stopPurpose(stop));
      if (stop.location === 'off-campus' && outside) outside.dwell += stop.end - stop.start;
      from = stop.location; freeAt = stop.end; notBeforeDeparture = freeAt; currentBasis = stop;
      lingerUntil = params && !compact && stop.meeting && stop.end < DAY - 3 * 3600
        ? stop.end + fraction(`${agent.id}:${stop.weekday}:${stop.meeting.id}:linger`) * params.scalars.postClassLingerMinutes * 60 : 0;
      if (!valid) return undefined;
    }
    if (from !== home) {
      const depart = from === 'off-campus' ? Math.max(freeAt, offReady(home)) : Math.max(freeAt, lingerUntil);
      addStay(from, freeAt, depart, currentBasis);
      if (!move(home, depart)) return undefined;
    }
    addStay(home, freeAt, DAY, undefined, HOME_PURPOSE);
    if (!valid) return undefined;
    // Riders leaving campus wait at their stop for the next published departure the other way,
    // and must be aboard before any later return to campus.
    if (commute) moves.forEach((leg, index) => {
      if (leg.to !== 'off-campus') return;
      const stopPoint = leg.route.path.at(-1)!;
      const visits = transit!.visits(commute.outGate, commute.route, commute.outDirection, weekday, 'board');
      const returnLeg = moves.slice(index + 1).find((later) => later.from === 'off-campus');
      const limit = Math.min(leg.arrive + MAX_STOP_WAIT_SECONDS, returnLeg ? returnLeg.depart - ALIGHT_SECONDS - 60 : DAY - 1);
      let best = -1;
      // A walk that had to use another stop (no route within 2 km from the rider's own) isn't a ride.
      if (straightLineMetres(stopPoint, gatePoint(commute.outGate)) > 1) return;
      if (visits) {
        for (let k = Math.max(0, lastAtOrBefore(visits.arrivals, leg.arrive - 600)); k < visits.arrivals.length && visits.arrivals[k] <= limit; k++) {
          const departure = visits.departures[k];
          if (departure >= leg.arrive && departure <= limit && tripHasRoom(visits.trips[k], commute.route)
            && (best < 0 || departure < visits.departures[best])) best = k;
        }
      }
      if (best < 0) { unmatchedLegs++; return; }
      rides.push({ kind: 'board', trip: visits!.trips[best], route: commute.route, direction: commute.outDirection,
        stop: commute.outGate, time: visits!.departures[best], waitStart: leg.arrive, position: stopPoint });
    });
    return { stays, moves, walkingSeconds, rides, unmatchedLegs };
  };
  const presenceKeys = (plan: DayPlan): Set<number> => {
    const keys = new Set<number>();
    for (const stay of plan.stays) {
      const index = resourceIndex.get(stay.location);
      if (index === undefined) continue;
      for (let minute = Math.floor(stay.start / OPTIONAL_CAPACITY_BUCKET_SECONDS); minute < Math.ceil(stay.end / OPTIONAL_CAPACITY_BUCKET_SECONDS); minute++) keys.add(index * bucketsPerDay + minute);
    }
    return keys;
  };
  const favorites = new Map<string, string | undefined>();
  /** A stable home-relative favourite venue per kind, chosen with the same capacity/distance weights. */
  const favoriteVenue = (agent: Agent, kind: string): string | undefined => {
    const key = `${agent.id}:${kind}`;
    if (favorites.has(key)) return favorites.get(key);
    const campus = agent.campus ?? (locations.has(agent.home) ? campusOf(locations.get(agent.home)!) : 'charles-river');
    const options = base.locations.filter(location => location.kind === kind && campusOf(location) === campus)
      .map(location => ({ id: location.id, weight: venueWeight(location.capacity, duration(agent.home, location.id, agent)) }))
      .filter(option => Number.isFinite(option.weight) && option.weight > 0);
    let choice = fraction(`${key}:favorite-venue`) * options.reduce((sum, option) => sum + option.weight, 0);
    const favorite = options.find(option => { choice -= option.weight; return choice < 0; })?.id;
    favorites.set(key, favorite); return favorite;
  };
  const days = new Map<string, SourceDay>();
  // ── Conditions engine hook: helpers for a conditioned day (all inert while `tuned` is unset) ──
  const isResident = (agent: Agent) => agent.residency === 'resident' || (!agent.residency && agent.home !== 'off-campus');
  const isAway = (agent: Agent, params: ResolvedParams) =>
    fraction(`${agent.id}:away`) < (isResident(agent) ? params.scalars.awayShareResidents : params.scalars.awayShareCommuters);
  /** A scenario's event (sim/conditions.ts) as one more Gathering, unless a published event already fills that venue then. */
  const scenarioGatherings = (published: Gathering[], date: string, weekday: number): Gathering[] => {
    if (!tuned) return [];
    const out: Gathering[] = [];
    for (const event of tuned.behavior.events) {
      if (!locations.has(event.locationId) || published.some(g => g.locationId === event.locationId && g.startSec < event.end && event.start < g.endSec)) continue;
      // Who can go under the gathering rules: residents, and commuters on days they have classes.
      const audience = base.agents.filter(agent => {
        const levels = event.audience?.levels;
        const resident = isResident(agent);
        return (resident ? event.audience?.residents !== false : event.audience?.commuters !== false && enrollment.get(agent.id)!.some(stop => stop.weekday === weekday))
          && (!levels || (agent.studentLevel !== undefined && levels.includes(agent.studentLevel)));
      }).length;
      const id = `${event.id}@${date}`;
      tuned.gatheringSeats.set(id, event.capacity);
      out.push({ id, eventId: event.id, name: event.label, locationId: event.locationId, date, startSec: event.start, endSec: event.end, projected: false,
        endEstimated: false, attendanceProbability: audience ? Math.min(1, event.expectedStudents * tuned.behavior.params.scalars.eventAttendanceFactor / audience) : 0, roomSeats: null, roomCode: null,
        sourceUrl: event.provenance?.source ?? '' });
    }
    return out;
  };
  /** A scenario event's published seats replace the venue's everyday capacity while it runs. */
  const scenarioSeats = (location: string, minute: number): number | undefined => {
    for (const event of tuned?.behavior.events ?? []) {
      if (event.locationId === location && minute * OPTIONAL_CAPACITY_BUCKET_SECONDS >= event.start && minute * OPTIONAL_CAPACITY_BUCKET_SECONDS < event.end) return event.capacity;
    }
    return undefined;
  };
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  const buildDay = (weekday: number, eventDate: string | null): SourceDay => {
    const published = eventDate ? gatheringsOnDate(data, eventDate).filter(g => locations.has(g.locationId)) : [];
    const gatherings = tuned ? [...published, ...scenarioGatherings(published, eventDate ?? dateForWeekday(data, weekday), weekday)]
      .sort((a, b) => a.startSec - b.startSec || a.id.localeCompare(b.id)) : published;
    const gatheringAttendees = new Map(gatherings.map(g => [g.id, 0]));
    const gatheringCapacity = (g: Gathering) => {
      const venue = locations.get(g.locationId)!;
      const seats = tuned?.gatheringSeats.get(g.id); // conditions engine hook: scenario event seats
      if (seats !== undefined) return seats;
      return Math.max(0, Math.floor(Math.min(venue.capacity, estimatedProfile(venue)?.capacity ?? Infinity, g.roomSeats ?? Infinity)));
    };
    // Conditions engine hook: classes the student attends today (all of them under today's rules).
    const dayStops = (agent: Agent): WeeklyStop[] => {
      const all = enrollment.get(agent.id)!.filter(stop => stop.weekday === weekday);
      const params = tunedParams(agent);
      if (!params || !all.length) return all;
      if (isAway(agent, params)) return [];
      const attendance = params.scalars.classAttendance;
      return attendance >= 1 ? all : all.filter(stop => fraction(`${agent.id}:${weekday}:${stop.meeting?.id ?? stop.pool}:attend`) < attendance);
    };
    const trips: Trip[] = [];
    const transitRides: TransitRide[] = [];
    tripLoad = new Map();
    let transitUnmatchedLegs = 0;
    const riders = new Set<string>();
    const stays: { agent: string; location: string; start: number; end: number }[] = [];
    const assignments: SourceAssignment[] = [];
    const activities: SourceActivity[] = [];
    let composedTrips = 0, scheduledStudents = 0, campusAccessTrips = 0, modeledActivities = 0, modeledOffCampusMeals = 0, modeledOffCampusOutings = 0, unavailableActivities = 0, optionalCapacityRejected = 0, estimatedActivities = 0;
    let unmappedAcademicBlocks = 0, behaviorRejectedCandidates = 0, optionalTravelRejectedCandidates = 0;
    const estimatedLocationCounts: Record<string, number> = {};
    // Classroom buildings and event venues join this day's minute ledger next to the optional-visit
    // resources, so classes, waits, study blocks and every overlapping event share the venue's capacity.
    const dayResources = [...new Set([...resourceLocations,
      ...base.locations.filter(location => location.kind === 'classroom'),
      ...gatherings.map(g => locations.get(g.locationId)!)])];
    const dayIndex = new Map(dayResources.map((location, index) => [location.id, index]));
    const seatLimit = (location: CampusLocation, minute: number): number => (tuned ? scenarioSeats(location.id, minute) : undefined)
      ?? Math.max(0, Math.floor(Math.min(location.capacity, estimatedProfile(location)?.capacity ?? Infinity)));
    const dayPresenceKeys = (plan: DayPlan, only?: (stay: PlannedStay) => boolean): Set<number> => {
      const keys = new Set<number>();
      for (const stay of plan.stays) {
        const index = dayIndex.get(stay.location);
        if (index === undefined || (only && !only(stay))) continue;
        for (let minute = Math.floor(stay.start / OPTIONAL_CAPACITY_BUCKET_SECONDS); minute < Math.ceil(stay.end / OPTIONAL_CAPACITY_BUCKET_SECONDS); minute++) keys.add(index * bucketsPerDay + minute);
      }
      return keys;
    };
    const capacityLedger = new Int32Array(dayResources.length * bucketsPerDay);
    const baselinePresence = new Map<string, Set<number>>();
    const baselinePlans = new Map<string, DayPlan>();
    const isClass = (stay: PlannedStay) => stay.purpose.kind === 'class';
    compactArrivals = new Map();
    let classroomWaitsShortened = 0;
    // Published class presence is reserved first, for everyone.
    for (const agent of base.agents) {
      let plan = planDay(agent, dayStops(agent));
      // Conditions engine hook: a student whose classes don't fit the day's parameters keeps today's rules.
      if (!plan && tuned && !tuned.legacy.has(agent.id)) {
        tuned.legacy.add(agent.id); tuned.speeds.delete(agent.id); tuned.params.delete(agent.id);
        plan = planDay(agent, dayStops(agent));
      }
      if (!plan) throw new Error(`Published schedule has no feasible itinerary for ${agent.id}`);
      baselinePlans.set(agent.id, plan);
      for (const key of dayPresenceKeys(plan, isClass)) capacityLedger[key]++;
    }
    // Then the waits and lingering around those classes. A student whose wait would take a classroom
    // building past its seats arrives with the minimum lead and leaves at the end of class instead.
    const seatOverflow = (keys: Set<number>) => {
      let minutes = 0;
      for (const key of keys) {
        const location = dayResources[Math.floor(key / bucketsPerDay)];
        if (location.kind === 'classroom' && capacityLedger[key] + 1 > seatLimit(location, key % bucketsPerDay)) minutes++;
      }
      return minutes;
    };
    const waitOrder = [...base.agents].sort((a, b) => fraction(`class-wait-order:${a.id}`) - fraction(`class-wait-order:${b.id}`) || a.id.localeCompare(b.id));
    for (const agent of waitOrder) {
      let plan = baselinePlans.get(agent.id)!;
      const classKeys = dayPresenceKeys(plan, isClass);
      // A class and an adjacent wait can touch the same minute; reserve that student only once.
      const waitKeys = (candidate: DayPlan) => {
        const keys = dayPresenceKeys(candidate, stay => !isClass(stay));
        for (const key of classKeys) keys.delete(key);
        return keys;
      };
      let waits = waitKeys(plan);
      let overflow = seatOverflow(waits);
      for (const mode of [1, 2] as const) {
        if (!overflow) break;
        compactArrivals.set(agent.id, mode);
        const compactPlan = planDay(agent, dayStops(agent));
        const compactWaits = compactPlan && waitKeys(compactPlan);
        const compactOverflow = compactWaits ? seatOverflow(compactWaits) : Infinity;
        if (compactPlan && compactWaits && compactOverflow < overflow) { plan = compactPlan; waits = compactWaits; overflow = compactOverflow; }
        else if (mode === 2) compactArrivals.set(agent.id, 1);
      }
      // Keep the variant actually chosen (none, 1 or 2).
      if (plan === baselinePlans.get(agent.id)) compactArrivals.delete(agent.id);
      else classroomWaitsShortened++;
      for (const key of waits) capacityLedger[key]++;
      baselinePresence.set(agent.id, dayPresenceKeys(plan));
    }
    const activityPlanningOrder = [...base.agents].sort((a, b) => Number(enrollment.get(a.id)!.length > 0) - Number(enrollment.get(b.id)!.length > 0)
      || fraction(`activity-order:${a.id}`) - fraction(`activity-order:${b.id}`) || a.id.localeCompare(b.id));
    for (const agent of activityPlanningOrder) {
      const params = tunedParams(agent); // conditions engine hook (undefined = today's rules)
      if (params && isAway(agent, params)) { stays.push({ agent: agent.id, location: 'off-campus', start: 0, end: DAY, purpose: HOME_PURPOSE } as typeof stays[number]); continue; }
      let stops = dayStops(agent);
      const fixedClasses = stops.length;
      const baseline = baselinePresence.get(agent.id)!;
      let reserved = new Set<number>();
      let currentPlan = planDay(agent, stops)!;
      const capacityFor = (proposed: WeeklyStop[], activitySeconds: number): Set<number> | undefined => {
        const plan = planDay(agent, proposed);
        if (!plan) { behaviorRejectedCandidates++; return undefined; }
        if (plan.walkingSeconds - currentPlan.walkingSeconds > activitySeconds + 1e-7) { optionalTravelRejectedCandidates++; return undefined; }
        const keys = dayPresenceKeys(plan);
        for (const key of baseline) keys.delete(key);
        for (const key of keys) {
          const location = dayResources[Math.floor(key / bucketsPerDay)];
          if (capacityLedger[key] - (reserved.has(key) ? 1 : 0) + 1 > seatLimit(location, key % bucketsPerDay)) { optionalCapacityRejected++; return undefined; }
        }
        return keys;
      };
      const reserve = (keys: Set<number>) => {
        for (const key of reserved) capacityLedger[key]--;
        for (const key of keys) capacityLedger[key]++;
        reserved = keys;
      };
      const resident = agent.residency === 'resident' || (!agent.residency && agent.home !== 'off-campus');
      const campus = agent.campus ?? (locations.has(agent.home) ? campusOf(locations.get(agent.home)!) : 'charles-river');
      const activityCampuses = new Set([campus, ...stops.map(stop => campusOf(locations.get(stop.location)!))]);
      const classStart = stops[0]?.start ?? DAY;
      const classEnd = stops.at(-1)?.end ?? 0;
      const academicDays = [0, 1, 2, 3, 4].sort((a, b) => fraction(`${agent.id}:unmapped-academic-day:${a}`) - fraction(`${agent.id}:unmapped-academic-day:${b}`));
      // Conditions engine hook: unmapped course time follows class attendance; block length and off-map share are parameters.
      const attendsUnmapped = !params || fraction(`${agent.id}:${weekday}:unmapped-attend`) < params.scalars.classAttendance;
      const offMapShare = params ? params.scalars.offMapAcademicShare : OFF_MAP_ACADEMIC_SHARE;
      if (attendsUnmapped && academicDays.slice(0, Math.min(5, unmappedLoads.get(agent.id) ?? 0)).includes(weekday)) {
        for (let attempt = 0; attempt < 8; attempt++) {
          const start = (9 + fraction(`${agent.id}:${weekday}:unmapped-academic-time:${attempt}`) * 7) * 3600;
          const seconds = (params ? params.scalars.unmappedAcademicMinutes : UNMAPPED_ACADEMIC_MINUTES) * 60;
          const blockAt = (location: string): WeeklyStop => ({ location, start, end: start + seconds,
            weekday, pool: '', activity: 'unmapped-academic', unmappedAcademic: true });
          // Most students study on campus: a library, or a building where they already have mapped classes.
          const sites: { proposed: WeeklyStop[]; keys: Set<number>; weight: number }[] = [];
          if ((resident || fixedClasses > 0) && fraction(`${agent.id}:${weekday}:unmapped-study-site:${attempt}`) >= offMapShare) {
            const ownBuildings = new Set(enrollment.get(agent.id)!.map(row => row.location));
            for (const location of base.locations) {
              const own = location.kind === 'classroom' && ownBuildings.has(location.id);
              if (!(location.kind === 'library' || own) || !activityCampuses.has(campusOf(location))) continue;
              const stop = blockAt(location.id);
              if (!isOpen(stop)) continue;
              const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
              if (!feasible(proposed, agent)) continue;
              const keys = capacityFor(proposed, seconds);
              if (!keys) continue;
              const index = proposed.indexOf(stop);
              const travel = duration(proposed[index - 1]?.location ?? agent.home, location.id, agent)
                + duration(location.id, proposed[index + 1]?.location ?? agent.home, agent);
              const habit = location.kind === 'library' && favoriteVenue(agent, 'library') === location.id ? params?.scalars.favoriteVenueWeight ?? FAVORITE_VENUE_WEIGHT : 1;
              sites.push({ proposed, keys, weight: habit * venueWeight(location.capacity, travel) });
            }
          }
          let siteChoice = fraction(`${agent.id}:${weekday}:unmapped-study-choice:${attempt}`) * sites.reduce((sum, site) => sum + site.weight, 0);
          let site: { proposed: WeeklyStop[]; keys: Set<number> } | undefined = sites.find(row => (siteChoice -= row.weight) < 0);
          if (!site) {
            const proposed = [...stops, blockAt('off-campus')].sort((a, b) => a.start - b.start);
            const keys = feasible(proposed, agent) ? capacityFor(proposed, seconds) : undefined;
            if (keys) site = { proposed, keys };
          }
          if (!site) continue;
          reserve(site.keys); stops = site.proposed; currentPlan = planDay(agent, stops)!; unmappedAcademicBlocks++; modeledActivities++;
          break;
        }
      }
      // Gatherings rank after fixed commitments and before discretionary visits (plan Section 5.3).
      // Choices are keyed by student and event, so adding an event never reshuffles anyone else's draws.
      if (resident || fixedClasses > 0) for (const gathering of gatherings) {
        if (gatheringAttendees.get(gathering.id)! >= gatheringCapacity(gathering)) continue;
        if (!activityCampuses.has(campusOf(locations.get(gathering.locationId)!))) continue;
        if (fraction(`${agent.id}:${gathering.eventId}:gathering-attend`) >= gathering.attendanceProbability) continue;
        const stop: WeeklyStop = { location: gathering.locationId, start: gathering.startSec, end: gathering.endSec,
          weekday, pool: '', activity: 'gathering', gathering };
        const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
        if (!feasible(proposed, agent)) continue;
        const keys = capacityFor(proposed, gathering.endSec - gathering.startSec);
        if (!keys) continue;
        reserve(keys); stops = proposed; currentPlan = planDay(agent, stops)!; modeledActivities++;
        gatheringAttendees.set(gathering.id, gatheringAttendees.get(gathering.id)! + 1);
        break;
      }
      const estimates: { proposed: WeeklyStop[]; keys: Set<number>; location: string; weight: number }[] = [];
      const sourceCovered = enrollment.get(agent.id)!.length > 0;
      for (const location of base.locations) {
        const profile = estimatedProfile(location);
        if (!profile || !activityCampuses.has(campusOf(location)) || (profile.studentLevel !== 'any' && agent.studentLevel !== profile.studentLevel)
          || (estimatedLocationCounts[location.id] ?? 0) >= dailyParticipantLimit(profile, weekday)) continue;
        const seed = `${agent.id}:${weekday}:estimated:${location.id}`;
        if (fraction(`${seed}:participation`) >= profile.attendanceProbability * (sourceCovered ? SOURCE_COVERED_ESTIMATED_ACTIVITY_FACTOR : 1)) continue;
        const windows = profile.weekdayWindows.filter(row => row.weekday === weekday).flatMap(row => row.windows)
          .filter(([start, end]) => end - start >= profile.durationMinutes * 60);
        if (!windows.length) continue;
        for (let attempt = 0; attempt < ESTIMATED_TIME_ATTEMPTS; attempt++) {
          const window = windows[Math.floor(fraction(`${seed}:${attempt}:window`) * windows.length)];
          const start = window[0] + fraction(`${seed}:${attempt}:time`) * (window[1] - window[0] - profile.durationMinutes * 60);
          const stop: WeeklyStop = { location: location.id, start, end: start + profile.durationMinutes * 60,
            weekday, pool: '', activity: 'estimated', estimatedProfile: profile };
          const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
          if (!isOpen(stop) || !feasible(proposed, agent)) continue;
          const keys = capacityFor(proposed, profile.durationMinutes * 60);
          if (!keys) continue;
          const travelTime = duration(proposed[proposed.indexOf(stop) - 1]?.location ?? agent.home, location.id, agent)
            + duration(location.id, proposed[proposed.indexOf(stop) + 1]?.location ?? agent.home, agent);
          estimates.push({ proposed, keys, location: location.id, weight: Math.sqrt(Math.max(1, profile.capacity)) / (300 + travelTime) });
          break;
        }
      }
      let estimatedChoice = fraction(`${agent.id}:${weekday}:estimated-choice`) * estimates.reduce((sum, row) => sum + row.weight, 0);
      const estimate = estimates.find(row => { estimatedChoice -= row.weight; return estimatedChoice < 0; });
      if (estimate) {
        reserve(estimate.keys); stops = estimate.proposed; currentPlan = planDay(agent, stops)!; estimatedActivities++; modeledActivities++;
        estimatedLocationCounts[estimate.location] = (estimatedLocationCounts[estimate.location] ?? 0) + 1;
      }
      if (resident || fixedClasses >= (params ? params.scalars.commuterMinClasses : 2)) {
        // Conditions engine hook: the day's menu with persona-adjusted habits, visit length spread,
        // bell-shaped arrivals, gap placement, commuter window and river visits.
        const population = tuned?.behavior.params;
        for (const [index, activity] of (params ? params.menus[weekday] : freeTimeActivities(weekday)).entries()) {
          const seed = `${agent.id}:${weekday}:activity:${index}`;
          const slot = params ? tunedSlot(activity) : habitSlot(activity);
          const habitOf = (name: string) => params && population ? tunedHabitMultiplier(agent.id, name, params, population) : habitMultiplier(agent.id, name);
          const commuterFactor = params && activity.kind === 'outdoor' && !resident ? params.scalars.commuterOutdoorFactor : 1;
          if (fraction(`${seed}:attend`) >= Math.min(1, activity.probability * commuterFactor * habitOf(slot))) continue;
          const minutes = params ? activity.minutes * (1 + params.scalars.visitLengthSpread * (2 * fraction(`${seed}:length`) - 1)) : activity.minutes;
          const intoGap = (time: number) => params && params.scalars.gapPlacement >= 0.5 ? placeInGap(stops, time, minutes * 60, activity.shoulder) : time;
          const start = intoGap(params ? tunedHabitualStart(agent.id, slot, seed, activity, params) : habitualStart(agent.id, slot, seed, index, weekday));
          const outing = activity.kind === 'off-campus-outing';
          if (outing && !resident) continue;
          const reach = params ? params.scalars.commuterActivityWindowMinutes * 60 : 0;
          const withinClassDay = (time: number) => resident || (time >= classStart - reach && time + minutes * 60 <= classEnd + reach);
          const offCampusMeal = activity.kind === 'dining'
            && fraction(`${seed}:off-campus`) < Math.min(1, (params ? params.scalars.offCampusMealShare : MODELED_OFF_CAMPUS_MEAL_SHARE) * habitOf('off-campus-meal'));
          if (offCampusMeal || outing) {
            if (!withinClassDay(start)) continue;
            const stop: WeeklyStop = { location: 'off-campus', start, end: start + minutes * 60, weekday, pool: '', activity: outing ? 'off-campus-outing' : 'off-campus-meal' };
            const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
            const keys = (agent.home === 'off-campus' || accessRoute(agent, agent.home, 'out')) && feasible(proposed, agent) ? capacityFor(proposed, minutes * 60) : undefined;
            if (keys) {
              reserve(keys); stops = proposed; currentPlan = planDay(agent, stops)!; modeledActivities++;
              if (outing) modeledOffCampusOutings++; else modeledOffCampusMeals++;
            } else unavailableActivities++;
            continue;
          }
          const candidates: { stop: WeeklyStop; proposed: WeeklyStop[]; weight: number; keys: Set<number> }[] = [];
          for (const location of activity.kind === 'outdoor' ? outdoorCandidates((activity as ActivitySpec).spot) : base.locations) {
            if (location.kind !== activity.kind || !activityCampuses.has(campusOf(location))) continue;
            const visitStart = location.id === 'fitrec' && activity.kind === 'gym'
              ? intoGap(fitrecVisitStart(data.fitrecUsage, dateForWeekday(data, weekday), fraction(`${seed}:fitrec-hour`), fraction(`${seed}:fitrec-minute`)) ?? start)
              : start;
            if (!withinClassDay(visitStart)) continue;
            const stop: WeeklyStop = { location: location.id, start: visitStart, end: visitStart + minutes * 60, weekday, pool: '', activity: activity.kind };
            if (!isOpen(stop)) continue;
            const proposed = [...stops, stop].sort((a, b) => a.start - b.start);
            if (!feasible(proposed, agent)) continue;
            const keys = capacityFor(proposed, minutes * 60);
            if (!keys) continue;
            const index = proposed.indexOf(stop);
            const origin = proposed[index - 1]?.location ?? agent.home;
            const destination = proposed[index + 1]?.location ?? agent.home;
            const travelTime = duration(origin, location.id, agent) + duration(location.id, destination, agent);
            const habit = favoriteVenue(agent, activity.kind) === location.id ? params?.scalars.favoriteVenueWeight ?? FAVORITE_VENUE_WEIGHT : 1;
            candidates.push({ stop, proposed, keys, weight: habit * venueWeight(location.capacity, travelTime) });
          }
          const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
          let choice = fraction(`${seed}:venue`) * totalWeight;
          const selected = candidates.find(candidate => { choice -= candidate.weight; return choice < 0; });
          if (selected) { reserve(selected.keys); stops = selected.proposed; currentPlan = planDay(agent, stops)!; modeledActivities++; }
          else unavailableActivities++;
        }
      }
      if (fixedClasses) scheduledStudents++;
      const plan = planDay(agent, stops)!;
      for (const stay of plan.stays) stays.push({ agent: agent.id, ...stay });
      for (const ride of plan.rides) {
        transitRides.push({ agent: agent.id, ...ride }); riders.add(agent.id);
        tripLoad.set(ride.trip, (tripLoad.get(ride.trip) ?? 0) + 1);
      }
      transitUnmatchedLegs += plan.unmatchedLegs;
      for (const move of plan.moves) {
        const timestamps = move.route.cumulative.map(distance => move.depart + distance / speed(agent));
        trips.push({ agent: agent.id, from: move.from, to: move.to, path: move.route.path, timestamps });
        if (move.from === 'off-campus' || move.to === 'off-campus') campusAccessTrips++;
        if (composed.has(`${move.from}>${move.to}`)) composedTrips++;
      }
      for (const stop of stops) {
        if (stop.meeting) assignments.push({ agentId: agent.id, meetingId: stop.meeting.id, courseCode: stop.meeting.courseCode,
          locationId: stop.location, startSec: stop.start, endSec: stop.end, ...(stop.component ? { component: stop.component } : {}) });
        if (stop.activity) activities.push({ agentId: agent.id, locationId: stop.location, startSec: stop.start, endSec: stop.end, kind: stop.activity,
          ...(stop.estimatedProfile ? { estimated: true as const, purpose: stop.estimatedProfile.purpose, basis: stop.estimatedProfile.basis,
            confidence: stop.estimatedProfile.confidence, note: stop.estimatedProfile.note, proxy: stop.estimatedProfile.proxy } : {}),
          ...(stop.unmappedAcademic ? { estimated: true as const, purpose: 'unmapped-academic' as const, basis: 'modeled_unmapped_academic_time',
            confidence: 'low' as const, note: 'Estimated academic/study commitment for a course not on the map, placed on campus when a library or the student’s own academic building fits; actual course, location and schedule are unknown.', proxy: 'Eligible mapped/full catalog offering coverage and a 120-minute weekly scenario per uncovered course slot' } : {}),
          ...(stop.gathering ? { estimated: true as const, basis: 'modeled_event_gathering', confidence: 'low' as const,
            eventId: stop.gathering.eventId, projected: stop.gathering.projected,
            note: 'Modeled attendance at a published campus event; real attendance is unknown.' } : {}) });
      }
    }
    const residentLocations = new Set(base.agents.filter(agent => agent.residency === 'resident').map(agent => agent.home));
    const visited = new Set(stays.filter(stay => (stay as { purpose?: StayPurpose }).purpose?.kind !== 'wait').map(stay => stay.location));
    const dayLocations = base.locations.map(location => {
      const source = data.locations[location.id];
      const hasClass = source?.meetings.some(meeting => effectiveMeetingIntervals(meeting, data).some(interval => interval.weekday === weekday));
      const optionalOnly = ['dining', 'library', 'gym'].includes(location.kind) && !residentLocations.has(location.id) && !hasClass && !location.estimatedProfile;
      if (!optionalOnly) return location;
      const hours = source?.hours ?? [];
      const today = openingHoursForDate(hours, dates[weekday], weekday);
      const entries = today.length ? today : carriedForwardHours(hours, dates[weekday], weekday);
      const open = entries.flatMap(entry => entry.windows);
      // Unknown hours are not modeled; a published closure is a known zero. A venue open only outside
      // every modeled visit window of its kind (After Hours opens after dinner ends at 22:00) has no
      // one modeled there either, so it reads "not modeled", not "Quiet".
      return { ...location, activityModeled: entries.length > 0
        && (open.length === 0 || visited.has(location.id) || inModeledVisitTimes(location.kind, open, weekday)) };
    });
    transitRides.sort((a, b) => a.time - b.time || a.agent.localeCompare(b.agent));
    // Conditions engine hook: river spots are places in a conditioned day (kind 'outdoor', like an incident's
    // assembly point), so every stay names a known location; they hold people, not seats (capacity 0).
    const dayPlaces = tuned?.behavior.outdoor && outdoorLocations.length ? [...dayLocations, ...outdoorLocations.map(location => ({ ...location, capacity: 0 }))] : dayLocations;
    const result: SourceDay = { ...base, locations: dayPlaces, day: WEEKDAYS[weekday], trips, stays, transitRides,
      sourceStats: { ...stats, eligibleMeetings: [...occurrences].filter((key) => Number(key.split(':').at(-3)) === weekday).length,
        assignedClasses: assignments.length, scheduledStudents, composedTrips, campusAccessTrips, modeledActivities, modeledOffCampusMeals, modeledOffCampusOutings, unavailableActivities, optionalCapacityRejected, classroomWaitsShortened, estimatedActivities, unmappedAcademicBlocks, behaviorRejectedCandidates, optionalTravelRejectedCandidates, estimatedLocationCounts,
        transitCommuters: riders.size, transitAlightings: transitRides.filter((ride) => ride.kind === 'alight').length,
        transitBoardings: transitRides.filter((ride) => ride.kind === 'board').length, transitUnmatchedLegs,
        assumptions: gatherings.length ? [...stats.assumptions, ...GATHERING_ASSUMPTIONS] : stats.assumptions },
      sourceAssignments: assignments, sourceActivities: activities, eventDate,
      gatherings: gatherings.map(g => ({ ...g, attendees: gatheringAttendees.get(g.id)!, capacity: gatheringCapacity(g) })) };
    return result;
  };
  // Conditions engine hook: unconditioned days are cached as before; conditioned days by weekday,
  // event date and conditions/model key, keeping only the most recent few.
  const conditionedDays = new Map<string, SourceDay>();
  return (weekday, eventDate, behavior) => {
    if (!behavior) {
      const cacheKey = `${weekday}:${eventDate ?? 'baseline'}`;
      const cached = days.get(cacheKey);
      if (cached) { days.delete(cacheKey); days.set(cacheKey, cached); return cached; }
      const result = buildDay(weekday, eventDate);
      days.set(cacheKey, result);
      while (days.size > CACHED_DAYS) days.delete(days.keys().next().value!);
      return result;
    }
    const key = `${weekday}:${eventDate ?? 'baseline'}|${behavior.key}`;
    const cached = conditionedDays.get(key);
    if (cached) { conditionedDays.delete(key); conditionedDays.set(key, cached); return cached; }
    if (behavior.outdoor) injectOutdoor(behavior.outdoor);
    tuned = { behavior, weekday, legacy: new Set(), params: new Map(), speeds: new Map(), gatheringSeats: new Map() };
    let result: SourceDay;
    try { result = buildDay(weekday, eventDate); } finally { tuned = undefined; }
    conditionedDays.set(key, result);
    while (conditionedDays.size > CONDITIONED_DAYS_KEPT) conditionedDays.delete(conditionedDays.keys().next().value!);
    return result;
  };
}

/** Whether any of the day's free-time activities of this kind (breakfast, lunch, dinner, study, gym)
 * may start while the venue is open. A venue open only outside them gets no modeled visits. */
export function inModeledVisitTimes(kind: string, open: readonly (readonly [number, number])[], weekday: number): boolean {
  return freeTimeActivities(weekday).some(activity => activity.kind === kind
    && open.some(([from, to]) => Math.min(to, activity.shoulder[1] * 3600) > Math.max(from, activity.shoulder[0] * 3600)));
}

/**
 * Typical opening hours (seconds since midnight) for places with no published schedule, by kind.
 * Weekday = 0 Monday ... 6 Sunday. BU dining halls serve roughly 7 AM-9 PM on weekdays and from
 * brunch at weekends; libraries 8 AM-midnight; FitRec-style gyms 6 AM-11 PM. Assumptions, labelled.
 */
function typicalWindows(kind: string | undefined, weekday: number): [number, number][] {
  const h = (hour: number) => hour * 3600;
  const weekend = weekday >= 5;
  switch (kind) {
    case 'dining':
      return weekend ? [[h(10), h(20)]] : [[h(7), h(21)]];
    case 'library':
      return weekend ? [[h(10), h(22)]] : [[h(8), h(24)]];
    case 'gym':
      return weekend ? [[h(8), h(22)]] : [[h(6), h(23)]];
    default:
      return [];
  }
}

/** Monday-first weekday (0 = Monday) of an ISO date, as a calendar date (no timezone shift). */
function isoWeekday(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return (new Date(y, m - 1, d).getDay() + 6) % 7;
}

/** The nearest dated entry on the same weekday, within four weeks of `date`. */
function sameWeekdayWindows(hours: { date: string | null; windows: [number, number][] }[], date: string, weekday: number): [number, number][] {
  const target = Date.parse(`${date}T12:00:00Z`);
  let best: { gap: number; windows: [number, number][] } | null = null;
  for (const entry of hours) {
    if (!entry.date || isoWeekday(entry.date) !== weekday) continue;
    const gap = Math.abs(Date.parse(`${entry.date}T12:00:00Z`) - target);
    if (gap <= 28 * 86400000 && (!best || gap < best.gap)) best = { gap, windows: entry.windows };
  }
  return best?.windows ?? [];
}

/** Published availability is strict by default: exact-date entries (an empty one is a closure), then
 * valid weekly entries. `carryForward` then repeats a venue's dated hours from one week away only for
 * dates past its published dated horizon (see `carriedForwardHours`), and never for restricted venues.
 * Published windows are returned even for `hoursStatus: 'restricted'` venues, because estimated
 * arena/rowing/research activities rely on them; callers admitting ordinary visits or relocations must
 * reject restricted venues themselves, as `optionalWindows` does. Estimated callers may explicitly
 * request nearest-week or typical-kind assumptions; those windows never establish published hours. */
export function venueWindows(data: CampusData, location: string, kind: string | undefined, weekday: number,
  options: { estimatedFallback?: boolean; carryForward?: boolean } = {}): [number, number][] {
  const date = dateForWeekday(data, weekday);
  const hours = data.locations[location]?.hours ?? [];
  const selected = openingHoursForDate(hours, date, weekday);
  if (selected.length) return selected.flatMap((entry) => entry.windows);
  if (options.carryForward && data.locations[location]?.hoursStatus !== 'restricted') {
    const carried = carriedForwardHours(hours, date, weekday);
    if (carried.length) return carried.flatMap((entry) => entry.windows);
  }
  if (!options.estimatedFallback || data.locations[location]?.hoursStatus === 'restricted') return [];
  if (hours.length) return sameWeekdayWindows(hours, date, weekday);
  return typicalWindows(kind, weekday);
}
