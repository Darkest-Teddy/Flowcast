// Illustrative fire-truck response for a modeled building fire. Pure and deterministic: the plan is
// built once per fire from saved bus/shuttle corridors (transit.json route paths) and building
// footprints, and fireResponseAt(plan, time) derives every truck's pose from time alone, so any
// time can be seeked to and replayed without carried state.
//
// The trucks are model units that enter the map along a saved corridor. They are not dispatched
// from a real fire station, and nothing here models suppression: existing damage and casualties
// are unchanged, and the water stream is a visual cue only.

import type { TransitRoute } from '../transit/mbta';
import type { BuildingFootprint } from './playback';

export type FireTruckPhase = 'responding' | 'staging' | 'fighting' | 'leaving';

export interface FireTruckFrame {
  /** Stable per truck: 'engine-1', 'engine-2'. */
  id: string;
  /** [lng, lat] ground point at the truck's centre (wheelbase midpoint). */
  position: [number, number];
  /** Compass degrees clockwise from north; the direction the cab faces. */
  bearing: number;
  phase: FireTruckPhase;
  /** [lng, lat, metres above ground] on the target facade. Present only while phase === 'fighting'. */
  waterTarget?: [number, number, number];
  /** Metres per second along the corridor at this time (0 while parked). */
  speed: number;
}

export interface FireTruckPlan {
  id: string;
  /** Saved corridor this truck drives: transit route id and path direction. */
  routeId: string;
  direction: 0 | 1;
  /** Drive line ([lng, lat], travel order) from the corridor entry to its exit, offset to the right-hand lane. */
  path: [number, number][];
  /** Cumulative metres along `path`, same length as `path`. */
  cumulative: number[];
  /** Metres along `path` where the truck parks. */
  stageAt: number;
  /** Sim seconds. departAt ≤ arriveAt ≤ fightStart ≤ fightEnd ≤ leaveAt ≤ exitAt. */
  departAt: number;
  arriveAt: number;
  fightStart: number;
  fightEnd: number;
  leaveAt: number;
  exitAt: number;
  /** Nearest target-facade point to the parked truck, and the hose length to it in metres. */
  waterTarget: [number, number, number];
  hoseMetres: number;
}

export interface FireResponse {
  incidentStart: number;
  activeUntil: number;
  routeId: string;
  routeName: string;
  direction: 0 | 1;
  trucks: FireTruckPlan[];
}

export type FireResponseRun = {
  incident: { kind: string; start: number };
  location: { position: [number, number]; building?: string };
  hazard?: { activeUntil: number } | null;
};

export const FIRE_RESPONSE_ASSUMPTIONS = {
  /** Seconds from ignition until the first truck enters the corridor. */
  dispatchDelaySeconds: 60,
  /** Seconds between successive trucks entering, and between successive trucks leaving. */
  staggerSeconds: 20,
  /** Metres of saved corridor driven before staging (shorter when the path starts nearer). */
  approachMetres: 600,
  /** Metres of saved corridor driven after leaving (shorter when the path ends nearer). */
  departMetres: 600,
  /** Illustrative urban driving speed, m/s (~18 mph). */
  cruiseSpeed: 8,
  /** m/s² braking into the staging point. */
  deceleration: 1.5,
  /** m/s² pulling away. */
  acceleration: 1,
  /** Seconds parked before water flows. */
  setupSeconds: 90,
  /** Seconds parked after the active fire ends, stowing hose, before leaving. */
  stowSeconds: 45,
  /** Longest hose line from the truck to the facade, metres. */
  maxHoseMetres: 80,
  /** Minimum and maximum spacing between the two parked trucks along the corridor, metres. */
  minSpacingMetres: 20,
  maxSpacingMetres: 120,
  /** Truck body kept clear of every building footprint: half length along the corridor and full width, metres. */
  truckHalfLengthMetres: 6,
  truckWidthMetres: 2.6,
  /** Right-hand lane offset from a saved bus/shuttle centreline (matches the bus lane offset). */
  laneOffsetMetres: 2.5,
  /** Water stream height on the facade: this share of the building height, clamped to [min, max] metres. */
  waterHeightShare: 0.6,
  minWaterHeight: 4,
  maxWaterHeight: 25,
  trucks: 2,
} as const;

