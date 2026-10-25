// "Tonight": after 9 PM Boston time, or once today's classes are over, what is still open by its
// published hours (dining and cafés, libraries, the gym) with its closing time and the walk from
// where the student is, and the last published T (or BU Shuttle) trip home. Pure: the Home card
// renders it.
//
// Honest by construction: a place without published hours for now is never listed (studyOpenAt
// refuses to guess); rides are published trips from the saved timetables, used only for a date
// inside the feed's coverage (so the 2024-25 BU Shuttle baseline is left out until a covering feed
// is saved) and aligned to the timetable's reference week by weekday; the crowd figure is the
// model's projection, never a live count.
import { ALIGHT_SECONDS } from '../../../map-client/src/sim/transitService';
import type { CampusGeo, CampusLocation, HourlyForecast, ScheduleItem } from '../data/types';
import { addDays, bostonLocal, hoursSource, MINUTE, openUntil } from './placeHours';
import { studyOpenAt, studyWalkMinutes, type StudyHoursByLocation } from './studyFinder';
import { BOARD_MARGIN_MINUTES, referenceDateFor, serviceEpoch, type Timetable, type TransitContext, type TransitExclusion, type TransitOption } from './transitDeparture';

/** Late-night mode starts at 21:00 and lasts until 05:00 Boston time. */
export const NIGHT_STARTS = 21 * 60;
export const NIGHT_ENDS = 5 * 60;
/** A place must stay open at least this long after you arrive to be listed. */
export const MIN_OPEN_AFTER_ARRIVAL = 15;
/** Places farther than this on foot are left out. */
export const MAX_NIGHT_WALK = 25;
/** Places listed, open latest first. */
export const MAX_NIGHT_OPTIONS = 6;
/** How far ahead a closing time is looked for; past this the place is "open late". */
const CLOSING_LOOKAHEAD = 12 * 60;
/** A class that ended this recently still says where the student is. */
const RECENT_CLASS_MINUTES = 120;
/** Published trips run past midnight on the same service day (GTFS 24:xx-29:xx). */
const SERVICE_DAY_END = 30 * 3600;

export type NightKind = 'dining' | 'library' | 'gym';
export type NightMode = 'late' | 'classes-done' | 'no-classes-today';

const valid = (s: ScheduleItem) => Number.isFinite(Date.parse(s.start)) && Date.parse(s.end) > Date.parse(s.start);

/**
 * Whether Home shows the Tonight card: 'late' after 21:00 (until 05:00); otherwise, with an
 * imported schedule, 'classes-done' once today's last class has ended and 'no-classes-today' on a
 * day without any. Null while classes are still left today (the gap card covers that).
 */
export function nightMode(schedule: ScheduleItem[], now: number): NightMode | null {
  const { day, minutes } = bostonLocal(now);
  if (minutes >= NIGHT_STARTS || minutes < NIGHT_ENDS) return 'late';
  const todays = schedule.filter((s) => valid(s) && bostonLocal(Date.parse(s.start)).day === day);
  if (todays.some((s) => Date.parse(s.end) > now)) return null;
  if (todays.length) return 'classes-done';
  return schedule.length ? 'no-classes-today' : null;
}

export interface NightOption {
  locationId: string;
  kind: NightKind;
  walkMinutes: number;
  arriveAt: number;
  /** Next closing by published hours, or null when open past the 12-hour lookahead. */
  closesAt: number | null;
  /** Modeled share of capacity at arrival, or null when the model has no figure. */
  crowd: number | null;
  hoursSourceUrl: string | null;
  walkHomeMinutes: number | null;
  /** The last published ride from this place home tonight. */
  rideHome: LastRide;
}

/** `none-left`: tonight's connecting trips have all gone; `no-direct`: no published trip links the nearby stops tonight. */
export type LastRideStatus = 'ride' | 'none-left' | 'no-direct' | 'no-stops' | 'not-covered' | 'at-home';
export interface LastRide {
  status: LastRideStatus;
  option: TransitOption | null;
  /** Timetables not used for tonight's service date because their feed does not cover it. */
  excluded: TransitExclusion[];
}

export interface TonightPlan {
  from: string | null;
  fromSource: 'class' | 'home' | null;
  homeLocationId: string | null;
  options: NightOption[];
  /** The last ride home from where the student is now (`at-home` when that is home). */
  rideHome: LastRide | null;
}

export interface TonightInput {
  schedule: ScheduleItem[];
  locations: CampusLocation[];
  geo: CampusGeo;
  hours: StudyHoursByLocation;
  forecasts: HourlyForecast[];
  homeLocationId: string | null;
  now: number;
  transit?: TransitContext;
  /** How many places to list (default 6). */
  maxOptions?: number;
}

