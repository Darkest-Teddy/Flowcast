// BU's own shuttle ("the BUS") from BU's TransLoc feed: routes, stops, live vehicles and
// arrival estimates. The feed is open to browsers (CORS *), so the map polls it directly.
// Results are shaped like the MBTA data so the same tracks, snapping and panels handle both.
import { parseObservationTime, ShuttleObservationClock } from './liveFreshness';
import type { Arrival, TransitArea, TransitRoute, TransitStop } from './mbta';

const API = 'https://bu.transloc.com/Services/JSONPRelay.svc';
const observationClock = new ShuttleObservationClock();
export const BU_RED = '#CC0000';

interface TlRouteStop {
  AddressID: number;
  RouteStopID: number;
  Description: string;
  Latitude: number;
  Longitude: number;
}

interface TlRoute {
  RouteID: number;
  Description: string;
  MapLineColor: string;
  EncodedPolyline: string;
  IsRunning: boolean;
  IsVisibleOnMap: boolean;
  Stops: TlRouteStop[];
}

export interface ShuttleVehicleReport {
  observedAt: number | null;
  id: string;
  route: string;
  position: [number, number];
  heading: number;
  speed: number; // metres per second
  label: string;
}

export const shuttleRouteId = (routeId: number) => `BU-${routeId}`;

/**
 * When each BU line runs (local time), for playback when there's no live "running" flag.
 * Days are from bu.edu/thebus (route list). Hours are approximate: BU publishes them only in an
 * interactive schedule tool. The Night line's 7 PM start is from TransLoc's own scheduled stop
 * times; its end and the day lines' hours are estimates (day lines hand over to Night at 7 PM).
 * days: 0 = Sunday ... 6 = Saturday. end may pass midnight (e.g. 26 = 2 AM next day).
 */
export interface ServiceWindow {
  days: number[];
  start: number; // hours
  end: number; // hours, can exceed 24
  source: string;
}
const WEEKDAYS = [1, 2, 3, 4, 5];
export const SHUTTLE_SERVICE: Record<number, ServiceWindow> = {
  1: { days: WEEKDAYS, start: 7, end: 19, source: 'days: bu.edu/thebus; hours estimated' }, // 1 BU (Charles River–Medical)
  2: { days: WEEKDAYS, start: 7, end: 19, source: 'days: bu.edu/thebus; hours estimated' }, // Albany / E Newton
  3: { days: WEEKDAYS, start: 7, end: 19, source: 'days: bu.edu/thebus; hours estimated' }, // Comm Ave
  4: { days: [1, 2, 3, 4, 5, 6], start: 7, end: 19, source: 'days: bu.edu/thebus; hours estimated' }, // Fenway
  6: { days: [0, 1, 2, 3, 4, 5, 6], start: 19, end: 26, source: 'start: TransLoc scheduled times; end estimated' }, // Night
};

/** Is a shuttle route in service at `seconds` since midnight on `weekday` (0 = Sunday)? */
export function shuttleInService(route: TransitRoute, seconds: number, weekday: number): boolean {
  const window = route.service;
  if (!window) return true;
  const hour = seconds / 3600;
  // Today's window, or yesterday's window running past midnight.
  if (window.days.includes(weekday) && hour >= window.start && hour < window.end) return true;
  const yesterday = (weekday + 6) % 7;
  return window.end > 24 && window.days.includes(yesterday) && hour + 24 < window.end;
}

function normaliseHex(value: string | null | undefined): string | null {
  const hex = value?.trim();
  return hex && /^#[0-9a-fA-F]{6}$/.test(hex) ? hex.toUpperCase() : null;
}

/** "/Date(1792857383042)/" or "/Date(1792878931000-0600)/" -> epoch ms. */
function parseTlDate(value: string | null | undefined): number | null {
  const ms = value?.match(/\/Date\((\d+)/)?.[1];
  return ms ? Number(ms) : null;
}

/** Google encoded polyline -> [lng, lat][]. */
export function decodePolyline(encoded: string): [number, number][] {
  const out: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = encoded.charCodeAt(index++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += delta;
      else lng += delta;
    }
    out.push([lng / 1e5, lat / 1e5]);
  }
  return out;
}

function areaFor([lng, lat]: [number, number], areas: TransitArea[]): string {
  const hit = areas.find(({ bbox: [w, s, e, n] }) => lng >= w && lng <= e && lat >= s && lat <= n);
  return hit?.id ?? 'other';
}

