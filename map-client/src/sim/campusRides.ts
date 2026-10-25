// Rides between campus stops: a student's long walk between two mapped places may instead be a
// published MBTA or BU Shuttle ride (the Green Line B along Comm Ave, the C/D lines, the BU
// Shuttle loops). The rider walks to a stop near where they are, waits for a published departure,
// rides that same trip to a stop near where they are going and walks on, arriving no later than
// the walk would have. Only the saved timetable's trips are used (sim/transitService.ts): no trip,
// headway or stop is invented, and the ride is recorded as a board and an alight on that trip, so
// waiting riders, students aboard vehicles and the ridership counts include it.
//
// Who rides is an explicit, uncalibrated assumption (see CAMPUS_RIDE_ASSUMPTION): only walks of at
// least 12 minutes, only when the ride saves at least 3 minutes door to door including the wait, and
// then with a probability growing with the time saved, highest for the free BU Shuttle; rain, snow,
// storms or cold make it more likely (the conditions engine's campusRideFactor). The planner
// (sim/sourceDay.ts) decides per person and walk with stable hashes.
import type { TransitRide } from './playback';
import { ALIGHT_SECONDS, lastAtOrBefore, routeKind, type StopVisits, type TransitService } from './transitService';

/** Whether a ride record is one end of a ride between campus stops (not a commute). */
export const isCampusRide = (ride: Pick<TransitRide, 'alightsAt' | 'boardedAt'>): boolean => ride.alightsAt !== undefined || ride.boardedAt !== undefined;

type Route = { path: [number, number][]; cumulative: number[] };

/** Walks shorter than this are always walked (dry weather). */
export const CAMPUS_RIDE_MIN_WALK_SECONDS = 12 * 60;
/** ...and on days whose ride factor is above 1 (rain, snow, storms or cold in behavior.json). */
export const CAMPUS_RIDE_BAD_WEATHER_MIN_WALK_SECONDS = 9 * 60;
/** A ride must save at least this much door to door, waiting included (dry weather; 0 in bad weather). */
export const CAMPUS_RIDE_MIN_SAVING_SECONDS = 3 * 60;
/** Time saved at which the ride share reaches its maximum. */
export const CAMPUS_RIDE_FULL_SAVING_SECONDS = 8 * 60;
/** Largest share of eligible walks that become rides on a dry day (times the day's ride factor, at most 95%). */
export const CAMPUS_RIDE_SHARE = 0.55;
/** Relative pull of each mode: the BU Shuttle is free with a BU ID; the T and MBTA buses cost a fare
 * (or a pass) and a bus is slower in traffic. Uncalibrated weights. */
export const CAMPUS_RIDE_MODE_WEIGHT = { shuttle: 1, subway: 0.3, bus: 0.15 } as const;
/** Stops a rider will walk to or from: at most this far along saved walks. */
export const CAMPUS_RIDE_MAX_ACCESS_METRES = 450;
/** Stops considered at each end, nearest first. */
const NEAR_STOPS = 4;
/** Riders who time their trip (a stable half of students, e.g. with the BU Shuttle or MBTA app) take the latest
 * departure that still gets them there in time and reach the stop 1–8 minutes before it (when they can leave
 * that early); the rest leave when they would have set off walking and take the first departure that gets
 * them there in time, waiting at most 15 minutes. */
export const CAMPUS_RIDE_TIMED_SHARE = 0.5;
export const CAMPUS_RIDE_STOP_MARGIN_SECONDS: readonly [number, number] = [60, 8 * 60];
export const CAMPUS_RIDE_MAX_WAIT_SECONDS = 15 * 60;

export const CAMPUS_RIDE_ASSUMPTION = `Students ride between campus stops (an uncalibrated assumption, not observed BU travel): a walk of at least ${CAMPUS_RIDE_MIN_WALK_SECONDS / 60} minutes between two mapped places may instead be a published MBTA or BU Shuttle trip from a stop within ${CAMPUS_RIDE_MAX_ACCESS_METRES} m of saved walk to one within ${CAMPUS_RIDE_MAX_ACCESS_METRES} m of the destination, when it saves at least ${CAMPUS_RIDE_MIN_SAVING_SECONDS / 60} minutes door to door including the wait at the stop: half of students time their trip (the latest departure that gets them there, reaching the stop ${CAMPUS_RIDE_STOP_MARGIN_SECONDS[0] / 60}–${CAMPUS_RIDE_STOP_MARGIN_SECONDS[1] / 60} minutes early), the rest set off when they would have walked and take the first departure that does (waiting at most ${CAMPUS_RIDE_MAX_WAIT_SECONDS / 60} minutes). The share riding grows with the time saved, reaching ${Math.round(CAMPUS_RIDE_SHARE * 100)}% at ${CAMPUS_RIDE_FULL_SAVING_SECONDS / 60} minutes saved on the free BU Shuttle, ${CAMPUS_RIDE_MODE_WEIGHT.subway}× that on the Green Line and ${CAMPUS_RIDE_MODE_WEIGHT.bus}× on an MBTA bus (fares, slower buses); the conditions engine scales these shares (×1.4 in rain, snow or storms, ×1.25 below 32°F in behavior.json), and on such days a ride no slower than walking is taken at least half as often and walks from ${CAMPUS_RIDE_BAD_WEATHER_MIN_WALK_SECONDS / 60} minutes qualify. The person takes the option they are most likely to take. Choices are stable per student and walk. Riders never arrive later than they would have walking, never on a full vehicle, and groups walking to a meal together keep walking; employees walk.`;

