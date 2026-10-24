// Modeled fire engines for the fire scenario: procedural trucks (no downloaded models, no agency
// markings) driven only by the frames from sim/disasterFireResponse.ts, with deterministic light flashing
// and, while a truck is fighting the fire, a ground hose and a stylized water arc onto the facade.
// Illustrative only; not a model of any real fire department's apparatus or tactics.
//
// Draw cost is fixed: one merged truck mesh (one draw for every truck), one lens layer, one glow
// layer and, while fighting, a hose, two arc strokes, droplets and a splash. The truck mesh is built
// once at module load; per-frame work is a handful of small instance arrays.
//
// Local truck space (metres): +x to the truck's right, +y forward (towards the cab), +z up. With
// getOrientation [0, -bearing, 0] (as in transit.ts) +y points at the compass bearing.
import type { Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CubeGeometry } from '@luma.gl/engine';
import type { FireTruckFrame } from '../sim/disasterFireResponse';

type RGB = [number, number, number];
type RGBA = [number, number, number, number];
type Vec3 = [number, number, number];

const METRES_PER_DEGREE = 111_320;
/** Half-length of the truck body in metres (a ~10.4 m pumper with a roof ladder). */
export const TRUCK_HALF_LENGTH = 5.2;
export const TRUCK_HEIGHT = 3.3;

/** True size up close, growing modestly on the overview (a little less than buses do). */
export function fireTruckScale(zoom: number): number {
  return Math.min(4, Math.max(1, 2 ** (18.2 - zoom)));
}

// ---------------------------------------------------------------- procedural mesh

const C = {
  red: [0.78, 0.06, 0.06],
  darkRed: [0.5, 0.04, 0.04],
  white: [0.96, 0.96, 0.94],
  glass: [0.12, 0.18, 0.26],
  silver: [0.74, 0.76, 0.79],
  chrome: [0.88, 0.89, 0.9],
  black: [0.06, 0.06, 0.07],
  tyreHub: [0.62, 0.64, 0.66],
  lamp: [1, 0.97, 0.85],
  housing: [0.16, 0.16, 0.18],
} satisfies Record<string, RGB>;

interface MeshBuilder { p: number[]; n: number[]; c: number[] }

function quad(m: MeshBuilder, a: Vec3, b: Vec3, c: Vec3, d: Vec3, normal: Vec3, color: RGB) {
  for (const v of [a, b, c, a, c, d]) { m.p.push(...v); m.n.push(...normal); m.c.push(...color); }
}

