// A simulated day packed into typed arrays, so the day worker (sim/dayWorker.ts) can hand it to
// the map thread by transfer (no structured-clone copy of 100k trip objects), and the map thread
// can unpack it in small resumable steps (decodeDaySteps) between frames.
import type { CampusLocation, DayData, Stay, StayPurpose, TransitRide, Trip } from './playback';
import type { GatheringOutcome } from './gatherings';

export interface EncodedDay {
  key: string;
  dayName: string;
  /** Location index table for trips and stays (includes 'off-campus' and outdoor spots). */
  locationIds: string[];
  /** Per base location: the day's activityModeled flag when the builder changed it, else null. */
  activityModeled: (boolean | null)[];
  /** Places the day adds beyond the roster's (river spots of a conditioned day). */
  extraLocations: CampusLocation[];
  agentCount: number;
  firstAgent: string;
  lastAgent: string;
  routes: { coords: Float64Array; cumulative: Float64Array; offsets: Int32Array };
  trips: { agent: Int32Array; from: Int16Array; to: Int16Array; route: Int32Array; depart: Float64Array; speed: Float64Array };
  stays: { agent: Int32Array; location: Int16Array; start: Float64Array; end: Float64Array; purpose: Int32Array };
  /** Distinct stay purposes (JSON), indexed by stays.purpose (-1 = none). */
  purposes: string[];
  /** Published transit trips students ride, campus events and their date: small, sent as-is. */
  transitRides: TransitRide[];
  gatherings: GatheringOutcome[];
  eventDate: string | null;
}

/** What the map thread needs besides trips and stays (a SourceDay carries more for the panels). */
export interface DecodedDay extends DayData { gatherings: GatheringOutcome[]; eventDate: string | null }

export function encodeDay(day: DayData & { gatherings?: GatheringOutcome[]; eventDate?: string | null }, base: DayData, key: string): EncodedDay {
  const agentIndex = new Map(base.agents.map((agent, index) => [agent.id, index]));
  const locationIds: string[] = [], locationIndex = new Map<string, number>();
  const loc = (id: string) => {
    let index = locationIndex.get(id);
    if (index === undefined) { index = locationIds.length; locationIds.push(id); locationIndex.set(id, index); }
    return index;
  };
  const routeIndex = new Map<[number, number][], number>(), routeList: { path: [number, number][]; cumulative: number[] }[] = [];
  const n = day.trips.length;
  const trips = { agent: new Int32Array(n), from: new Int16Array(n), to: new Int16Array(n), route: new Int32Array(n), depart: new Float64Array(n), speed: new Float64Array(n) };
  day.trips.forEach((trip, i) => {
    let route = routeIndex.get(trip.path);
    if (route === undefined) {
      // The route's progress profile in its first walker's seconds; every walker on a shared path
      // moves at a constant speed, so the others are the same profile scaled by their duration.
      route = routeList.length; routeIndex.set(trip.path, route);
      routeList.push({ path: trip.path, cumulative: trip.timestamps.map(time => time - trip.timestamps[0]) });
    }
    const cumulative = routeList[route].cumulative;
    const duration = trip.timestamps.at(-1)! - trip.timestamps[0];
    trips.agent[i] = agentIndex.get(trip.agent) ?? -1;
    trips.from[i] = loc(trip.from); trips.to[i] = loc(trip.to); trips.route[i] = route;
    trips.depart[i] = trip.timestamps[0];
    trips.speed[i] = duration > 0 && cumulative.at(-1)! > 0 ? cumulative.at(-1)! / duration : 1;
  });
  const points = routeList.reduce((sum, route) => sum + route.path.length, 0);
  const routes = { coords: new Float64Array(points * 2), cumulative: new Float64Array(points), offsets: new Int32Array(routeList.length + 1) };
  let offset = 0;
  routeList.forEach((route, r) => {
    routes.offsets[r] = offset;
    route.path.forEach((point, k) => { routes.coords[(offset + k) * 2] = point[0]; routes.coords[(offset + k) * 2 + 1] = point[1]; routes.cumulative[offset + k] = route.cumulative[k]; });
    offset += route.path.length;
  });
  routes.offsets[routeList.length] = offset;
  const stayRows = day.stays ?? [];
  const stays = { agent: new Int32Array(stayRows.length), location: new Int16Array(stayRows.length), start: new Float64Array(stayRows.length),
    end: new Float64Array(stayRows.length), purpose: new Int32Array(stayRows.length) };
  // Purposes are shared objects (one per class meeting, one per kind), so a small table covers them all.
  const purposes: string[] = [], purposeIndex = new Map<StayPurpose, number>(), byText = new Map<string, number>();
  const purposeOf = (purpose: StayPurpose | undefined) => {
    if (!purpose) return -1;
    let index = purposeIndex.get(purpose);
    if (index === undefined) {
      const text = JSON.stringify(purpose);
      index = byText.get(text);
      if (index === undefined) { index = purposes.length; purposes.push(text); byText.set(text, index); }
      purposeIndex.set(purpose, index);
    }
    return index;
  };
  stayRows.forEach((stay, i) => { stays.agent[i] = agentIndex.get(stay.agent) ?? -1; stays.location[i] = loc(stay.location); stays.start[i] = stay.start;
    stays.end[i] = stay.end; stays.purpose[i] = purposeOf(stay.purpose); });
  if (locationIds.length > 32767) throw new Error('Too many locations to encode');
  const baseLocations = new Map(base.locations.map(location => [location.id, location]));
  return {
    key, dayName: day.day, locationIds,
    activityModeled: base.locations.map(location => {
      const own = day.locations.find(row => row.id === location.id);
      return !own || own === location ? null : own.activityModeled ?? null;
    }),
    extraLocations: day.locations.filter(location => !baseLocations.has(location.id)),
    agentCount: base.agents.length, firstAgent: base.agents[0]?.id ?? '', lastAgent: base.agents.at(-1)?.id ?? '',
    routes, trips, stays, purposes, transitRides: day.transitRides ?? [], gatherings: day.gatherings ?? [], eventDate: day.eventDate ?? null,
  };
}

