// Leave-by times by T or BU Shuttle: walk to a stop, ride a published trip, walk to class.
//
// Every ride is a published trip: MBTA times from the saved GTFS timetable (transit-schedule.json),
// BU Shuttle times from shuttle-schedule.json. A timetable is used only for a class date inside its
// own feed coverage; the BU Shuttle file is BU's 2024-25 baseline, so it is excluded until a feed
// covering the date is saved. The timetables hold one reference week; a class on another date in
// the feed's coverage uses that week's same weekday and says so. Walks to and from stops follow the
// bundled pedestrian routes (campusStops.ts) at the same 1.4 m/s as walking the whole way; a place
// without one gets no transit option. A departure is "live" only when a fresh prediction
// (liveFreshness.ts) matches the trip; everything else is a timetable time.
import type { PublishedScheduleData } from '../../../map-client/src/transit/publishedSchedule';
import { ALIGHT_SECONDS } from '../../../map-client/src/sim/transitService';
import { isFreshObservation } from '../../../map-client/src/transit/liveFreshness';
import type { CampusRoutes, CampusStops } from '../data/types';

const DAY = 86400;
/** Minutes to be at the stop before a published departure. A planner assumption, not a measurement. */
export const BOARD_MARGIN_MINUTES = 2;
/** A walk this long or longer gets a transit option whenever it walks less, even if it leaves earlier. */
export const LONG_WALK_MINUTES = 20;
/** A prediction matches a published trip with no trip id when within this of its timetable departure. */
const LIVE_MATCH_SECONDS = 10 * 60;

export type Operator = 'mbta' | 'bu-shuttle';
export interface Timetable { operator: Operator; schedule: PublishedScheduleData }
/** A predicted departure from a feed, with when it was received or observed (epoch ms). */
export interface LiveDeparture { trip?: string; route: string; direction: 0 | 1; stop: string; time: number; observedAt: number | null }
export interface TransitContext {
  timetables: Timetable[];
  stops: CampusStops;
  routes?: CampusRoutes;
  live?: LiveDeparture[];
}

export type TimeBasis = 'live' | 'timetable';
export interface TransitOption {
  operator: Operator;
  route: string;
  routeName: string;
  direction: 0 | 1;
  toward: string | null;
  trip: string;
  boardStop: { id: string; name: string };
  alightStop: { id: string; name: string };
  walkToStopMinutes: number;
  walkFromStopMinutes: number;
  rideMinutes: number;
  /** Epoch ms. */
  leaveBy: number;
  departure: number;
  arrival: number;
  /** When the walk from the stop reaches the class building. */
  atClass: number;
  /** Whole minutes between reaching the building and the class start (the buffer is inside it). */
  marginMinutes: number;
  departureBasis: TimeBasis;
  /** A prediction matched this trip but was too old to use. */
  liveStale: boolean;
  /** Timetable times always come from this reference date's published service. */
  timetable: { referenceDate: string; exactDate: boolean; referenceWeekStart: string; feedVersion: string; sourceUrl: string };
}
export interface TransitExclusion { operator: Operator; feedStart: string; feedEnd: string }
export type TransitStatus = 'offered' | 'walking-better' | 'no-trip' | 'no-stops' | 'not-covered';
export interface TransitPlan {
  status: TransitStatus;
  /** Best published trip found (latest leave-by that still arrives in time), offered or not. */
  option: TransitOption | null;
  /** Why it is offered: no walking route, it lets you leave later, or it cuts a long walk. */
  reason: 'no-walk-route' | 'leave-later' | 'less-walking' | null;
  /** Minutes later than the walking leave-by (positive) or earlier (negative). */
  versusWalkMinutes: number | null;
  /** Timetables not used for this date because their feed does not cover it. */
  excluded: TransitExclusion[];
}

export interface TransitRequest {
  /** Boston service date of the class, YYYY-MM-DD. */
  date: string;
  from: string;
  to: string;
  classStart: number;
  arrivalTarget: number;
  now: number;
  walkMinutes: number | null;
  walkLeaveBy: number | null;
}

const walkMinutes = (meters: number) => Math.ceil(meters / (1.4 * 60));
const stamp = (date: string) => date.replaceAll('-', '');
const weekdayOf = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/** GTFS times count from noon minus 12 hours, Boston time, so DST days keep the wall clock. */
export function serviceEpoch(date: string, seconds: number): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, 12);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' }).formatToParts(guess).map((p) => [p.type, p.value]));
  const offset = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute)) - guess;
  return guess - offset - 12 * 3600_000 + seconds * 1000;
}