/** Axis-aligned box from min to max corner. */
function box(m: MeshBuilder, [x0, y0, z0]: Vec3, [x1, y1, z1]: Vec3, color: RGB) {
  quad(m, [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], [1, 0, 0], color);
  quad(m, [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [-1, 0, 0], color);
  quad(m, [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [0, 1, 0], color);
  quad(m, [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [0, -1, 0], color);
  quad(m, [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [0, 0, 1], color);
  quad(m, [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0], [0, 0, -1], color);
}

/** A wheel: an octagonal prism on an axis parallel to x, with a silver hub cap on the outer face. */
function wheel(m: MeshBuilder, x0: number, x1: number, y: number, radius: number) {
  const sides = 10;
  const at = (k: number, r: number): [number, number] => {
    const a = (k / sides) * 2 * Math.PI;
    return [y + Math.cos(a) * r, radius + Math.sin(a) * r];
  };
  const outer = Math.abs(x1) > Math.abs(x0) ? x1 : x0;
  const sign = Math.sign(outer) || 1;
  for (let k = 0; k < sides; k++) {
    const [ya, za] = at(k, radius), [yb, zb] = at(k + 1, radius);
    const mid = ((k + 0.5) / sides) * 2 * Math.PI;
    quad(m, [x0, ya, za], [x1, ya, za], [x1, yb, zb], [x0, yb, zb], [0, Math.cos(mid), Math.sin(mid)], C.black);
    // Tyre side walls (black) and hub (silver) on the outer face.
    for (const x of [x0, x1]) {
      const s = x === outer ? sign : -sign;
      const tri = (pa: Vec3, pb: Vec3, pc: Vec3, col: RGB) => {
        for (const v of s > 0 ? [pa, pb, pc] : [pa, pc, pb]) { m.p.push(...v); m.n.push(s, 0, 0); m.c.push(...col); }
      };
      tri([x, y, radius], [x, ya, za], [x, yb, zb], C.black);
      if (x === outer) {
        const [ha, hza] = at(k, radius * 0.5), [hb, hzb] = at(k + 1, radius * 0.5);
        tri([x + sign * 0.01, y, radius], [x + sign * 0.01, ha, hza], [x + sign * 0.01, hb, hzb], C.tyreHub);
      }
    }
  }
}

interface MeshAttributes { positions: { value: Float32Array; size: 3 }; normals: { value: Float32Array; size: 3 }; colors: { value: Float32Array; size: 3 } }

/** The engine: red body, white cab roof, windshield, silver compartments, roof ladder, black wheels. */
function buildTruckMesh(): { attributes: MeshAttributes } {
  const m: MeshBuilder = { p: [], n: [], c: [] };
  const L = TRUCK_HALF_LENGTH, W = 1.25;
  const cabRear = 2.3;
  // Chassis rail and rear body.
  box(m, [-0.9, -L + 0.2, 0.45], [0.9, L - 0.3, 0.7], C.black);
  box(m, [-W, -L, 0.7], [W, cabRear - 0.1, 2.75], C.red);
  // White stripe along the body and a dark red skirt over the wheels.
  box(m, [-W - 0.02, -L, 2.0], [W + 0.02, cabRear - 0.1, 2.12], C.white);
  box(m, [-W - 0.015, -L, 0.7], [W + 0.015, cabRear - 0.1, 0.82], C.darkRed);
  // Silver equipment compartments, three roll-up doors a side.
  const doors: [number, number][] = [[-4.95, -3.0], [-2.85, -0.9], [-0.75, 1.95]];
  for (const [y0, y1] of doors) {
    for (const side of [-1, 1]) {
      const xIn = side * W, xOut = side * (W + 0.04);
      box(m, [Math.min(xIn, xOut), y0, 0.95], [Math.max(xIn, xOut), y1, 1.92], C.silver);
      // Door handle bar.
      const xh = side * (W + 0.07);
      box(m, [Math.min(xOut, xh), (y0 + y1) / 2 - 0.35, 1.05], [Math.max(xOut, xh), (y0 + y1) / 2 + 0.35, 1.12], C.chrome);
    }
  }
  // Rear step and tail panel.
  box(m, [-W, -L - 0.35, 0.55], [W, -L, 0.7], C.chrome);
  box(m, [-0.9, -L - 0.02, 1.0], [0.9, -L, 2.4], C.silver);
  // Cab: red lower, glass band, white roof.
  box(m, [-W, cabRear, 0.7], [W, L, 1.75], C.red);
  box(m, [-W, cabRear, 1.75], [W, cabRear + 0.25, 2.85], C.red); // rear cab pillar
  box(m, [-W, L - 0.2, 1.75], [W, L, 1.85], C.red); // under-windshield sill
  box(m, [-W + 0.05, cabRear + 0.25, 1.75], [W - 0.05, L - 0.12, 2.75], C.glass); // side windows + glass core
  box(m, [-W, L - 0.3, 1.85], [-W + 0.12, L, 2.75], C.red); // A pillars
  box(m, [W - 0.12, L - 0.3, 1.85], [W, L, 2.75], C.red);
  box(m, [-W + 0.12, L - 0.12, 1.85], [W - 0.12, L - 0.02, 2.72], C.glass); // windshield face
  box(m, [-W - 0.03, cabRear - 0.05, 2.75], [W + 0.03, L + 0.03, 2.98], C.white); // white cab roof
  box(m, [-W - 0.005, (cabRear + L) / 2 - 0.05, 0.85], [W + 0.005, (cabRear + L) / 2 + 0.05, 2.75], C.red); // door seam
  // Front: chrome bumper, grille, headlights.
  box(m, [-W - 0.05, L, 0.5], [W + 0.05, L + 0.28, 0.9], C.chrome);
  box(m, [-0.7, L, 0.95], [0.7, L + 0.04, 1.6], C.silver);
  for (let k = 0; k < 4; k++) box(m, [-0.65, L + 0.04, 1.02 + k * 0.15], [0.65, L + 0.06, 1.08 + k * 0.15], C.housing);
  box(m, [-W + 0.08, L, 1.1], [-W + 0.38, L + 0.05, 1.35], C.lamp);
  box(m, [W - 0.38, L, 1.1], [W - 0.08, L + 0.05, 1.35], C.lamp);
  // Mirrors.
  box(m, [-W - 0.32, L - 0.45, 2.0], [-W - 0.06, L - 0.35, 2.5], C.black);
  box(m, [W + 0.06, L - 0.45, 2.0], [W + 0.32, L - 0.35, 2.5], C.black);
  // Light-bar housing on the cab roof (the lenses are a separate, flashing layer).
  box(m, [-1.05, L - 0.9, 2.98], [1.05, L - 0.45, 3.04], C.housing);
  // Roof: ladder rack posts and a two-rail ladder with rungs, overhanging the cab.
  for (const y of [-4.6, -0.6, cabRear + 0.4]) {
    box(m, [-0.7, y - 0.08, y > cabRear ? 2.98 : 2.75], [-0.6, y + 0.08, 3.1], C.silver);
    box(m, [0.6, y - 0.08, y > cabRear ? 2.98 : 2.75], [0.7, y + 0.08, 3.1], C.silver);
  }
  const ladderY0 = -L - 0.4, ladderY1 = L - 1.1;
  box(m, [-0.7, ladderY0, 3.1], [-0.56, ladderY1, 3.24], C.chrome);
  box(m, [0.56, ladderY0, 3.1], [0.7, ladderY1, 3.24], C.chrome);
  for (let y = ladderY0 + 0.2; y < ladderY1; y += 0.42) box(m, [-0.56, y - 0.03, 3.14], [0.56, y + 0.03, 3.2], C.silver);
  // Deck gun (water monitor) amidships, behind the cab.
  box(m, [-0.18, 0.9, 2.75], [0.18, 1.25, 3.05], C.silver);
  box(m, [-0.08, 1.05, 3.05], [0.08, 1.75, 3.17], C.chrome);
  // Hose bed hint at the rear (a coiled hose: tan blocks).
  box(m, [-1.05, -L + 0.1, 2.75], [1.05, -L + 1.1, 2.9], [0.72, 0.6, 0.36]);
  // Wheels: front axle and a rear tandem.
  for (const y of [3.65, -2.35, -3.6]) {
    wheel(m, -W - 0.04, -W + 0.34, y, 0.52);
    wheel(m, W - 0.34, W + 0.04, y, 0.52);
  }
  return {
    attributes: {
      positions: { value: new Float32Array(m.p), size: 3 },
      normals: { value: new Float32Array(m.n), size: 3 },
      colors: { value: new Float32Array(m.c), size: 3 },
    },
  };
}

/** Built once and reused by every layer instance, so deck.gl never re-uploads the geometry. */
export const FIRE_TRUCK_MESH = buildTruckMesh();
const LENS = new CubeGeometry(); // -1..1; getScale gives half-dimensions in metres

// ---------------------------------------------------------------- local -> world

/** World [lng, lat, z] of a point given in a truck's local metres, at the given size scale. */
export function truckPoint(frame: Pick<FireTruckFrame, 'position' | 'bearing'>, local: Vec3, scale: number): Vec3 {
  const b = (frame.bearing * Math.PI) / 180;
  const x = local[0] * scale, y = local[1] * scale;
  const east = x * Math.cos(b) + y * Math.sin(b);
  const north = -x * Math.sin(b) + y * Math.cos(b);
  const lat = frame.position[1];
  return [
    frame.position[0] + east / (METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180)),
    lat + north / METRES_PER_DEGREE,
    local[2] * scale,
  ];
}

// ---------------------------------------------------------------- lights

/** Flash period in simulation seconds. Deterministic: the same time always gives the same lamps. */
export const FLASH_PERIOD = 0.8;
const RED: RGB = [255, 32, 24];
const WHITE: RGB = [255, 250, 236];
const dim = (c: RGB): RGBA => [Math.round(c[0] * 0.35), Math.round(c[1] * 0.35), Math.round(c[2] * 0.35), 255];

interface LensSpec { local: Vec3; half: Vec3; color: RGB; group: 0 | 1 | 2 }
const L = TRUCK_HALF_LENGTH;
// group 0 and 1 alternate (wig-wag); group 2 (white) strobes twice in each half.
const LENSES: LensSpec[] = [
  { local: [-0.78, L - 0.67, 3.1], half: [0.24, 0.17, 0.08], color: RED, group: 0 },
  { local: [-0.27, L - 0.67, 3.1], half: [0.22, 0.17, 0.08], color: WHITE, group: 2 },
  { local: [0.27, L - 0.67, 3.1], half: [0.22, 0.17, 0.08], color: RED, group: 1 },
  { local: [0.78, L - 0.67, 3.1], half: [0.24, 0.17, 0.08], color: RED, group: 0 },
  { local: [-0.9, L + 0.06, 1.48], half: [0.14, 0.04, 0.07], color: RED, group: 1 },
  { local: [0.9, L + 0.06, 1.48], half: [0.14, 0.04, 0.07], color: RED, group: 0 },
  { local: [-1.0, -L - 0.03, 2.55], half: [0.16, 0.04, 0.12], color: RED, group: 0 },
  { local: [1.0, -L - 0.03, 2.55], half: [0.16, 0.04, 0.12], color: RED, group: 1 },
  { local: [0, -L - 0.03, 2.55], half: [0.16, 0.04, 0.12], color: WHITE, group: 2 },
];

/** Whether a light group is lit at sim time `time`, with a per-truck offset so units don't sync. */
export function lightOn(group: 0 | 1 | 2, time: number, offset = 0): boolean {
  const u = (((time + offset) / FLASH_PERIOD) % 1 + 1) % 1;
  if (group === 0) return u < 0.5;
  if (group === 1) return u >= 0.5;
  return (u % 0.5) < 0.09 || ((u % 0.5) > 0.16 && (u % 0.5) < 0.25);
}

/** Stable per-id offset in [0, FLASH_PERIOD), from a small string hash. */
function idOffset(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) / 4294967296) * FLASH_PERIOD;
}

export interface Lens { position: Vec3; half: Vec3; orientation: Vec3; color: RGBA; on: boolean }
export interface Glow { position: Vec3; color: RGBA; radius: number }

// ---------------------------------------------------------------- water

export interface WaterArc { id: string; path: Vec3[] }
export interface Hose { id: string; path: Vec3[] }
export interface Droplet { position: Vec3; radius: number; color: RGBA }

const ARC_SEGMENTS = 28;
const NOZZLE: Vec3 = [0, 1.75, 3.2]; // deck gun tip, local
const DISCHARGE: Vec3 = [1.3, 0.2, 0.9]; // right-side pump panel outlet, local

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Ground distance in metres between two lng/lat points (equirectangular; fine at campus scale). */
function metresBetween(a: readonly number[], b: readonly number[]): number {
  const dx = (b[0] - a[0]) * METRES_PER_DEGREE * Math.cos((a[1] * Math.PI) / 180);
  const dy = (b[1] - a[1]) * METRES_PER_DEGREE;
  return Math.hypot(dx, dy);
}

/** A ballistic-looking arc from nozzle to target, rising above both ends by a share of the reach. */
export function waterArcPath(from: Vec3, to: Vec3): Vec3[] {
  const reach = metresBetween(from, to);
  const lift = Math.min(14, 2 + reach * 0.22);
  const path: Vec3[] = [];
  for (let i = 0; i <= ARC_SEGMENTS; i++) {
    const t = i / ARC_SEGMENTS;
    const p = lerp3(from, to, t);
    p[2] += lift * 4 * t * (1 - t);
    path.push(p);
  }
  return path;
}

/** A hose laid on the ground from the pump outlet to the base of the facade, with a gentle bend. */
function hosePath(outlet: Vec3, target: Vec3): Vec3[] {
  const base: Vec3 = [target[0], target[1], 0.15];
  const start: Vec3 = [outlet[0], outlet[1], 0.15];
  const drop: Vec3 = outlet;
  const path: Vec3[] = [drop, start];
  // Bend sideways by a fixed fraction of the run (deterministic, no noise).
  const dx = base[0] - start[0], dy = base[1] - start[1];
  for (let i = 1; i <= 8; i++) {
    const t = i / 8;
    const bend = Math.sin(t * Math.PI) * 0.12;
    path.push([start[0] + dx * t - dy * bend, start[1] + dy * t + dx * bend, 0.15]);
  }
  return path;
}

// ---------------------------------------------------------------- frame data

export interface FireResponseRenderData {
  scale: number;
  trucks: readonly FireTruckFrame[];
  lenses: Lens[];
  glows: Glow[];
  arcs: WaterArc[];
  hoses: Hose[];
  droplets: Droplet[];
  splash: Droplet[];
}

const DROPLETS_PER_ARC = 14;
const SPLASH_PER_ARC = 12;

/** All instance data for one frame. Pure: the same frames, time and zoom give identical output. */
export function fireResponseRenderData(frames: readonly FireTruckFrame[], time: number, zoom: number): FireResponseRenderData {
  const scale = fireTruckScale(zoom);
  const lenses: Lens[] = [], glows: Glow[] = [], arcs: WaterArc[] = [], hoses: Hose[] = [], droplets: Droplet[] = [], splash: Droplet[] = [];
  for (const frame of frames) {
    const offset = idOffset(frame.id);
    const orientation: Vec3 = [0, -frame.bearing, 0];
    // Lights flash on the way in and while on scene; a departing unit runs dark.
    const flashing = frame.phase !== 'leaving';
    for (const spec of LENSES) {
      const on = flashing && lightOn(spec.group, time, offset);
      const position = truckPoint(frame, spec.local, scale);
      lenses.push({ position, half: spec.half, orientation, on, color: on ? [...spec.color, 255] : dim(spec.color) });
      if (on) glows.push({ position, color: [...spec.color, spec.color === WHITE ? 150 : 170], radius: spec.local[2] > 3 ? 9 : 6 });
    }
    if (frame.phase === 'fighting' && frame.waterTarget) {
      const target = frame.waterTarget;
      const nozzle = truckPoint(frame, NOZZLE, scale);
      const path = waterArcPath(nozzle, target);
      arcs.push({ id: frame.id, path });
      hoses.push({ id: frame.id, path: hosePath(truckPoint(frame, DISCHARGE, scale), target) });
      // Droplets travel along the arc; positions depend only on time.
      for (let k = 0; k < DROPLETS_PER_ARC; k++) {
        const t = ((time * 0.9 + k / DROPLETS_PER_ARC + offset) % 1 + 1) % 1;
        const i = t * ARC_SEGMENTS, i0 = Math.min(ARC_SEGMENTS - 1, Math.floor(i));
        droplets.push({ position: lerp3(path[i0], path[i0 + 1], i - i0), radius: 0.35 + 0.25 * ((k * 7) % 3) / 2, color: [236, 248, 255, 235] });
      }
      // Splash: a ring of spray around the hit point, pulsing outwards.
      const cosLat = Math.cos((target[1] * Math.PI) / 180);
      for (let k = 0; k < SPLASH_PER_ARC; k++) {
        const pulse = ((time * 1.4 + k / SPLASH_PER_ARC) % 1 + 1) % 1;
        const a = (k / SPLASH_PER_ARC) * 2 * Math.PI + k * 0.7;
        const r = 0.6 + 2.2 * pulse;
        splash.push({
          position: [target[0] + (Math.cos(a) * r) / (METRES_PER_DEGREE * cosLat), target[1] + (Math.sin(a) * r) / METRES_PER_DEGREE, Math.max(0.3, target[2] - pulse * 2.5 + Math.sin(a * 2) * 0.6)],
          radius: 0.5 + 0.6 * (1 - pulse),
          color: [214, 236, 252, Math.round(230 * (1 - pulse * 0.7))],
        });
      }
    }
  }
  return { scale, trucks: frames, lenses, glows, arcs, hoses, droplets, splash };
}

// ---------------------------------------------------------------- layers

const ADDITIVE = {
  depthWriteEnabled: false,
  depthCompare: 'less-equal',
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'zero',
  blendAlphaDstFactor: 'one',
} as const;

const slot = { slot: 'middle' } as Record<string, unknown>; // read by @deck.gl/mapbox for Mapbox Standard

/** Fire engines, their lights and, while fighting, hose and water. Empty when there are no trucks. */
export function fireResponseLayers(frames: readonly FireTruckFrame[], time: number, zoom: number): Layer[] {
  if (!frames.length) return [];
  const d = fireResponseRenderData(frames, time, zoom);
  const { scale } = d;
  const fighting = d.arcs.length > 0;
  const layers: Layer[] = [
    new SimpleMeshLayer<FireTruckFrame>({
      id: 'fire-response-trucks',
      data: d.trucks as FireTruckFrame[],
      mesh: FIRE_TRUCK_MESH as never,
      sizeScale: scale,
      getPosition: (f) => [f.position[0], f.position[1], 0],
      getOrientation: (f) => [0, -f.bearing, 0],
      getColor: [255, 255, 255, 255],
      material: { ambient: 0.55, diffuse: 0.65, shininess: 48, specularColor: [90, 90, 90] },
      pickable: false,
      updateTriggers: { getPosition: time, getOrientation: time },
      ...slot,
    }),
    new SimpleMeshLayer<Lens>({
      id: 'fire-response-lenses',
      data: d.lenses,
      mesh: LENS,
      sizeScale: scale,
      getPosition: (l) => l.position,
      getScale: (l) => l.half,
      getOrientation: (l) => l.orientation,
      getColor: (l) => l.color,
      material: { unlit: true } as never,
      pickable: false,
      ...slot,
    }),
    new ScatterplotLayer<Glow>({
      id: 'fire-response-light-glow',
      data: d.glows,
      visible: d.glows.length > 0,
      getPosition: (g) => g.position,
      getRadius: (g) => g.radius,
      radiusUnits: 'pixels',
      getFillColor: (g) => g.color,
      billboard: true,
      pickable: false,
      parameters: ADDITIVE,
      ...slot,
    }),
  ];
  if (!fighting) return layers;
  layers.push(
    new PathLayer<Hose>({
      id: 'fire-response-hoses',
      data: d.hoses,
      getPath: (h) => h.path,
      getColor: [196, 150, 52, 255],
      getWidth: 0.18 * Math.min(scale, 2),
      widthUnits: 'meters',
      widthMinPixels: 2,
      jointRounded: true,
      capRounded: true,
      pickable: false,
      parameters: { depthBias: -1, depthBiasSlopeScale: -400 },
      ...slot,
    }),
    // Water arc: a darker blue edge under a pale core, so it reads on light and dark base maps.
    new PathLayer<WaterArc>({
      id: 'fire-response-water-edge',
      data: d.arcs,
      getPath: (a) => a.path,
      getColor: [36, 104, 186, 235],
      getWidth: 0.9,
      widthUnits: 'meters',
      widthMinPixels: 4,
      billboard: true,
      jointRounded: true,
      capRounded: true,
      pickable: false,
      ...slot,
    }),
    new PathLayer<WaterArc>({
      id: 'fire-response-water-core',
      data: d.arcs,
      getPath: (a) => a.path,
      getColor: [214, 238, 255, 245],
      getWidth: 0.45,
      widthUnits: 'meters',
      widthMinPixels: 2,
      billboard: true,
      jointRounded: true,
      capRounded: true,
      pickable: false,
      ...slot,
    }),
    new ScatterplotLayer<Droplet>({
      id: 'fire-response-water-droplets',
      data: d.droplets,
      getPosition: (p) => p.position,
      getRadius: (p) => p.radius,
      radiusUnits: 'meters',
      radiusMinPixels: 1.5,
      getFillColor: (p) => p.color,
      stroked: true,
      getLineColor: [36, 104, 186, 200],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      billboard: true,
      pickable: false,
      ...slot,
    }),
    new ScatterplotLayer<Droplet>({
      id: 'fire-response-water-splash',
      data: d.splash,
      getPosition: (p) => p.position,
      getRadius: (p) => p.radius,
      radiusUnits: 'meters',
      radiusMinPixels: 2,
      getFillColor: (p) => p.color,
      stroked: true,
      getLineColor: [60, 128, 200, 180],
      lineWidthUnits: 'pixels',
      getLineWidth: 1,
      billboard: true,
      pickable: false,
      parameters: { depthCompare: 'less-equal', depthWriteEnabled: false },
      ...slot,
    }),
  );
  return layers;
}