export const FIRE_RESPONSE_LIMITATIONS = [
  'Fire trucks are illustrative model units. They enter along a saved MBTA bus or BU shuttle corridor near the fire; no real fire station, dispatch record, response time or apparatus type is used or implied.',
  'Trucks follow saved bus/shuttle route geometry only, in that route’s travel direction. Other streets, traffic, signals, pedestrians and access lanes are not modeled, and parking positions are the nearest corridor points within hose reach, not real hydrant or apparatus positions.',
  'Water spray is a visual cue only. It does not shorten the fire, change building damage, or alter any injury, fatality, evacuation or rescue outcome.',
  'Timing uses fixed assumptions (dispatch delay, stagger, speed, setup and stow times). When no saved corridor passes within hose reach of the building, or every reachable spot’s straight hose line would cross another building, no trucks are shown and the rest of the scenario runs unchanged.',
];

/** Why no trucks are shown: not a fire; no valid active-fire window; no saved bus/shuttle path;
 * no clear parking spot within hose reach; or every in-reach spot's hose line crosses another building. */
export type FireResponseUnavailable = 'not-fire' | 'no-active-fire' | 'no-corridor' | 'out-of-reach' | 'obstructed';

const A = FIRE_RESPONSE_ASSUMPTIONS;
const SAMPLE_METRES = 2;
const EDGE_MARGIN = 15; // keep staging off the very ends of a path so there is room to arrive and leave

type XY = [number, number];
interface Frame { lng0: number; lat0: number; kx: number; ky: number }
const makeFrame = ([lng0, lat0]: XY): Frame => { const ky = 111320; return { lng0, lat0, ky, kx: ky * Math.cos(lat0 * Math.PI / 180) }; };
const toXY = (f: Frame, [lng, lat]: XY): XY => [(lng - f.lng0) * f.kx, (lat - f.lat0) * f.ky];
const toLngLat = (f: Frame, [x, y]: XY): XY => [round(f.lng0 + x / f.kx, 1e7), round(f.lat0 + y / f.ky, 1e7)];
const round = (v: number, k: number) => Math.round(v * k) / k;

function insidePolygon([x, y]: XY, ring: XY[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

function nearestOnRing(p: XY, ring: XY[]): { point: XY; distance: number } {
  let best = { point: ring[0], distance: Infinity };
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j], [bx, by] = ring[i];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / l2));
    const q: XY = [ax + t * dx, ay + t * dy], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < best.distance) best = { point: q, distance: d };
  }
  return best;
}

/** Offset a polyline `offset` metres to the right of travel, with mitred joins clamped at 2× the offset. */
function offsetRight(path: XY[], offset: number): XY[] {
  if (offset === 0 || path.length < 2) return path.slice();
  const normals: XY[] = [];
  for (let i = 0; i + 1 < path.length; i++) {
    const dx = path[i + 1][0] - path[i][0], dy = path[i + 1][1] - path[i][1], l = Math.hypot(dx, dy) || 1;
    normals.push([dy / l, -dx / l]);
  }
  return path.map((p, i) => {
    const a = normals[Math.max(0, i - 1)], b = normals[Math.min(normals.length - 1, i)];
    let nx = a[0] + b[0], ny = a[1] + b[1];
    const l = Math.hypot(nx, ny);
    if (l < 1e-9) { nx = b[0]; ny = b[1]; } else { nx /= l; ny /= l; }
    const cos = nx * b[0] + ny * b[1];
    const scale = Math.min(2, 1 / Math.max(cos, 1e-6)) * offset;
    return [p[0] + nx * scale, p[1] + ny * scale];
  });
}

function cumulativeOf(path: XY[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) out.push(out[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  return out;
}

function pointAt(path: XY[], cumulative: number[], s: number): XY {
  const total = cumulative[cumulative.length - 1];
  const d = Math.max(0, Math.min(total, s));
  let lo = 0, hi = cumulative.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cumulative[mid] <= d) lo = mid; else hi = mid; }
  const span = cumulative[hi] - cumulative[lo];
  const t = span > 0 ? (d - cumulative[lo]) / span : 0;
  return [path[lo][0] + (path[hi][0] - path[lo][0]) * t, path[lo][1] + (path[hi][1] - path[lo][1]) * t];
}

