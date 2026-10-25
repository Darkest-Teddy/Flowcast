// Outdoor crowds for a building fire (incident kind 'fire' with `outdoorCrowd`): which exit each
// occupant leaves by, which standing area and spot they wait at, and for how long. Pure and
// deterministic; incidents.ts schedules the walks and the onward decisions with the same
// activity-aware rules (relocation, rejoining the schedule outside the damaged building) as the
// direct-dispersal fire.
import { concat, hash01, metresBetween, polyline, type FireGeometry, type LngLat, type Polyline, type StandingArea, type Tree } from './fireEvacuation';
import type { CampusLocation } from './playback';

/** Illustrative, uncalibrated timing and decision assumptions for the outdoor crowd. */
export const FIRE_CROWD_ASSUMPTIONS = {
  /** People stand outside until 10–20 minutes after the alarm (most toward the short end), and at least 2 minutes. */
  lingerMinSeconds: 600, lingerMaxSeconds: 1200, minimumOutsideSeconds: 120,
  /** People walking to the building while the fire is active turn back this far from it. */
  turnBackMetres: 70,
  /** A next activity more than this after arriving sends a resident home first. */
  nextActivityHorizonSeconds: 3600,
  /** Where displaced residents shelter: an open venue of these kinds with modeled room, within this saved walk. */
  shelterKinds: ['dining', 'library', 'gym'] as readonly string[],
  maxShelterWalkMetres: 1600,
  /** Share of people taking the best-placed exit; the rest use the second or third. */
  bestExitShare: 0.6,
} as const;

export const FIRE_CROWD_LIMITATIONS = [
  'Outdoor crowd (fire option): occupants leave by the saved door or another point of the mapped footprint edge with a short, clear step (at most 25 m) to the saved pedestrian network, chosen toward where each person is heading next, with some randomness. These are not surveyed fire exits; the walk from where a person entered to their exit is a straight indoor line. Exit timing keeps the fire reaction (10–45 s), stair descent and 2 persons/second per building.',
  'Standing areas are points on saved pedestrian geometry 30–80 m from the burning footprint, clear of mapped footprints, of modeled carriageways (street centrelines, when loaded) and of the parked fire trucks. People spread along each sidewalk in loose rows about 1.4 m apart, facing the building. Areas are not official assembly areas; their capacity is that spacing, not a measurement.',
  'Everyone stays outside until 10–20 minutes after the alarm (at least 2 minutes after arriving), then moves on by saved walks: an optional meal, study or workout may move to an open venue with room; otherwise they go on to the next stop of their day outside the damaged building (waiting there for a later activity, or going home first when it is more than an hour away), go home, or walk to their usual stop or gateway and take the next published departure within 30 minutes when one exists (vehicle loads are not rechecked).',
  'Residents of the burning building with nothing else planned shelter for the rest of the day at the nearest open dining hall, library or gym with modeled room; when none is open, the nearest one with room is assumed to be opened as an emergency shelter. People walking toward the building while the fire is active turn back 70 m from it and make the same choice; later visits are cancelled as without the crowd.',
] as const;

/** How an evacuee or turned-back arrival moved on. */
export type FireDispersal = 'next-activity' | 'home' | 'transit' | 'relocated' | 'shelter';
export interface FireCrowd {
  /** One outdoor location per standing area: they count as outdoors, never in a building. */
  areas: CampusLocation[];
  /** Each evacuee's own spot, facing and area. */
  spots: Record<string, { position: LngLat; bearing: number; area: string }>;
  /** Footprint edge points used as exits. */
  exits: LngLat[];
}
export interface CrowdPlan {
  area: StandingArea;
  spot: number;
  /** Leaves their place inside (the exit slot, less the walk to the exit). */
  departAt: number;
  /** From where the person is (the end of their last walk, or the exit) to their spot. */
  path: Polyline;
  arriveAt: number;
  leaveAt: number;
  /** From the spot back to the area's network node, which `tree` starts at. */
  lead: Polyline;
  tree: Tree;
}

