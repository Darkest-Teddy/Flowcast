// Stylized active effects for modeled fire, earthquake and meteor scenarios: flames and smoke,
// dust plumes and falling debris, a falling fiery body, impact flash and shockwave. Every value is
// a pure function of the simulation clock, the run and the shared damage frames (no stored state,
// no Math.random, no wall clock), so pausing, seeking or rewinding redraws the exact same frame.
// The effects are illustrative. Casualty events and markers are handled separately.
// Persistent destruction (rubble, crater, cracks) lives in destruction.ts.
import type { Layer } from '@deck.gl/core';
import { IconLayer, ScatterplotLayer } from '@deck.gl/layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CubeGeometry } from '@luma.gl/engine';
import type { BuildingDamageFrame } from '../sim/disasterDamage';
import type { DisasterKind, IncidentHazard } from '../sim/incidents';

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];
/** Accent per kind, chosen to stay distinct from the yellow assembly marker on the dark basemap. */
export const DISASTER_COLORS: Record<DisasterKind, RGB> = {
  fire: [255, 128, 48],
  earthquake: [176, 148, 255],
  meteor: [255, 92, 132],
};

/** Sim seconds of the meteor's visible fall before the impact (incident.start). */
export const METEOR_APPROACH_SECONDS = 45;
const END_FADE_SECONDS = 90;
const QUAKE_RING_PERIOD = 24;
const METRES_PER_DEGREE = 111320;
/** Fixed illustrative wind (unit vector east, north) for smoke drift. */
const WIND: [number, number] = [0.86, 0.5];

// ---------------------------------------------------------------- shared helpers

/** Deterministic [0, 1) hash of an integer index and salt. */
export function hash(index: number, salt: number): number {
  let h = Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(salt + 1, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}
export const frac = (x: number) => x - Math.floor(x);
export const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
export const easeOut = (u: number) => 1 - (1 - clamp01(u)) ** 3;
export const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const alpha = (c: RGB, a: number): RGBA => [c[0], c[1], c[2], Math.round(Math.min(255, Math.max(0, a)))];
export const seedInt = (seed: number) => Math.floor(seed * 1e6);

export function offset(center: [number, number], east: number, north: number): [number, number] {
  return [
    center[0] + east / (METRES_PER_DEGREE * Math.cos(center[1] * Math.PI / 180)),
    center[1] + north / METRES_PER_DEGREE,
  ];
}

/** A footprint ring in local metres around its vertex mean. */
export interface LocalShape {
  center: [number, number];
  ring: [number, number][];
  area: number;
  /** sqrt(area), a length scale for sizing effects. */
  size: number;
  bounds: [number, number, number, number];
}
const shapes = new WeakMap<object, LocalShape>();
export function localShape(polygon: [number, number][], center?: [number, number]): LocalShape {
  const cached = shapes.get(polygon);
  if (cached) return cached;
  const c: [number, number] = center ?? [0, 0];
  if (!center) for (const v of polygon) { c[0] += v[0] / polygon.length; c[1] += v[1] / polygon.length; }
  const kx = METRES_PER_DEGREE * Math.cos(c[1] * Math.PI / 180);
  const ring = polygon.map(v => [(v[0] - c[0]) * kx, (v[1] - c[1]) * METRES_PER_DEGREE] as [number, number]);
  let area = 0;
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    area += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]) / 2;
    bounds[0] = Math.min(bounds[0], ring[i][0]); bounds[1] = Math.min(bounds[1], ring[i][1]);
    bounds[2] = Math.max(bounds[2], ring[i][0]); bounds[3] = Math.max(bounds[3], ring[i][1]);
  }
  area = Math.max(Math.abs(area), 25);
  const shape = { center: c, ring, area, size: Math.sqrt(area), bounds };
  shapes.set(polygon, shape);
  return shape;
}
/** A disc stand-in when no footprint is known. */
export function discShape(center: [number, number], radius: number): LocalShape {
  const ring: [number, number][] = [];
  for (let i = 0; i < 12; i++) ring.push([Math.cos(i * Math.PI / 6) * radius, Math.sin(i * Math.PI / 6) * radius]);
  const area = Math.PI * radius * radius;
  return { center, ring, area, size: Math.sqrt(area), bounds: [-radius, -radius, radius, radius] };
}
export const at = (shape: LocalShape, east: number, north: number, z: number): [number, number, number] =>
  [...offset(shape.center, east, north), z] as [number, number, number];

