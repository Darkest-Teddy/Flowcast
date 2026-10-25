// "Schedule check": schedule-shape facts for each day of a student's imported classes. Pure; the
// Schedule page and the import summary on Calendars render it.
//
// Every finding is a plain schedule fact (times, walks, gaps) with its assumptions stated. Walks
// are the saved pedestrian routes at 1.4 m/s (studyWalkMinutes, as the departure planner and study
// finder compute them). Rushed transitions are counted by the fatigue model (fatigue.ts), whose
// score is never shown: per its spec it stays an on-device projection, not health data, and only
// the count of rushed transitions leaves this module. Nothing here is stored or sent anywhere.
import type { CampusGeo, CampusLocation, Profile, ScheduleItem } from '../data/types';
import { bostonDay, bostonTime } from './departure';
import { FATIGUE_ASSUMPTIONS, modelFatigue } from './fatigue';
import { GAP_STAY, MEAL_WINDOW } from './gapPlanner';
import { studyWalkMinutes } from './studyFinder';
import { planTransit, type TransitContext, type TransitPlan } from './transitDeparture';

export const SCHEDULE_CHECK_ASSUMPTIONS = {
  /** A transfer with this many minutes or fewer left after the walk counts as tight. */
  tightSpareMinutes: 5,
  /** A day this long from first class start to last class end counts as long. */
  longDayMinutes: 8 * 60,
  /** Shortest break that counts as a meal break (the gap planner's shortest meal stay). */
  mealMinutes: GAP_STAY.eat.min,
  /** Minutes before and after the saved meal time a meal break can fall in (the gap planner's window). */
  mealWindow: MEAL_WINDOW,
  /** Meal times used when no profile is available. */
  defaultLunch: '12:00',
  defaultDinner: '18:00',
  /** Gap under which moving between two different buildings counts as rushed (fatigue model). */
  rushGapMinutes: FATIGUE_ASSUMPTIONS.rushGapMinutes,
} as const;

/** Plain-language statement of the assumptions above, for the page footnote. */
export const SCHEDULE_CHECK_NOTES = [
  'Walks follow the saved campus walking routes at an average 1.4 m/s (about 84 m a minute), building entrance to entrance.',
  `A transfer is tight when ${SCHEDULE_CHECK_ASSUMPTIONS.tightSpareMinutes} minutes or fewer are left after the walk.`,
  `A meal break is a free stretch of at least ${SCHEDULE_CHECK_ASSUMPTIONS.mealMinutes} minutes, after walks between classes, from ${-MEAL_WINDOW[0]} minutes before to ${MEAL_WINDOW[1]} minutes after your saved lunch or dinner time.`,
  `A long day is ${SCHEDULE_CHECK_ASSUMPTIONS.longDayMinutes / 60} hours or more from your first class to your last.`,
  `A rushed transition is a move to a different building with under ${SCHEDULE_CHECK_ASSUMPTIONS.rushGapMinutes} minutes between classes.`,
  'Campus areas come from building ids (BU Medical Campus and Fenway buildings); T and shuttle options are published timetable trips, not live service.',
];

export type CampusArea = 'charles-river' | 'medical' | 'fenway';
const AREA_NAME: Record<CampusArea, string> = { 'charles-river': 'Charles River', medical: 'Medical', fenway: 'Fenway' };
/** Which BU campus a mapped building is on, from its id (the web locations carry no campus field). */
export function campusArea(locationId: string): CampusArea {
  if (locationId.startsWith('bumc-')) return 'medical';
  if (locationId.startsWith('fenway-')) return 'fenway';
  return 'charles-river';
}

