// Fans in their seats at Fenway Park. The building models' manifest lists the ballpark's seat rows
// (make_building_models.py, landmark_ballpark: the stepped bowl, the Monster seats and the roof box
// seats). During a game, every event visitor who has reached the gate and not yet left sits in a
// seat: visitor i of the event takes seat ORDER[i] (a fixed shuffle across the whole park, so the
// stands fill evenly, section by section at random, the way ticketed seats do), several visitors
// sharing a seat when the game sells more tickets than the model has seats. Like the walking
// visitors, it is a pure function of sim time: the same people sit in the same seats at any speed.
//
// Drawn as three tiny meshes per fan (body and cap in their shirt colour, head, legs), each one
// GPU-instanced draw for the whole crowd. Rebuilt only when the set of seated fans changes.
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type { Layer } from '@deck.gl/core';
import type { PlannedVisitorEvent, VisitorPlan } from '../sim/visitors';

/** [lng0, lat0, lng1, lat1, tread height (m), seats, facing bearing (deg), section (0 bowl, 1 Monster, 2 roof)]. */
export type SeatRow = [number, number, number, number, number, number, number, number];
export interface Seating { total: number; rows: SeatRow[] }

export interface Seats {
  /** lng, lat, height per seat. */
  position: Float64Array;
  /** Compass bearing each seat faces. */
  bearing: Float32Array;
  /** Seats in fill order: visitor i sits in ORDER[i] (or shares one when there are more fans than seats). */
  order: Uint32Array;
  count: number;
}

const FENWAY = 'fenway-park';

function hash(i: number, salt: number): number {
  let h = (i * 0x9e3779b1) ^ (salt * 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Every seat of the rows, evenly along each row, and a fixed shuffled fill order. */
export function expandSeats(seating: Seating | null | undefined): Seats | null {
  if (!seating?.rows.length) return null;
  const count = seating.rows.reduce((s, r) => s + r[5], 0);
  const position = new Float64Array(count * 3);
  const bearing = new Float32Array(count);
  let k = 0;
  for (const [x0, y0, x1, y1, h, n, facing] of seating.rows) {
    for (let j = 0; j < n; j++) {
      const f = n === 1 ? 0.5 : j / (n - 1);
      position[k * 3] = x0 + (x1 - x0) * f;
      position[k * 3 + 1] = y0 + (y1 - y0) * f;
      position[k * 3 + 2] = h;
      bearing[k] = facing;
      k++;
    }
  }
  // Fisher-Yates with a fixed hash: the same order on every load.
  const order = new Uint32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  for (let i = count - 1; i > 0; i--) {
    const j = Math.floor(hash(i, 7) * (i + 1));
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  return { position, bearing, order, count };
}

function upperBound(a: Float64Array, x: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] <= x) lo = mid + 1; else hi = mid; }
  return lo;
}

/** The Fenway game in a day's visitor plan, if any. */
export function fenwayEvent(plan: VisitorPlan): PlannedVisitorEvent | null {
  return plan.events.find((e) => e.estimate.venue.id === FENWAY) ?? null;
}

/**
 * Seats occupied at `t`: each visitor who has reached the gate (arrive <= t) and not yet left
 * (depart > t) sits in seat ORDER[i], or ORDER[floor(i * seats / visitors)] when the game has more
 * fans than modeled seats. Returns the occupied seat indices, in fill order.
 */
export function occupiedSeats(seats: Seats, event: PlannedVisitorEvent | null, t: number): Uint32Array {
  if (!event || !event.n) return new Uint32Array(0);
  const arrived = upperBound(event.arrive, t);
  if (!arrived) return new Uint32Array(0);
  const share = event.n > seats.count ? seats.count / event.n : 1;
  const taken = new Uint8Array(seats.count);
  const out: number[] = [];
  for (let i = 0; i < arrived; i++) {
    if (event.depart[i] <= t) continue;
    const s = seats.order[share < 1 ? Math.floor(i * share) : i];
    if (s === undefined || taken[s]) continue;
    taken[s] = 1;
    out.push(s);
  }
  return Uint32Array.from(out);
}

// ---------------------------------------------------------------- the fan, seated, facing +y

type Vec3 = [number, number, number];
interface MeshBuilder { p: number[]; n: number[]; c: number[] }
function quad(m: MeshBuilder, a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal: Vec3, color: Vec3) {
  for (const v of [a, b, c, a, c, d]) { m.p.push(...v); m.n.push(...normal); m.c.push(...color); }
}
function box(m: MeshBuilder, [x0, y0, z0]: Vec3, [x1, y1, z1]: Vec3, color: Vec3 = [1, 1, 1]) {
  quad(m, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], color);
  quad(m, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0], color);
  quad(m, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], color);
  quad(m, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], color);
  quad(m, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], color);
  quad(m, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1], color);
}
function mesh(build: (m: MeshBuilder) => void) {
  const m: MeshBuilder = { p: [], n: [], c: [] };
  build(m);
  return { attributes: {
    positions: { value: new Float32Array(m.p), size: 3 },
    normals: { value: new Float32Array(m.n), size: 3 },
    colors: { value: new Float32Array(m.c), size: 3 },
  } };
}
/** Metres, z up from the tread, facing +y (the field). Seat height 0.45 m. */
const BODY = mesh((m) => {
  box(m, [-0.19, -0.16, 0.42], [0.19, 0.08, 0.98]); // torso
  box(m, [-0.27, -0.1, 0.55], [-0.19, 0.16, 0.9]); // arms, forearms on the knees
  box(m, [0.19, -0.1, 0.55], [0.27, 0.16, 0.9]);
  box(m, [-0.13, -0.09, 1.23], [0.13, 0.13, 1.31]); // cap crown
  box(m, [-0.12, 0.13, 1.23], [0.12, 0.24, 1.25]); // cap brim, towards the field
});
const HEAD = mesh((m) => box(m, [-0.11, -0.1, 1.0], [0.11, 0.12, 1.24]));
const LEGS = mesh((m) => {
  box(m, [-0.17, -0.06, 0.4], [0.17, 0.4, 0.52]); // thighs, forward on the seat
  box(m, [-0.16, 0.32, 0.0], [0.16, 0.44, 0.42]); // shins down to the tread in front
});