function insideRing(x: number, y: number, ring: [number, number][]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function edgeDistance(x: number, y: number, ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const ax = ring[j][0] - x, ay = ring[j][1] - y, dx = ring[i][0] - ring[j][0], dy = ring[i][1] - ring[j][1];
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : clamp01(-(ax * dx + ay * dy) / l2);
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

export interface ShapePoint { x: number; y: number; inside: boolean; edge: number }
const pointCache = new WeakMap<LocalShape, Map<string, ShapePoint[]>>();
/** Deterministic scatter inside the footprint or within `spill` metres outside it. Cached per shape. */
export function scatter(shape: LocalShape, count: number, salt: number, spill: number): ShapePoint[] {
  let bySalt = pointCache.get(shape);
  if (!bySalt) { bySalt = new Map(); pointCache.set(shape, bySalt); }
  const key = `${count}:${salt}:${spill.toFixed(2)}`;
  const cached = bySalt.get(key);
  if (cached) return cached;
  const [x0, y0, x1, y1] = shape.bounds;
  const points: ShapePoint[] = [];
  for (let i = 0; i < count; i++) {
    let found: ShapePoint = { x: 0, y: 0, inside: insideRing(0, 0, shape.ring), edge: 0 };
    for (let attempt = 0; attempt < 14; attempt++) {
      const x = x0 - spill + (x1 - x0 + 2 * spill) * hash(i * 17 + attempt, salt);
      const y = y0 - spill + (y1 - y0 + 2 * spill) * hash(i * 17 + attempt, salt + 1);
      const inside = insideRing(x, y, shape.ring);
      const edge = edgeDistance(x, y, shape.ring);
      if (inside || edge <= spill) { found = { x, y, inside, edge }; break; }
    }
    points.push(found);
  }
  if (bySalt.size > 32) bySalt.clear();
  bySalt.set(key, points);
  return points;
}
/** A point on the footprint edge and its outward direction. */
export function perimeter(shape: LocalShape, u: number, v: number): { x: number; y: number; nx: number; ny: number } {
  const n = shape.ring.length;
  const i = Math.min(n - 1, Math.floor(u * n)), a = shape.ring[i], b = shape.ring[(i + 1) % n];
  const x = a[0] + (b[0] - a[0]) * v, y = a[1] + (b[1] - a[1]) * v;
  const l = Math.hypot(x, y) || 1;
  return { x, y, nx: x / l, ny: y / l };
}

// ---------------------------------------------------------------- sprites and render parameters

let atlas: string | null = null;
/** One small canvas atlas (glow, lumpy puff, flame tongue), built once. */
export function effectAtlas(): string {
  if (atlas !== null) return atlas;
  if (typeof document === 'undefined') return (atlas = '');
  const canvas = document.createElement('canvas');
  canvas.width = 320; canvas.height = 128;
  const g = canvas.getContext('2d')!;
  const glow = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  for (let i = 0; i <= 16; i++) glow.addColorStop(i / 16, `rgba(255,255,255,${Math.exp(-((i / 16) ** 2) * 5.5).toFixed(3)})`);
  g.fillStyle = glow;
  g.fillRect(0, 0, 128, 128);
  const image = g.createImageData(192, 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 192; x++) {
    let a = 0;
    if (x < 128) {
      // Puff: soft disc with a lumpy edge.
      const dx = (x - 64) / 62, dy = (y - 64) / 62, r = Math.hypot(dx, dy), th = Math.atan2(dy, dx);
      const lump = 0.08 * Math.sin(3 * th + 1) + 0.06 * Math.sin(5 * th + 2.3) + 0.04 * Math.sin(9 * th + 0.7);
      a = (1 - smooth(0.35, 0.95 + lump, r)) * (0.75 + 0.25 * Math.cos(r * 6 + th * 2));
    } else {
      // Flame tongue: wide rounded base, narrowing to a tip at the top.
      const u = (x - 128 + 0.5) / 64 - 0.5, v = 1 - (y + 0.5) / 128;
      const half = 0.46 * Math.sin(Math.PI * Math.min(1, 0.18 + 0.82 * (1 - v)) ** 0.9) * (v < 0.12 ? Math.sqrt(v / 0.12) : 1);
      a = half > 0 ? clamp01(1 - Math.abs(u) / half) ** 1.4 * (1 - smooth(0.75, 1, v) * 0.6) : 0;
    }
    const k = (y * 192 + x) * 4;
    image.data[k] = image.data[k + 1] = image.data[k + 2] = 255;
    image.data[k + 3] = Math.round(255 * clamp01(a));
  }
  g.putImageData(image, 128, 0);
  atlas = canvas.toDataURL();
  return atlas;
}
const MAPPING = {
  glow: { x: 0, y: 0, width: 128, height: 128, mask: true },
  puff: { x: 128, y: 0, width: 128, height: 128, mask: true },
  flame: { x: 256, y: 0, width: 64, height: 128, mask: true, anchorY: 128 },
};
type Icon = keyof typeof MAPPING;

/** Light adds to the scene, never writes depth, and is still hidden by buildings in front of it. */
export const ADDITIVE = {
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
/** Smoke and dust: ordinary alpha blending, depth-tested, no depth writes. */
export const TRANSLUCENT = { depthWriteEnabled: false, depthCompare: 'less-equal' } as const;
/** Ground decals: depth-tested but pulled forward so they beat the ground and building bases. */
export const ON_SURFACE = { ...TRANSLUCENT, depthBias: -1, depthBiasSlopeScale: -1600 } as const;
export const ADDITIVE_ON_SURFACE = { ...ADDITIVE, depthBias: -1, depthBiasSlopeScale: -1600 } as const;

export interface Sprite { position: [number, number, number]; size: number; color: RGBA; icon: Icon }
export function spriteLayer(id: string, data: Sprite[], parameters: object, billboard = true, minPixels = 1): Layer {
  return new IconLayer<Sprite>({
    id,
    data,
    iconAtlas: effectAtlas(),
    iconMapping: MAPPING,
    getIcon: d => d.icon,
    getPosition: d => d.position,
    getSize: d => d.size,
    getColor: d => d.color,
    sizeUnits: 'meters',
    sizeMinPixels: minPixels,
    billboard,
    alphaCutoff: 0.01,
    pickable: false,
    parameters,
    // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
    slot: 'middle',
  });
}

export const CUBE = new CubeGeometry(); // spans -1..1; getScale gives half-dimensions in metres
export interface Chunk { position: [number, number, number]; scale: [number, number, number]; orientation: [number, number, number]; color: RGB }
export function chunkLayer(id: string, data: Chunk[]): Layer {
  return new SimpleMeshLayer<Chunk>({
    id,
    data,
    mesh: CUBE,
    getPosition: d => d.position,
    getScale: d => d.scale,
    getOrientation: d => d.orientation,
    getColor: d => d.color,
    material: { ambient: 0.55, diffuse: 0.65, shininess: 4, specularColor: [30, 30, 30] },
    pickable: false,
    // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
    slot: 'middle',
  });
}

export interface Ring { position: [number, number, number]; radius: number; fill: RGBA; line: RGBA; width: number }
export function ringLayer(id: string, data: Ring[], widthUnits: 'pixels' | 'meters' = 'pixels'): Layer {
  return new ScatterplotLayer<Ring>({
    id,
    data,
    getPosition: d => d.position,
    getRadius: d => d.radius,
    radiusUnits: 'meters',
    filled: true,
    stroked: true,
    getFillColor: d => d.fill,
    getLineColor: d => d.line,
    getLineWidth: d => d.width,
    lineWidthUnits: widthUnits,
    pickable: false,
    parameters: ON_SURFACE,
    // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
    slot: 'middle',
  });
}

// ---------------------------------------------------------------- active effects

export interface DisasterFrame {
  kind: DisasterKind;
  hazard: IncidentHazard;
  center: [number, number];
  /** Roof height of the primary building in metres, used when no damage frame covers it. */
  baseHeight: number;
  /** Primary building footprint, used when no damage frame covers it. */
  footprint?: [number, number][] | null;
  start: number;
  time: number;
  /** Shared damage frames for this time (damageAt). */
  damage: readonly BuildingDamageFrame[];
}

/** The meteor's approach path: from high and off to one side, down to the impact point. */
export function meteorPath(center: [number, number], start: number) {
  const angle = hash(Math.floor(start), 41) * 2 * Math.PI;
  return { dx: Math.cos(angle), dy: Math.sin(angle), horizontal: 800, altitude: 1000, center };
}
export const craterRadius = (impactRadius: number) => Math.min(40, Math.max(10, impactRadius * 0.22));

/** Active-effect layers for one frame; [] outside [start (minus the meteor approach), activeUntil). */
export function disasterLayers(frame: DisasterFrame): Layer[] {
  const { kind, hazard, start, time } = frame;
  const lead = kind === 'meteor' ? METEOR_APPROACH_SECONDS : 0;
  if (time < start - lead || time >= hazard.activeUntil) return [];
  const fadeEnd = clamp01((hazard.activeUntil - time) / END_FADE_SECONDS);
  if (kind === 'fire') return fireLayers(frame, fadeEnd);
  if (kind === 'earthquake') return quakeLayers(frame, fadeEnd);
  return meteorLayers(frame, fadeEnd);
}

function fireLayers(frame: DisasterFrame, fadeEnd: number): Layer[] {
  const { time, start, damage, hazard } = frame;
  const dt = time - start;
  const target = damage.find(d => d.kind === 'fire') ?? null;
  const shape = target ? localShape(target.polygon, target.center)
    : frame.footprint && frame.footprint.length >= 3 ? localShape(frame.footprint) : discShape(frame.center, 10);
  const roof = Math.max(3, target ? target.remainingHeight : frame.baseHeight);
  const seed = seedInt(target?.seed ?? 0.5);
  // Visible from the first frame, fully developed after about 90 sim seconds.
  const grow = 0.45 + 0.55 * smooth(0, 90, dt);
  const intensity = grow * fadeEnd;
  const scale = Math.min(14, Math.max(5, shape.size / 5));
  const sites = scatter(shape, Math.min(12, Math.max(5, Math.round(shape.area / 150))), seed, 0);

  // Flames are drawn with ordinary blending (bright cores added on top), so they read on light
  // and dark basemaps alike.
  const flames: Sprite[] = [], cores: Sprite[] = [], smoke: Sprite[] = [];
  const flame = (position: [number, number, number], h: number, i: number) => {
    flames.push({ icon: 'flame', position: [position[0], position[1], position[2] + h * 0.1], size: h * 1.3, color: [200, 44, 12, 215] });
    flames.push({ icon: 'flame', position, size: h, color: [255, 118, 24, 235] });
    cores.push({ icon: 'flame', position, size: h * 0.55, color: [255, 226, 140, 230] });
    if (i % 2 === 0) cores.push({ icon: 'glow', position: [position[0], position[1], position[2] + h * 0.3], size: h * 1.8, color: [255, 120, 40, Math.round(110 * intensity)] });
  };
  const flick = (i: number, salt: number) => {
    const p = hash(i, seed + salt) * 6.28;
    return 0.8 + 0.12 * Math.sin(dt * 1.9 + p) + 0.08 * Math.sin(dt * 5.3 + 2 * p);
  };
  // Roof fire.
  sites.forEach((site, i) => {
    const lit = i === 0 ? 1 : clamp01((grow - 0.45 - hash(i, seed + 2) * 0.45) / 0.2);
    if (lit <= 0) return;
    flame(at(shape, site.x, site.y, roof + 0.2), scale * (0.9 + 0.7 * hash(i, seed + 4)) * lit * flick(i, 3) * fadeEnd, i);
  });
  // Window flames on the facades at several floor heights, pushed just outside the wall so the
  // building model doesn't hide the ones facing the camera.
  const floors = Math.max(1, Math.floor(roof / 3.5));
  const windows = Math.min(18, 6 + floors);
  const windowSize = Math.min(9, Math.max(3.5, roof / 7));
  for (let i = 0; i < windows; i++) {
    const lit = i < 4 ? 1 : clamp01((grow - 0.45 - hash(i, seed + 12) * 0.5) / 0.15);
    if (lit <= 0) continue;
    const p = perimeter(shape, hash(i, seed + 13), 0.15 + 0.7 * hash(i, seed + 14));
    const floor = Math.floor(hash(i, seed + 15) * floors);
    const z = Math.min(roof - 1, 2 + floor * 3.5);
    const h = windowSize * (0.8 + 0.5 * hash(i, seed + 16)) * lit * flick(i, 17) * fadeEnd;
    flame(at(shape, p.x + p.nx * 1.2, p.y + p.ny * 1.2, z), h, i);
    // Smoke pouring out of the window and climbing the facade.
    for (let k = 0; k < 2; k++) {
      const u = frac(dt / 120 + hash(i * 2 + k, seed + 18));
      const out = 1.5 + u * 6, rise = u * (roof - z + 25), drift = u * u * 30;
      const shade = Math.round(52 + 40 * u);
      smoke.push({ icon: 'puff', position: at(shape, p.x + p.nx * out + WIND[0] * drift, p.y + p.ny * out + WIND[1] * drift, z + h * 0.6 + rise),
        size: windowSize * 1.4 + u * 18, color: [shade, shade - 2, shade - 4, Math.round(185 * Math.sin(Math.PI * u) ** 0.6 * intensity)] });
    }
  }
  // Embers rise quickly from the roof sites and fade.
  for (let i = 0; i < 20; i++) {
    const u = frac(dt / 34 + hash(i, seed + 5));
    const site = sites[Math.floor(hash(i, seed + 6) * sites.length)];
    const sway = Math.sin(u * 6.28 + i) * 2.5, drift = u * 18;
    cores.push({ icon: 'glow', position: at(shape, site.x + WIND[0] * drift + sway, site.y + WIND[1] * drift, roof + 2 + u * (20 + scale * 2.5)),
      size: 1 + 1.5 * (1 - u), color: [255, Math.round(200 - 100 * u), 70, Math.round(230 * Math.sin(Math.PI * u) * intensity)] });
  }
  // Roof smoke column: dark, growing puffs that rise and lean downwind.
  for (let i = 0; i < 26; i++) {
    const u = frac(dt / 300 + hash(i, seed + 7));
    const site = sites[Math.floor(hash(i, seed + 8) * sites.length)];
    const drift = u * u * 140, shade = Math.round(44 + 46 * u);
    smoke.push({ icon: 'puff', position: at(shape, site.x + WIND[0] * drift, site.y + WIND[1] * drift, roof + scale * 0.9 + u * 170),
      size: scale * 1.3 + u * 55, color: [shade, shade - 2, shade - 4, Math.round(185 * Math.sin(Math.PI * u) ** 0.7 * (1 - 0.4 * u) * intensity)] });
  }
  // Ground-level smoke drifting off the base.
  for (let i = 0; i < 8; i++) {
    const u = frac(dt / 160 + hash(i, seed + 9));
    const p = perimeter(shape, hash(i, seed + 10), hash(i, seed + 11));
    const out = 3 + u * 14;
    smoke.push({ icon: 'puff', position: at(shape, p.x + p.nx * out + WIND[0] * u * 25, p.y + p.ny * out + WIND[1] * u * 25, 2 + u * 10),
      size: 7 + u * 16, color: [70, 66, 62, Math.round(140 * Math.sin(Math.PI * u) * intensity)] });
  }
  const layers: Layer[] = [];
  if (hazard.radiusMetres > 0) layers.push(ringLayer('incident-fire-area', [{ position: [...frame.center, 0.4], radius: hazard.radiusMetres,
    fill: alpha(DISASTER_COLORS.fire, 14 * fadeEnd), line: alpha(DISASTER_COLORS.fire, 170 * fadeEnd), width: 2 }]));
  layers.push(spriteLayer('incident-fire-roofglow', [{ icon: 'glow', position: at(shape, 0, 0, roof + 0.4), size: shape.size * 1.7,
    color: [255, 120, 40, Math.round(150 * intensity)] }], ADDITIVE_ON_SURFACE, false));
  layers.push(spriteLayer('incident-fire-flames', flames, TRANSLUCENT, true, 6));
  layers.push(spriteLayer('incident-fire-smoke', smoke, TRANSLUCENT, true, 4));
  layers.push(spriteLayer('incident-fire-cores', cores, ADDITIVE, true, 2));
  return layers;
}

const DUST: RGB = [178, 158, 128];
const CONCRETE: RGB = [150, 146, 140];

function quakeLayers(frame: DisasterFrame, fadeEnd: number): Layer[] {
  const { time, start, hazard, damage, center } = frame;
  const dt = time - start;
  const shaking = time < hazard.responseStartsAt;
  const env = (shaking ? 1 : Math.exp(-(time - hazard.responseStartsAt) / 180)) * fadeEnd;
  const [r, g, b] = DISASTER_COLORS.earthquake;
  const ringRadius = hazard.radiusMetres > 0 ? hazard.radiusMetres : 40;
  const rings: Ring[] = [];
  if (shaking) for (let k = 0; k < 3; k++) {
    const u = frac(dt / QUAKE_RING_PERIOD + k / 3);
    rings.push({ position: [...center, 0.4], radius: ringRadius * (0.08 + 1.1 * u), fill: [r, g, b, 0], line: [r, g, b, Math.round(230 * (1 - u) ** 1.5)], width: 3 });
  }
  if (hazard.radiusMetres > 0) rings.push({ position: [...center, 0.3], radius: hazard.radiusMetres,
    fill: [r, g, b, Math.round((shaking ? 12 : 20) * fadeEnd)], line: [r, g, b, Math.round(180 * fadeEnd)], width: 2 });

  const dust: Sprite[] = [], skirts: Sprite[] = [], debris: Chunk[] = [];
  const buildings = [...damage].filter(d => d.kind === 'earthquake')
    .sort((a, b) => b.severity - a.severity || (a.id < b.id ? -1 : 1)).slice(0, 24);
  for (const bld of buildings) {
    if (env <= 0.01) break;
    const shape = localShape(bld.polygon, bld.center);
    const s = seedInt(bld.seed);
    const collapsing = bld.finalCollapse > 0 && bld.collapse > 0 && bld.collapse < bld.finalCollapse - 1e-3;
    const strength = env * (0.35 + 0.65 * bld.severity) * (collapsing ? 1.3 : 1);
    const puffs = 3 + Math.round(4 * bld.severity) + (bld.finalCollapse > 0.5 ? 3 : 0);
    for (let k = 0; k < puffs; k++) {
      const u = frac(dt / 70 + hash(k, s + 1));
      const p = perimeter(shape, hash(k, s + 2), hash(k, s + 3));
      const out = 2 + u * 9;
      dust.push({ icon: 'puff', position: at(shape, p.x + p.nx * out, p.y + p.ny * out, 2 + u * (bld.height * 0.55 + 10)),
        size: (6 + u * 22) * (0.6 + 0.6 * bld.severity), color: alpha(DUST, 165 * Math.sin(Math.PI * u) ** 0.8 * strength) });
    }
    skirts.push({ icon: 'puff', position: at(shape, 0, 0, 0.5), size: shape.size * 1.5 + 12, color: alpha(DUST, 120 * strength * bld.severity) });
    // Falling pieces from the roof edge while the building gives way.
    if (bld.finalCollapse > 0 && (shaking || collapsing) && debris.length < 160) {
      for (let k = 0; k < 8; k++) {
        const u = frac(dt / 9 + hash(k, s + 4));
        const p = perimeter(shape, hash(k, s + 5), hash(k, s + 6));
        const z0 = Math.max(2, bld.remainingHeight) * (0.45 + 0.55 * hash(k, s + 7));
        const out = 0.8 + u * (2 + 4 * hash(k, s + 8));
        const half = 0.3 + 0.7 * hash(k, s + 9);
        debris.push({ position: at(shape, p.x + p.nx * out, p.y + p.ny * out, half + (z0 - half) * (1 - u * u)),
          scale: [half, half * 0.8, half * 0.6], orientation: [hash(k, s + 10) * 360 + u * 420, hash(k, s + 11) * 360, u * 300], color: CONCRETE });
      }
    }
  }
  const layers: Layer[] = [ringLayer('incident-earthquake-rings', rings)];
  if (skirts.length) layers.push(spriteLayer('incident-earthquake-skirts', skirts, ON_SURFACE, false));
  if (dust.length) layers.push(spriteLayer('incident-earthquake-dust', dust, TRANSLUCENT));
  if (debris.length) layers.push(chunkLayer('incident-earthquake-debris', debris));
  return layers;
}

function meteorLayers(frame: DisasterFrame, fadeEnd: number): Layer[] {
  const { time, start, hazard, center } = frame;
  const dt = time - start;
  const impactRadius = hazard.radiusMetres > 0 ? hazard.radiusMetres : 40;
  const ground = discShape(center, 1);
  const hot: Sprite[] = [], smoke: Sprite[] = [], flat: Sprite[] = [], rings: Ring[] = [], rocks: Chunk[] = [];
  const salt = Math.floor(start);

  if (dt < 0) {
    const path = meteorPath(center, start);
    const s = clamp01((dt + METEOR_APPROACH_SECONDS) / METEOR_APPROACH_SECONDS) ** 1.7;
    const point = (q: number) => {
      const k = 1 - clamp01(q);
      return at(ground, path.dx * path.horizontal * k, path.dy * path.horizontal * k, Math.max(2, path.altitude * k));
    };
    hot.push({ icon: 'glow', position: point(s), size: 150, color: [255, 90, 40, 130] });
    // A normally blended body under the additive glow, so the meteor reads on a light basemap too.
    smoke.push({ icon: 'glow', position: point(s), size: 60, color: [255, 110, 30, 255] });
    hot.push({ icon: 'glow', position: point(s), size: 70, color: [255, 180, 90, 220] });
    hot.push({ icon: 'glow', position: point(s), size: 26, color: [255, 250, 230, 255] });
    for (let k = 1; k <= 26; k++) {
      const q = s - k * 0.011;
      if (q < 0) break;
      const fade = 1 - k / 27;
      hot.push({ icon: 'glow', position: point(q), size: 8 + 30 * fade, color: [255, Math.round(80 + 120 * fade), Math.round(30 + 60 * fade), Math.round(220 * fade)] });
    }
    for (let k = 0; k < 18; k++) {
      const q = s - 0.05 - k * 0.028;
      if (q < 0) break;
      const age = k / 18;
      const shade = Math.round(80 + 40 * age);
      smoke.push({ icon: 'puff', position: point(q), size: 22 + 40 * age, color: [shade, shade - 4, shade - 8, Math.round(140 * (1 - age))] });
    }
    flat.push({ icon: 'glow', position: [...center, 0.5], size: impactRadius * (0.5 + s), color: [255, 140, 70, Math.round(140 * s ** 3)] });
  } else {
    const cr = craterRadius(impactRadius);
    // Flash and fireball.
    if (dt < 10) hot.push({ icon: 'glow', position: at(ground, 0, 0, 25), size: impactRadius * 3.5 * easeOut(dt / 1.5 + 0.2),
      color: [255, 250, 235, Math.round(255 * (1 - dt / 10) ** 2)] });
    if (dt < 60) for (let k = 0; k < 8; k++) {
      const u = dt / 60, a = hash(k, salt + 1) * 6.28, d = cr * 0.6 * hash(k, salt + 2);
      hot.push({ icon: 'glow', position: at(ground, Math.cos(a) * d, Math.sin(a) * d, 8 + u * (40 + 70 * hash(k, salt + 3))),
        size: cr * 2.4 * (0.6 + u), color: [255, Math.round(150 - 90 * u), 40, Math.round(230 * (1 - u) ** 1.5)] });
      smoke.push({ icon: 'puff', position: at(ground, Math.cos(a) * d, Math.sin(a) * d, 8 + u * (40 + 70 * hash(k, salt + 3))),
        size: cr * 1.6 * (0.6 + u), color: [Math.round(255 - 150 * u), Math.round(110 - 50 * u), 30, Math.round(220 * (1 - u))] });
    }
    if (dt < 6) flat.push({ icon: 'glow', position: [...center, 0.5], size: impactRadius * 2.4, color: [255, 200, 140, Math.round(220 * (1 - dt / 6))] });
    // Shockwave rings on the ground.
    if (dt < 40) for (let k = 0; k < 2; k++) {
      const u = clamp01((dt - k * 4) / 40);
      if (u <= 0) continue;
      rings.push({ position: [...center, 0.5], radius: cr + (impactRadius * 2.6 - cr) * easeOut(u), fill: [255, 210, 180, Math.round(30 * (1 - u))],
        line: [255, 225, 200, Math.round((k ? 140 : 240) * (1 - u) ** 1.3)], width: k ? 2 : 4 });
    }
    // Base surge: a dust ring that runs out with the shockwave and settles.
    if (dt < 400) for (let k = 0; k < 28; k++) {
      const a = (k + hash(k, salt + 4)) / 28 * 6.28;
      const d = cr * 1.2 + impactRadius * 1.4 * easeOut(dt / 60) * (0.8 + 0.3 * hash(k, salt + 5));
      smoke.push({ icon: 'puff', position: at(ground, Math.cos(a) * d, Math.sin(a) * d, 3 + dt / 400 * 22),
        size: 12 + 30 * clamp01(dt / 120), color: alpha(DUST, 150 * (1 - dt / 400) * fadeEnd) });
    }
    // Rising column with a spreading cap.
    const column = (1 - smooth(600, 1200, dt)) * smooth(0, 8, dt) * fadeEnd;
    if (column > 0) for (let k = 0; k < 24; k++) {
      const u = frac(dt / 360 + hash(k, salt + 6));
      const a = hash(k, salt + 7) * 6.28, d = cr * 0.4 + (u > 0.65 ? (u - 0.65) * cr * 5 : 0);
      const shade = Math.round(66 + 30 * u);
      smoke.push({ icon: 'puff', position: at(ground, Math.cos(a) * d + WIND[0] * u * 50, Math.sin(a) * d + WIND[1] * u * 50, 6 + u * 240),
        size: 16 + u * 45, color: [shade, shade - 6, shade - 10, Math.round(170 * Math.sin(Math.PI * u) ** 0.7 * column)] });
    }
    // Ejecta: rocks and sparks thrown out on arcs; the rocks come to rest as crater rubble (destruction.ts).
    if (dt < 16) for (let k = 0; k < 64; k++) {
      const flight = 6 + 8 * hash(k, salt + 8), u = dt / flight;
      if (u >= 1) continue;
      const a = hash(k, salt + 9) * 6.28, d = cr * (1.1 + 2 * hash(k, salt + 10)) * u;
      const apex = 15 + 70 * hash(k, salt + 11), z = 1 + 4 * apex * u * (1 - u);
      const position = at(ground, Math.cos(a) * d, Math.sin(a) * d, z);
      if (k < 40) {
        const half = 0.5 + 1.2 * hash(k, salt + 12);
        rocks.push({ position, scale: [half, half * 0.8, half * 0.7], orientation: [u * 500, a * 57, u * 300], color: [74, 60, 50] });
      } else hot.push({ icon: 'glow', position, size: 2.5 + 3 * (1 - u), color: [255, 170, 80, Math.round(240 * (1 - u))] });
    }
  }
  const layers: Layer[] = [];
  if (hazard.radiusMetres > 0 && dt >= 0) rings.push({ position: [...center, 0.3], radius: hazard.radiusMetres,
    fill: [0, 0, 0, 0], line: alpha(DISASTER_COLORS.meteor, 170 * fadeEnd * clamp01(dt / 30)), width: 2 });
  if (rings.length) layers.push(ringLayer('incident-meteor-rings', rings));
  if (flat.length) layers.push(spriteLayer('incident-meteor-groundglow', flat, ADDITIVE_ON_SURFACE, false));
  if (rocks.length) layers.push(chunkLayer('incident-meteor-ejecta', rocks));
  if (smoke.length) layers.push(spriteLayer('incident-meteor-smoke', smoke, TRANSLUCENT));
  if (hot.length) layers.push(spriteLayer('incident-meteor-fire', hot, ADDITIVE));
  return layers;
}
