// What the Ask tools may read beyond the shown day's occupancy: other simulated days (never
// waiting on a build), the chosen campus bundle, each place's capacity basis with its source URLs
// stripped, the population summary, published pedestrian counts, and short statements of the
// model's assumptions by topic.
//
// Never here: stays, trips, agent ids, source assignments or activities, bike rides, live
// transit feeds, source URL lists, or the private bundle unless FLOWCAST_ASK_PRIVATE_BUNDLE=1.

import type { PersonalSchedule } from '../../map-client/src/personalSchedule';
import type { AskContext } from '../../map-client/src/insights';
import { ASK_ASSUMPTIONS } from '../../map-client/src/insights';
import { LEVELS } from '../../map-client/src/layers/crowdLevels';
import type { CampusLocation, Playback } from '../../map-client/src/sim/playback';
import type { PopulationSummary } from '../../map-client/src/sim/population';
import { MODELED_OFF_CAMPUS_MEAL_SHARE } from '../../map-client/src/sim/sourceDay';
import { WEEKDAYS, type CampusData } from '../../map-client/src/data/campusData';
import type { ChatFacts } from './chatData';

export const BASIS_TOPICS = ['capacity', 'crowding', 'walking', 'enrollment', 'hours', 'meals_study_gym', 'housing', 'estimated_places', 'population'] as const;
export type BasisTopic = (typeof BASIS_TOPICS)[number];

export interface CapacityBasis {
  basis: string;
  confidence: string | null;
  note: string | null;
}

export interface PedestrianSite {
  name: string;
  campus: string;
  observedFrom: string;
  observedTo: string;
  profiles: { weekday: number | null; weekdays?: number[]; hour: number; pedestrians: number }[];
}

export type DayResult = { playback: Playback } | { available: false; reason: string; retryAfterSec: number };

export interface AskFacts {
  /** The chosen campus bundle (public unless FLOWCAST_ASK_PRIVATE_BUNDLE=1). */
  data: CampusData;
  /** A built day, or why it isn't available; a missing day starts building in the background. */
  day(weekday: number): DayResult;
  /** Capacity basis per location id, without source URLs. */
  basis: Record<string, CapacityBasis>;
  populationSummary: Pick<PopulationSummary, 'total' | 'reportingPeriod' | 'campusAllocation'> & Partial<Pick<PopulationSummary, 'staff' | 'staffReportingPeriod'>>;
  pedestrians: PedestrianSite[];
  /** Short assumption statements by topic (model_basis). */
  assumptions: Record<BasisTopic, string[]>;
  /** Every location the playback knows, including off-campus gateways (for walking destinations). */
  allLocations: CampusLocation[];
  /** The extra datasets only the chat tools read (chatData.ts); absent in minimal fixtures. */
  chat?: ChatFacts;
}

/** The Ask context on the server: the shared one plus the facts above. */
export type ServerAskContext = AskContext & { facts?: AskFacts; personalSchedule?: PersonalSchedule };

export const clip = (text: string | null | undefined, max = 200) =>
  !text ? null : text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

/** locationCapacityBasis from population.json, keeping only basis, confidence and a short note. */
export function capacityBasis(raw: Record<string, Record<string, unknown>> | undefined): Record<string, CapacityBasis> {
  const out: Record<string, CapacityBasis> = {};
  for (const [id, b] of Object.entries(raw ?? {})) {
    out[id] = {
      basis: String(b.basis ?? 'unknown'),
      confidence: typeof b.confidence === 'string' ? b.confidence : null,
      note: clip(typeof b.note === 'string' ? b.note : null),
    };
  }
  return out;
}

/** Published pedestrian counts from mobility.json; road and bike data are left out. */
export function pedestrianSites(mobility: { pedestrians?: { locations?: Record<string, unknown>[] } } | undefined): PedestrianSite[] {
  return (mobility?.pedestrians?.locations ?? []).map((l) => ({
    name: String(l.name),
    campus: String(l.campus ?? 'charles-river'),
    observedFrom: String(l.observedFrom),
    observedTo: String(l.observedTo),
    profiles: ((l.profiles as PedestrianSite['profiles']) ?? []).map(({ weekday, weekdays, hour, pedestrians }) => ({ weekday, weekdays, hour, pedestrians })),
  }));
}

