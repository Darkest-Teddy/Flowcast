// "Your next gap": what fits between now (or the end of the class in progress) and leaving for the
// next class today. For each kind of thing to do (eat, study, work out) it picks the best place that
// is open for the whole stay by its published hours, reachable and back in time on the saved walking
// routes, ranked by the modeled crowd at arrival and the walk. Pure: the Home card renders it.
//
// Honest by construction: a place without published hours for that time is never offered (studyOpenAt
// refuses to guess), meals are only suggested near the student's saved lunch or dinner time, and the
// crowd figure is the model's projection (from real day-to-day data, never a live count).
import type { CampusGeo, CampusLocation, HourlyForecast, Profile, ScheduleItem } from '../data/types';
import { studyOpenAt, studyWalkMinutes, type StudyHoursByLocation } from './studyFinder';

export type GapActivity = 'eat' | 'study' | 'gym';

/** Shortest worthwhile stay, and the longest one suggested, per activity (minutes). */
export const GAP_STAY: Record<GapActivity, { min: number; max: number }> = {
  eat: { min: 20, max: 40 },
  study: { min: 30, max: 180 },
  gym: { min: 35, max: 60 },
};
/** A gap shorter than this (after walking) is just "head to class". */
export const MIN_GAP_MINUTES = 20;
/** Meals are suggested from this long before to this long after the saved meal time. */
export const MEAL_WINDOW: [number, number] = [-75, 90];
/** How far ahead "open until" looks (a morning arrival still sees a midnight closing). */
const CLOSING_LOOKAHEAD_MINUTES = 16 * 60;
/** How far back a class that just ended still says where the student is. */
const RECENT_CLASS_MINUTES = 120;
const KIND_ACTIVITY: Partial<Record<CampusLocation['kind'], GapActivity>> = { dining: 'eat', library: 'study', gym: 'gym' };

export interface GapOption {
  activity: GapActivity;
  locationId: string;
  walkThere: number;
  walkBack: number;
  arriveAt: number;
  /** Leave the place by this time to make the next class (with the buffer). */
  leaveBy: number;
  stayMinutes: number;
  /** Modeled share of capacity at arrival, or null when the model has no figure. */
  crowd: number | null;
  /** When the place next closes by its published hours (within 16 hours), else null. */
  closesAt: number | null;
  hoursSourceUrl: string | null;
}

export type GapStatus = 'gap' | 'tight' | 'no-next' | 'unknown-origin' | 'unmapped-class';

export interface GapPlan {
  status: GapStatus;
  next: ScheduleItem | null;
  /** The class in progress, when the gap starts at its end. */
  current: ScheduleItem | null;
  from: string | null;
  fromSource: 'class' | 'home' | null;
  startsAt: number;
  /** Leave for the next class by this time, walking straight from `from`. */
  leaveForClassBy: number | null;
  gapMinutes: number | null;
  options: GapOption[];
}

export interface GapInput {
  schedule: ScheduleItem[];
  locations: CampusLocation[];
  geo: CampusGeo;
  hours: StudyHoursByLocation;
  forecasts: HourlyForecast[];
  profile: Pick<Profile, 'lunchTime' | 'dinnerTime' | 'studySpotId'> | null;
  homeLocationId: string | null;
  now: number;
  bufferMinutes?: number;
}

const MINUTE = 60_000;
const clockFormat = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** Boston date and minutes after midnight. */
function local(at: number): { day: string; minutes: number } {
  const parts = clockFormat.formatToParts(at);
  const get = (key: string) => parts.find((p) => p.type === key)!.value;
  return { day: `${get('year')}-${get('month')}-${get('day')}`, minutes: +get('hour') * 60 + +get('minute') };
}
const toMinutes = (hhmm: string | undefined): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return match ? +match[1] * 60 + +match[2] : null;
};

/** Minutes the place stays open from `from`, by published hours, checked every 5 minutes (up to `cap`). */
function openMinutes(source: StudyHoursByLocation[string] | undefined, from: number, cap: number): number {
  let minutes = 0;
  while (minutes < cap && studyOpenAt(source, from + minutes * MINUTE) === true && studyOpenAt(source, from + Math.min(cap, minutes + 5) * MINUTE - 1) === true) minutes += 5;
  // The last part-step, minute by minute, so a closing time isn't rounded down.
  while (minutes < cap && studyOpenAt(source, from + (minutes + 1) * MINUTE - 1) === true) minutes++;
  return Math.min(cap, minutes);
}

