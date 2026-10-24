// Where people go when a building is on fire: the exits they leave by, and the loose crowds they
// stand in on the surrounding sidewalks and plazas while Boston Fire works.
//
// Pure geometry on the saved pedestrian network (every saved walk route and stop route near the
// building, joined where they share a vertex), the building's mapped footprint, and optionally
// the street centrelines and parked fire apparatus from sim/fireResponse.ts. Nothing here is
// timed; sim/fireIncident.ts schedules who walks where and when.
import type { BuildingFootprint, DayData } from './playback';

export type LngLat = [number, number];
/** A street centreline segment and half its carriageway width (metres), to keep crowds off the road. */
export interface RoadSegment { a: LngLat; b: LngLat; halfWidth: number }
/** What the fire service occupies: streets near the building and where apparatus park. */
export interface FireScene { roads?: RoadSegment[]; apparatus?: LngLat[] }

/** Illustrative, uncalibrated geometry assumptions for a real building fire. */
export const FIRE_GEOMETRY_ASSUMPTIONS = {
  /** Standing areas: this far (metres) from the burning footprint, measured to its nearest edge. */
  standMinMetres: 30, standMaxMetres: 80,
  /** A person's own spot may sit a little closer or further than its area's centre. */
  spotMinMetres: 25, spotMaxMetres: 95,
  /** Clear of every other mapped footprint (a sidewalk beside a wall is fine). */
  footprintClearanceMetres: 1.2,
  /** Beyond the modeled carriageway edge (street centreline plus half its width). */
  roadMarginMetres: 0.5,
  /** Kept clear around each parked fire apparatus (hose lines, ladders, crews). */
  apparatusClearanceMetres: 18,
  /** Longest straight step from a footprint edge exit to the saved pedestrian network. */
  exitConnectorMaxMetres: 25,
  exitSpacingMetres: 18,
  maxExits: 8,
  areaSpacingMetres: 35,
  maxAreas: 12,
  /** How far a crowd spreads each way along its sidewalk from the area's centre. */
  stretchMetres: 45,
  /** Loose crowd: one person per this many metres along the sidewalk in each row. */
  spotSpacingMetres: 1.4,
  /** Region of the pedestrian network considered around the building. */
  regionMetres: 350,
} as const;

const KY = 111_320;
interface Frame { lng0: number; lat0: number; kx: number }
const toXY = (f: Frame, p: readonly number[]): [number, number] => [(p[0] - f.lng0) * f.kx, (p[1] - f.lat0) * KY];
const toLngLat = (f: Frame, x: number, y: number): LngLat => [f.lng0 + x / f.kx, f.lat0 + y / KY];

/** Segments of polylines (e.g. surface Green Line tracks and their platforms) within `radius` metres of `center`, kept clear like a road. */
export function segmentsNear(lines: readonly (readonly (readonly number[])[])[], center: readonly number[], radius: number, halfWidth: number): RoadSegment[] {
  const frame: Frame = { lng0: center[0], lat0: center[1], kx: KY * Math.cos(center[1] * Math.PI / 180) };
  const out: RoadSegment[] = [];
  for (const line of lines) for (let i = 1; i < line.length; i++) {
    const [ax, ay] = toXY(frame, line[i - 1]), [bx, by] = toXY(frame, line[i]);
    if (segDistance(0, 0, ax, ay, bx, by).d <= radius) out.push({ a: [line[i - 1][0], line[i - 1][1]], b: [line[i][0], line[i][1]], halfWidth });
  }
  return out;
}

export function hash01(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function segDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return { d: Math.hypot(ax + t * dx - px, ay + t * dy - py), t };
}
function insideXY(x: number, y: number, ring: [number, number][]): boolean {
  let result = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) result = !result;
  }
  return result;
}
function ringDistance(x: number, y: number, ring: [number, number][]): number {
  let best = Infinity;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) best = Math.min(best, segDistance(x, y, ring[j][0], ring[j][1], ring[i][0], ring[i][1]).d);
  return best;
}

