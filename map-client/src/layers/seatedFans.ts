// Fans in their seats at Fenway Park. The building models' manifest lists the ballpark's seat rows
// (make_building_models.py, landmark_ballpark: the stepped bowl, the Monster seats and the roof box
// seats). During a game, every event visitor who has reached the gate and not yet left sits in a
// seat: visitor i of the event takes seat ORDER[i] (a fixed shuffle across the whole park, so the
// stands fill evenly, section by section at random, the way ticketed seats do), several visitors
// sharing a seat when the game sells more tickets than the model has seats. Like the walking
// visitors, it is a pure function of sim time: the same people sit in the same seats at any speed.
//
// Drawn as one flat sprite per fan in a single layer; its data is rebuilt only when the set of
// seated fans changes, and nothing is drawn when the camera is far away.
import { IconLayer } from '@deck.gl/layers';
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

// ---------------------------------------------------------------- drawing: one 2D sprite per fan

// A seated fan is a flat head-and-shoulders silhouette facing the camera (deck.gl's IconLayer,
// tinted by shirt colour): four vertices a fan, one draw for the whole crowd. 3D figures cost about
// 290 vertices a fan, millions for a sold-out park, and nobody sees more than a coloured dot.
const SHIRTS: [number, number, number][] = [
  [189, 48, 57], [189, 48, 57], [189, 48, 57], [178, 36, 46], // Red Sox red
  [12, 35, 64], [12, 35, 64], [24, 44, 78], // navy
  [236, 236, 232], [236, 236, 232], // home whites
  [128, 132, 138], [40, 40, 44], [62, 110, 74], [214, 182, 70], // grey, black, green, gold
];
const slot = { slot: 'middle' } as Record<string, unknown>; // read by @deck.gl/mapbox for Mapbox Standard
/** No fans drawn below this zoom (the park is a few dozen pixels across); half of them below FULL_ZOOM. */
export const MIN_ZOOM = 15.5;
export const FULL_ZOOM = 17;

const ICON_W = 32, ICON_H = 40;
let atlas: string | null = null;
/** The silhouette, drawn once on a canvas: a head over rounded shoulders, white (the layer tints it). */
function iconAtlas(): string {
  if (atlas) return atlas;
  const c = document.createElement('canvas');
  c.width = ICON_W; c.height = ICON_H;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(16, 9, 7.5, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.moveTo(3, 40); g.lineTo(3, 27); g.quadraticCurveTo(3, 18, 12, 18); g.lineTo(20, 18); g.quadraticCurveTo(29, 18, 29, 27); g.lineTo(29, 40); g.closePath(); g.fill();
  return (atlas = c.toDataURL());
}
const ICON_MAPPING = { fan: { x: 0, y: 0, width: ICON_W, height: ICON_H, anchorY: ICON_H, mask: true } };

/** What a layer draws: seat indices, and the same list thinned to half for middle zooms. Built once per occupancy. */
export interface FanData { all: Uint32Array; half: Uint32Array; version: number }
export function fanData(occupied: Uint32Array, version: number): FanData {
  return { all: occupied, half: occupied.filter((s) => hash(s, 23) < 0.5), version };
}

/** The seated fans as one IconLayer, or nothing when zoomed far out or the stands are empty. */
export function seatedFanLayers(seats: Seats, data: FanData, zoom: number): Layer[] {
  if (!data.all.length || zoom < MIN_ZOOM || typeof document === 'undefined') return [];
  const shown = zoom >= FULL_ZOOM ? data.all : data.half;
  return [new IconLayer({
    id: 'fenway-fans',
    // Stable arrays: deck.gl only recomputes positions and colours when the crowd changes.
    data: shown as unknown as number[],
    iconAtlas: iconAtlas(),
    iconMapping: ICON_MAPPING,
    getIcon: () => 'fan',
    getPosition: (s: number) => [seats.position[s * 3], seats.position[s * 3 + 1], seats.position[s * 3 + 2]],
    getColor: (s: number) => SHIRTS[Math.floor(hash(s, 11) * SHIRTS.length)],
    getSize: 1.15,
    sizeUnits: 'meters',
    sizeMinPixels: 1.5,
    sizeMaxPixels: 20,
    billboard: true,
    pickable: false,
    updateTriggers: { getPosition: data.version, getColor: data.version },
    ...slot,
  }) as Layer];
}

// One cache for the map: seats expanded once per manifest, occupancy recomputed when the visitor
// plan changes or sim time crosses a REFRESH_SECONDS step (fans arrive by the thousand over hours;
// a 20 s step is invisible and keeps fast playback cheap). The layer's data arrays change only
// when the set of seated fans does.
const REFRESH_SECONDS = 20;
let cache: { seating: Seating | null; seats: Seats | null; plan: VisitorPlan | null; key: number; occupied: Uint32Array; data: FanData } =
  { seating: null, seats: null, plan: null, key: Number.NaN, occupied: new Uint32Array(0), data: fanData(new Uint32Array(0), 0) };

/**
 * The fans' layer data at sim time `t`: the same object (and arrays) frame after frame until the set
 * of seated fans changes. Handing deck.gl a new array every frame would make it recompute the whole
 * crowd's attributes every frame.
 */
export function fenwayFanData(seating: Seating | null | undefined, plan: VisitorPlan, t: number): { seats: Seats; data: FanData } | null {
  if (!seating) return null;
  if (cache.seating !== seating) {
    cache = { seating, seats: expandSeats(seating), plan: null, key: Number.NaN, occupied: new Uint32Array(0), data: fanData(new Uint32Array(0), cache.data.version + 1) };
  }
  const seats = cache.seats;
  if (!seats) return null;
  const key = Math.floor(t / REFRESH_SECONDS);
  if (cache.plan !== plan || cache.key !== key) {
    const occupied = occupiedSeats(seats, fenwayEvent(plan), t);
    const same = occupied.length === cache.occupied.length && occupied.every((s, i) => s === cache.occupied[i]);
    cache = { ...cache, plan, key, occupied: same ? cache.occupied : occupied, data: same ? cache.data : fanData(occupied, cache.data.version + 1) };
  }
  return { seats, data: cache.data };
}

/** Fenway's seated fans at sim time `t` (local seconds on the shown day) for the map's layer list. */
export function fenwayFanLayers(seating: Seating | null | undefined, plan: VisitorPlan, t: number, zoom: number): Layer[] {
  if (zoom < MIN_ZOOM) return [];
  const fans = fenwayFanData(seating, plan, t);
  return fans ? seatedFanLayers(fans.seats, fans.data, zoom) : [];
}
