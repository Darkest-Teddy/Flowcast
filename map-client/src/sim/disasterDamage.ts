// Illustrative building damage for modeled fire, earthquake and meteor scenarios. A pure function of
// the incident run and the sim clock: no stored state, no Math.random, so seeking or rewinding
// redraws the same frame. Values drive map visuals only (scorching, partial and full collapse);
// they are not a structural assessment. The separate casualty model uses this illustrative severity.
import type { DisasterKind } from './disasters';
import { footprintDistance, isDisasterKind } from './disasters';

/** The fields of an incident run that damage depends on (App's IncidentRun satisfies this). */
export interface DamageRun {
  incident: { kind: string; start: number };
  hazard?: { radiusMetres: number; affectedBuildingIds: readonly string[]; activeUntil?: number } | null;
  location: { position: [number, number]; building?: string | null };
}

/** A saved footprint ring (day.buildings). Multi-part buildings appear once per ring. */
export interface DamageFootprint { id: string; polygon: [number, number][]; height: number }

/** One damaged building at one moment. Sorted by id. */
export interface BuildingDamageFrame {
  /** Building id, the same OSM id as day.buildings[].id and the model manifest's `osm`. */
  id: string;
  kind: DisasterKind;
  /** Every footprint ring of the building, [lng, lat]. */
  rings: [number, number][][];
  /** Largest ring, for consumers that want one polygon. */
  polygon: [number, number][];
  /** Mean of the largest ring's vertices, [lng, lat]. */
  center: [number, number];
  /** Original modeled height, metres (tallest ring; 12 m when the saved height is 0). */
  height: number;
  /** Metres from the hazard centre to the footprint (0 inside it). */
  distanceMetres: number;
  /** Final damage level this building reaches, 0..1. Constant through the run. */
  severity: number;
  /** How far this building's damage has progressed toward its final state, 0..1. */
  progress: number;
  /** Current charring / dust darkening, 0..1. */
  scorch: number;
  /** Current fraction of the height lost, 0..1 (1 = flattened to rubble). */
  collapse: number;
  /** Final collapse fraction, 0..1, so rubble can be sized before collapse completes. */
  finalCollapse: number;
  /** Final scorch, 0..1. */
  finalScorch: number;
  /** Current shear of the standing part (metres sideways per metre up); finalLean at the end. */
  lean: number;
  finalLean: number;
  /** Lean direction, radians counter-clockwise from east (earthquake: per building; meteor: away from impact). */
  leanDirection: number;
  /** When collapse and scorch happen, seconds after `onset` (see damageCurves). */
  timing: DamageTiming;
  /** Current standing height, metres: height * (1 - collapse). */
  remainingHeight: number;
  /** Sim second the incident started; timings are relative to it. */
  onset: number;
  /** Deterministic per-building [0, 1) value shared by every layer (lean direction, debris scatter). */
  seed: number;
}

/** Illustrative, uncalibrated timings. */
export const DAMAGE_ASSUMPTIONS = {
  fire: { scorchSeconds: 600, collapseStartSeconds: 600, collapseEndSeconds: 1800, finalCollapse: 0.4 },
  earthquake: { shakingSeconds: 60, innerFraction: 0.45, collapseChance: 0.5 },
  meteor: { impactSeconds: 3, settleSeconds: 30, innerFraction: 0.45 },
} as const;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const smooth = (a: number, b: number, x: number) => { const t = b > a ? clamp01((x - a) / (b - a)) : x >= b ? 1 : 0; return t * t * (3 - 2 * t); };

/** Deterministic [0, 1) hash of a string. */
export function damageSeed(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 0x01000193);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function ringArea(r: [number, number][]): number {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return Math.abs(a);
}

/** When each part of a building's damage happens, in seconds after the incident starts. Both
 *  `collapse` and `scorch` follow a smoothstep between their start and end; the GPU shader in
 *  layers/buildingDamage.ts evaluates the same curves, so meshes and rubble stay in step. */
export interface DamageTiming { collapseStart: number; collapseEnd: number; scorchStart: number; scorchEnd: number }

interface Profile { severity: number; finalCollapse: number; finalScorch: number; lean: number; leanDirection: number; timing: DamageTiming }