/** Trim a polyline to [from, to] metres, returning the sub-path and its cumulative metres from 0. */
function slice(path: XY[], cumulative: number[], from: number, to: number): { path: XY[]; cumulative: number[] } {
  const out: XY[] = [pointAt(path, cumulative, from)];
  for (let i = 0; i < path.length; i++) if (cumulative[i] > from + 1e-6 && cumulative[i] < to - 1e-6) out.push(path[i]);
  out.push(pointAt(path, cumulative, to));
  return { path: out, cumulative: cumulativeOf(out) };
}

interface Candidate { s: number; point: XY; facade: XY; hose: number; score: number }
interface Corridor { routeId: string; routeName: string; direction: 0 | 1; order: number; path: XY[]; cumulative: number[]; candidates: Candidate[] }

/** Build the response once per fire. Returns null when the fire has no reachable saved corridor. */
export function buildFireResponse(run: FireResponseRun, transit: { routes: readonly TransitRoute[] }, footprints: readonly BuildingFootprint[]): FireResponse | null {
  return planFireResponse(run, transit, footprints).plan;
}

/** buildFireResponse plus the reason when no plan is possible. */
export function planFireResponse(run: FireResponseRun, transit: { routes: readonly TransitRoute[] }, footprints: readonly BuildingFootprint[]):
  { plan: FireResponse; reason: null } | { plan: null; reason: FireResponseUnavailable } {
  if (run?.incident?.kind !== 'fire') return { plan: null, reason: 'not-fire' };
  const start = run.incident.start, activeUntil = run.hazard?.activeUntil;
  if (!Number.isFinite(start) || !Number.isFinite(activeUntil) || !(activeUntil! > start)) return { plan: null, reason: 'no-active-fire' };
  const frame = makeFrame(run.location.position);
  const building = run.location.building || '';
  const rings = footprints.filter(f => f.id && f.polygon?.length >= 3).map(f => ({ id: f.id, height: f.height, ring: f.polygon.map(p => toXY(frame, p)) }));
  const target = building ? rings.filter(r => r.id === building) : [];
  const others = rings.filter(r => r.id !== building);
  const targetHeight = Math.max(0, ...target.map(r => r.height || 0));
  const waterHeight = round(Math.min(A.maxWaterHeight, Math.max(A.minWaterHeight, targetHeight * A.waterHeightShare)), 100);
  const centre: XY = [0, 0];
  const facadeFrom = (p: XY): { point: XY; distance: number } => {
    if (!target.length) return { point: centre, distance: Math.hypot(p[0], p[1]) };
    return target.map(r => nearestOnRing(p, r.ring)).reduce((a, b) => b.distance < a.distance ? b : a);
  };
  const near = (p: XY, ring: XY[], pad: number) => ring.some(q => Math.abs(q[0] - p[0]) < pad && Math.abs(q[1] - p[1]) < pad);
  const blocked = (p: XY) => rings.some(r => insidePolygon(p, r.ring));
  const crossesOther = (a: XY, b: XY) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]), steps = Math.max(1, Math.ceil(length / 1));
    for (let i = 1; i < steps; i++) {
      const t = i / steps, p: XY = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (others.some(r => near(p, r.ring, 400) && insidePolygon(p, r.ring))) return true;
    }
    return false;
  };

  const corridors: Corridor[] = [];
  let order = 0, reachableSpots = 0;
  for (const route of transit?.routes ?? []) {
    if (route.kind !== 'bus' && route.kind !== 'shuttle') continue;
    for (const raw of route.paths ?? []) {
      const index = order++;
      if (!raw?.path || raw.path.length < 2) continue;
      const centreline = raw.path.map(p => toXY(frame, p));
      const path = offsetRight(centreline, raw.isTrack ? 0 : A.laneOffsetMetres);
      const cumulative = cumulativeOf(path);
      const total = cumulative[cumulative.length - 1];
      if (!(total > 2 * EDGE_MARGIN)) continue;
      const tunnels = (raw.underground ?? []).map(([a, b]) => [cumulative[Math.max(0, a)] ?? 0, cumulative[Math.min(cumulative.length - 1, b)] ?? total]);
      const candidates: Candidate[] = [];
      for (let s = EDGE_MARGIN; s <= total - EDGE_MARGIN; s += SAMPLE_METRES) {
        if (tunnels.some(([a, b]) => s >= a - A.truckHalfLengthMetres && s <= b + A.truckHalfLengthMetres)) continue;
        const point = pointAt(path, cumulative, s);
        // Cheap reject before footprint tests: the hose cannot reach from beyond this.
        if (Math.hypot(point[0], point[1]) > A.maxHoseMetres + 500) continue;
        const facade = facadeFrom(point);
        if (facade.distance > A.maxHoseMetres) continue;
        // Truck body: centre, front and rear axle points, and the four corners of a 12 × 2.6 m box.
        const back = pointAt(path, cumulative, s - A.truckHalfLengthMetres), front = pointAt(path, cumulative, s + A.truckHalfLengthMetres);
        const fx = front[0] - back[0], fy = front[1] - back[1], fl = Math.hypot(fx, fy) || 1;
        const hw = A.truckWidthMetres / 2, nx = fy / fl * hw, ny = -fx / fl * hw;
        const body: XY[] = [point, back, front, [back[0] + nx, back[1] + ny], [back[0] - nx, back[1] - ny], [front[0] + nx, front[1] + ny], [front[0] - nx, front[1] - ny]];
        if (body.some(blocked)) continue;
        reachableSpots++;
        // A hose line through a neighbouring building is not a usable spot.
        if (crossesOther(point, facade.point)) continue;
        candidates.push({ s, point, facade: facade.point, hose: facade.distance, score: facade.distance });
      }
      corridors.push({ routeId: route.id, routeName: route.name, direction: raw.direction, order: index, path, cumulative, candidates });
    }
  }
  if (!corridors.length) return { plan: null, reason: 'no-corridor' };
  const reachable = corridors.filter(c => c.candidates.length);
  if (!reachable.length) return { plan: null, reason: reachableSpots ? 'obstructed' : 'out-of-reach' };
  const bestOf = (cs: Candidate[]) => cs.reduce((a, b) => b.score < a.score - 1e-9 ? b : a);
  const corridor = reachable.reduce((a, b) => {
    const sa = bestOf(a.candidates).score, sb = bestOf(b.candidates).score;
    return sb < sa - 1e-9 ? b : a; // ties keep the earlier route/path (input order), deterministic
  });

  const first = bestOf(corridor.candidates);
  const spots: Candidate[] = [first];
  if (A.trucks > 1) {
    const second = corridor.candidates.filter(c => Math.abs(c.s - first.s) >= A.minSpacingMetres && Math.abs(c.s - first.s) <= A.maxSpacingMetres);
    if (second.length) spots.push(bestOf(second));
  }
  // The lead truck parks furthest along the corridor so later trucks never pass it on the way in.
  spots.sort((a, b) => b.s - a.s);

  const total = corridor.cumulative[corridor.cumulative.length - 1];
  const trucks: FireTruckPlan[] = spots.map((spot, i) => {
    const from = Math.max(0, spot.s - A.approachMetres), to = Math.min(total, spot.s + A.departMetres);
    const sub = slice(corridor.path, corridor.cumulative, from, to);
    const stageAt = spot.s - from, exitLength = sub.cumulative[sub.cumulative.length - 1] - stageAt;
    const departAt = start + A.dispatchDelaySeconds + i * A.staggerSeconds;
    const arriveAt = departAt + approachDuration(stageAt);
    const fightStart = arriveAt + A.setupSeconds;
    const fightEnd = Math.max(fightStart, activeUntil!);
    const leaveAt = fightEnd + A.stowSeconds + i * A.staggerSeconds;
    const exitAt = leaveAt + departDuration(exitLength);
    const [lng, lat] = toLngLat(frame, spot.facade);
    return {
      id: `engine-${i + 1}`, routeId: corridor.routeId, direction: corridor.direction,
      path: sub.path.map(p => toLngLat(frame, p)), cumulative: sub.cumulative.map(v => round(v, 1000)), stageAt: round(stageAt, 1000),
      departAt, arriveAt: round(arriveAt, 1000), fightStart: round(fightStart, 1000), fightEnd, leaveAt, exitAt: round(exitAt, 1000),
      waterTarget: [lng, lat, waterHeight], hoseMetres: round(spot.hose, 100),
    };
  });
  return { plan: { incidentStart: start, activeUntil: activeUntil!, routeId: corridor.routeId, routeName: corridor.routeName, direction: corridor.direction, trucks }, reason: null };
}