const NIGHT_KINDS: Partial<Record<CampusLocation['kind'], NightKind>> = { dining: 'dining', library: 'library', gym: 'gym' };

/** The Boston service date tonight's trips run on: before 05:00 that is still yesterday's. */
export function serviceDateFor(now: number): string {
  const { day, minutes } = bostonLocal(now);
  return minutes < NIGHT_ENDS ? addDays(day, -1) : day;
}

type Trip = Timetable['schedule']['trips'][number];
const indexes = new WeakMap<Timetable['schedule'], Map<string, { trip: Trip; call: number }[]>>();
function callsByStop(schedule: Timetable['schedule']) {
  let index = indexes.get(schedule);
  if (!index) {
    const built = new Map<string, { trip: Trip; call: number }[]>();
    for (const trip of schedule.trips) trip.stops.forEach((call, i) => {
      const stop = schedule.stops[call.stop]?.mapStopId;
      if (!stop) return;
      const list = built.get(stop) ?? [];
      list.push({ trip, call: i }); built.set(stop, list);
    });
    indexes.set(schedule, built);
    index = built;
  }
  return index;
}
function stopsNear(context: TransitContext, place: string) {
  const near = new Map<string, number>();
  for (const [id, stop] of Object.entries(context.stops)) {
    const meters = stop.walkMeters[place];
    if (Number.isFinite(meters) && meters >= 0) near.set(id, Math.ceil(meters / (1.4 * 60)));
  }
  return near;
}

/**
 * The last published trip of tonight's service from a stop near `from` to a stop near home that
 * you can still catch (leave by >= now), alighting where it gets you home soonest. Published
 * timetable times only (no live predictions this far ahead).
 */
export function lastRideHome({ from, home, now, transit }: { from: string; home: string; now: number; transit: TransitContext | undefined }): LastRide {
  if (from === home) return { status: 'at-home', option: null, excluded: [] };
  if (!transit) return { status: 'not-covered', option: null, excluded: [] };
  const date = serviceDateFor(now);
  const excluded: TransitExclusion[] = [];
  const covered = transit.timetables.flatMap((timetable) => {
    const reference = referenceDateFor(timetable.schedule, date);
    if (!reference) excluded.push({ operator: timetable.operator, feedStart: timetable.schedule.feed.start, feedEnd: timetable.schedule.feed.end });
    return reference ? [{ ...timetable, ...reference }] : [];
  });
  if (!covered.length) return { status: 'not-covered', option: null, excluded };
  const origin = stopsNear(transit, from), destination = stopsNear(transit, home);
  if (!origin.size || !destination.size) return { status: 'no-stops', option: null, excluded };
  let best: TransitOption | null = null;
  let connects = false;
  for (const { operator, schedule, referenceDate, exactDate } of covered) {
    const weekday = schedule.dates.indexOf(referenceDate);
    const index = callsByStop(schedule);
    const reachesHome = (trip: Trip, call: number) => trip.stops.slice(call + 1).some((c) => {
      const id = schedule.stops[c.stop]?.mapStopId;
      return !!id && destination.has(id);
    });
    for (const [boardId, toStop] of origin) for (const { trip, call } of index.get(boardId) ?? []) {
      if (!trip.weekdays.includes(weekday) || call >= trip.stops.length - 1) continue;
      const board = trip.stops[call];
      if (!(board.departure >= 0 && board.departure < SERVICE_DAY_END)) continue;
      const departure = serviceEpoch(date, board.departure);
      const leaveBy = departure - (BOARD_MARGIN_MINUTES + toStop) * MINUTE;
      if (leaveBy < now || (best && departure < best.departure)) {
        connects ||= reachesHome(trip, call);
        continue;
      }
      let pick: { alightId: string; arrival: number; atHome: number; fromStop: number; seconds: number } | null = null;
      for (let j = call + 1; j < trip.stops.length; j++) {
        const alight = trip.stops[j];
        const alightId = schedule.stops[alight.stop]?.mapStopId;
        const fromStop = alightId ? destination.get(alightId) : undefined;
        if (!alightId || fromStop === undefined || alightId === boardId || alight.arrival < board.departure) continue;
        const arrival = serviceEpoch(date, alight.arrival);
        const atHome = arrival + ALIGHT_SECONDS * 1000 + fromStop * MINUTE;
        if (!pick || atHome < pick.atHome) pick = { alightId, arrival, atHome, fromStop, seconds: alight.arrival };
      }
      if (!pick) continue;
      connects = true;
      // Latest departure wins; on a tie, the one that gets you home soonest.
      if (best && departure === best.departure && (pick.atHome > best.atClass || (pick.atHome === best.atClass && `${trip.id}:${boardId}` >= `${best.trip}:${best.boardStop.id}`))) continue;
      const routeInfo = transit.routes?.[trip.route];
      best = {
        operator, route: trip.route, routeName: routeInfo?.name ?? (operator === 'bu-shuttle' ? 'BU Shuttle' : trip.route),
        direction: trip.direction, toward: routeInfo?.directions?.[trip.direction] ?? null, trip: trip.id,
        boardStop: { id: boardId, name: transit.stops[boardId].name }, alightStop: { id: pick.alightId, name: transit.stops[pick.alightId].name },
        walkToStopMinutes: toStop, walkFromStopMinutes: pick.fromStop, rideMinutes: Math.ceil((pick.seconds - board.departure) / 60),
        leaveBy, departure, arrival: pick.arrival, atClass: pick.atHome, marginMinutes: 0,
        departureBasis: 'timetable', liveStale: false,
        timetable: { referenceDate, exactDate, referenceWeekStart: schedule.referenceWeekStart, feedVersion: schedule.feed.version, sourceUrl: schedule.sourceUrl },
      };
    }
  }
  return best ? { status: 'ride', option: best, excluded } : { status: connects ? 'none-left' : 'no-direct', option: null, excluded };
}