/** The reference-week date whose published service stands in for `date`, or null outside the feed. */
export function referenceDateFor(schedule: PublishedScheduleData, date: string): { referenceDate: string; exactDate: boolean } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || schedule.dates?.length !== 7) return null;
  if (!(schedule.feed.start <= stamp(date) && stamp(date) <= schedule.feed.end)) return null;
  const referenceDate = schedule.dates.find((day) => weekdayOf(day) === weekdayOf(date));
  return referenceDate ? { referenceDate, exactDate: referenceDate === date } : null;
}

type Call = PublishedScheduleData['trips'][number]['stops'][number];
type Trip = PublishedScheduleData['trips'][number];
const indexes = new WeakMap<PublishedScheduleData, Map<string, { trip: Trip; call: number }[]>>();
/** Every call of every trip, by map stop. */
function callsByStop(schedule: PublishedScheduleData) {
  let index = indexes.get(schedule);
  if (!index) {
    index = new Map();
    for (const trip of schedule.trips) trip.stops.forEach((call, i) => {
      const stop = schedule.stops[call.stop]?.mapStopId;
      if (!stop) return;
      const list = index!.get(stop) ?? [];
      list.push({ trip, call: i }); index!.set(stop, list);
    });
    indexes.set(schedule, index);
  }
  return index;
}

function stopsNear(stops: CampusStops, place: string) {
  const near = new Map<string, number>();
  for (const [id, stop] of Object.entries(stops)) {
    const meters = stop.walkMeters[place];
    if (Number.isFinite(meters) && meters >= 0) near.set(id, walkMinutes(meters));
  }
  return near;
}

function liveFor(live: LiveDeparture[], trip: Trip, stop: string, scheduled: number) {
  let best: LiveDeparture | null = null;
  for (const row of live) {
    if (row.route !== trip.route || row.direction !== trip.direction || row.stop !== stop || !Number.isFinite(row.time)) continue;
    if (row.trip !== undefined ? row.trip !== trip.id : Math.abs(row.time - scheduled) > LIVE_MATCH_SECONDS * 1000) continue;
    if (!best || Math.abs(row.time - scheduled) < Math.abs(best.time - scheduled)) best = row;
  }
  return best;
}

