// Which of the base map's buildings stand where we draw our own models.
//
// The city layer leaves out our buildings by OSM id, but Mapbox's tiles don't always use the OSM
// id: relations and some multipolygons get synthetic ids, and a building can be split into
// differently-numbered pieces. Those slipped through and drew a plain box inside or through our
// model. So the tiles' features are also tested against our own footprints
// (building-footprints.json): a feature whose centre lies inside one of them, or most of whose
// outline does, is hidden whatever its id. Neighbours that only share a wall keep their centre
// outside and stay.

export type Ring = [number, number][];

export interface FootprintIndex {
  rings: Ring[];
  boxes: [number, number, number, number][]; // [w, s, e, n] per ring
  cells: Map<string, number[]>; // grid cell -> ring indices
}

const CELL = 0.002; // degrees (~170 m east-west here)
const cellKey = (x: number, y: number) => `${Math.floor(x / CELL)}:${Math.floor(y / CELL)}`;

export function buildFootprintIndex(footprints: { rings: Ring[] }[]): FootprintIndex {
  const rings = footprints.flatMap((f) => f.rings).filter((r) => r.length >= 3);
  const boxes = rings.map((r) => {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const [x, y] of r) {
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    }
    return [w, s, e, n] as [number, number, number, number];
  });
  const cells = new Map<string, number[]>();
  boxes.forEach(([w, s, e, n], i) => {
    for (let cx = Math.floor(w / CELL); cx <= Math.floor(e / CELL); cx++) {
      for (let cy = Math.floor(s / CELL); cy <= Math.floor(n / CELL); cy++) {
        const key = `${cx}:${cy}`;
        const list = cells.get(key);
        if (list) list.push(i);
        else cells.set(key, [i]);
      }
    }
  });
  return { rings, boxes, cells };
}

function inRing([x, y]: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** True if the point lies inside any of our footprints. */
export function insideFootprint(index: FootprintIndex, p: [number, number]): boolean {
  for (const i of index.cells.get(cellKey(p[0], p[1])) ?? []) {
    const [w, s, e, n] = index.boxes[i];
    if (p[0] < w || p[0] > e || p[1] < s || p[1] > n) continue;
    if (inRing(p, index.rings[i])) return true;
  }
  return false;
}

/** Area-weighted centroid of a ring (falls back to the vertex mean for degenerate rings). */
function centroid(ring: Ring): [number, number] {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  if (Math.abs(a) < 1e-14) {
    const n = ring.length;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

/** Whether a base-map building (its outer rings) stands where one of our models does. */
export function coveredByModels(index: FootprintIndex, outerRings: Ring[]): boolean {
  for (const ring of outerRings) {
    if (ring.length < 3) continue;
    if (insideFootprint(index, centroid(ring))) return true;
    let inside = 0;
    for (const p of ring) if (insideFootprint(index, p)) inside++;
    if (inside / ring.length > 0.6) return true;
  }
  return false;
}
