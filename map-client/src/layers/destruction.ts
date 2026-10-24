// Persistent, stylized destruction for modeled disasters: rubble around damaged buildings, the
// meteor crater, earthquake ground cracks and fire soot. Driven only by the shared damage frames
// (sim/disasterDamage.ts) and the sim clock, so a building with no damage frame (or no collapse)
// never gets rubble, and the final state stays on the map after hazard.activeUntil until the run
// is reset or the day changes. Illustrative only; not a structural assessment.
//
// Render data is memoized by content (chunk layout per building, crater per run), never by time,
// so steady frames reuse the same arrays and deck.gl skips attribute updates.
import type { Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { BuildingDamageFrame } from '../sim/disasterDamage';
import type { DisasterKind, IncidentHazard } from '../sim/incidents';
import {
  ADDITIVE_ON_SURFACE, ON_SURFACE, alpha, chunkLayer, clamp01, craterRadius, discShape, easeOut, hash, localShape,
  offset, scatter, seedInt, smooth, spriteLayer, type Chunk, type RGB, type Sprite,
} from './disasterEffects';

/** Chunk budget across every damaged building, so a large earthquake stays at hundreds of instances. */
const MAX_RUBBLE = 480;
const MAX_PER_BUILDING = 44;
/** Buildings below this final collapse stay intact: no rubble. */
const MIN_COLLAPSE_FOR_RUBBLE = 0.05;

export interface DestructionFrame {
  kind: DisasterKind;
  hazard: IncidentHazard;
  center: [number, number];
  start: number;
  time: number;
  damage: readonly BuildingDamageFrame[];
}

/** Buildings the map should mark as damaged (any collapse or noticeable scorch). */
export const isDamaged = (d: BuildingDamageFrame) => d.finalCollapse >= MIN_COLLAPSE_FOR_RUBBLE || d.scorch >= 0.3;

const PALETTE: Record<DisasterKind, RGB[]> = {
  fire: [[44, 38, 34], [58, 50, 44], [74, 64, 56], [96, 70, 56]],
  earthquake: [[150, 146, 140], [128, 124, 118], [168, 162, 152], [146, 94, 72], [112, 104, 96]],
  meteor: [[70, 60, 52], [92, 82, 74], [52, 44, 40], [110, 100, 92]],
};

// One chunk layout per building and final state; reused every frame.
const layouts = new Map<string, Chunk[]>();
function layout(d: BuildingDamageFrame, count: number): Chunk[] {
  const key = `${d.id}:${d.kind}:${count}:${d.finalCollapse.toFixed(3)}:${d.height.toFixed(1)}`;
  const cached = layouts.get(key);
  if (cached) return cached;
  const shape = localShape(d.polygon, d.center);
  const s = seedInt(d.seed);
  const spill = Math.min(12, Math.max(2, 2 + d.height * d.finalCollapse * 0.3));
  const pile = Math.min(6, d.height * d.finalCollapse * 0.14);
  const scale = Math.min(1.6, Math.max(0.8, Math.sqrt(d.height / 12)));
  const palette = PALETTE[d.kind];
  const chunks = scatter(shape, count, s + 101, spill).map((p, i): Chunk => {
    const half = (0.5 + 1.5 * hash(i, s + 102) ** 1.5) * scale;
    const flat = 0.35 + 0.45 * hash(i, s + 103);
    // Heaped inside the footprint, thinning out across the spill zone.
    const heap = p.inside ? pile * (0.3 + 0.7 * hash(i, s + 104)) : pile * 0.25 * (1 - p.edge / spill) * hash(i, s + 104);
    return {
      position: [...offset(shape.center, p.x, p.y), half * flat + heap] as [number, number, number],
      scale: [half, half * (0.6 + 0.5 * hash(i, s + 105)), half * flat],
      orientation: [hash(i, s + 106) * 40 - 20, hash(i, s + 107) * 360, hash(i, s + 108) * 40 - 20],
      color: palette[Math.floor(hash(i, s + 109) * palette.length)],
    };
  });
  if (layouts.size > 512) layouts.clear();
  layouts.set(key, chunks);
  return chunks;
}

let rubbleMemo: { key: string; data: Chunk[] } = { key: '', data: [] };
function rubble(damage: readonly BuildingDamageFrame[]): Chunk[] {
  const candidates = damage.filter(d => d.finalCollapse >= MIN_COLLAPSE_FOR_RUBBLE && d.polygon.length >= 3);
  const wanted = candidates.map(d => {
    const shape = localShape(d.polygon, d.center);
    return Math.round(Math.min(MAX_PER_BUILDING, Math.max(8, shape.area / 35)) * (0.35 + 0.65 * d.finalCollapse));
  });
  const total = wanted.reduce((a, b) => a + b, 0);
  const budget = total > MAX_RUBBLE ? MAX_RUBBLE / total : 1;
  const parts: { d: BuildingDamageFrame; count: number; shown: number }[] = [];
  let key = '';
  candidates.forEach((d, i) => {
    const count = Math.max(3, Math.floor(wanted[i] * budget));
    // Chunks appear as the building comes down; once collapse is final the count is fixed.
    const shown = Math.round(count * clamp01(d.collapse / d.finalCollapse));
    if (shown <= 0) return;
    parts.push({ d, count, shown });
    key += `${d.id}:${count}:${shown}|`;
  });
  if (key === rubbleMemo.key) return rubbleMemo.data;
  const data: Chunk[] = [];
  for (const { d, count, shown } of parts) data.push(...layout(d, count).slice(0, shown));
  rubbleMemo = { key, data };
  return data;
}

interface Disc { position: [number, number, number]; radius: number; fill: [number, number, number, number]; line: [number, number, number, number]; width: number }
interface Crack { path: [number, number, number][]; width: number; color: [number, number, number, number] }

let craterMemo: { key: string; discs: Disc[]; rays: Crack[]; rocks: Chunk[] } = { key: '', discs: [], rays: [], rocks: [] };
function crater(center: [number, number], impactRadius: number, start: number, grow: number) {
  const g = Math.round(grow * 20) / 20;
  const key = `${center[0]},${center[1]}:${impactRadius}:${start}:${g}`;
  if (key === craterMemo.key) return craterMemo;
  const cr = craterRadius(impactRadius) * (0.3 + 0.7 * g);
  const z = (k: number) => 0.2 + k * 0.05;
  const discs: Disc[] = [
    { position: [...center, z(0)], radius: cr * 2.5, fill: [46, 38, 34, 130], line: [0, 0, 0, 0], width: 0 },
    { position: [...center, z(1)], radius: cr * 1.08, fill: [0, 0, 0, 0], line: [104, 90, 78, 235], width: cr * 0.28 },
    { position: [...center, z(2)], radius: cr, fill: [26, 21, 18, 240], line: [0, 0, 0, 0], width: 0 },
    { position: [...center, z(3)], radius: cr * 0.62, fill: [12, 10, 9, 220], line: [0, 0, 0, 0], width: 0 },
  ];
  const salt = Math.floor(start);
  const rays: Crack[] = [];
  for (let k = 0; k < 14; k++) {
    const a = (k + hash(k, salt + 20)) / 14 * 2 * Math.PI, length = cr * (1.4 + 1.6 * hash(k, salt + 21));
    rays.push({ path: [[...offset(center, Math.cos(a) * cr * 1.1, Math.sin(a) * cr * 1.1), z(4)],
      [...offset(center, Math.cos(a) * length, Math.sin(a) * length), z(4)]] as [number, number, number][],
      width: cr * (0.12 + 0.12 * hash(k, salt + 22)), color: [36, 30, 26, 150] });
  }
  const rocks: Chunk[] = [];
  const shape = discShape(center, cr);
  for (let k = 0; k < 40; k++) {
    const a = hash(k, salt + 23) * 2 * Math.PI, d = cr * (1 + 0.9 * hash(k, salt + 24) ** 2);
    const half = (0.6 + 1.6 * hash(k, salt + 25)) * Math.min(1.5, cr / 18);
    rocks.push({ position: [...offset(shape.center, Math.cos(a) * d, Math.sin(a) * d), half * 0.5],
      scale: [half, half * 0.8, half * 0.6], orientation: [hash(k, salt + 26) * 30, a * 57, hash(k, salt + 27) * 30],
      color: PALETTE.meteor[Math.floor(hash(k, salt + 28) * 4)] });
  }
  craterMemo = { key, discs, rays, rocks };
  return craterMemo;
}

let crackMemo: { key: string; data: Crack[] } = { key: '', data: [] };
function cracks(center: [number, number], radius: number, start: number, grow: number): Crack[] {
  const g = Math.round(grow * 24) / 24;
  const key = `${center[0]},${center[1]}:${radius}:${start}:${g}`;
  if (key === crackMemo.key) return crackMemo.data;
  const salt = Math.floor(start);
  const data: Crack[] = [];
  const span = Math.min(180, Math.max(30, radius * 0.6));
  for (let k = 0; k < 9; k++) {
    let a = (k + hash(k, salt + 30)) / 9 * 2 * Math.PI;
    const length = span * (0.5 + 0.5 * hash(k, salt + 31)) * g;
    const steps = 12;
    const path: [number, number, number][] = [[...center, 0.25]];
    let x = 0, y = 0;
    for (let i = 1; i <= steps; i++) {
      a += (hash(k * 31 + i, salt + 32) - 0.5) * 0.9;
      x += Math.cos(a) * length / steps; y += Math.sin(a) * length / steps;
      path.push([...offset(center, x, y), 0.25]);
    }
    if (length > 0) data.push({ path, width: 1.6 + 1.2 * hash(k, salt + 33), color: [24, 20, 18, 210] });
  }
  crackMemo = { key, data };
  return data;
}

const paths = (id: string, data: Crack[]) => new PathLayer<Crack>({
  id,
  data,
  getPath: d => d.path,
  getWidth: d => d.width,
  getColor: d => d.color,
  widthUnits: 'meters',
  widthMinPixels: 1,
  capRounded: true,
  jointRounded: true,
  pickable: false,
  parameters: ON_SURFACE,
  // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
  slot: 'middle',
});

const discs = (id: string, data: Disc[]) => new ScatterplotLayer<Disc>({
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
  lineWidthUnits: 'meters',
  pickable: false,
  parameters: ON_SURFACE,
  // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
  slot: 'middle',
});

/** Persistent destruction layers from incident start until the run is cleared. */
export function destructionLayers(frame: DestructionFrame): Layer[] {
  const { kind, hazard, center, start, time, damage } = frame;
  if (time < start) return [];
  const dt = time - start;
  const layers: Layer[] = [];
  const chunks = rubble(damage);

  if (kind === 'meteor') {
    const impactRadius = hazard.radiusMetres > 0 ? hazard.radiusMetres : 40;
    const c = crater(center, impactRadius, start, easeOut(dt / 3));
    layers.push(discs('incident-crater', c.discs), paths('incident-crater-rays', c.rays));
    // Rim rocks arrive with the ejecta (disasterEffects.ts) over the first seconds.
    const rim = dt >= 16 ? c.rocks : c.rocks.slice(0, Math.floor(c.rocks.length * clamp01(dt / 16)));
    if (rim.length) layers.push(chunkLayer('incident-crater-rocks', rim));
    // The floor cools from a molten glow to dark over about 40 minutes.
    const heat = 1 - smooth(0, 2400, dt);
    if (heat > 0.01) {
      const cr = craterRadius(impactRadius);
      const glow: Sprite[] = [{ icon: 'glow', position: [...center, 0.5], size: cr * 1.8, color: [255, 110, 40, Math.round(210 * heat)] }];
      const salt = Math.floor(start);
      for (let k = 0; k < 12; k++) {
        const a = hash(k, salt + 40) * 2 * Math.PI, d = cr * 0.8 * Math.sqrt(hash(k, salt + 41));
        const flicker = 0.6 + 0.4 * Math.sin(dt / 20 + hash(k, salt + 42) * 6.28);
        glow.push({ icon: 'glow', position: [...offset(center, Math.cos(a) * d, Math.sin(a) * d), 0.6],
          size: cr * (0.25 + 0.2 * hash(k, salt + 43)), color: [255, 150, 60, Math.round(220 * heat * flicker)] });
      }
      layers.push(spriteLayer('incident-crater-glow', glow, ADDITIVE_ON_SURFACE, false));
    }
  } else if (kind === 'earthquake') {
    const radius = hazard.radiusMetres > 0 ? hazard.radiusMetres : 60;
    const shakeSeconds = Math.max(1, hazard.responseStartsAt - start);
    layers.push(paths('incident-cracks', cracks(center, radius, start, easeOut(dt / shakeSeconds))));
  } else {
    // Soot stains around the burning building's base, darkening with scorch.
    const soot: Sprite[] = [];
    for (const d of damage) {
      if (d.kind !== 'fire' || d.scorch <= 0.02) continue;
      const shape = localShape(d.polygon, d.center), s = seedInt(d.seed);
      for (const [i, p] of scatter(shape, 12, s + 200, 6).entries())
        soot.push({ icon: 'puff', position: [...offset(shape.center, p.x, p.y), 0.4], size: 8 + 8 * hash(i, s + 201),
          color: alpha([20, 17, 15], 150 * d.scorch) });
    }
    if (soot.length) layers.push(spriteLayer('incident-soot', soot, ON_SURFACE, false));
  }
  if (chunks.length) layers.push(chunkLayer('incident-rubble', chunks));
  return layers;
}