function profile(kind: DisasterKind, isTarget: boolean, distance: number, radius: number, seed: number, away: number): Profile | null {
  if (kind === 'fire') {
    if (!isTarget) return null;
    const f = DAMAGE_ASSUMPTIONS.fire;
    return { severity: 1, finalCollapse: f.finalCollapse, finalScorch: 1, lean: 0, leanDirection: 0,
      timing: { collapseStart: f.collapseStartSeconds, collapseEnd: f.collapseEndSeconds, scorchStart: 0, scorchEnd: f.scorchSeconds } };
  }
  const r = Math.max(radius, 1);
  const u = isTarget ? 0 : clamp01(distance / r); // 0 at the centre, 1 at the edge
  if (kind === 'earthquake') {
    const q = DAMAGE_ASSUMPTIONS.earthquake;
    const severity = clamp01(1 - u);
    const inner = u < q.innerFraction;
    // Inside the inner area about half the buildings collapse (more near the centre); the rest crack and lean.
    const collapses = inner && seed < q.collapseChance + 0.4 * (1 - u / q.innerFraction) - 0.2;
    const finalCollapse = collapses ? 0.55 + 0.45 * severity : inner ? 0.12 * severity : 0;
    // Each building gives way at its own moment during the shaking.
    const start = 5 + seed * 30, end = Math.min(q.shakingSeconds, start + 25);
    return { severity, finalCollapse, finalScorch: 0.25 + 0.35 * severity, lean: (collapses ? 0.05 : 0.025) * severity,
      leanDirection: seed * 2 * Math.PI, timing: { collapseStart: start, collapseEnd: end, scorchStart: 0, scorchEnd: end } };
  }
  const m = DAMAGE_ASSUMPTIONS.meteor;
  const inner = isTarget || u < m.innerFraction;
  const severity = inner ? 1 : 0.1 + 0.8 * clamp01(1 - (u - m.innerFraction) / (1 - m.innerFraction));
  // The blast front reaches farther buildings slightly later; outer buildings are pushed away from it.
  const delay = u * m.impactSeconds;
  return { severity, finalCollapse: inner ? 1 : 0.15 + 0.45 * (severity - 0.1) / 0.8, finalScorch: inner ? 1 : 0.4 + 0.5 * severity,
    lean: inner ? 0 : 0.04 * severity, leanDirection: away,
    timing: { collapseStart: delay, collapseEnd: delay + (inner ? 2.5 : 6), scorchStart: delay, scorchEnd: delay + m.settleSeconds } };
}

/** Collapse and scorch of a building `elapsed` seconds after onset (the shader's curves, in JS). */
export function damageCurves(final: { finalCollapse: number; finalScorch: number; timing: DamageTiming }, elapsed: number) {
  const t = final.timing;
  return {
    collapse: final.finalCollapse * smooth(t.collapseStart, t.collapseEnd, elapsed),
    scorch: final.finalScorch * smooth(t.scorchStart, t.scorchEnd, elapsed),
    progress: clamp01(elapsed / Math.max(t.collapseEnd, t.scorchEnd, 1e-6)),
  };
}

/**
 * Damage of every affected building at sim time `time` (seconds since midnight). Nothing before
 * the incident starts. From the start every building that will be damaged is listed (so the set
 * is stable through the run; early entries can still read 0), and after the hazard ends the final
 * state persists until the run is reset or the day changes (the caller then passes run = null).
 * `heights` (e.g. the 3D model manifest's tops, via buildingModelHeights) overrides footprint
 * heights, which are 0 for many saved buildings.
 */
export function damageAt(run: DamageRun | null | undefined, time: number, footprints: readonly DamageFootprint[],
  heights?: ReadonlyMap<string, number>): BuildingDamageFrame[] {
  if (!run?.hazard || !isDisasterKind(run.incident.kind) || !(time >= run.incident.start)) return [];
  const kind = run.incident.kind;
  const dt = time - run.incident.start;
  const affected = new Set(run.hazard.affectedBuildingIds);
  const byId = new Map<string, DamageFootprint[]>();
  for (const f of footprints) if (f.id && affected.has(f.id) && f.polygon.length >= 3) {
    const list = byId.get(f.id) ?? [];
    list.push(f); byId.set(f.id, list);
  }
  const origin = run.location.position;
  const kx = 111320 * Math.cos(origin[1] * Math.PI / 180);
  const out: BuildingDamageFrame[] = [];
  for (const id of [...byId.keys()].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
    const parts = byId.get(id)!;
    const rings = parts.map(p => p.polygon);
    const polygon = rings.reduce((best, r) => ringArea(r) > ringArea(best) ? r : best, rings[0]);
    const center: [number, number] = [0, 0];
    for (const v of polygon) { center[0] += v[0] / polygon.length; center[1] += v[1] / polygon.length; }
    const distance = Math.min(...rings.map(r => footprintDistance(origin, r)));
    const isTarget = id === run.location.building || distance === 0;
    const seed = damageSeed(id);
    const away = Math.atan2((center[1] - origin[1]) * 111320, (center[0] - origin[0]) * kx);
    const p = profile(kind, isTarget, distance, run.hazard.radiusMetres, seed, away);
    if (!p) continue;
    const now = damageCurves(p, dt);
    const height = heights?.get(id) || Math.max(...parts.map(f => f.height || 0)) || 12;
    out.push({
      id, kind, rings, polygon, center, height, distanceMetres: distance, severity: p.severity,
      progress: now.progress, scorch: now.scorch, collapse: now.collapse, finalCollapse: p.finalCollapse, finalScorch: p.finalScorch,
      lean: p.lean * smooth(p.timing.collapseStart, p.timing.collapseEnd, dt), finalLean: p.lean, leanDirection: p.leanDirection,
      timing: p.timing, remainingHeight: height * (1 - now.collapse), onset: run.incident.start, seed,
    });
  }
  return out;
}