/** Buffers to transfer with postMessage. */
export function transferables(encoded: EncodedDay): ArrayBuffer[] {
  const arrays = [encoded.routes.coords, encoded.routes.cumulative, encoded.routes.offsets, ...Object.values(encoded.trips), ...Object.values(encoded.stays)];
  return arrays.map(array => array.buffer as ArrayBuffer);
}

/** Rebuild the day on top of the map thread's own roster, yielding every `chunk` items. */
export function* decodeDaySteps(encoded: EncodedDay, base: DayData, chunk = 4096): Generator<void, DecodedDay> {
  if (encoded.agentCount !== base.agents.length || encoded.firstAgent !== (base.agents[0]?.id ?? '') || encoded.lastAgent !== (base.agents.at(-1)?.id ?? '')) {
    throw new Error('The day worker simulated a different roster');
  }
  const { routes } = encoded;
  const paths: [number, number][][] = [];
  for (let r = 0; r + 1 < routes.offsets.length; r++) {
    const path: [number, number][] = [];
    for (let k = routes.offsets[r]; k < routes.offsets[r + 1]; k++) path.push([routes.coords[k * 2], routes.coords[k * 2 + 1]]);
    paths.push(path);
    if (r % 512 === 511) yield;
  }
  const ids = base.agents.map(agent => agent.id);
  const trips: Trip[] = new Array(encoded.trips.agent.length);
  for (let i = 0; i < trips.length; i++) {
    const route = encoded.trips.route[i], start = routes.offsets[route], end = routes.offsets[route + 1];
    const depart = encoded.trips.depart[i], speed = encoded.trips.speed[i];
    const timestamps = new Array<number>(end - start);
    for (let k = start; k < end; k++) timestamps[k - start] = depart + routes.cumulative[k] / speed;
    trips[i] = { agent: ids[encoded.trips.agent[i]], from: encoded.locationIds[encoded.trips.from[i]], to: encoded.locationIds[encoded.trips.to[i]], path: paths[route], timestamps };
    if (i % chunk === chunk - 1) yield;
  }
  const purposes = encoded.purposes.map(text => Object.freeze(JSON.parse(text)) as StayPurpose);
  const stays: Stay[] = new Array(encoded.stays.agent.length);
  for (let i = 0; i < stays.length; i++) {
    const purpose = encoded.stays.purpose[i];
    stays[i] = { agent: ids[encoded.stays.agent[i]], location: encoded.locationIds[encoded.stays.location[i]], start: encoded.stays.start[i], end: encoded.stays.end[i],
      ...(purpose >= 0 ? { purpose: purposes[purpose] } : {}) };
    if (i % chunk === chunk - 1) yield;
  }
  const locations = [...base.locations.map((location, index) => {
    const flag = encoded.activityModeled[index];
    return flag === null || flag === undefined ? location : { ...location, activityModeled: flag };
  }), ...encoded.extraLocations];
  return { ...base, locations, day: encoded.dayName, trips, stays, transitRides: encoded.transitRides, gatherings: encoded.gatherings, eventDate: encoded.eventDate };
}