export function reversePolyline(line: Polyline): Polyline {
  const total = line.cumulative[line.cumulative.length - 1];
  return { path: [...line.path].reverse(), cumulative: [...line.cumulative].reverse().map((d) => total - d) };
}
export function pointAt(line: Polyline, distance: number): LngLat {
  const c = line.cumulative;
  if (distance <= 0) return line.path[0];
  if (distance >= c[c.length - 1]) return line.path[line.path.length - 1];
  let i = 1;
  while (c[i] < distance) i++;
  const f = (distance - c[i - 1]) / (c[i] - c[i - 1] || 1), a = line.path[i - 1], b = line.path[i];
  return f >= 1 ? b : [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}
/** The first `distance` metres of a line. */
export function cutPolyline(line: Polyline, distance: number): Polyline {
  const c = line.cumulative, i = c.findIndex((d) => d >= distance);
  if (i < 0) return line;
  if (i === 0) return { path: [line.path[0]], cumulative: [0] };
  const end = pointAt(line, distance), prev = line.path[i - 1];
  if (Math.abs(prev[0] - end[0]) <= 1e-12 && Math.abs(prev[1] - end[1]) <= 1e-12) return { path: line.path.slice(0, i), cumulative: c.slice(0, i) };
  return { path: [...line.path.slice(0, i), end], cumulative: [...c.slice(0, i), distance] };
}
/** First distance along `line` within `metres` of the burning footprint (the line's length when never). */
export function turnBackDistance(geometry: FireGeometry, line: Polyline, metres: number): number {
  const total = line.cumulative[line.cumulative.length - 1];
  for (let d = 0; d <= total; d += 2) if (geometry.clearance(pointAt(line, d)) <= metres) return d;
  return total;
}

/**
 * Exit, standing area and spot for one occupant, walking from `from` (the end of their last walk,
 * when they arrived by one) toward `heading` (their next walk out). Areas fill as people arrive.
 */
export function planSpot(geometry: FireGeometry, incidentId: string, agentId: string, exitAt: number, speed: number, alarmAt: number,
  options: { heading?: Polyline; from?: LngLat; ready?: number }): CrowdPlan {
  const A = FIRE_CROWD_ASSUMPTIONS;
  const { graph, exits, areas } = geometry;
  let toward: LngLat | undefined;
  if (options.heading) {
    const along = Math.min(100, options.heading.cumulative[options.heading.cumulative.length - 1]);
    toward = pointAt(options.heading, along);
  }
  const ranked = exits.map((exit, e) => ({ e, score: (toward ? metresBetween(exit.edge, toward) : hash01(`${incidentId}:${agentId}:${e}`) * 60) + exit.connector }))
    .sort((a, b) => a.score - b.score || a.e - b.e);
  const near = ranked.filter((r, k) => k < 3 && r.score <= ranked[0].score * 1.6 + 20);
  const draw = hash01(`${incidentId}:${agentId}:exit`);
  const exit = exits[near[draw < A.bestExitShare || near.length === 1 ? 0 : draw < 0.85 || near.length === 2 ? 1 : 2].e];
  // Nearest standing areas with room, chosen with some randomness among those not much further.
  const reachable = areas.filter((area) => Number.isFinite(exit.tree.dist[area.node]));
  const withRoom = reachable.filter((area) => area.used < area.spots.length).map((area) => ({ area, d: exit.tree.dist[area.node] }))
    .sort((a, b) => a.d - b.d || a.area.index - b.area.index);
  let area: StandingArea;
  if (withRoom.length) {
    const close = withRoom.filter((c, k) => k < 3 && c.d <= withRoom[0].d * 1.5 + 30);
    const weights = close.map((c) => 1 / (c.d + 15) ** 2), total = weights.reduce((s, w) => s + w, 0);
    let r = hash01(`${incidentId}:${agentId}:area`) * total, k = 0;
    while (k < close.length - 1 && r > weights[k]) { r -= weights[k]; k++; }
    area = close[k].area;
  } else if (reachable.length) area = reachable.sort((a, b) => a.used / a.spots.length - b.used / b.spots.length || a.index - b.index)[0];
  else throw new Error('No standing area reachable from the building exits');
  // Overfull areas reuse spots (a denser crowd) rather than inventing new ones.
  const spot = area.used++ % area.spots.length;
  const exitNode = graph.points[exit.node];
  // From the end of their last walk (outside the door) through the building to the exit, then out.
  const indoor = options.from ? (exit.door && sameSpot(options.from, exitNode) ? [options.from] : [options.from, exit.edge]) : [exit.edge];
  const path = concat([polyline([...indoor, exitNode]), geometry.pathFrom(exit.tree, area.node), area.spots[spot].approach]);
  // The exit slot is when they pass the exit: the walk to it inside starts that much earlier, once they are ready.
  const indoorSeconds = (indoor.length > 1 ? metresBetween(indoor[0], indoor[1]) : 0) / speed;
  const departAt = Math.max(options.ready ?? exitAt, exitAt - indoorSeconds);
  const arriveAt = departAt + path.cumulative[path.cumulative.length - 1] / speed;
  const linger = A.lingerMinSeconds + (A.lingerMaxSeconds - A.lingerMinSeconds) * hash01(`${incidentId}:${agentId}:linger`) ** 1.6;
  const leaveAt = Math.max(arriveAt + A.minimumOutsideSeconds, alarmAt + linger);
  const approach = area.spots[spot].approach;
  return { area, spot, path, departAt, arriveAt, leaveAt, lead: reversePolyline(approach), tree: area.tree };
}
const sameSpot = (a: readonly number[], b: readonly number[]) => Math.abs(a[0] - b[0]) <= 1e-10 && Math.abs(a[1] - b[1]) <= 1e-10;
