// People spending free time by the Charles (sim/outdoor.ts): sitting on BU Beach and the
// Esplanade lawns (Kenney 'idle' clip, at stable per-person spots; drawn, unpickable, in the waiting
// riders' idle layers) and walking or running the river path (they join the walkers' existing
// layers). Neither adds layers of their own.
// Only people near the camera are drawn, at most OUTDOOR_DRAW_CAP.
import type { DayData, Stay, WalkingAgent } from '../sim/playback';
import { alongRoute, isOutdoor, loopPace, sittingSpot, type OutdoorFile, type OutdoorSpot } from '../sim/outdoor';

export const OUTDOOR_DRAW_CAP = 300;
const BUCKET = 300;
const STROLL = 1.3; // m/s, walking from the path to a spot on the grass

interface OutdoorStay { id: string; agent: string; model: number; spot: OutdoorSpot; start: number; end: number; sit?: [number, number]; walk?: number }
export interface OutdoorIndex { buckets: Map<number, OutdoorStay[]>; count: number }

const metres = (a: [number, number], b: [number, number]) => Math.hypot((b[0] - a[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), (b[1] - a[1]) * 110540);
const bearing = (a: [number, number], b: [number, number]) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;

/** Built once per day from its outdoor stays: bucketed by five minutes. */
export function outdoorIndex(stays: readonly Stay[] | undefined, agents: DayData['agents'], outdoor: OutdoorFile | null | undefined): OutdoorIndex | null {
  if (!outdoor || !stays?.length) return null;
  const spots = new Map(outdoor.spots.map(spot => [spot.id, spot]));
  const models = new Map(agents.map(agent => [agent.id, agent.model]));
  const buckets = new Map<number, OutdoorStay[]>();
  let count = 0;
  for (const stay of stays) {
    if (!isOutdoor(stay.location)) continue;
    const spot = spots.get(stay.location);
    if (!spot) continue;
    const row: OutdoorStay = { id: `${stay.agent}@${stay.start}`, agent: stay.agent, model: models.get(stay.agent) ?? 0, spot, start: stay.start, end: stay.end };
    count++;
    for (let bucket = Math.floor(stay.start / BUCKET); bucket < Math.ceil(stay.end / BUCKET); bucket++) {
      const list = buckets.get(bucket) ?? []; list.push(row); buckets.set(bucket, list);
    }
  }
  return count ? { buckets, count } : null;
}

/** Everyone by the river at time t (for the head count; not limited to the camera). */
export function outdoorCount(index: OutdoorIndex | null, t: number): number {
  let n = 0;
  for (const row of index?.buckets.get(Math.floor(t / BUCKET)) ?? []) if (row.start <= t && t < row.end) n++;
  return n;
}

function place(row: OutdoorStay, t: number): { agent: WalkingAgent; sitting: boolean } {
  const base = { id: row.id, model: row.model, to: row.spot.id };
  if (row.spot.loop) {
    const length = row.spot.loop.cumulative.at(-1) ?? 0;
    const duration = row.end - row.start;
    const pace = loopPace(row.agent).speed;
    // Whole laps, so each person is back at the path entrance when their stay ends.
    const laps = length > 0 ? Math.max(1, Math.round(pace * duration / length)) : 0;
    const { position, bearing: heading } = alongRoute(row.spot.loop, laps * length * (t - row.start) / Math.max(1, duration));
    return { agent: { ...base, position: [position[0], position[1], 0], bearing: heading }, sitting: false };
  }
  row.sit ??= sittingSpot(row.spot, row.agent);
  row.walk ??= Math.min((row.end - row.start) / 3, metres(row.spot.entry, row.sit) / STROLL);
  const into = (t - row.start) / Math.max(1, row.walk), out = (row.end - t) / Math.max(1, row.walk);
  if (into < 1 || out < 1) {
    // Strolling from the path to their spot on arrival, and back to the path before leaving.
    const [a, b, f] = into < 1 ? [row.spot.entry, row.sit, into] : [row.sit, row.spot.entry, 1 - out];
    return { agent: { ...base, position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, 0], bearing: bearing(a, b) }, sitting: false };
  }
  // Facing the river (roughly north here), give or take.
  const facing = (330 + ((row.agent.charCodeAt(row.agent.length - 1) * 37) % 60)) % 360;
  return { agent: { ...base, position: [row.sit[0], row.sit[1], 0], bearing: facing }, sitting: true };
}

/** People to draw near the camera: sitters (idle) and people moving (walk clip, merged with walkers). */
export function outdoorPeople(index: OutdoorIndex | null, t: number, center: [number, number], radius: number | null): { sitting: WalkingAgent[]; moving: WalkingAgent[] } {
  const sitting: WalkingAgent[] = [], moving: WalkingAgent[] = [];
  if (!index) return { sitting, moving };
  const limit = radius ?? 2500;
  for (const row of index.buckets.get(Math.floor(t / BUCKET)) ?? []) {
    if (row.start > t || t >= row.end) continue;
    if (metres(center, row.spot.position) > limit + 2000) continue;
    const { agent, sitting: still } = place(row, t);
    if (radius !== null && metres(center, [agent.position[0], agent.position[1]]) > radius) continue;
    (still ? sitting : moving).push(agent);
    if (sitting.length + moving.length >= OUTDOOR_DRAW_CAP) break;
  }
  return { sitting, moving };
}