export interface ShuttleData {
  routes: TransitRoute[];
  stops: TransitStop[];
  /** TransLoc RouteStopID -> our stop id, for matching arrival estimates. */
  stopForRouteStop: Map<number, string>;
}

/**
 * BU's shuttle lines that are running right now, per TransLoc's own schedule flag: the day
 * routes in the day, Night at night, and Thanksgiving / FitRec Snow Day only when they operate.
 */
export async function loadShuttles(areas: TransitArea[]): Promise<ShuttleData> {
  const res = await fetch(`${API}/GetRoutesForMapWithScheduleWithEncodedLine`);
  if (!res.ok) throw new Error(`BU shuttle routes: ${res.status}`);
  const all: TlRoute[] = await res.json();
  // Every regular line (each one is shown only during its service hours; see shuttleInService).
  // Seasonal lines (Thanksgiving, FitRec Snow Day) appear only while TransLoc says they're running.
  const shown = all.filter((r) => r.IsVisibleOnMap && r.EncodedPolyline && (r.IsRunning || SHUTTLE_SERVICE[r.RouteID]));

  const stops = new Map<string, TransitStop>();
  const stopForRouteStop = new Map<number, string>();
  const routes = shown.map((r): TransitRoute => {
    const id = shuttleRouteId(r.RouteID);
    for (const s of r.Stops ?? []) {
      const stopId = `BU-stop-${s.AddressID}`;
      stopForRouteStop.set(s.RouteStopID, stopId);
      const position: [number, number] = [s.Longitude, s.Latitude];
      const stop = stops.get(stopId) ?? {
        id: stopId,
        name: `BU Shuttle · ${s.Description}`,
        short: s.Description,
        kind: 'shuttle' as const,
        area: areaFor(position, areas),
        position,
        platforms: [],
        routes: [],
      };
      if (!stop.routes.includes(id)) stop.routes.push(id);
      stops.set(stopId, stop);
    }
    return {
      id,
      name: 'BU',
      longName: r.Description.trim(),
      kind: 'shuttle',
      service: SHUTTLE_SERVICE[r.RouteID],
      night: r.RouteID === 6,
      // The line in BU's own map colour (1 BU red, Comm Ave green, Fenway orange...); the
      // buses themselves are always BU red, as in real life.
      color: normaliseHex(r.MapLineColor) ?? BU_RED,
      textColor: '#FFFFFF',
      // One looping route; the loop's point order is its travel order.
      directions: ['Loop', 'Loop'],
      paths: [{ direction: 0, path: decodePolyline(r.EncodedPolyline) }],
    };
  });
  return { routes, stops: [...stops.values()], stopForRouteStop };
}

export async function pollShuttleVehicles(): Promise<ShuttleVehicleReport[]> {
  const res = await fetch(`${API}/GetMapVehiclePoints`);
  if (!res.ok) throw new Error(`BU shuttle vehicles: ${res.status}`);
  const json: { VehicleID: number; RouteID: number; Latitude: number; Longitude: number; Heading: number; GroundSpeed: number; Name: string; TimeStamp: string | null }[] =
    await res.json();
  return json.map((v) => ({
    observedAt: observationClock.observe(`BU-${v.VehicleID}`, parseObservationTime(v.TimeStamp)),
    id: `BU-${v.VehicleID}`,
    route: shuttleRouteId(v.RouteID),
    position: [v.Longitude, v.Latitude],
    heading: v.Heading,
    speed: v.GroundSpeed * 0.44704, // TransLoc reports mph
    label: v.Name,
  }));
}

export async function pollShuttleArrivals(stopForRouteStop: Map<number, string>): Promise<Arrival[]> {
  const res = await fetch(`${API}/GetStopArrivalTimes`);
  if (!res.ok) throw new Error(`BU shuttle arrivals: ${res.status}`);
  const json: { RouteId: number; RouteStopId: number; Times: { EstimateTime: string | null; ScheduledTime: string | null }[] }[] =
    await res.json();
  return json.flatMap((entry) => {
    const stop = stopForRouteStop.get(entry.RouteStopId);
    if (!stop) return [];
    return entry.Times.flatMap((t) => {
      const time = parseTlDate(t.EstimateTime) ?? parseTlDate(t.ScheduledTime);
      return time ? [{ stop, route: shuttleRouteId(entry.RouteId), direction: 0 as const, time }] : [];
    });
  });
}
