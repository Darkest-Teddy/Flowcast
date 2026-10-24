// Footprint geometry for the crowd glow: rings nudged just outside the walls, the convex hull
// grown into a rounded halo, and the sharp corners that get vertical light edges. For buildings
// whose detailed model is several volumes (CDS's stacked pieces, Warren's towers on their
// podium), the same roof rims and corner edges per volume, trimmed where another volume hides them.
// Worked in local metres around each footprint (a few hundred metres at most, so flat is fine).
import type { BuildingFootprint } from '../sim/playback';
import type { BuildingVolume } from './buildings';

type XY = [number, number];

/** The fields of a building-models.json entry the glow reads. Context entries are scenery (the
 *  city around campus, Fenway Park): they have models but never glow, tags or occupancy. */
interface ManifestEntry { osm: string; height: number; volumes?: BuildingVolume[]; context?: boolean }
type Manifest = { campuses: { buildings: ManifestEntry[] }[] } | null | undefined;
const tracked = (manifest: Manifest) => manifest?.campuses.flatMap((c) => c.buildings.filter((b) => !b.context)) ?? [];

/** Top of each building's detailed model, by OSM id (building-models.json). */
export type RoofHeights = ReadonlyMap<string, number>;

/** Reads model heights from the building-model manifest (any object of that shape), BU's only. */
export function modelRoofHeights(manifest?: Manifest): RoofHeights {
  return new Map(tracked(manifest).map((b) => [b.osm, b.height] as const));
}

/** The massing of each multi-volume model, by OSM id (building-models.json `volumes`). */
export type ModelVolumes = ReadonlyMap<string, readonly BuildingVolume[]>;

/** Reads the models' volumes from the building-model manifest (any object of that shape), BU's only. */
export function modelVolumes(manifest?: Manifest): ModelVolumes {
  return new Map(tracked(manifest).flatMap((b) => (b.volumes?.length ? [[b.osm, b.volumes] as const] : [])));
}

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LNG = 111_320;

export interface FootprintGeometry {
  id: string;
  height: number;
  /** Footprint ring 0.4 m outside the walls (clear of the detailed models' 0.3 m), lng/lat, closed. */
  outline: XY[];
  /** Footprint 0.5 m inside the walls, lng/lat: the invisible click target hides inside the building. */
  inset: XY[];
  /** Convex hull in local metres, counter-clockwise. */
  hull: XY[];
  /** Sharp corners, 0.6 m outside the walls, lng/lat. */
  corners: XY[];
  toLngLat: (p: XY) => XY;
}

function localFrame(polygon: XY[]) {
  const [lng0, lat0] = polygon.reduce(([a, b], [x, y]) => [a + x / polygon.length, b + y / polygon.length], [0, 0]);
  const kx = M_PER_DEG_LNG * Math.cos((lat0 * Math.PI) / 180);
  return {
    toLocal: ([lng, lat]: XY): XY => [(lng - lng0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLngLat: ([x, y]: XY): XY => [lng0 + x / kx, lat0 + y / M_PER_DEG_LAT],
  };
}

/** Open ring without repeated or near-duplicate points, counter-clockwise. */
function cleanRing(points: XY[]): XY[] {
  const ring: XY[] = [];
  for (const p of points) {
    const q = ring[ring.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.05) ring.push(p);
  }
  while (ring.length > 2 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) <= 0.05) ring.pop();
  let area = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % ring.length];
    area += x0 * y1 - x1 * y0;
  }
  return area < 0 ? ring.reverse() : ring;
}

const normal = (a: XY, b: XY): XY => {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  // Outward for a counter-clockwise ring.
  return [(b[1] - a[1]) / len, -(b[0] - a[0]) / len];
};