/** The model_basis table, built once from the bundle, the population file and the model constants. */
export function assumptionTable(data: CampusData, locations: CampusLocation[], summary: AskFacts['populationSummary']): Record<BasisTopic, string[]> {
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const levels = [...LEVELS].reverse().map((l) => `${l.label} from ${pct(l.min)}`).join(', ');
  const profiles = locations.filter((l) => l.estimatedProfile).map((l) => l.short);
  const housing = locations.filter((l) => l.estimatedHousingProfile).length;
  const fromBundle = (re: RegExp) => data.assumptions.filter((a) => re.test(a)).slice(0, 1);
  return {
    capacity: [
      'Each place has a stated capacity with a basis: a published figure, deduplicated published classroom seats, residential beds, or a configured model size. place_info gives the basis and confidence for one place.',
      'Percent full is simulated people present (students, plus modeled faculty and staff in academic buildings, dining venues and gyms) over that capacity. Residential and low-confidence estimated capacities are not shown as percentages.',
    ],
    crowding: [
      `Crowd levels over stated capacity: ${levels}.`,
      'Counts are simulated people (students and modeled staff) present at that minute on a representative reference week, not measurements or live counts.',
    ],
    walking: [
      `Walks follow bundled OpenStreetMap pedestrian routes at ${ASK_ASSUMPTIONS.walkSpeedMps} m/s. A pair with no mapped route uses straight-line distance × ${ASK_ASSUMPTIONS.detourFactor}, marked as an estimate.`,
    ],
    enrollment: [
      'Enrollment is synthetic and fixed for the reference week; published classes supply places, times and seat upper bounds, not actual enrollment or attendance.',
      'Modeled course loads: 1–2 courses for part-time students, 3–4 for full-time graduate students, 4–5 for full-time undergraduates.',
    ],
    hours: [
      ...fromBundle(/missing dates remain unknown/),
      'Optional visits (meals, study, gym) need published dated or weekly hours; unknown hours and restricted venues get no optional visits. Published classes keep their own times.',
      'Simulated stays end at midnight, so a place open after midnight reads empty then: not modeled, not empty.',
    ],
    meals_study_gym: [
      'Residents may make modeled trips: breakfast around 08:00 (45% chance, 25 min), lunch around 12:00 (75%, 35 min), study around 14:00 (55%, 75 min), gym around 17:00 (25%, 55 min), dinner around 18:00 (70%, 40 min).',
      `These are uncalibrated assumptions, not observed behavior; ${pct(MODELED_OFF_CAMPUS_MEAL_SHARE)} of attempted resident meals are modeled off campus. FitRec entry counts shape gym arrival timing only.`,
    ],
    housing: [
      'Residence capacity is beds, not occupied beds; the undergraduate resident headcount is estimated from a rounded published percentage.',
      `${housing} residences use low-confidence estimated housing profiles (capacity and occupancy rate are estimates).`,
    ],
    estimated_places: [
      `${profiles.length} places use low-confidence estimated activity profiles${profiles.length ? ` (${profiles.slice(0, 6).join(', ')}${profiles.length > 6 ? ', …' : ''})` : ''}: synthetic student-only use with estimated windows, turnout and dwell, not published classes or opening hours.`,
    ],
    population: [
      `${summary.total.toLocaleString('en-US')} students (${summary.reportingPeriod}) are simulated; institutional enrollment is not simultaneous campus occupancy.`,
      ...(summary.staff ? [`${summary.staff.toLocaleString('en-US')} faculty and staff (${summary.staffReportingPeriod ?? 'published employee headcount'}) are also simulated with a modeled working day: most on campus on weekdays 08:00–18:00, working in a mapped academic building, planned after every student. Their schedules are assumptions, not observed.`] : []),
      clip(summary.campusAllocation, 300) ?? '',
    ].filter(Boolean),
  };
}

/**
 * The tools' view of one weekday: the shown day as passed in, another day only when its build has
 * finished (a missing one starts building and the tool says to retry).
 */
export function dayContext(ctx: ServerAskContext, weekday: number | null): { ctx: ServerAskContext; playback?: Playback } | { available: false; reason: string; retryAfterSec: number } {
  const w = weekday ?? ctx.weekday;
  const day = ctx.facts?.day(w);
  if (w === ctx.weekday) return { ctx, playback: day && 'playback' in day ? day.playback : undefined };
  if (!day) return { available: false, reason: `Only ${WEEKDAYS[ctx.weekday]} is available here.`, retryAfterSec: 0 };
  if (!('playback' in day)) return day;
  const playback = day.playback;
  return { ctx: { ...ctx, weekday: w, occupancyAt: (t) => playback.occupancyAt(t) }, playback };
}

/** The `day` function for AskFacts around a day cache. */
export function dayFrom(ready: (weekday: number) => Playback | undefined, build: (weekday: number) => Promise<Playback>, retryAfterSec: number) {
  return (weekday: number): DayResult => {
    const playback = ready(weekday);
    if (playback) return { playback };
    build(weekday).catch((error: Error) => console.error(`couldn't simulate ${WEEKDAYS[weekday]}: ${error?.name ?? 'unknown'}`));
    return { available: false, reason: `${WEEKDAYS[weekday]} is still being simulated`, retryAfterSec };
  };
}