export function planTransit(request: TransitRequest, context: TransitContext): TransitPlan {
  const { date, from, to, classStart, arrivalTarget, now } = request;
  const origin = stopsNear(context.stops, from), destination = stopsNear(context.stops, to);
  const excluded: TransitExclusion[] = [];
  const covered = context.timetables.flatMap((timetable) => {
    const reference = referenceDateFor(timetable.schedule, date);
    if (!reference) excluded.push({ operator: timetable.operator, feedStart: timetable.schedule.feed.start, feedEnd: timetable.schedule.feed.end });
    return reference ? [{ ...timetable, ...reference }] : [];
  });
  const empty = (status: TransitStatus): TransitPlan => ({ status, option: null, reason: null, versusWalkMinutes: null, excluded });
  if (!covered.length) return empty('not-covered');
  if (!origin.size || !destination.size || from === to) return empty('no-stops');
  let best: TransitOption | null = null;
  for (const { operator, schedule, referenceDate, exactDate } of covered) {
    const weekday = schedule.dates.indexOf(referenceDate);
    const index = callsByStop(schedule);
    for (const [boardId, toStop] of origin) for (const { trip, call } of index.get(boardId) ?? []) {
      if (!trip.weekdays.includes(weekday) || call >= trip.stops.length - 1) continue;
      const board: Call = trip.stops[call];
      // Only same-service-day calls: a class date's times never borrow the next day's 24:xx service.
      if (!(board.departure >= 0 && board.departure < DAY && board.arrival <= board.departure)) continue;
      const scheduled = serviceEpoch(date, board.departure);
      const prediction = context.live && operator === 'mbta' ? liveFor(context.live, trip, boardId, scheduled) : null;
      const fresh = !!prediction && isFreshObservation(prediction.observedAt, now);
      const shift = fresh ? prediction!.time - scheduled : 0;
      const departure = scheduled + shift;
      const leaveBy = departure - (BOARD_MARGIN_MINUTES + toStop) * 60_000;
      if (leaveBy < now) continue;
      // The stop on this trip that gets you to the building soonest (a later stop can be a shorter walk).
      let pick: { alightId: string; alight: Call; fromStop: number; arrival: number; atClass: number } | null = null;
      for (let j = call + 1; j < trip.stops.length; j++) {
        const alight = trip.stops[j];
        const alightId = schedule.stops[alight.stop]?.mapStopId;
        const fromStop = alightId ? destination.get(alightId) : undefined;
        if (!alightId || fromStop === undefined || alightId === boardId || alight.arrival < board.departure || alight.arrival >= DAY) continue;
        const arrival = serviceEpoch(date, alight.arrival) + shift;
        const atClass = arrival + ALIGHT_SECONDS * 1000 + fromStop * 60_000;
        if (atClass <= arrivalTarget && (!pick || atClass < pick.atClass)) pick = { alightId, alight, fromStop, arrival, atClass };
      }
      if (!pick) continue;
      const { alightId, alight, fromStop, arrival, atClass } = pick;
      const better = !best || leaveBy > best.leaveBy || (leaveBy === best.leaveBy && (atClass < best.atClass
        || (atClass === best.atClass && `${trip.id}:${boardId}` < `${best.trip}:${best.boardStop.id}`)));
      if (!better) continue;
      const routeInfo = context.routes?.[trip.route];
      best = {
        operator, route: trip.route, routeName: routeInfo?.name ?? (operator === 'bu-shuttle' ? 'BU Shuttle' : trip.route),
        direction: trip.direction, toward: routeInfo?.directions?.[trip.direction] ?? null, trip: trip.id,
        boardStop: { id: boardId, name: context.stops[boardId].name }, alightStop: { id: alightId, name: context.stops[alightId].name },
        walkToStopMinutes: toStop, walkFromStopMinutes: fromStop, rideMinutes: Math.ceil((alight.arrival - board.departure) / 60),
        leaveBy, departure, arrival, atClass, marginMinutes: Math.floor((classStart - atClass) / 60_000),
        departureBasis: fresh ? 'live' : 'timetable', liveStale: !!prediction && !fresh,
        timetable: { referenceDate, exactDate, referenceWeekStart: schedule.referenceWeekStart, feedVersion: schedule.feed.version, sourceUrl: schedule.sourceUrl },
      };
    }
  }
  if (!best) return empty('no-trip');
  const { walkMinutes: walk, walkLeaveBy } = request;
  const versusWalkMinutes = walkLeaveBy === null ? null : Math.round((best.leaveBy - walkLeaveBy) / 60_000);
  const transitWalking = best.walkToStopMinutes + best.walkFromStopMinutes;
  const reason = walk === null || walkLeaveBy === null ? 'no-walk-route'
    : best.leaveBy > walkLeaveBy ? 'leave-later'
      : walk >= LONG_WALK_MINUTES && transitWalking < walk ? 'less-walking' : null;
  return { status: reason ? 'offered' : 'walking-better', option: best, reason, versusWalkMinutes, excluded };
}

const OPERATOR_NAME: Record<Operator, string> = { mbta: 'MBTA', 'bu-shuttle': 'BU Shuttle' };
const shortDate = (date: string, withWeekday = true) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC',
  ...(withWeekday ? { weekday: 'short' } : {}), month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00Z`));

/** Whether the departure is a live prediction or which published timetable it comes from, in plain words. */
export function departureBasisLabel(option: TransitOption): string {
  const operator = OPERATOR_NAME[option.operator];
  if (option.departureBasis === 'live') return `Live ${operator} prediction; ride time from the timetable`;
  const { referenceDate, exactDate, referenceWeekStart } = option.timetable;
  const stale = option.liveStale ? ' (live prediction too old to use)' : '';
  return exactDate ? `${operator} timetable for ${shortDate(referenceDate)}${stale}`
    : `${operator} timetable, ${shortDate(referenceDate)} of the reference week of ${shortDate(referenceWeekStart, false)} applied by weekday, not date-specific service${stale}`;
}

export function exclusionLabel(exclusion: TransitExclusion): string {
  const day = (value: string) => shortDate(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`, false) + `, ${value.slice(0, 4)}`;
  return `${OPERATOR_NAME[exclusion.operator]} timetable not used: its feed covers ${day(exclusion.feedStart)}–${day(exclusion.feedEnd)}.`;
}