export interface CampusRideNetwork {
  /** Map stops with saved walks to nearby places. */
  stops: readonly string[];
  stopPoint(stop: string): [number, number];
  /** Where a place's walks start and end, for a quick distance screen. */
  point(location: string): [number, number] | undefined;
  /** The saved walk from a stop to a place (undefined when there is none). */
  fromStop(stop: string, location: string): Route | undefined;
}

export interface CampusRideOption {
  board: string;
  alight: string;
  route: string;
  direction: 0 | 1;
  /** Walk from the origin to the boarding stop, and from the alighting stop to the destination. */
  access: Route;
  egress: Route;
}

export interface CampusRideRequest {
  from: string;
  to: string;
  weekday: number;
  /** Walking speed (m/s). */
  speed: number;
  /** Earliest the rider can leave the origin. */
  earliest: number;
  /** The walk this ride would replace: when it leaves and how long it takes. */
  walkDepart: number;
  walkSeconds: number;
  /** The day's ride factor (behaviour parameter campusRideFactor, 1 on a dry day): scales the shares; above 1
   * (rain, snow, storms, cold) rides no slower than walking and shorter walks also qualify. */
  shareFactor: number;
  /** Stable draws in [0, 1): whether to ride, whether the person times their trip, and how early to be at the stop. */
  rideDraw: number;
  timingDraw: number;
  marginDraw: number;
  /** Whether the trip has room for one more rider (boarding and alighting). */
  hasRoom(trip: string, route: string): boolean;
  /** Whether leaving the origin at `leave` and reaching the destination at `reach` keeps the day valid. */
  fits(leave: number, reach: number): boolean;
}

export interface CampusRidePlan {
  option: CampusRideOption;
  trip: string;
  /** Leave the origin, reach the stop, published departure, published arrival, walk on, reach the destination. */
  leave: number;
  atStop: number;
  departs: number;
  arrives: number;
  walkOn: number;
  reach: number;
}