export function planTonight(input: TonightInput): TonightPlan {
  const { locations, geo, hours, forecasts, now, transit } = input;
  const known = (id: string | null | undefined): id is string => !!id && locations.some((l) => l.id === id);
  const today = bostonLocal(now).day;
  const items = input.schedule.filter(valid).sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  const current = items.find((s) => Date.parse(s.start) <= now && Date.parse(s.end) > now);
  const recent = current ?? [...items].reverse().find((s) => Date.parse(s.end) <= now && now - Date.parse(s.end) <= RECENT_CLASS_MINUTES * MINUTE && bostonLocal(Date.parse(s.end)).day === today);
  const home = known(input.homeLocationId) ? input.homeLocationId : null;
  const from = known(recent?.locationId) ? recent!.locationId : home;
  const fromSource = !from ? null : known(recent?.locationId) ? 'class' : 'home';
  if (!from) return { from: null, fromSource: null, homeLocationId: home, options: [], rideHome: null };
  // Leave from the end of a class in progress.
  const startsAt = current && known(current.locationId) ? Date.parse(current.end) : now;
  const options: Omit<NightOption, 'rideHome'>[] = [];
  for (const location of locations) {
    const kind = NIGHT_KINDS[location.kind];
    if (!kind) continue;
    const walkMinutes = studyWalkMinutes(geo, locations, from, location.id);
    if (walkMinutes === null || walkMinutes > MAX_NIGHT_WALK) continue;
    const source = hours[location.id];
    const arriveAt = startsAt + walkMinutes * MINUTE;
    if (studyOpenAt(source, startsAt) !== true) continue;
    const closesAt = openUntil(source, arriveAt, CLOSING_LOOKAHEAD);
    if (closesAt !== null && closesAt - arriveAt < MIN_OPEN_AFTER_ARRIVAL * MINUTE) continue;
    const arrival = bostonLocal(arriveAt);
    const share = forecasts.find((f) => f.locationId === location.id && f.day === arrival.day)?.hours.find((h) => h.hour === Math.floor(arrival.minutes / 60))?.share;
    options.push({
      locationId: location.id, kind, walkMinutes, arriveAt, closesAt,
      crowd: share !== undefined && Number.isFinite(share) && share >= 0 ? share : null,
      hoursSourceUrl: hoursSource(source),
      walkHomeMinutes: home ? studyWalkMinutes(geo, locations, location.id, home) : null,
    });
  }
  // Open latest first, so the soonest-closing places come last; then the shorter walk.
  options.sort((a, b) => (b.closesAt ?? Infinity) - (a.closesAt ?? Infinity) || a.walkMinutes - b.walkMinutes || a.locationId.localeCompare(b.locationId));
  // Rides are searched only for the places listed (each search walks the whole timetable).
  const listed = options.slice(0, Math.max(0, input.maxOptions ?? MAX_NIGHT_OPTIONS)).map((option): NightOption => ({ ...option,
    rideHome: home ? lastRideHome({ from: option.locationId, home, now, transit }) : { status: 'no-stops', option: null, excluded: [] } }));
  return { from, fromSource, homeLocationId: home, options: listed, rideHome: home ? lastRideHome({ from, home, now, transit }) : null };
}