export type TransferKind = 'overlap' | 'short' | 'tight' | 'no-route';
export interface TransferFinding {
  kind: TransferKind;
  from: ScheduleItem;
  to: ScheduleItem;
  gapMinutes: number;
  walkMinutes: number | null;
  /** Gap minus walk; negative when walking does not make it. */
  spareMinutes: number | null;
  /** Both buildings are mapped and on different BU campuses. */
  crossCampus: { from: CampusArea; to: CampusArea } | null;
  transit: { status: TransitPlan['status']; text: string } | null;
  text: string;
}
export interface MealFinding { meal: 'lunch' | 'dinner'; savedTime: string; defaulted: boolean; windowStart: number; windowEnd: number; longestFreeMinutes: number; text: string }
export interface DayCheck {
  /** Boston date, YYYY-MM-DD. */
  day: string;
  weekday: string;
  classCount: number;
  firstStart: string | null;
  lastEnd: string | null;
  spanMinutes: number;
  long: boolean;
  rushes: number;
  transfers: TransferFinding[];
  meals: MealFinding[];
}
export interface ScheduleCheck { days: DayCheck[]; issueCount: number }

export interface ScheduleCheckInput {
  items: ScheduleItem[];
  locations: CampusLocation[];
  geo: CampusGeo | null;
  /** Lunch and dinner times; null uses the defaults, an empty time skips that meal. */
  profile: Pick<Profile, 'lunchTime' | 'dinnerTime'> | null;
  transit?: TransitContext;
  /** First Boston day to check, YYYY-MM-DD. */
  fromDay: string;
  dayCount?: number;
}

