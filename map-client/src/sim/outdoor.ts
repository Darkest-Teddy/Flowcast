// Outdoor free-time destinations by the Charles (public/data/outdoor.json, built by
// data-pipeline/build_outdoor_spots.py): BU Beach, the Esplanade lawns and the river path loop.
// The behaviour engine plans stays there (sim/sourceDay.ts); this module also says where each
// person stands or how far round the loop they are, for the map (layers/outdoor.ts).
import type { WalkRoute } from './playback';

export type OutdoorSpotKind = 'lawn' | 'riverside' | 'loop';
export interface OutdoorConnector extends WalkRoute { location: string }
export interface OutdoorSpot {
  id: string; // "outdoor:bu-beach"
  kind: OutdoorSpotKind;
  name: string;
  campus: string;
  position: [number, number];
  /** Where the connectors arrive. */
  entry: [number, number];
  polygon?: [number, number][];
  areaSquareMetres?: number;
  /** Loops start and end at `entry`. */
  loop?: WalkRoute;
  source: string;
  note: string;
  connectors: OutdoorConnector[];
}
export interface OutdoorFile { schemaVersion: 1; attribution: string; crossings?: string; spots: OutdoorSpot[] }

export const isOutdoor = (location: string) => location.startsWith('outdoor:');

/** Same hash as the day builder. */
function unit(key: string): number {
  let value = 2166136261;
  for (let index = 0; index < key.length; index++) value = Math.imul(value ^ key.charCodeAt(index), 16777619);
  value ^= value >>> 16; value = Math.imul(value, 0x85ebca6b);
  value ^= value >>> 13; value = Math.imul(value, 0xc2b2ae35);
  value ^= value >>> 16;
  return (value >>> 0) / 4294967296;
}

function inside(point: [number, number], polygon: [number, number][]): boolean {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if ((yi > point[1]) !== (yj > point[1]) && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) hit = true;
  }
  return hit;
}

/** A stable spot on the grass for one person (rejection-sampled inside the lawn). */
export function sittingSpot(spot: OutdoorSpot, person: string): [number, number] {
  const polygon = spot.polygon;
  if (!polygon?.length) return spot.position;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of polygon) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  for (let attempt = 0; attempt < 24; attempt++) {
    const point: [number, number] = [minX + unit(`${person}:${spot.id}:x:${attempt}`) * (maxX - minX), minY + unit(`${person}:${spot.id}:y:${attempt}`) * (maxY - minY)];
    if (inside(point, polygon)) return point;
  }
  return spot.position;
}

/** Point and bearing a given distance along a route (wrapping round a loop). */
export function alongRoute(route: WalkRoute, metres: number): { position: [number, number]; bearing: number } {
  const total = route.cumulative.at(-1) ?? 0;
  const d = total > 0 ? ((metres % total) + total) % total : 0;
  let lo = 1;
  while (lo < route.cumulative.length - 1 && route.cumulative[lo] < d) lo++;
  const a = route.path[lo - 1], b = route.path[lo] ?? a;
  const span = route.cumulative[lo] - route.cumulative[lo - 1];
  const f = span > 0 ? (d - route.cumulative[lo - 1]) / span : 0;
  const bearing = (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;
  return { position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], bearing };
}

/** Runners or walkers on the loop: a stable pace per person (m/s) and a stable starting offset. */
export function loopPace(person: string): { speed: number; running: boolean } {
  const running = unit(`${person}:loop-runner`) < 0.6;
  return { running, speed: running ? 2.6 + unit(`${person}:loop-pace`) * 0.8 : 1.2 + unit(`${person}:loop-pace`) * 0.3 };
}

export async function loadOutdoor(url = '/data/outdoor.json'): Promise<OutdoorFile | undefined> {
  try {
    const response = await fetch(url);
    if (!response.ok) return undefined;
    const data = await response.json() as OutdoorFile;
    return data.schemaVersion === 1 && Array.isArray(data.spots) ? data : undefined;
  } catch { return undefined; }
}