// Speed profiles. Approach: enter at cruise speed and brake to a stop at the staging point (or, on a
// short approach, enter at the speed that stops exactly there). Depart: accelerate from rest to cruise.
const brakeDistance = () => A.cruiseSpeed ** 2 / (2 * A.deceleration);
const accelDistance = () => A.cruiseSpeed ** 2 / (2 * A.acceleration);
function approachDuration(d: number): number {
  if (d <= 0) return 0;
  if (d >= brakeDistance()) return (d - brakeDistance()) / A.cruiseSpeed + A.cruiseSpeed / A.deceleration;
  return Math.sqrt(2 * A.deceleration * d) / A.deceleration;
}
/** Metres travelled and speed `t` seconds after entering an approach of length d. */
function approachAt(d: number, t: number): { s: number; v: number } {
  const total = approachDuration(d);
  if (t >= total) return { s: d, v: 0 };
  const left = total - t; // time still to stop: braking backwards from the stop is symmetric
  const brakeTime = d >= brakeDistance() ? A.cruiseSpeed / A.deceleration : total;
  if (left >= brakeTime) return { s: A.cruiseSpeed * t, v: A.cruiseSpeed };
  return { s: d - A.deceleration * left * left / 2, v: A.deceleration * left };
}
function departDuration(d: number): number {
  if (d <= 0) return 0;
  if (d >= accelDistance()) return A.cruiseSpeed / A.acceleration + (d - accelDistance()) / A.cruiseSpeed;
  return Math.sqrt(2 * d / A.acceleration);
}
function departAtTime(t: number): { s: number; v: number } {
  const tAccel = A.cruiseSpeed / A.acceleration;
  if (t <= tAccel) return { s: A.acceleration * t * t / 2, v: A.acceleration * t };
  return { s: accelDistance() + A.cruiseSpeed * (t - tAccel), v: A.cruiseSpeed };
}