/** Mitred outward offset; only for small distances (no self-intersection handling). */
function offsetRing(ring: XY[], d: number): XY[] {
  const n = ring.length;
  return ring.map((p, i) => {
    const n1 = normal(ring[(i - 1 + n) % n], p);
    const n2 = normal(p, ring[(i + 1) % n]);
    const bx = n1[0] + n2[0];
    const by = n1[1] + n2[1];
    const bl = Math.hypot(bx, by) || 1;
    const cos = Math.max((bx / bl) * n1[0] + (by / bl) * n1[1], 0.5); // mitre limit 2
    return [p[0] + (bx / bl) * (d / cos), p[1] + (by / bl) * (d / cos)];
  });
}

function convexHull(points: XY[]): XY[] {
  const pts = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (pts.length < 3) return pts;
  const cross = (o: XY, a: XY, b: XY) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: XY[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: XY[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]; // counter-clockwise
}

/** A convex ring grown by r with rounded corners (never self-intersects). Open ring, CCW. */
export function roundedOffset(hull: XY[], r: number, stepDeg = 15): XY[] {
  const n = hull.length;
  const out: XY[] = [];
  for (let i = 0; i < n; i++) {
    const p = hull[i];
    const a0 = Math.atan2(...(normal(hull[(i - 1 + n) % n], p).reverse() as XY));
    let a1 = Math.atan2(...(normal(p, hull[(i + 1) % n]).reverse() as XY));
    while (a1 < a0) a1 += 2 * Math.PI;
    const steps = Math.max(1, Math.ceil(((a1 - a0) * 180) / Math.PI / stepDeg));
    for (let s = 0; s <= steps; s++) {
      const a = a0 + ((a1 - a0) * s) / steps;
      out.push([p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)]);
    }
  }
  return out;
}

/** Vertices where the wall turns by more than ~25 degrees (skips the many points of curved walls). */
function sharpCorners(ring: XY[]): number[] {
  const n = ring.length;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const n1 = normal(ring[(i - 1 + n) % n], ring[i]);
    const n2 = normal(ring[i], ring[(i + 1) % n]);
    if (n1[0] * n2[0] + n1[1] * n2[1] < 0.9) out.push(i);
  }
  return out;
}

const cache = new WeakMap<BuildingFootprint, FootprintGeometry | null>();

export function footprintGeometry(f: BuildingFootprint): FootprintGeometry | null {
  if (cache.has(f)) return cache.get(f)!;
  let geometry: FootprintGeometry | null = null;
  if (f.polygon.length >= 3) {
    const { toLocal, toLngLat } = localFrame(f.polygon);
    const ring = cleanRing(f.polygon.map(toLocal));
    if (ring.length >= 3) {
      const outline = offsetRing(ring, 0.4).map(toLngLat);
      const corner = offsetRing(ring, 0.6);
      geometry = {
        id: f.id,
        height: f.height,
        outline: [...outline, outline[0]],
        inset: offsetRing(ring, -0.5).map(toLngLat),
        hull: convexHull(ring),
        corners: sharpCorners(ring).map((i) => toLngLat(corner[i])),
        toLngLat,
      };
    }
  }
  cache.set(f, geometry);
  return geometry;
}

/** A visible stretch of one volume's roof edge, lng/lat, at that volume's top (metres). */
export interface VolumeRim {
  path: XY[];
  top: number;
}

/** A visible corner of the massing, lng/lat, from z0 up to z1 (metres). */
export interface VolumeEdge {
  at: XY;
  z0: number;
  z1: number;
}

export interface VolumeGeometry {
  rims: VolumeRim[];
  edges: VolumeEdge[];
}

/** A rim or corner this close to another volume's walls (m) is against them, not in the open. */
const AGAINST = 0.9;
/** Rims are trimmed in pieces of at most this length (m). */
const RIM_STEP = 1;

function insideRing(p: XY, ring: XY[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function nearRing(p: XY, ring: XY[], d: number): boolean {
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const t = Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1), 0), 1);
    if (Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]) < d) return true;
  }
  return false;
}

const volumeCache = new WeakMap<readonly BuildingVolume[], VolumeGeometry>();