const metres = (a: [number, number], b: [number, number]) =>
  Math.hypot((a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (a[1] - b[1]) * 110540);
const length = (route: Route) => route.cumulative[route.cumulative.length - 1];

export interface CampusRides {
  /** Published ride options between two places (cached per pair). */
  options(from: string, to: string): CampusRideOption[];
  /** The ride replacing this walk, or undefined to walk. */
  plan(request: CampusRideRequest): CampusRidePlan | undefined;
}

export function createCampusRides(transit: TransitService, network: CampusRideNetwork): CampusRides {
  const reversed = new WeakMap<Route, Route>();
  const reverse = (route: Route): Route => {
    let out = reversed.get(route);
    if (!out) {
      const total = length(route);
      out = { path: [...route.path].reverse(), cumulative: [...route.cumulative].reverse().map(distance => total - distance) };
      reversed.set(route, out);
    }
    return out;
  };
  const stops = [...network.stops].sort().filter(stop => transit.services(stop).length);
  const nearCache = new Map<string, { stop: string; route: Route }[]>();
  /** The nearest stops (by saved walk) to a place, with the walk from each stop to it. */
  const near = (location: string) => {
    let list = nearCache.get(location);
    if (list) return list;
    list = [];
    const point = network.point(location);
    if (point) for (const stop of stops) {
      if (metres(point, network.stopPoint(stop)) > CAMPUS_RIDE_MAX_ACCESS_METRES) continue;
      const route = network.fromStop(stop, location);
      if (route && length(route) <= CAMPUS_RIDE_MAX_ACCESS_METRES) list.push({ stop, route });
    }
    list.sort((a, b) => length(a.route) - length(b.route) || a.stop.localeCompare(b.stop));
    list = list.slice(0, NEAR_STOPS);
    nearCache.set(location, list);
    return list;
  };
  const optionCache = new Map<string, CampusRideOption[]>();
  const options = (from: string, to: string): CampusRideOption[] => {
    const key = `${from}>${to}`;
    let list = optionCache.get(key);
    if (list) return list;
    list = [];
    const origins = near(from), destinations = from === to ? [] : near(to);
    for (const origin of origins) for (const destination of destinations) {
      if (origin.stop === destination.stop) continue;
      for (const service of transit.services(origin.stop)) {
        if (!transit.services(destination.stop).some(other => other.route === service.route && other.direction === service.direction)) continue;
        list.push({ board: origin.stop, alight: destination.stop, route: service.route, direction: service.direction,
          access: reverse(origin.route), egress: destination.route });
      }
    }
    optionCache.set(key, list);
    return list;
  };
  // Each trip's published arrivals at a stop (a loop can call twice), for matching a boarding to its alighting.
  const arrivalIndex = new WeakMap<StopVisits, Map<string, number[]>>();
  const arrivalsOf = (visits: StopVisits) => {
    let index = arrivalIndex.get(visits);
    if (!index) {
      index = new Map();
      visits.trips.forEach((trip, k) => { const list = index!.get(trip) ?? []; list.push(visits.arrivals[k]); index!.set(trip, list); });
      arrivalIndex.set(visits, index);
    }
    return index;
  };

  const plan = (request: CampusRideRequest): CampusRidePlan | undefined => {
    const { walkSeconds } = request, badWeather = request.shareFactor > 1;
    const share = Math.min(0.95, CAMPUS_RIDE_SHARE * Math.max(0, request.shareFactor));
    if (walkSeconds < (badWeather ? CAMPUS_RIDE_BAD_WEATHER_MIN_WALK_SECONDS : CAMPUS_RIDE_MIN_WALK_SECONDS) || request.rideDraw >= share) return undefined;
    const choices = options(request.from, request.to);
    if (!choices.length) return undefined;
    const arriveBy = request.walkDepart + walkSeconds;
    const margin = CAMPUS_RIDE_STOP_MARGIN_SECONDS[0] + request.marginDraw * (CAMPUS_RIDE_STOP_MARGIN_SECONDS[1] - CAMPUS_RIDE_STOP_MARGIN_SECONDS[0]);
    const timed = request.timingDraw < CAMPUS_RIDE_TIMED_SHARE;
    const found: CampusRidePlan[] = [];
    for (const option of choices) {
      const access = length(option.access) / request.speed, egress = length(option.egress) / request.speed;
      const boards = transit.visits(option.board, option.route, option.direction, request.weekday, 'board');
      const alights = transit.visits(option.alight, option.route, option.direction, request.weekday, 'alight');
      if (!boards || !alights) continue;
      const arrivals = arrivalsOf(alights);
      if (!timed) {
        // Set off as for the walk; the first published departure that still gets them there in time.
        const atStop = request.walkDepart + access;
        for (let k = Math.max(0, lastAtOrBefore(boards.arrivals, atStop - 900)); k < boards.arrivals.length && boards.arrivals[k] <= arriveBy; k++) {
          const departs = boards.departures[k];
          if (departs < atStop || departs > atStop + CAMPUS_RIDE_MAX_WAIT_SECONDS) continue;
          const arrives = arrivals.get(boards.trips[k])?.find(time => time > departs);
          if (arrives === undefined || arrives + ALIGHT_SECONDS + egress > arriveBy + 1e-7 || !request.hasRoom(boards.trips[k], option.route)) continue;
          found.push({ option, trip: boards.trips[k], leave: request.walkDepart, atStop, departs, arrives, walkOn: arrives + ALIGHT_SECONDS, reach: arrives + ALIGHT_SECONDS + egress });
          break;
        }
        continue;
      }
      // The latest published departure that still gets the rider there by the time the walk would have.
      for (let k = lastAtOrBefore(boards.arrivals, arriveBy - egress - ALIGHT_SECONDS); k >= 0; k--) {
        const departs = boards.departures[k];
        if (departs < request.earliest + access - 900) break;
        if (departs < request.earliest + access) continue;
        const arrives = arrivals.get(boards.trips[k])?.find(time => time > departs);
        if (arrives === undefined) continue;
        const walkOn = arrives + ALIGHT_SECONDS, reach = walkOn + egress;
        if (reach > arriveBy + 1e-7 || !request.hasRoom(boards.trips[k], option.route)) continue;
        const leave = Math.max(request.earliest, departs - margin - access);
        found.push({ option, trip: boards.trips[k], leave, atStop: leave + access, departs, arrives, walkOn, reach });
        break;
      }
    }
    // How likely the person is to take each: more time saved and a free shuttle pull harder.
    const scored = found.map(ride => {
      const saving = walkSeconds - (ride.reach - ride.leave);
      const pull = saving < (badWeather ? 0 : CAMPUS_RIDE_MIN_SAVING_SECONDS) ? 0
        : share * CAMPUS_RIDE_MODE_WEIGHT[routeKind(ride.option.route)] * Math.min(1, Math.max(badWeather ? 0.5 : 0, saving / CAMPUS_RIDE_FULL_SAVING_SECONDS));
      return { ride, pull, saving };
    }).filter(row => row.pull > 0);
    // The most likely first (then the quicker, then a stable order); one draw decides whether they ride at all.
    scored.sort((a, b) => b.pull - a.pull || b.saving - a.saving || a.ride.option.board.localeCompare(b.ride.option.board)
      || a.ride.option.alight.localeCompare(b.ride.option.alight) || a.ride.option.route.localeCompare(b.ride.option.route));
    for (const { ride, pull } of scored) {
      if (request.rideDraw >= pull) return undefined;
      if (request.fits(ride.leave, ride.reach)) return ride;
    }
    return undefined;
  };
  return { options, plan };
}