function headingAt(plan: FireTruckPlan, s: number, path: XY[]): number {
  const total = plan.cumulative[plan.cumulative.length - 1];
  const a = Math.max(0, Math.min(total - 0.5, s - 4)), b = Math.min(total, Math.max(a + 0.5, s + 4));
  const p = pointAt(path, plan.cumulative, a), q = pointAt(path, plan.cumulative, b);
  const deg = Math.atan2(q[0] - p[0], q[1] - p[1]) * 180 / Math.PI;
  return round((deg + 360) % 360, 100);
}

// Local-metre copy of each truck's drive line, cached per plan object (plans are immutable once built).
const projections = new WeakMap<FireTruckPlan, { frame: Frame; path: XY[] }>();
function projected(truck: FireTruckPlan): { frame: Frame; path: XY[] } {
  let hit = projections.get(truck);
  if (!hit) { const frame = makeFrame(truck.path[0]); hit = { frame, path: truck.path.map(p => toXY(frame, p)) }; projections.set(truck, hit); }
  return hit;
}

/** Every visible truck at `time` (sim seconds). Trucks are absent before they enter and after they exit. */
export function fireResponseAt(plan: FireResponse | null | undefined, time: number): FireTruckFrame[] {
  if (!plan || !Number.isFinite(time)) return [];
  const out: FireTruckFrame[] = [];
  for (const truck of plan.trucks) {
    if (time < truck.departAt || time >= truck.exitAt) continue;
    const { frame, path } = projected(truck);
    let s: number, speed: number, phase: FireTruckPhase;
    if (time < truck.arriveAt) { const m = approachAt(truck.stageAt, time - truck.departAt); s = m.s; speed = m.v; phase = 'responding'; }
    else if (time < truck.leaveAt) { s = truck.stageAt; speed = 0; phase = time >= truck.fightStart && time < truck.fightEnd ? 'fighting' : 'staging'; }
    else {
      const total = truck.cumulative[truck.cumulative.length - 1];
      const m = departAtTime(time - truck.leaveAt); s = Math.min(total, truck.stageAt + m.s); speed = m.v; phase = 'leaving';
    }
    const [lng, lat] = toLngLat(frame, pointAt(path, truck.cumulative, s));
    const result: FireTruckFrame = { id: truck.id, position: [lng, lat], bearing: headingAt(truck, s, path), phase, speed: round(speed, 1000) };
    if (phase === 'fighting') result.waterTarget = [...truck.waterTarget];
    out.push(result);
  }
  return out;
}