const DAY_MS = 86_400_000;
const clockFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Minutes since Boston midnight. */
function minuteOfDay(at: number): number {
  const parts = clockFormatter.formatToParts(at);
  return +parts.find((p) => p.type === 'hour')!.value * 60 + +parts.find((p) => p.type === 'minute')!.value;
}
const toMinutes = (hhmm: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  return match ? +match[1] * 60 + +match[2] : null;
};
const clockLabel = (minutes: number) => {
  const h = Math.floor(minutes / 60) % 24, m = minutes % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
const weekdayOf = (day: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' }).format(new Date(`${day}T12:00:00Z`));
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
/** "10:10–11:00 AM", or "11:30 AM–12:20 PM" across noon. */
function range(start: string, end: string) {
  const a = bostonTime(start), b = bostonTime(end);
  return a.slice(-2) === b.slice(-2) ? `${a.slice(0, -3)}–${b}` : `${a}–${b}`;
}
export function durationLabel(minutes: number) {
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return h ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function transitSummary(plan: TransitPlan): string {
  const o = plan.option;
  if (o) return `A published ${o.routeName} trip may make it: leave by ${bostonTime(o.leaveBy)}, board at ${o.boardStop.name} ${bostonTime(o.departure)}, at class ${bostonTime(o.atClass)} (timetable time, not live).`;
  if (plan.status === 'not-covered') return 'No saved T or shuttle timetable covers this date.';
  if (plan.status === 'no-stops') return 'No mapped T or shuttle stop has a walking route to both buildings.';
  return 'No published T or shuttle trip gets there in time.';
}

export function checkSchedule(input: ScheduleCheckInput): ScheduleCheck {
  const a = SCHEDULE_CHECK_ASSUMPTIONS;
  const byId = new Map(input.locations.map((l) => [l.id, l]));
  const place = (item: ScheduleItem) => byId.get(item.locationId)?.short || byId.get(item.locationId)?.name || item.title;
  const walk = (from: string, to: string) => (input.geo ? studyWalkMinutes(input.geo, input.locations, from, to) : null);
  const timed = input.items
    .filter((i) => (i.source !== 'suggested' || i.accepted) && Number.isFinite(Date.parse(i.start)) && Date.parse(i.end) > Date.parse(i.start))
    .sort((x, y) => Date.parse(x.start) - Date.parse(y.start) || x.id.localeCompare(y.id));
  const meals: { meal: 'lunch' | 'dinner'; time: string; defaulted: boolean }[] = input.profile
    ? [{ meal: 'lunch' as const, time: input.profile.lunchTime, defaulted: false }, { meal: 'dinner' as const, time: input.profile.dinnerTime, defaulted: false }]
    : [{ meal: 'lunch', time: a.defaultLunch, defaulted: true }, { meal: 'dinner', time: a.defaultDinner, defaulted: true }];

  const days: DayCheck[] = [];
  for (let n = 0; n < (input.dayCount ?? 7); n++) {
    const day = addDays(input.fromDay, n);
    const items = timed.filter((i) => bostonDay(i.start) === day);
    const check: DayCheck = { day, weekday: weekdayOf(day), classCount: items.length, firstStart: null, lastEnd: null,
      spanMinutes: 0, long: false, rushes: 0, transfers: [], meals: [] };
    days.push(check);
    if (!items.length) continue;
    const lastEnd = Math.max(...items.map((i) => Date.parse(i.end)));
    check.firstStart = items[0].start;
    check.lastEnd = new Date(lastEnd).toISOString();
    check.spanMinutes = Math.round((lastEnd - Date.parse(items[0].start)) / 60_000);
    check.long = check.spanMinutes >= a.longDayMinutes;
    check.rushes = modelFatigue(items, input.locations, { wakeAt: items[0].start, until: check.lastEnd, stepMinutes: 15 }).rushes;

    // Free time between consecutive classes after the walk, in Boston minutes of day, for meals.
    const free: [number, number, number][] = []; // [start, end, minutes lost to walking]
    free.push([0, minuteOfDay(Date.parse(items[0].start)), 0]);
    for (let k = 1; k < items.length; k++) {
      const prev = items.slice(0, k).reduce((latest, i) => (Date.parse(i.end) > Date.parse(latest.end) ? i : latest));
      const next = items[k];
      const gap = Math.round((Date.parse(next.start) - Date.parse(prev.end)) / 60_000);
      const moving = prev.locationId !== next.locationId;
      const w = moving ? walk(prev.locationId, next.locationId) : 0;
      if (gap > 0) free.push([minuteOfDay(Date.parse(prev.end)), minuteOfDay(Date.parse(next.start)), w ?? 0]);
      if (!moving) continue;
      const fromKnown = byId.has(prev.locationId), toKnown = byId.has(next.locationId);
      const areas = fromKnown && toKnown ? { from: campusArea(prev.locationId), to: campusArea(next.locationId) } : null;
      const crossCampus = areas && areas.from !== areas.to ? areas : null;
      const spare = w === null ? null : gap - w;
      const kind: TransferKind | null = gap < 0 ? 'overlap'
        : spare !== null ? (spare < 0 ? 'short' : spare <= a.tightSpareMinutes ? 'tight' : null)
          : fromKnown && toKnown && (crossCampus || gap < a.rushGapMinutes) ? 'no-route' : null;
      if (!kind) continue;
      const head = `${place(prev)} ${range(prev.start, prev.end)} then ${place(next)} ${bostonTime(next.start)}`;
      const text = kind === 'overlap' ? `${head}: the classes overlap by ${-gap} min`
        : kind === 'short' ? `${head}: ${w} min walk in a ${gap} min gap, ${-spare!} min short on foot`
          : kind === 'tight' ? `${head}: ${w} min walk, ${spare} min to spare`
            : `${head}: ${gap} min gap, no saved walking route between these buildings`;
      let transit: TransferFinding['transit'] = null;
      if (input.transit && kind !== 'overlap' && kind !== 'tight' && (crossCampus || kind === 'no-route' || (w ?? 0) >= 20)) {
        const plan = planTransit({ date: day, from: prev.locationId, to: next.locationId, classStart: Date.parse(next.start),
          arrivalTarget: Date.parse(next.start), now: Date.parse(prev.end), walkMinutes: w,
          walkLeaveBy: w === null ? null : Date.parse(next.start) - w * 60_000 }, input.transit);
        transit = { status: plan.status, text: transitSummary(plan) };
      }
      check.transfers.push({ kind, from: prev, to: next, gapMinutes: gap, walkMinutes: w, spareMinutes: spare,
        crossCampus, transit, text: crossCampus ? `${text} (${AREA_NAME[crossCampus.from]} to ${AREA_NAME[crossCampus.to]} campus)` : text });
    }
    free.push([minuteOfDay(lastEnd) || 24 * 60, 24 * 60, 0]);
    // A class ending past midnight leaves no evening free time on this day.
    if (bostonDay(lastEnd) !== day) free.pop();

    for (const meal of meals) {
      const at = toMinutes(meal.time);
      if (at === null) continue;
      const windowStart = Math.max(0, at + a.mealWindow[0]), windowEnd = Math.min(24 * 60, at + a.mealWindow[1]);
      const longest = Math.max(0, ...free.map(([s, e, lost]) => Math.min(e, windowEnd) - Math.max(s, windowStart) - lost));
      if (longest >= a.mealMinutes) continue;
      check.meals.push({ meal: meal.meal, savedTime: meal.time, defaulted: meal.defaulted, windowStart, windowEnd, longestFreeMinutes: longest,
        text: `No ${a.mealMinutes} min ${meal.meal} break between ${clockLabel(windowStart)} and ${clockLabel(windowEnd)} (${meal.defaulted ? 'assumed' : 'saved'} ${meal.meal} ${clockLabel(at)}${longest > 0 ? `; longest free stretch ${longest} min` : ''})` });
    }
  }
  const issueCount = days.reduce((sum, d) => sum + d.transfers.length + d.meals.length + (d.long ? 1 : 0), 0);
  return { days, issueCount };
}

/** The first Boston day from `now` on with a class (an import can start weeks ahead); today if none. */
export function firstClassDay(items: ScheduleItem[], now: number): string {
  const today = bostonDay(now);
  return items.map((item) => Date.parse(item.start)).filter(Number.isFinite).map((start) => bostonDay(start))
    .filter((day) => day >= today).sort()[0] ?? today;
}
/** "Oct 27" for a YYYY-MM-DD day. */
export const weekOfLabel = (day: string) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(`${day}T12:00:00Z`));

/** Short phrases for one day's findings: "2 tight transfers", "no lunch break", "9 h 15 min day". */
export function dayPhrases(d: DayCheck): string[] {
  const count = (kind: TransferKind) => d.transfers.filter((t) => t.kind === kind).length;
  const phrases: string[] = [];
  if (count('overlap')) phrases.push(plural(count('overlap'), 'overlapping class pair'));
  if (count('short')) phrases.push(`${plural(count('short'), 'transfer')} too short to walk`);
  if (count('tight')) phrases.push(plural(count('tight'), 'tight transfer'));
  if (count('no-route')) phrases.push(`${plural(count('no-route'), 'transfer')} with no saved walking route`);
  for (const m of d.meals) phrases.push(`no ${m.meal} break`);
  if (d.long) phrases.push(`${durationLabel(d.spanMinutes)} day`);
  return phrases;
}

/** One line for the import confirmation: "2 tight transfers on Tuesday; no lunch break on Thursday". */
export function summarizeScheduleCheck(check: ScheduleCheck, max = 3): string {
  const byPhrase = new Map<string, string[]>();
  for (const d of check.days) for (const p of dayPhrases(d)) byPhrase.set(p, [...(byPhrase.get(p) ?? []), d.weekday]);
  if (!byPhrase.size) return check.days.some((d) => d.classCount) ? 'No tight transfers, missed meal breaks or long days found.' : 'No classes to check this week.';
  const list = (names: string[]) => names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  const parts = [...byPhrase].map(([phrase, names]) => `${phrase} on ${list(names)}`);
  return parts.slice(0, max).join('; ') + (parts.length > max ? `; ${parts.length - max} more` : '');
}
