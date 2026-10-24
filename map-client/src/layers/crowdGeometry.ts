// Footprint geometry for the crowd glow: rings nudged just outside the walls, the convex hull
// grown into a rounded halo, and the sharp corners that get vertical light edges.
// Worked in local metres around each footprint (a few hundred metres at most, so flat is fine).
import type { BuildingFootprint } from '../sim/playback';

type XY = [number, number];

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