/**
 * Roof rims and corner edges that trace a multi-volume model. Each volume's roof edge is kept
 * only where it's in the open: where another volume stands on it or rises beside it at that
 * height (flush walls included), the edge is hidden in the massing and dropped. Corners are cut
 * the same way and joined up where volumes stack flush, so a corner running up several pieces
 * is one edge from the ground (or the bottom of an overhang) to the top.
 */
export function volumeGeometry(volumes: readonly BuildingVolume[]): VolumeGeometry {
  const hit = volumeCache.get(volumes);
  if (hit) return hit;
  const { toLocal, toLngLat } = localFrame(volumes.flatMap((v) => v.ring));
  const vols = volumes
    .map((v) => ({ ring: cleanRing(v.ring.map(toLocal)), base: v.base, top: v.top }))
    .filter((v) => v.ring.length >= 3);
  const against = (p: XY, ring: XY[]) => insideRing(p, ring) || nearRing(p, ring, AGAINST);

  const rims: VolumeRim[] = [];
  vols.forEach((v, self) => {
    // A roof edge is hidden by any other volume that spans its height there.
    const hides = vols.filter((w, i) => i !== self && w.base <= v.top + 0.3 && w.top >= v.top - 0.3);
    const covered = (p: XY) => hides.some((w) => against(p, w.ring));
    const outline = offsetRing(v.ring, 0.4);
    const runs: XY[][] = [];
    let run: XY[] | null = null;
    let first = true; // the first piece of the ring is in the open
    for (let i = 0; i < outline.length; i++) {
      const a = outline[i];
      const b = outline[(i + 1) % outline.length];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / RIM_STEP));
      for (let k = 0; k < n; k++) {
        const at = (t: number): XY => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        const open = !covered(at((k + 0.5) / n));
        if (i === 0 && k === 0) first = open;
        if (open) {
          if (!run) runs.push((run = [at(k / n)]));
          if (k === n - 1) run.push(b);
        } else if (run) {
          run.push(at(k / n));
          run = null;
        }
      }
    }
    // A run still open at the end carries on into the first one (unless it is the whole ring).
    if (run && first && runs.length > 1) runs[0] = [...runs.pop()!, ...runs[0].slice(1)];
    for (const r of runs) if (r.length >= 2) rims.push({ path: r.map(toLngLat), top: v.top });
  });

  // Corners: each volume's sharp corners over its own height, minus the heights where another
  // volume's walls are around them.
  const pieces: { p: XY; z0: number; z1: number }[] = [];
  vols.forEach((v, self) => {
    const corner = offsetRing(v.ring, 0.6);
    for (const i of sharpCorners(v.ring)) {
      const p = corner[i];
      let spans: [number, number][] = [[v.base, v.top]];
      vols.forEach((w, j) => {
        if (j === self || !against(p, w.ring)) return;
        spans = spans.flatMap(([z0, z1]): [number, number][] => {
          if (w.top <= z0 || w.base >= z1) return [[z0, z1]];
          const keep: [number, number][] = [];
          if (w.base > z0) keep.push([z0, w.base]);
          if (w.top < z1) keep.push([w.top, z1]);
          return keep;
        });
      });
      for (const [z0, z1] of spans) if (z1 - z0 > 0.5) pieces.push({ p, z0, z1 });
    }
  });
  pieces.sort((a, b) => a.z0 - b.z0);
  const edges: { p: XY; z0: number; z1: number }[] = [];
  for (const piece of pieces) {
    const below = edges.find((e) => Math.hypot(e.p[0] - piece.p[0], e.p[1] - piece.p[1]) < 1 && piece.z0 <= e.z1 + 1.5);
    if (below) below.z1 = Math.max(below.z1, piece.z1);
    else edges.push({ ...piece });
  }

  const geometry = { rims, edges: edges.map((e) => ({ at: toLngLat(e.p), z0: e.z0, z1: e.z1 })) };
  volumeCache.set(volumes, geometry);
  return geometry;
}
