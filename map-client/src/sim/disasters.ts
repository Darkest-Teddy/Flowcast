// Disaster scenario parameters and hazard-zone selection for applyIncident. Pure helpers; the
// recovery itself (exits, waiting, relocation, arrivals, transit) is shared with closures in incidents.ts.
import type { CampusLocation, DayData } from './playback';

export type DisasterKind = 'fire' | 'earthquake' | 'meteor';
export const isDisasterKind = (kind: string): kind is DisasterKind => kind === 'fire' || kind === 'earthquake' || kind === 'meteor';

/** Illustrative, uncalibrated scenario parameters. No fire spread, ground motion or impact physics are modeled; casualties are illustrative (casualties.ts). */
export const DISASTER_ASSUMPTIONS = {
  maxRadiusMetres: 500,
  fire: { defaultRadiusMetres: 0, responseDelaySeconds: 0, reactionMinSeconds: 10, reactionMaxSeconds: 45, minDurationSeconds: 1800 },
  earthquake: { defaultRadiusMetres: 250, responseDelaySeconds: 60, reactionMinSeconds: 15, reactionMaxSeconds: 90, minDurationSeconds: 900 },
  meteor: { defaultRadiusMetres: 100, responseDelaySeconds: 0, reactionMinSeconds: 5, reactionMaxSeconds: 30, minDurationSeconds: 1800 },
} as const;

export const DISASTER_LIMITATIONS = [
  'Fire, earthquake and meteor scenarios are uncalibrated what-if projections of movement and building closure. The shown damage is a fixed illustration, not a structural assessment; fire spread, smoke, ground motion and impact physics are not modeled. Injuries and casualties are uncalibrated illustrations from modeled exposure (see CASUALTY_LIMITATIONS), not a prediction.',
  'Fire affects only the selected building and reacts faster (10–45 seconds) than a drill, with an active fire of at least 30 minutes. Earthquake occupants shelter in place for 60 seconds before a 15–90 second reaction, then leave every building within the radius (default 250 m, at least 15 minutes of shaking response). Meteor occupants react in 5–30 seconds and leave every building within the impact radius (default 100 m, at least 30 minutes of impact response).',
  'The hazard zone is the selected location’s building plus every building whose saved footprint, or any of its locations, lies within the radius of the selected location, plus on-campus outdoor locations within the radius. The requested duration only sets how long the active fire, shaking or impact is shown. Every affected building and outdoor location stays closed until midnight; nothing reopens the same simulated day. Resetting the scenario or changing the day restores it.',
  'Nobody re-enters the zone that day. Classes and other visits there are cancelled and never moved; optional dining, library and gym visits may move to an open venue outside the zone. People rejoin their schedule at its next stop outside the zone by a saved walk (their own saved return, a saved route, or a saved gateway walk); without one they stay at their last place outside the zone until midnight. Residents of affected buildings are not rehoused.',
  'Each building (or outdoor location) has its own exit flow (2 persons/second). Waiting places and relocation venues are outside the zone and reached by saved walks that never stop at a zone location, but saved path geometry can still cross the zone, and someone already walking between two zone buildings retraces to the origin entrance before leaving; through-traffic is not rerouted. Missed transit rides are removed, not replaced.',
] as const;

const metres = (a: [number, number], b: [number, number]) => {
  const ky = 111320, kx = ky * Math.cos(a[1] * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky);
};
function inside(point: [number, number], polygon: [number, number][]): boolean {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j], b = polygon[i];
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
/** Metric distance from a point to a footprint ring: 0 inside, else the nearest edge. */
export function footprintDistance(point: [number, number], polygon: [number, number][]): number {
  if (polygon.length >= 3 && inside(point, polygon)) return 0;
  const ky = 111320, kx = ky * Math.cos(point[1] * Math.PI / 180);
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const ax = (polygon[j][0] - point[0]) * kx, ay = (polygon[j][1] - point[1]) * ky;
    const bx = (polygon[i][0] - point[0]) * kx, by = (polygon[i][1] - point[1]) * ky;
    const dx = bx - ax, dy = by - ay, length2 = dx * dx + dy * dy;
    const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

/** Locations and buildings excluded by a hazard centred on the target location. Sorted, deterministic. */
export function hazardZone(day: DayData, target: CampusLocation, radiusMetres: number): { locationIds: string[]; buildingIds: string[] } {
  const buildings = new Set<string>();
  if (target.building) buildings.add(target.building);
  if (radiusMetres > 0) {
    for (const building of day.buildings)
      if (building.id && building.polygon.length && footprintDistance(target.position, building.polygon) <= radiusMetres) buildings.add(building.id);
    for (const location of day.locations)
      if (location.building && location.kind !== 'off-campus' && metres(target.position, location.position) <= radiusMetres) buildings.add(location.building);
  }
  const locations = day.locations.filter(location => location.id !== 'off-campus' && location.kind !== 'off-campus' && (location.id === target.id
    || location.building && buildings.has(location.building)
    || !location.building && radiusMetres > 0 && metres(target.position, location.position) <= radiusMetres)).map(location => location.id);
  const sort = (values: Iterable<string>) => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  return { locationIds: sort(locations), buildingIds: sort(buildings) };
}