class Heap {
  private keys: number[] = []; private values: number[] = [];
  get size() { return this.keys.length; }
  push(key: number, value: number) {
    const k = this.keys, v = this.values; let i = k.length; k.push(key); v.push(value);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
    k[i] = key; v[i] = value;
  }
  pop(): [number, number] {
    const k = this.keys, v = this.values, top: [number, number] = [k[0], v[0]];
    const lastK = k.pop()!, lastV = v.pop()!;
    if (k.length) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = l + 1; let m = i, mk = lastK;
        if (l < k.length && k[l] < mk) { m = l; mk = k[l]; }
        if (r < k.length && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return top;
  }
}

export interface Tree { dist: Float64Array; prev: Int32Array; source: number }

/** The saved pedestrian network near the building: nodes are exact saved vertices (plus inserted points). */
export class PedestrianGraph {
  readonly points: LngLat[] = [];
  readonly xy: [number, number][] = [];
  readonly adj: number[][] = [];
  readonly weight: number[][] = [];
  /** Original saved segments, for nearest-point queries. */
  readonly segments: [number, number][] = [];
  private readonly index = new Map<string, number>();
  private readonly frame: Frame;
  constructor(frame: Frame) { this.frame = frame; }
  nodeOf(p: LngLat): number | undefined { return this.index.get(`${p[0]},${p[1]}`); }
  node(p: LngLat): number {
    const key = `${p[0]},${p[1]}`;
    let id = this.index.get(key);
    if (id === undefined) {
      id = this.points.length; this.index.set(key, id);
      this.points.push(p); this.xy.push(toXY(this.frame, p)); this.adj.push([]); this.weight.push([]);
    }
    return id;
  }
  link(a: number, b: number) {
    if (a === b || this.adj[a].includes(b)) return;
    const w = Math.hypot(this.xy[a][0] - this.xy[b][0], this.xy[a][1] - this.xy[b][1]);
    this.adj[a].push(b); this.weight[a].push(w); this.adj[b].push(a); this.weight[b].push(w);
  }
  /** Insert a new node on saved segment `segment` at its point nearest p. */
  attach(segment: number, p: LngLat): number {
    const existing = this.nodeOf(p);
    if (existing !== undefined) return existing;
    const [a, b] = this.segments[segment];
    const id = this.node(p);
    this.link(id, a); this.link(id, b);
    return id;
  }
  tree(source: number, limit = Infinity): Tree {
    const n = this.points.length, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
    dist[source] = 0;
    const heap = new Heap(); heap.push(0, source);
    while (heap.size) {
      const [d, u] = heap.pop();
      if (d > dist[u] || d > limit) continue;
      const adj = this.adj[u], w = this.weight[u];
      for (let i = 0; i < adj.length; i++) {
        const nd = d + w[i];
        if (nd < dist[adj[i]]) { dist[adj[i]] = nd; prev[adj[i]] = u; heap.push(nd, adj[i]); }
      }
    }
    return { dist, prev, source };
  }
  /** Node ids from the tree's source to `target`, inclusive. */
  pathTo(tree: Tree, target: number): number[] {
    const out: number[] = [];
    for (let u = target; u !== -1; u = tree.prev[u]) out.push(u);
    return out.reverse();
  }
}

/** A path in [lng, lat] with metres from its start. */
export interface Polyline { path: LngLat[]; cumulative: number[] }

export function metresBetween(a: readonly number[], b: readonly number[]): number {
  const kx = KY * Math.cos(((a[1] + b[1]) / 2) * Math.PI / 180);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * KY);
}
/** Build a polyline from points, dropping repeated points. */
export function polyline(points: LngLat[]): Polyline {
  const path: LngLat[] = [], cumulative: number[] = [];
  for (const p of points) {
    const last = path[path.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    cumulative.push(last ? cumulative[cumulative.length - 1] + metresBetween(last, p) : 0);
    path.push(p);
  }
  return { path, cumulative };
}
/** Concatenate polylines whose ends meet (the shared point is kept once). */
export function concat(parts: Polyline[]): Polyline {
  const path: LngLat[] = [], cumulative: number[] = [];
  for (const part of parts) {
    if (!part.path.length) continue;
    const offset = cumulative.length ? cumulative[cumulative.length - 1] - part.cumulative[0] : -part.cumulative[0];
    part.path.forEach((p, i) => {
      const last = path[path.length - 1];
      if (last && last[0] === p[0] && last[1] === p[1]) return;
      if (last && i === 0) { // ends did not meet exactly: bridge them
        cumulative.push(cumulative[cumulative.length - 1] + metresBetween(last, p)); path.push(p); return;
      }
      path.push(p); cumulative.push(part.cumulative[i] + offset);
    });
  }
  return { path, cumulative };
}

export interface Exit {
  /** Point on the burning footprint's edge where people step out. */
  edge: LngLat;
  /** Graph node on the saved pedestrian network the exit leads to. */
  node: number;
  /** Straight step from the edge to the network, metres. */
  connector: number;
  /** A saved door (walk-route start) rather than another point of the footprint. */
  door: boolean;
  tree: Tree;
}
export interface Spot {
  position: LngLat;
  /** Faces the burning building, give or take. */
  bearing: number;
  /** From the area's centre node to the spot. */
  approach: Polyline;
}
export interface StandingArea {
  index: number;
  centre: LngLat;
  node: number;
  /** Metres from the burning footprint. */
  clearance: number;
  spots: Spot[];
  tree: Tree;
  used: number;
}
export interface FireGeometry {
  graph: PedestrianGraph;
  exits: Exit[];
  areas: StandingArea[];
  /** Centre of the burning footprint (the crowd faces it). */
  centroid: LngLat;
  /** Metres from the burning footprint. */
  clearance(p: LngLat): number;
  /** Points along `p` → network → the polyline `route` (which must share saved vertices), cheapest join. */
  join(tree: Tree, route: Polyline): Polyline | null;
  /** The graph path from a tree's source to a node, as a polyline. */
  pathFrom(tree: Tree, node: number): Polyline;
  /** A tree from an arbitrary point on the saved network (inserted on its nearest segment). */
  treeFrom(p: LngLat): Tree | null;
}

const bearingOf = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;

/**
 * Exits, standing areas and per-person spots around the burning building. `doors` are the saved
 * walk-route start points of the building's locations; `polylines` are extra saved paths (the
 * affected people's own walks) so their routes join the network exactly.
 */
export function fireGeometry(day: DayData, buildingId: string, doors: LngLat[], expected: number, scene: FireScene = {},
  polylines: readonly (readonly LngLat[])[] = []): FireGeometry | null {
  const G = FIRE_GEOMETRY_ASSUMPTIONS;
  const rings = day.buildings.filter((b: BuildingFootprint) => b.id === buildingId && b.polygon.length >= 3).map((b) => b.polygon);
  if (!rings.length) return null;
  let sx = 0, sy = 0, count = 0;
  for (const ring of rings) for (const p of ring) { sx += p[0]; sy += p[1]; count++; }
  const centroid: LngLat = [sx / count, sy / count];
  const frame: Frame = { lng0: centroid[0], lat0: centroid[1], kx: KY * Math.cos(centroid[1] * Math.PI / 180) };
  const target = rings.map((ring) => ring.map((p) => toXY(frame, p)));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of target) for (const [x, y] of ring) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y); }
  const R = G.regionMetres;
  const inRegion = (x: number, y: number) => x >= minX - R && x <= maxX + R && y >= minY - R && y <= maxY + R;
  const others = day.buildings.map((b) => b.polygon.map((p) => toXY(frame, p))).filter((ring) => ring.some(([x, y]) => inRegion(x, y)));
  const roads = (scene.roads ?? []).map((r) => ({ a: toXY(frame, r.a), b: toXY(frame, r.b), half: r.halfWidth }))
    .filter((r) => Math.max(r.a[0], r.b[0]) >= minX - R && Math.min(r.a[0], r.b[0]) <= maxX + R && Math.max(r.a[1], r.b[1]) >= minY - R && Math.min(r.a[1], r.b[1]) <= maxY + R);
  const apparatus = (scene.apparatus ?? []).map((p) => toXY(frame, p));
  const targetClearance = (x: number, y: number) => {
    let best = Infinity;
    for (const ring of target) best = Math.min(best, insideXY(x, y, ring) ? 0 : ringDistance(x, y, ring));
    return best;
  };
  const insideAny = (x: number, y: number) => others.some((ring) => insideXY(x, y, ring));
  const footprintClear = (x: number, y: number, metres: number) => others.every((ring) => !insideXY(x, y, ring) && ringDistance(x, y, ring) >= metres);
  const offRoad = (x: number, y: number) => roads.every((r) => segDistance(x, y, r.a[0], r.a[1], r.b[0], r.b[1]).d >= r.half + G.roadMarginMetres);
  const clearOfApparatus = (x: number, y: number, metres: number) => apparatus.every(([ax, ay]) => Math.hypot(ax - x, ay - y) >= metres);

  // The saved pedestrian network near the building.
  const graph = new PedestrianGraph(frame);
  const addPath = (path: readonly (readonly number[])[]) => {
    for (let i = 1; i < path.length; i++) {
      const a = path[i - 1], b = path[i];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const [ax, ay] = toXY(frame, a), [bx, by] = toXY(frame, b);
      if (!inRegion(ax, ay) && !inRegion(bx, by)) continue;
      const u = graph.node([a[0], a[1]]), v = graph.node([b[0], b[1]]);
      if (graph.adj[u].includes(v)) continue;
      graph.link(u, v); graph.segments.push([u, v]);
    }
  };
  for (const route of Object.values(day.walkRoutes ?? {})) addPath(route.path);
  for (const route of Object.values(day.stopRoutes ?? {})) addPath(route.path);
  for (const path of polylines) addPath(path);
  const doorNodes = doors.map((d) => graph.nodeOf(d)).filter((n): n is number => n !== undefined);
  if (!doorNodes.length) return null;
  // Only the part of the network connected to the building's doors.
  const reach = new Uint8Array(graph.points.length);
  for (const door of doorNodes) { const t = graph.tree(door, 2 * R); t.dist.forEach((d, i) => { if (d < Infinity) reach[i] = 1; }); }
  const reachable = (n: number) => n < reach.length && reach[n] === 1;
  const baseSegments = graph.segments.length;
  const nearestSegment = (x: number, y: number, within: number) => {
    let best: { segment: number; t: number; d: number } | null = null;
    for (let s = 0; s < baseSegments; s++) {
      const [u, v] = graph.segments[s];
      if (!reachable(u) || !reachable(v)) continue;
      const a = graph.xy[u], b = graph.xy[v];
      if (Math.min(a[0], b[0]) - within > x || Math.max(a[0], b[0]) + within < x || Math.min(a[1], b[1]) - within > y || Math.max(a[1], b[1]) + within < y) continue;
      const hit = segDistance(x, y, a[0], a[1], b[0], b[1]);
      if (hit.d <= within && (!best || hit.d < best.d)) best = { segment: s, t: hit.t, d: hit.d };
    }
    return best;
  };
  const pointOn = (segment: number, t: number): LngLat => {
    const [u, v] = graph.segments[segment];
    if (t <= 0) return graph.points[u];
    if (t >= 1) return graph.points[v];
    const a = graph.xy[u], b = graph.xy[v];
    return toLngLat(frame, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
  };
  const clearStep = (ax: number, ay: number, bx: number, by: number) => {
    const length = Math.hypot(bx - ax, by - ay), steps = Math.max(1, Math.ceil(length));
    for (let k = 1; k <= steps; k++) {
      const f = k / steps, x = ax + (bx - ax) * f, y = ay + (by - ay) * f;
      if (insideAny(x, y) && !target.some((ring) => insideXY(x, y, ring) && ringDistance(x, y, ring) < 0.5)) return false;
      if (k < steps && target.some((ring) => insideXY(x, y, ring))) return false;
      if (!offRoad(x, y)) return false;
    }
    return true;
  };
  const nearestEdge = (x: number, y: number): [number, number] => {
    let best: [number, number] = target[0][0], bestD = Infinity;
    for (const ring of target) for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i], hit = segDistance(x, y, a[0], a[1], b[0], b[1]);
      if (hit.d < bestD) { bestD = hit.d; best = [a[0] + (b[0] - a[0]) * hit.t, a[1] + (b[1] - a[1]) * hit.t]; }
    }
    return best;
  };

  // Exits: the saved doors first, then other points of the footprint edge with a short, clear
  // step to the network, spread around the building.
  type ExitCandidate = { edge: [number, number]; node?: number; segment?: number; t?: number; connector: number; door: boolean };
  const candidates: ExitCandidate[] = [];
  for (const node of doorNodes) {
    const [x, y] = graph.xy[node], edge = nearestEdge(x, y);
    candidates.push({ edge, node, connector: Math.hypot(edge[0] - x, edge[1] - y), door: true });
  }
  for (const ring of target) for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let s = 1.5; s < length; s += 3) {
      const x = a[0] + (b[0] - a[0]) * s / length, y = a[1] + (b[1] - a[1]) * s / length;
      const hit = nearestSegment(x, y, G.exitConnectorMaxMetres);
      if (!hit) continue;
      const [u, v] = graph.segments[hit.segment], qa = graph.xy[u], qb = graph.xy[v];
      const qx = qa[0] + (qb[0] - qa[0]) * hit.t, qy = qa[1] + (qb[1] - qa[1]) * hit.t;
      if (targetClearance(qx, qy) < 0.5 || insideAny(qx, qy) || !offRoad(qx, qy) || !clearStep(x, y, qx, qy)) continue;
      candidates.push({ edge: [x, y], segment: hit.segment, t: hit.t, connector: hit.d, door: false });
    }
  }
  const chosen: ExitCandidate[] = [];
  const spaced = (c: ExitCandidate) => chosen.every((o) => Math.hypot(o.edge[0] - c.edge[0], o.edge[1] - c.edge[1]) >= G.exitSpacingMetres);
  for (const c of candidates.filter((c) => c.door)) if (spaced(c)) chosen.push(c);
  for (const c of candidates.filter((c) => !c.door).sort((a, b) => a.connector - b.connector || a.edge[0] - b.edge[0] || a.edge[1] - b.edge[1])) {
    if (chosen.length >= G.maxExits) break;
    if (spaced(c)) chosen.push(c);
  }
  const exits: Exit[] = chosen.map((c) => {
    const node = c.node ?? graph.attach(c.segment!, pointOn(c.segment!, c.t!));
    return { edge: toLngLat(frame, c.edge[0], c.edge[1]), node, connector: c.connector, door: c.door, tree: undefined as unknown as Tree };
  });

  // Standing areas: points on the network 30-80 m from the burning footprint, outside every
  // footprint, off the carriageway, clear of the apparatus, spread around the building.
  const spotOk = (x: number, y: number) => {
    const c = targetClearance(x, y);
    return c >= G.spotMinMetres && c <= G.spotMaxMetres && footprintClear(x, y, G.footprintClearanceMetres) && offRoad(x, y)
      && clearOfApparatus(x, y, G.apparatusClearanceMetres);
  };
  type AreaCandidate = { segment: number; t: number; x: number; y: number; clearance: number; score: number; sector: number };
  const areaCandidates: AreaCandidate[] = [];
  for (let s = 0; s < baseSegments; s++) {
    const [u, v] = graph.segments[s];
    if (!reachable(u) || !reachable(v)) continue;
    const a = graph.xy[u], b = graph.xy[v], length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    for (let d = Math.min(2, length / 2); d < length; d += 4) {
      const t = d / length, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      const clearance = targetClearance(x, y);
      if (clearance < G.standMinMetres || clearance > G.standMaxMetres || !footprintClear(x, y, 2) || !offRoad(x, y)
        || !clearOfApparatus(x, y, G.apparatusClearanceMetres + 8)) continue;
      areaCandidates.push({ segment: s, t, x, y, clearance, score: Math.abs(clearance - 42), sector: Math.floor(((Math.atan2(x, y) + Math.PI) / (2 * Math.PI)) * 8) % 8 });
    }
  }
  areaCandidates.sort((a, b) => a.score - b.score || a.x - b.x || a.y - b.y);
  const forward = (from: number, toward: number, length: number): LngLat[] => {
    // Follow the network from `from` through `toward`, as straight as it goes, for `length` metres.
    const out: LngLat[] = [graph.points[from]];
    let prev = from, cur = toward, left = length;
    const visited = new Set([from]);
    while (left > 0) {
      const a = graph.xy[prev], b = graph.xy[cur], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l >= left) { const f = left / l; out.push(toLngLat(frame, a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f)); break; }
      out.push(graph.points[cur]); left -= l; visited.add(cur);
      const heading = Math.atan2(b[1] - a[1], b[0] - a[0]);
      let next = -1, bestTurn = Math.PI / 3;
      for (const n of graph.adj[cur]) {
        if (visited.has(n) || !reachable(n) && n < reach.length) continue;
        const c = graph.xy[n];
        if (Math.hypot(c[0] - b[0], c[1] - b[1]) < 1e-6) continue;
        let turn = Math.abs(Math.atan2(c[1] - b[1], c[0] - b[0]) - heading);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn < bestTurn) { bestTurn = turn; next = n; }
      }
      if (next < 0) break;
      prev = cur; cur = next;
    }
    return out;
  };
  const areas: StandingArea[] = [];
  let capacity = 0;
  const rowsWithRoads = [0, 0.9, -0.9, 1.8, -1.8];
  const rows = roads.length ? rowsWithRoads : [0, 0.6, -0.6];
  const tryArea = (c: AreaCandidate) => {
    if (areas.some((o) => metresBetween(o.centre, toLngLat(frame, c.x, c.y)) < G.areaSpacingMetres)) return;
    const centre = pointOn(c.segment, c.t);
    const [u, v] = graph.segments[c.segment];
    const node = graph.attach(c.segment, centre);
    const arms = [polyline(forward(node, v, G.stretchMetres)), polyline(forward(node, u, G.stretchMetres))];
    const spots: Spot[] = [];
    const index = areas.length;
    for (let k = 0; k * G.spotSpacingMetres <= G.stretchMetres; k++) {
      for (const side of k === 0 ? [0] : [0, 1]) {
        const arm = arms[side];
        const along = k * G.spotSpacingMetres;
        if (along > arm.cumulative[arm.cumulative.length - 1]) continue;
        let i = 1;
        while (i < arm.path.length - 1 && arm.cumulative[i] < along) i++;
        const a = toXY(frame, arm.path[i - 1]), b = toXY(frame, arm.path[Math.min(i, arm.path.length - 1)]);
        const segLength = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        const f = arm.path.length > 1 ? (along - arm.cumulative[i - 1]) / ((arm.cumulative[i] - arm.cumulative[i - 1]) || 1) : 0;
        const bx = a[0] + (b[0] - a[0]) * f, by = a[1] + (b[1] - a[1]) * f;
        const nx = -(b[1] - a[1]) / segLength, ny = (b[0] - a[0]) / segLength;
        for (const row of rows) {
          const seed = `${index}:${k}:${side}:${row}`;
          const jitterAlong = (hash01(`${seed}:a`) - 0.5) * 0.7, jitterSide = (hash01(`${seed}:s`) - 0.5) * 0.5;
          const tx = (b[0] - a[0]) / segLength, ty = (b[1] - a[1]) / segLength;
          const x = bx + nx * (row + jitterSide) + tx * jitterAlong, y = by + ny * (row + jitterSide) + ty * jitterAlong;
          const base = toLngLat(frame, bx, by);
          if (!spotOk(x, y) || !spotOk(bx, by)) continue;
          const position = toLngLat(frame, x, y);
          const toCentre = bearingOf(-x, -y) + (hash01(`${seed}:turn`) - 0.5) * 70;
          spots.push({ position, bearing: (toCentre + 360) % 360,
            approach: polyline([...arm.path.slice(0, i), base, position]) });
        }
      }
    }
    if (spots.length < 12) return;
    areas.push({ index, centre, node, clearance: c.clearance, spots, tree: undefined as unknown as Tree, used: 0 });
    capacity += spots.length;
  };
  const need = Math.max(expected * 1.25, 1);
  // One per sector first (spread around the building), then fill until there is room for everyone.
  const sectors = new Set<number>();
  for (const c of areaCandidates) {
    if (areas.length >= G.maxAreas) break;
    if (sectors.has(c.sector)) continue;
    const before = areas.length; tryArea(c);
    if (areas.length > before) sectors.add(c.sector);
    if (capacity >= need && areas.length >= 3) break;
  }
  for (const c of areaCandidates) {
    if (areas.length >= G.maxAreas || capacity >= need && areas.length >= 3) break;
    tryArea(c);
  }
  if (!areas.length || !exits.length) return null;
  for (const exit of exits) exit.tree = graph.tree(exit.node);
  for (const area of areas) area.tree = graph.tree(area.node);

  const pathFrom = (tree: Tree, node: number): Polyline => polyline(graph.pathTo(tree, node).map((n) => graph.points[n]));
  const join = (tree: Tree, route: Polyline): Polyline | null => {
    let best = -1, bestCost = Infinity, bestNode = -1;
    const total = route.cumulative[route.cumulative.length - 1];
    for (let k = 0; k < route.path.length; k++) {
      const node = graph.nodeOf(route.path[k]);
      if (node === undefined) continue;
      const cost = tree.dist[node] + (total - route.cumulative[k]);
      if (cost < bestCost - 1e-9) { bestCost = cost; best = k; bestNode = node; }
    }
    if (best < 0 || !Number.isFinite(bestCost)) return null;
    const head = pathFrom(tree, bestNode);
    const tail: Polyline = { path: route.path.slice(best), cumulative: route.cumulative.slice(best) };
    return concat([head, tail]);
  };
  const treeFrom = (p: LngLat): Tree | null => {
    const existing = graph.nodeOf(p);
    if (existing !== undefined) return graph.tree(existing, 4 * R);
    const [x, y] = toXY(frame, p);
    const hit = nearestSegment(x, y, 3);
    if (!hit) return null;
    return graph.tree(graph.attach(hit.segment, p), 4 * R);
  };
  return { graph, exits, areas, centroid, clearance: (p) => { const [x, y] = toXY(frame, p); return targetClearance(x, y); }, join, pathFrom, treeFrom };
}