const SHIRTS: [number, number, number][] = [
  [189, 48, 57], [189, 48, 57], [189, 48, 57], [178, 36, 46], // Red Sox red
  [12, 35, 64], [12, 35, 64], [24, 44, 78], // navy
  [236, 236, 232], [236, 236, 232], // home whites
  [128, 132, 138], [40, 40, 44], [62, 110, 74], [214, 182, 70], // grey, black, green, gold
];
const SKIN: [number, number, number][] = [[241, 204, 174], [224, 172, 132], [198, 140, 98], [160, 104, 70], [118, 78, 52], [92, 60, 40]];
const PANTS: [number, number, number][] = [[52, 64, 92], [44, 48, 56], [70, 86, 118], [120, 112, 98]];
const MATERIAL = { ambient: 0.6, diffuse: 0.55, shininess: 8, specularColor: [30, 30, 30] as [number, number, number] };
const slot = { slot: 'middle' } as Record<string, unknown>; // read by @deck.gl/mapbox for Mapbox Standard

/** Fans a little larger than life when zoomed out, so the crowd reads; never so large they overlap. */
export function fanScale(zoom: number): number {
  return Math.min(1.8, Math.max(1, 2 ** ((18 - zoom) * 0.5)));
}

/** Seated fans: three instanced meshes. Empty when nobody is in the stands. */
export function seatedFanLayers(seats: Seats, occupied: Uint32Array, zoom: number, version: number): Layer[] {
  if (!occupied.length || zoom < 14) return [];
  const data = { length: occupied.length };
  const at = (i: number) => occupied[i];
  const common = {
    data, sizeScale: fanScale(zoom), material: MATERIAL, pickable: false,
    getPosition: (_: unknown, { index }: { index: number }) => {
      const s = at(index);
      return [seats.position[s * 3], seats.position[s * 3 + 1], seats.position[s * 3 + 2]] as [number, number, number];
    },
    // The meshes face +y; deck.gl's yaw turns them to the seat's bearing.
    getOrientation: (_: unknown, { index }: { index: number }) => [0, -seats.bearing[at(index)], 0] as [number, number, number],
    updateTriggers: { getPosition: version, getOrientation: version, getColor: version },
    ...slot,
  };
  return [
    new SimpleMeshLayer({ ...common, id: 'fenway-fans-body', mesh: BODY as never,
      getColor: (_: unknown, { index }: { index: number }) => SHIRTS[Math.floor(hash(at(index), 11) * SHIRTS.length)] }),
    new SimpleMeshLayer({ ...common, id: 'fenway-fans-head', mesh: HEAD as never,
      getColor: (_: unknown, { index }: { index: number }) => SKIN[Math.floor(hash(at(index), 13) * SKIN.length)] }),
    new SimpleMeshLayer({ ...common, id: 'fenway-fans-legs', mesh: LEGS as never,
      getColor: (_: unknown, { index }: { index: number }) => PANTS[Math.floor(hash(at(index), 17) * PANTS.length)] }),
  ] as Layer[];
}

// One cache for the map: seats expanded once per manifest, occupancy recomputed when the visitor
// plan changes or sim time crosses a REFRESH_SECONDS step (fans arrive by the thousand over hours;
// a 20 s step is invisible and keeps fast playback cheap).
const REFRESH_SECONDS = 20;
let cache: { seating: Seating | null; seats: Seats | null; plan: VisitorPlan | null; key: number; occupied: Uint32Array; version: number } =
  { seating: null, seats: null, plan: null, key: Number.NaN, occupied: new Uint32Array(0), version: 0 };

/** Fenway's seated fans at sim time `t` (local seconds on the shown day) for the map's layer list. */
export function fenwayFanLayers(seating: Seating | null | undefined, plan: VisitorPlan, t: number, zoom: number): Layer[] {
  if (!seating) return [];
  if (cache.seating !== seating) cache = { seating, seats: expandSeats(seating), plan: null, key: Number.NaN, occupied: new Uint32Array(0), version: cache.version + 1 };
  const seats = cache.seats;
  if (!seats) return [];
  const key = Math.floor(t / REFRESH_SECONDS);
  if (cache.plan !== plan || cache.key !== key) {
    const occupied = occupiedSeats(seats, fenwayEvent(plan), t);
    const same = occupied.length === cache.occupied.length && occupied.every((s, i) => s === cache.occupied[i]);
    cache = { ...cache, plan, key, occupied, version: same ? cache.version : cache.version + 1 };
  }
  return seatedFanLayers(seats, cache.occupied, zoom, cache.version);
}