export function planGap(input: GapInput): GapPlan {
  const { geo, locations, hours, forecasts, now } = input;
  const buffer = Math.max(0, input.bufferMinutes ?? 5);
  const items = input.schedule.filter((s) => Number.isFinite(Date.parse(s.start)) && Date.parse(s.end) > Date.parse(s.start))
    .slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  const today = local(now).day;
  const current = items.find((s) => Date.parse(s.start) <= now && Date.parse(s.end) > now) ?? null;
  const startsAt = current ? Date.parse(current.end) : now;
  const next = items.find((s) => Date.parse(s.start) >= startsAt && s.id !== current?.id && local(Date.parse(s.start)).day === today) ?? null;
  const empty = (status: GapStatus, extra: Partial<GapPlan> = {}): GapPlan =>
    ({ status, next, current, from: null, fromSource: null, startsAt, leaveForClassBy: null, gapMinutes: null, options: [], ...extra });
  if (!next) return empty('no-next');
  const known = (id: string | null | undefined): id is string => !!id && locations.some((l) => l.id === id);
  if (!known(next.locationId)) return empty('unmapped-class');
  // Where the gap starts: the class in progress, a class that just ended, else home.
  const recent = current ?? [...items].reverse().find((s) => Date.parse(s.end) <= now && now - Date.parse(s.end) <= RECENT_CLASS_MINUTES * MINUTE && local(Date.parse(s.end)).day === today);
  const from = known(recent?.locationId) ? recent!.locationId : known(input.homeLocationId) ? input.homeLocationId : null;
  if (!from) return empty('unknown-origin');
  const fromSource = known(recent?.locationId) ? 'class' : 'home';
  const classStart = Date.parse(next.start);
  const direct = studyWalkMinutes(geo, locations, from, next.locationId);
  const leaveForClassBy = direct === null ? null : classStart - (buffer + direct) * MINUTE;
  const gapMinutes = leaveForClassBy === null ? null : Math.floor((leaveForClassBy - startsAt) / MINUTE);
  const base = { next, current, from, fromSource, startsAt, leaveForClassBy, gapMinutes } as const;
  if (gapMinutes === null || gapMinutes < MIN_GAP_MINUTES) return { status: 'tight', ...base, options: [] };

  const mealTimes = [toMinutes(input.profile?.lunchTime ?? '12:00'), toMinutes(input.profile?.dinnerTime ?? '18:00')].filter((m): m is number => m !== null);
  const best = new Map<GapActivity, { option: GapOption; score: number }>();
  for (const location of locations) {
    const activity = KIND_ACTIVITY[location.kind];
    if (!activity) continue;
    const walkThere = studyWalkMinutes(geo, locations, from, location.id);
    const walkBack = studyWalkMinutes(geo, locations, location.id, next.locationId);
    if (walkThere === null || walkBack === null) continue;
    const arriveAt = startsAt + walkThere * MINUTE;
    const leaveBy = classStart - (buffer + walkBack) * MINUTE;
    const available = Math.floor((leaveBy - arriveAt) / MINUTE);
    const { min, max } = GAP_STAY[activity];
    if (available < min) continue;
    if (activity === 'eat') {
      const at = local(arriveAt).minutes;
      if (!mealTimes.some((meal) => at >= meal + MEAL_WINDOW[0] && at <= meal + MEAL_WINDOW[1])) continue;
    }
    const source = hours[location.id];
    const stayMinutes = openMinutes(source, arriveAt, Math.min(max, available));
    if (stayMinutes < min) continue;
    const arrival = local(arriveAt);
    const share = forecasts.find((f) => f.locationId === location.id && f.day === arrival.day)?.hours.find((h) => h.hour === Math.floor(arrival.minutes / 60))?.share;
    const crowd = share !== undefined && Number.isFinite(share) && share >= 0 ? share : null;
    const openFor = openMinutes(source, arriveAt, CLOSING_LOOKAHEAD_MINUTES);
    const closesAt = openFor < CLOSING_LOOKAHEAD_MINUTES ? arriveAt + openFor * MINUTE : null;
    const option: GapOption = { activity, locationId: location.id, walkThere, walkBack, arriveAt, leaveBy, stayMinutes, crowd, closesAt,
      hoursSourceUrl: source?.hours.find((h) => h.sourceUrl)?.sourceUrl ?? null };
    // Quieter and closer first; the saved study spot gets a head start.
    const score = (crowd ?? 0.6) + (walkThere + walkBack) / 30 - (activity === 'study' && location.id === input.profile?.studySpotId ? 0.3 : 0);
    const held = best.get(activity);
    if (!held || score < held.score || (score === held.score && location.id < held.option.locationId)) best.set(activity, { option, score });
  }
  const options = [...best.values()].sort((a, b) => a.score - b.score).map((entry) => entry.option);
  return { status: 'gap', ...base, options };
}
