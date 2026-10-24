// BU's own shuttle ("the BUS") from BU's TransLoc feed: routes, stops, live vehicles and
// arrival estimates. The feed is open to browsers (CORS *), so the map polls it directly.
// Results are shaped like the MBTA data so the same tracks, snapping and panels handle both.
import type { Arrival, TransitArea, TransitRoute, TransitStop } from './mbta';

const API = 'https://bu.transloc.com/Services/JSONPRelay.svc';
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
  id: string;
  route: string;
  position: [number, number];
  heading: number;
  speed: number; // metres per second
  label: string;
}

export const shuttleRouteId = (routeId: number) => `BU-${routeId}`;

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
  const shown = all.filter((r) => r.IsVisibleOnMap && r.IsRunning && r.EncodedPolyline);

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
  const json: { VehicleID: number; RouteID: number; Latitude: number; Longitude: number; Heading: number; GroundSpeed: number; Name: string }[] =
    await res.json();
  return json.map((v) => ({
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
