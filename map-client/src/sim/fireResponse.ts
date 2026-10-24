// Boston Fire Department response to a fire alarm at a BU building: which companies go, the
// streets they take, and where each apparatus is at any simulated time.
//
// The street graph comes from data-pipeline/fetch_fire_response.py (OpenStreetMap streets with
// one-way rules, truck restrictions and traffic signals, pruned to the firehouse-to-BU paths).
// Everything is planned once, when the alarm sounds: routes (Dijkstra on ~8k nodes), a speed
// profile along each route (accelerating, braking for corners and signals) and the timeline.
// Positions are then a pure function of sim time, so playback at any speed, pausing and
// scrubbing all agree, and nothing is computed per frame beyond a binary search.
import { lampAt, secondsToGreen, type Lamp, type SignalApproach } from './signals';

export type ApparatusKind = 'engine' | 'ladder' | 'chief';
export interface FireUnitInfo { id: string; kind: ApparatusKind; name: string }
export interface FireStation { id: string; name: string; address: string; position: [number, number]; units: FireUnitInfo[] }
export interface FireNetworkJson {
  classes: string[];
  stations: FireStation[];
  /** Delta-encoded [lng, lat] pairs in 1e-6 degrees. */
  nodes: number[];
  signals: number[];
  /** [from, to, class, flags] per street segment; flags bit 0: one-way from -> to; lanes << 1. */
  edges: number[];
  hydrants: [number, number][];
  source?: string;
  sourceUrl?: string;
}

// Local metric frame (metres east / north of a point between the campuses), the same flat-earth
// scale incidents.ts uses for footprint distances.
const LNG0 = -71.1, LAT0 = 42.345;
const KY = 111_320, KX = KY * Math.cos(LAT0 * Math.PI / 180);
export const toXY = (p: readonly number[]): [number, number] => [(p[0] - LNG0) * KX, (p[1] - LAT0) * KY];
export const toLngLat = (x: number, y: number): [number, number] => [LNG0 + x / KX, LAT0 + y / KY];

export interface FireNetwork {
  classes: string[];
  stations: FireStation[];
  x: Float64Array; y: Float64Array;
  ea: Int32Array; eb: Int32Array; cls: Uint8Array; oneway: Uint8Array; lanes: Uint8Array; len: Float64Array;
  /** CSR adjacency of legal moves out of each node: edge index, and 1 if travelling a -> b. */
  adjStart: Int32Array; adjEdge: Int32Array; adjForward: Uint8Array;
  signal: Uint8Array;
  hydrants: [number, number][]; // metres
  source?: string;
}

export function parseFireNetwork(json: FireNetworkJson): FireNetwork {
  const count = json.nodes.length / 2;
  const x = new Float64Array(count), y = new Float64Array(count);
  let lng = 0, lat = 0;
  for (let i = 0; i < count; i++) {
    lng += json.nodes[i * 2]; lat += json.nodes[i * 2 + 1];
    [x[i], y[i]] = toXY([lng / 1e6, lat / 1e6]);
  }
  const edgeCount = json.edges.length / 4;
  const ea = new Int32Array(edgeCount), eb = new Int32Array(edgeCount);
  const cls = new Uint8Array(edgeCount), oneway = new Uint8Array(edgeCount), lanes = new Uint8Array(edgeCount);
  const len = new Float64Array(edgeCount);
  const degree = new Int32Array(count + 1);
  for (let e = 0; e < edgeCount; e++) {
    const [a, b, c, flags] = json.edges.slice(e * 4, e * 4 + 4);
    ea[e] = a; eb[e] = b; cls[e] = c; oneway[e] = flags & 1; lanes[e] = flags >> 1;
    len[e] = Math.hypot(x[b] - x[a], y[b] - y[a]);
    degree[a]++;
    if (!oneway[e]) degree[b]++;
  }
  const adjStart = new Int32Array(count + 1);
  for (let i = 0; i < count; i++) adjStart[i + 1] = adjStart[i] + degree[i];
  const fill = adjStart.slice(0, count);
  const adjEdge = new Int32Array(adjStart[count]), adjForward = new Uint8Array(adjStart[count]);
  for (let e = 0; e < edgeCount; e++) {
    adjEdge[fill[ea[e]]] = e; adjForward[fill[ea[e]]++] = 1;
    if (!oneway[e]) { adjEdge[fill[eb[e]]] = e; adjForward[fill[eb[e]]++] = 0; }
  }
  const signal = new Uint8Array(count);
  for (const node of json.signals) signal[node] = 1;
  return { classes: json.classes, stations: json.stations, x, y, ea, eb, cls, oneway, lanes, len, adjStart, adjEdge, adjForward, signal,
    hydrants: json.hydrants.map(toXY), source: json.source };
}

export async function loadFireNetwork(url = '/data/fire-response.json'): Promise<FireNetwork> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Fire response network unavailable (${response.status})`);
  return parseFireNetwork(await response.json());
}

// --------------------------------------------------------------------------------------------
// Driving assumptions (explicit and uncalibrated; shown in the Incidents panel)
// --------------------------------------------------------------------------------------------

/** m/s by OSM highway class: emergency running roughly 30-50 km/h on main roads; 25 mph city streets otherwise. */
const EMERGENCY_SPEED: Record<string, number> = { motorway: 18, trunk: 13.5, primary: 13, secondary: 12, tertiary: 11, unclassified: 9, residential: 8, living_street: 5, service: 5, link: 9 };
const NORMAL_SPEED: Record<string, number> = { motorway: 22, trunk: 13, primary: 11, secondary: 10.5, tertiary: 9.5, unclassified: 8, residential: 7, living_street: 4, service: 4, link: 8 };
const KIND_LENGTH: Record<ApparatusKind, number> = { engine: 10.2, ladder: 12.8, chief: 5.3 };
export const FIRE_RESPONSE_ASSUMPTIONS = {
  /** First-alarm box for a reported structure fire: BFD sends 3 engines, 2 ladders, a rescue and a district chief; the rescue isn't modeled. */
  assignment: { engine: 3, ladder: 2, chief: 1 },
  turnoutMinSeconds: 60, turnoutMaxSeconds: 80,
  lightsBeforeDepartSeconds: 30,
  signalPenaltySeconds: 4,
  /** Through a red signal with lights and siren: slow to ~10 km/h and clear the intersection; ~23 km/h through a green. */
  redSignalSpeed: 2.8, greenSignalSpeed: 6.5,
  emergencyAccel: 1.3, emergencyBrake: 2.2, normalAccel: 1.0, normalBrake: 1.8,
  emergencyLateral: 2.0, normalLateral: 1.4,
  /** A short reverse run down a one-way street to reach the kerb, as apparatus do on a final approach. */
  contraFlowMetres: 60,
  minimumOnSceneSeconds: 300,
  /** Released after access reopens: ladder first, engines pick up hose, the chief last. */
  releaseAfterSeconds: { ladder: 180, engine: 300, chief: 540 },
} as const;
export const FIRE_RESPONSE_LIMITATIONS = [
  'Companies, quarters and districts are from Boston.gov and OpenStreetMap. Dispatch picks the nearest units by modeled drive time; it ignores units already busy, move-ups, mutual aid from Brookline or Cambridge, and the rescue company in the real assignment.',
  'Routes follow OpenStreetMap streets, one-way rules and truck restrictions (no Storrow Drive underpasses). Apparatus may drive up to 60 m against a one-way street on the final approach. Traffic, double-parked cars and road works are not modeled.',
  'Turnout (60–80 s), speeds (about 30–50 km/h on main roads, slower through corners), slowing to ~10 km/h through red signals and the time on scene are uncalibrated assumptions, not BFD response data.',
  'Parking places are modeled: the first ladder at the kerb nearest the building, the first engine at a mapped hydrant when one is on its approach, others behind. Real positioning depends on the incident commander.',
] as const;

const SERVICE_PENALTY_M = 20;
const STEP = 2; // metres between profile samples

function driveSpeed(net: FireNetwork, edge: number, emergency: boolean) {
  const name = net.classes[net.cls[edge]];
  return (emergency ? EMERGENCY_SPEED : NORMAL_SPEED)[name] ?? 8;
}
/** Half the carriageway width in metres, from OSM lanes (or a typical count for the class). */
function roadHalfWidth(net: FireNetwork, edge: number) {
  const name = net.classes[net.cls[edge]];
  const typical = net.oneway[edge] ? (name === 'primary' || name === 'secondary' ? 2 : 1) : (name === 'primary' ? 4 : 2);
  return (net.lanes[edge] || typical) * 3.1 / 2 + 1.0;
}
const driveOffset = (net: FireNetwork, edge: number) => (net.oneway[edge] ? 0 : 1.7);
// Kerbside, capped: OSM centrelines and lane counts are rough, and a truck must never end up on the
// pavement or in a building's wall.
const parkOffset = (net: FireNetwork, edge: number) => Math.max(driveOffset(net, edge), Math.min(3.6, roadHalfWidth(net, edge) - 1.6));

// --------------------------------------------------------------------------------------------
// Snapping and routing
// --------------------------------------------------------------------------------------------

export interface Snap { edge: number; f: number; x: number; y: number; distance: number }

/** Nearest street point to any of `points` ([lng, lat]); motorways never, service roads only when clearly nearer. */
export function snapTo(net: FireNetwork, points: readonly (readonly number[])[]): Snap {
  const xy = points.map(toXY);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [px, py] of xy) { minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
  let best: Snap | null = null, bestScore = Infinity;
  for (let e = 0; e < net.ea.length; e++) {
    const a = net.ea[e], b = net.eb[e];
    // Skip segments wholly further than the best so far from the points' bounding box.
    const gap = Math.max(minX - Math.max(net.x[a], net.x[b]), Math.min(net.x[a], net.x[b]) - maxX, minY - Math.max(net.y[a], net.y[b]), Math.min(net.y[a], net.y[b]) - maxY);
    if (gap > bestScore || gap > 400) continue;
    const name = net.classes[net.cls[e]];
    const penalty = name === 'motorway' || name === 'trunk' || name === 'link' ? 1e4 : name === 'service' || name === 'living_street' ? SERVICE_PENALTY_M : 0;
    const ax = net.x[net.ea[e]], ay = net.y[net.ea[e]], dx = net.x[net.eb[e]] - ax, dy = net.y[net.eb[e]] - ay;
    const l2 = dx * dx + dy * dy;
    for (const [px, py] of xy) {
      const f = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
      const d = Math.hypot(ax + f * dx - px, ay + f * dy - py);
      if (d + penalty < bestScore) { bestScore = d + penalty; best = { edge: e, f, x: ax + f * dx, y: ay + f * dy, distance: d }; }
    }
  }
  if (!best) throw new Error('Fire response network has no streets');
  return best;
}

/** The point of `edge` nearest (x, y) metres. */
export function snapOnEdge(net: FireNetwork, edge: number, x: number, y: number): Snap {
  const ax = net.x[net.ea[edge]], ay = net.y[net.ea[edge]], dx = net.x[net.eb[edge]] - ax, dy = net.y[net.eb[edge]] - ay;
  const l2 = dx * dx + dy * dy;
  const f = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
  return { edge, f, x: ax + f * dx, y: ay + f * dy, distance: Math.hypot(ax + f * dx - x, ay + f * dy - y) };
}

export interface Route {
  /** Polyline in metres: the start point, graph nodes, the end point. */
  xs: number[]; ys: number[];
  /** Per segment (point i to i + 1): street edge. */
  edges: number[];
  /** Graph node id at each point (-1 at the snapped ends). */
  nodes: number[];
  seconds: number; metres: number;
  /** Arrived at the target point from the edge's b end (against a -> b). */
  fromB: boolean;
}

class Heap {
  private keys: number[] = []; private items: number[] = [];
  get size() { return this.items.length; }
  push(key: number, item: number) {
    let i = this.items.length;
    this.keys.push(key); this.items.push(item);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= key) break;
      this.keys[i] = this.keys[p]; this.items[i] = this.items[p]; i = p;
    }
    this.keys[i] = key; this.items[i] = item;
  }
  pop(): [number, number] {
    const top: [number, number] = [this.keys[0], this.items[0]];
    const key = this.keys.pop()!, item = this.items.pop()!;
    const n = this.items.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && this.keys[c + 1] < this.keys[c]) c++;
        if (this.keys[c] >= key) break;
        this.keys[i] = this.keys[c]; this.items[i] = this.items[c]; i = c;
      }
      this.keys[i] = key; this.items[i] = item;
    }
    return top;
  }
}

const bearingOf = (dx: number, dy: number) => ((Math.atan2(dx, dy) * 180 / Math.PI) + 360) % 360;
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

/**
 * Quickest legal route between two snapped street points. `emergency` uses emergency speeds and
 * allows the short contra-flow final approach; `startBearing` makes a U-turn at the start cost
 * extra (a parked truck pulls away forwards).
 */
export function routeBetween(net: FireNetwork, from: Snap, to: Snap, options: { emergency: boolean; startBearing?: number }): Route | null {
  const { emergency } = options;
  const n = net.x.length, T = n;
  const dist = new Float64Array(n + 1).fill(Infinity);
  const prev = new Int32Array(n + 1).fill(-2); // -1: seeded from the start point
  const prevEdge = new Int32Array(n + 1).fill(-1);
  const heap = new Heap();
  const time = (edge: number, metres: number) => metres / driveSpeed(net, edge, emergency);
  const uturn = (forward: boolean) => {
    if (options.startBearing === undefined) return 0;
    const e = from.edge, dx = net.x[net.eb[e]] - net.x[net.ea[e]], dy = net.y[net.eb[e]] - net.y[net.ea[e]];
    const heading = forward ? bearingOf(dx, dy) : bearingOf(-dx, -dy);
    return angleDiff(heading, options.startBearing) > 100 ? 45 : 0;
  };
  const seed = (node: number, cost: number) => {
    if (cost < dist[node]) { dist[node] = cost; prev[node] = -1; prevEdge[node] = from.edge; heap.push(cost, node); }
  };
  const L = net.len[from.edge];
  seed(net.eb[from.edge], time(from.edge, (1 - from.f) * L) + uturn(true));
  if (!net.oneway[from.edge]) seed(net.ea[from.edge], time(from.edge, from.f * L) + uturn(false));
  // Target candidates.
  const tl = net.len[to.edge];
  const contra = (metres: number) => !net.oneway[to.edge] || (emergency && metres <= FIRE_RESPONSE_ASSUMPTIONS.contraFlowMetres);
  let direct = Infinity, directFromB = false;
  if (from.edge === to.edge) {
    if (to.f >= from.f) { direct = time(to.edge, (to.f - from.f) * tl) + uturn(true); }
    else if (contra((from.f - to.f) * tl)) { direct = time(to.edge, (from.f - to.f) * tl) * (net.oneway[to.edge] ? 1.5 : 1) + uturn(false); directFromB = true; }
  }
  if (direct < Infinity) { dist[T] = direct; prev[T] = -1; heap.push(direct, T); }
  let fromB = directFromB;
  while (heap.size) {
    const [cost, u] = heap.pop();
    if (cost > dist[u]) continue;
    if (u === T) break;
    const relax = (v: number, c: number, edge: number) => {
      if (c < dist[v]) { dist[v] = c; prev[v] = u; prevEdge[v] = edge; heap.push(c, v); if (v === T) fromB = u === net.eb[to.edge] && u !== net.ea[to.edge]; }
    };
    if (u === net.ea[to.edge]) relax(T, cost + time(to.edge, to.f * tl), to.edge);
    if (u === net.eb[to.edge] && contra((1 - to.f) * tl)) relax(T, cost + time(to.edge, (1 - to.f) * tl) * (net.oneway[to.edge] ? 1.5 : 1), to.edge);
    const deadEnd = net.adjStart[u + 1] - net.adjStart[u] <= 1;
    for (let k = net.adjStart[u]; k < net.adjStart[u + 1]; k++) {
      const e = net.adjEdge[k];
      // No U-turn straight back down the street just driven, except out of a dead end.
      if (e === prevEdge[u] && !deadEnd) continue;
      const v = net.adjForward[k] ? net.eb[e] : net.ea[e];
      relax(v, cost + time(e, net.len[e]) + (net.signal[v] ? FIRE_RESPONSE_ASSUMPTIONS.signalPenaltySeconds : 0), e);
    }
  }
  if (dist[T] === Infinity) return null;
  // Walk back from the target.
  const nodes: number[] = [], edges: number[] = [];
  let node = prev[T];
  edges.push(to.edge);
  while (node >= 0) {
    nodes.push(node);
    if (prev[node] === -1) { edges.push(from.edge); break; }
    edges.push(prevEdge[node]);
    node = prev[node];
  }
  if (prev[T] === -1) edges.length = 1; // same edge, no graph nodes
  nodes.reverse(); edges.reverse();
  const xs = [from.x, ...nodes.map((v) => net.x[v]), to.x];
  const ys = [from.y, ...nodes.map((v) => net.y[v]), to.y];
  let metres = 0;
  for (let i = 1; i < xs.length; i++) metres += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  return { xs, ys, edges, nodes: [-1, ...nodes, -1], seconds: dist[T], metres, fromB: prev[T] === -1 ? directFromB : fromB };
}

// --------------------------------------------------------------------------------------------
// Legs: a route resampled into a drivable path with a speed profile
// --------------------------------------------------------------------------------------------

export interface Leg {
  n: number;
  x: Float64Array; y: Float64Array; s: Float64Array; bearing: Float64Array;
  v: Float64Array; t: Float64Array; wait: Float64Array;
  /** Bearing the vehicle starts with, blended into the path over the first metres (pulling out of a parking place). */
  initialBearing?: number;
  start: number; end: number; metres: number;
}

export interface SignalOracle {
  approaches: SignalApproach[];
  lamp(time: number, group: string, axis: number, flash?: boolean, movement?: string): Lamp | null;
  toGreen(time: number, group: string, axis: number, movement?: string): number;
}
export const signalOracle = (approaches: SignalApproach[]): SignalOracle => ({ approaches, lamp: lampAt, toGreen: secondsToGreen });

const stopLineCache = new WeakMap<SignalApproach[], { approach: SignalApproach; x: number; y: number }[]>();
function stopLines(signals: SignalOracle) {
  let list = stopLineCache.get(signals.approaches);
  if (!list) {
    list = signals.approaches.filter((a) => a.stopLine && a.approach !== undefined).map((approach) => {
      const [x, y] = toXY(approach.stopLine!);
      return { approach, x, y };
    });
    stopLineCache.set(signals.approaches, list);
  }
  return list;
}

interface SignalEvent { sample: number; group: string; axis: number; movement?: string; flash?: boolean }

interface LegInput {
  /** Polyline in metres with per-segment street edge (-1: off-street apron, e.g. a firehouse bay). */
  xs: number[]; ys: number[]; edges: number[]; nodes: number[];
  startOffset?: number; endOffset?: number;
  emergency: boolean; kind: ApparatusKind; start: number; initialBearing?: number;
}

function buildLeg(net: FireNetwork, input: LegInput, signals: SignalOracle | null): Leg {
  const { xs, ys, edges } = input;
  const cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
  const total = cum[cum.length - 1];
  const n = Math.max(2, Math.ceil(total / STEP) + 1);
  const cx = new Float64Array(n), cy = new Float64Array(n), s = new Float64Array(n), seg = new Int32Array(n);
  let hint = 0; // queries mostly move forward along the line
  const at = (d: number, out: [number, number]) => {
    let i = cum[hint] <= d ? hint : 0;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    hint = i;
    const l = cum[i + 1] - cum[i], f = l > 0 ? Math.min(1, Math.max(0, (d - cum[i]) / l)) : 0;
    out[0] = xs[i] + (xs[i + 1] - xs[i]) * f; out[1] = ys[i] + (ys[i + 1] - ys[i]) * f;
    return i;
  };
  const p: [number, number] = [0, 0], q: [number, number] = [0, 0];
  for (let k = 0; k < n; k++) {
    s[k] = Math.min(total, (k * total) / (n - 1));
    seg[k] = at(s[k], p); cx[k] = p[0]; cy[k] = p[1];
  }
  // Lateral offset to the right of the centreline: lane position, smoothed across junctions, eased
  // from/to the kerb at the ends.
  const raw = new Float64Array(n);
  for (let k = 0; k < n; k++) raw[k] = edges[seg[k]] < 0 ? 0 : driveOffset(net, edges[seg[k]]);
  const offset = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let sum = 0, count = 0;
    for (let j = Math.max(0, k - 5); j <= Math.min(n - 1, k + 5); j++) { sum += raw[j]; count++; }
    offset[k] = edges[seg[k]] < 0 ? 0 : sum / count;
  }
  const ease = (u: number) => { const c = Math.min(1, Math.max(0, u)); return c * c * (3 - 2 * c); };
  for (let k = 0; k < n; k++) {
    if (input.startOffset !== undefined) offset[k] += (input.startOffset - offset[k]) * (1 - ease(s[k] / 20));
    if (input.endOffset !== undefined) offset[k] += (input.endOffset - offset[k]) * ease(1 - (total - s[k]) / 25);
  }
  const x = new Float64Array(n), y = new Float64Array(n), bearing = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    at(Math.max(0, s[k] - 4), p); at(Math.min(total, s[k] + 4), q);
    const dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy) || 1;
    x[k] = cx[k] + (dy / l) * offset[k]; y[k] = cy[k] - (dx / l) * offset[k];
  }
  for (let k = 0; k < n; k++) {
    const a = Math.max(0, k - 2), b = Math.min(n - 1, k + 2);
    bearing[k] = bearingOf(x[b] - x[a], y[b] - y[a]);
  }
  // Speed limits: street class, corners, the bay apron.
  const A = FIRE_RESPONSE_ASSUMPTIONS;
  const chief = input.kind === 'chief';
  const accel = input.emergency ? (chief ? 2.6 : A.emergencyAccel) : (chief ? 2 : A.normalAccel);
  const brake = input.emergency ? (chief ? 3.5 : A.emergencyBrake) : (chief ? 3 : A.normalBrake);
  const lateral = (input.emergency ? A.emergencyLateral : A.normalLateral) * (chief ? 1.4 : 1);
  const vmax = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const edge = edges[seg[k]];
    let limit = edge < 0 ? 2.5 : driveSpeed(net, edge, input.emergency) * (chief && input.emergency ? 1.05 : 1);
    const a = Math.max(0, k - 3), b = Math.min(n - 1, k + 3);
    if (b > a) {
      const turn = angleDiff(bearing[a], bearing[b]) * Math.PI / 180;
      const arc = s[b] - s[a];
      if (turn > 0.05 && arc > 0) limit = Math.min(limit, Math.max(2.5, Math.sqrt(lateral / (turn / arc))));
    }
    vmax[k] = limit;
  }
  const v = new Float64Array(n), t = new Float64Array(n), wait = new Float64Array(n);
  const solve = (limits: Float64Array, stops: Map<number, number>) => {
    v[n - 1] = 0;
    for (let k = n - 2; k >= 0; k--) v[k] = Math.min(stops.has(k) ? 0 : limits[k], Math.sqrt(v[k + 1] ** 2 + 2 * brake * (s[k + 1] - s[k])));
    v[0] = 0;
    for (let k = 1; k < n; k++) v[k] = Math.min(v[k], Math.sqrt(v[k - 1] ** 2 + 2 * accel * (s[k] - s[k - 1])));
    t[0] = input.start;
    for (let k = 0; k < n; k++) {
      wait[k] = stops.get(k) ?? 0;
      if (k + 1 < n) t[k + 1] = t[k] + wait[k] + (2 * (s[k + 1] - s[k])) / Math.max(0.3, v[k] + v[k + 1]);
    }
  };
  // Signals on the way: street.json approaches (with their real timing plans) by stop line and
  // direction, then any other OSM signal node on the route with a simulated plan.
  const events: SignalEvent[] = [];
  if (signals) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let k = 0; k < n; k++) { minX = Math.min(minX, cx[k]); maxX = Math.max(maxX, cx[k]); minY = Math.min(minY, cy[k]); maxY = Math.max(maxY, cy[k]); }
    for (const { approach, x: sx, y: sy } of stopLines(signals)) {
      if (sx < minX - 7 || sx > maxX + 7 || sy < minY - 7 || sy > maxY + 7) continue;
      let best = -1, bestD = 49;
      for (let k = 3; k < n - 3; k++) {
        const d = (cx[k] - sx) ** 2 + (cy[k] - sy) ** 2;
        if (d < bestD && angleDiff(bearing[k], approach.approach!) < 40) { bestD = d; best = k; }
      }
      if (best >= 0 && !events.some((e) => e.group === approach.group)) events.push({ sample: best, group: approach.group, axis: approach.axis, movement: approach.movement, flash: approach.flash });
    }
    input.nodes.forEach((node, i) => {
      if (node < 0 || !net.signal[node]) return;
      const k = Math.round(cum[i] / total * (n - 1)) - 4;
      if (k < 3 || k >= n - 3) return;
      if (events.some((e) => Math.abs(s[e.sample] - s[k]) < 35)) return;
      const edge = edges[Math.min(edges.length - 1, Math.max(0, i - 1))];
      const name = edge >= 0 ? net.classes[net.cls[edge]] : 'service';
      events.push({ sample: k, group: `osm-${node}`, axis: name === 'primary' || name === 'secondary' || name === 'trunk' ? 0 : 1 });
    });
    events.sort((a, b) => a.sample - b.sample);
  }
  const limits = vmax.slice();
  const stops = new Map<number, number>();
  solve(limits, stops);
  if (signals && input.emergency) {
    // Lights and siren: through every signal, crawling through a red one. Two passes, as slowing
    // for one red shifts when the next signal is reached.
    for (let pass = 0; pass < 2; pass++) {
      for (const e of events) {
        const lamp = signals.lamp(t[e.sample], e.group, e.axis, e.flash, e.movement);
        const limit = e.flash ? 5 : lamp === 'green' ? A.greenSignalSpeed : A.redSignalSpeed;
        for (let k = Math.max(0, e.sample - 2); k <= Math.min(n - 1, e.sample + 4); k++) limits[k] = Math.min(vmax[k], limit);
      }
      solve(limits, stops);
    }
  } else if (signals) {
    // Back in service: stop at red and wait for green, in route order.
    for (const e of events) {
      if (e.flash) { for (let k = Math.max(0, e.sample - 2); k <= e.sample + 2 && k < n; k++) limits[k] = Math.min(limits[k], 4); solve(limits, stops); continue; }
      const lamp = signals.lamp(t[e.sample], e.group, e.axis, false, e.movement);
      if (lamp === 'green') continue;
      stops.set(e.sample, 0);
      solve(limits, stops);
      stops.set(e.sample, Math.min(120, signals.toGreen(t[e.sample], e.group, e.axis, e.movement)));
      solve(limits, stops);
    }
  }
  return { n, x, y, s, bearing, v, t, wait, initialBearing: input.initialBearing, start: input.start, end: t[n - 1] + wait[n - 1], metres: total };
}

const lerpAngle = (a: number, b: number, f: number) => (a + ((((b - a) % 360) + 540) % 360 - 180) * f + 360) % 360;

/** Where along a leg the vehicle is at `time`: writes [x, y] metres and returns the bearing. */
export function legAt(leg: Leg, time: number, out: [number, number]): number {
  const { t, wait, s, v, n } = leg;
  if (time <= t[0]) { out[0] = leg.x[0]; out[1] = leg.y[0]; return leg.initialBearing ?? leg.bearing[0]; }
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= time) lo = mid; else hi = mid - 1; }
  let k = lo, f = 0;
  if (k < n - 1 && time > t[k] + wait[k]) {
    const tau = time - t[k] - wait[k], ds = s[k + 1] - s[k];
    const a = ds > 0 ? (v[k + 1] ** 2 - v[k] ** 2) / (2 * ds) : 0;
    f = ds > 0 ? Math.min(1, Math.max(0, (v[k] * tau + 0.5 * a * tau * tau) / ds)) : 1;
  }
  if (k >= n - 1) { k = n - 2; f = 1; }
  out[0] = leg.x[k] + (leg.x[k + 1] - leg.x[k]) * f;
  out[1] = leg.y[k] + (leg.y[k + 1] - leg.y[k]) * f;
  let bearing = lerpAngle(leg.bearing[k], leg.bearing[k + 1], f);
  const along = s[k] + (s[k + 1] - s[k]) * f;
  if (leg.initialBearing !== undefined && along < 12) bearing = lerpAngle(leg.initialBearing, bearing, (along / 12) ** 2 * (3 - 2 * along / 12));
  return bearing;
}

// --------------------------------------------------------------------------------------------
// Dispatch
// --------------------------------------------------------------------------------------------

export type ApparatusPhase = 'turnout' | 'responding' | 'on-scene' | 'returning';
export interface ApparatusPlan {
  id: string; kind: ApparatusKind; name: string;
  /** "BFD Ladder 15". */
  label: string;
  station: FireStation;
  alarm: number; lightsOn: number; depart: number; arrive: number; release: number; home: number;
  out: Leg; back: Leg;
  /** Parked beside a mapped hydrant. */
  hydrant: boolean;
  /** Drive time estimate used for dispatch (seconds, alarm to arrival). */
  eta: number;
  /** Deterministic offset so each apparatus's strobes run on their own beat. */
  flashOffset: number;
}
export interface FireResponse {
  incidentId: string;
  targetName: string;
  units: ApparatusPlan[];
  /** First and last moments any apparatus is on the map. */
  from: number; until: number;
  source?: string;
}
export interface FireAlarmInput {
  id: string;
  start: number;
  /** When building access reopens (the incident's endsAt). */
  endsAt: number;
  targetName: string;
  position: [number, number];
  polygon?: [number, number][];
}

function hash01(text: string) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  // Final avalanche (murmur3 fmix32): ids that differ in one character still spread evenly.
  h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function densify(polygon: readonly (readonly number[])[], metres = 4): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    const [ax, ay] = toXY(a), [bx, by] = toXY(b);
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / metres));
    for (let k = 0; k < steps; k++) out.push(toLngLat(ax + (bx - ax) * k / steps, ay + (by - ay) * k / steps));
  }
  return out;
}

const stationSnaps = new WeakMap<FireNetwork, Map<string, { snap: Snap; bay: [number, number] }>>();
/** Where a firehouse's apron meets its street, and a point inside the bay ~12 m back from the kerb. */
function stationAccess(net: FireNetwork, station: FireStation) {
  let cache = stationSnaps.get(net);
  if (!cache) stationSnaps.set(net, (cache = new Map()));
  let entry = cache.get(station.id);
  if (!entry) {
    const snap = snapTo(net, [station.position]);
    const [sx, sy] = toXY(station.position);
    const dx = sx - snap.x, dy = sy - snap.y, d = Math.hypot(dx, dy);
    const back = Math.min(12, d) / (d || 1);
    entry = { snap, bay: [snap.x + dx * back, snap.y + dy * back] };
    cache.set(station.id, entry);
  }
  return entry;
}

/** Cut a route polyline `metres` short of its end (where a vehicle's centre stops). */
function shorten(route: Route, metres: number) {
  const xs = route.xs.slice(), ys = route.ys.slice(), edges = route.edges.slice(), nodes = route.nodes.slice();
  let left = metres;
  while (left > 0 && xs.length > 2) {
    const i = xs.length - 1, l = Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
    if (l > left) {
      const f = (l - left) / l;
      xs[i] = xs[i - 1] + (xs[i] - xs[i - 1]) * f; ys[i] = ys[i - 1] + (ys[i] - ys[i - 1]) * f; nodes[i] = -1;
      left = 0;
    } else { xs.pop(); ys.pop(); edges.pop(); nodes.pop(); nodes[nodes.length - 1] = -1; left -= l; }
  }
  if (left > 0 && xs.length === 2) {
    const l = Math.hypot(xs[1] - xs[0], ys[1] - ys[0]), f = Math.max(0.05, (l - left) / (l || 1));
    xs[1] = xs[0] + (xs[1] - xs[0]) * f; ys[1] = ys[0] + (ys[1] - ys[0]) * f;
  }
  return { xs, ys, edges, nodes };
}

/** Distance along a polyline (from its end) of the point nearest (x, y), if within `within` metres. */
function backFromEnd(xs: number[], ys: number[], x: number, y: number, within: number): number | null {
  let total = 0;
  const cum = [0];
  for (let i = 1; i < xs.length; i++) cum.push((total += Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1])));
  let best: number | null = null, bestD = within;
  for (let i = 0; i + 1 < xs.length; i++) {
    const dx = xs[i + 1] - xs[i], dy = ys[i + 1] - ys[i], l2 = dx * dx + dy * dy;
    const f = l2 ? Math.max(0, Math.min(1, ((x - xs[i]) * dx + (y - ys[i]) * dy) / l2)) : 0;
    const d = Math.hypot(xs[i] + f * dx - x, ys[i] + f * dy - y);
    if (d < bestD) { bestD = d; best = total - (cum[i] + f * Math.sqrt(l2)); }
  }
  return best;
}

/**
 * Plan the first-alarm response to a fire alarm: nearest companies by drive time, routes, parking
 * places and the whole timeline from turnout to back in quarters.
 */
export function planFireResponse(net: FireNetwork, alarm: FireAlarmInput, options: { signals?: SignalOracle | null; assignment?: { engine: number; ladder: number; chief: number } } = {}): FireResponse {
  const A = FIRE_RESPONSE_ASSUMPTIONS;
  const signals = options.signals ?? null;
  const assignment = options.assignment ?? A.assignment;
  const kerb = snapTo(net, alarm.polygon?.length ? [...densify(alarm.polygon), alarm.position] : [alarm.position]);
  // Candidate companies, by emergency drive time from their firehouse.
  const candidates: { unit: FireUnitInfo; station: FireStation; route: Route; turnout: number }[] = [];
  for (const station of net.stations) {
    const { snap } = stationAccess(net, station);
    const route = routeBetween(net, snap, kerb, { emergency: true });
    if (!route) continue;
    for (const unit of station.units) {
      const turnout = A.turnoutMinSeconds + hash01(`${alarm.id}:${unit.id}`) * (A.turnoutMaxSeconds - A.turnoutMinSeconds);
      candidates.push({ unit, station, route, turnout });
    }
  }
  const chosen = (['ladder', 'engine', 'chief'] as const).flatMap((kind) => candidates
    .filter((c) => c.unit.kind === kind)
    .sort((a, b) => a.route.seconds + a.turnout - (b.route.seconds + b.turnout))
    .slice(0, assignment[kind])
    .map((c, rank) => ({ ...c, rank })));
  // Parking priority: first ladder at the building, first engine (at a hydrant), the chief, then the rest.
  const priority = (c: typeof chosen[number]) => c.unit.kind === 'ladder' ? (c.rank === 0 ? 0 : 4) : c.unit.kind === 'engine' ? (c.rank === 0 ? 1 : 3 + c.rank) : 2;
  chosen.sort((a, b) => priority(a) - priority(b));
  const placed = new Map<string, [number, number][]>(); // per approach side: occupied [from, to] metres back from the kerb point
  const units: ApparatusPlan[] = [];
  for (const c of chosen) {
    const length = KIND_LENGTH[c.unit.kind];
    const side = c.route.fromB ? 'b' : 'a';
    const taken = placed.get(side) ?? [];
    const fits = (d: number) => taken.every(([lo, hi]) => d + length / 2 + 1.5 <= lo || d - length / 2 - 1.5 >= hi);
    let preferred = c.unit.kind === 'ladder' && c.rank === 0 ? 0 : length / 2 + 8;
    let hydrant = false;
    if (c.unit.kind === 'engine' && c.rank === 0) {
      let bestHydrant: number | null = null;
      for (const [hx, hy] of net.hydrants) {
        const back = backFromEnd(c.route.xs, c.route.ys, hx, hy, 16);
        if (back !== null && back >= 12 && back <= 140 && (bestHydrant === null || back < bestHydrant) && fits(back)) bestHydrant = back;
      }
      if (bestHydrant !== null) { preferred = bestHydrant; hydrant = true; }
    }
    let d = preferred;
    while (!fits(d)) d += 1;
    d = Math.min(d, Math.max(0, c.route.metres - 15));
    taken.push([d - length / 2, d + length / 2]);
    placed.set(side, taken);

    const { snap: home, bay } = stationAccess(net, c.station);
    const cut = shorten(c.route, d);
    const outEdges = [-1, ...cut.edges];
    const lightsOn = alarm.start + Math.max(0, c.turnout - A.lightsBeforeDepartSeconds);
    const depart = alarm.start + c.turnout;
    const finalEdge = cut.edges[cut.edges.length - 1];
    const out = buildLeg(net, {
      xs: [bay[0], ...cut.xs], ys: [bay[1], ...cut.ys], edges: outEdges, nodes: [-1, ...cut.nodes],
      // Its own right-hand kerb, whichever way it came.
      endOffset: parkOffset(net, finalEdge), emergency: true, kind: c.unit.kind, start: depart,
    }, signals);
    const arrive = out.end;
    const release = Math.max(alarm.endsAt + A.releaseAfterSeconds[c.unit.kind] + (c.unit.kind === 'engine' ? c.rank * 60 : 0), arrive + A.minimumOnSceneSeconds);
    // Back to quarters from where it parked, at normal speed, lights off, stopping for red.
    const parkedBearing = out.bearing[out.n - 1];
    const start = snapOnEdge(net, finalEdge, cut.xs[cut.xs.length - 1], cut.ys[cut.ys.length - 1]);
    const ret = routeBetween(net, start, home, { emergency: false, startBearing: parkedBearing })
      ?? routeBetween(net, start, home, { emergency: true, startBearing: parkedBearing })!;
    const firstBearing = bearingOf(ret.xs[Math.min(1, ret.xs.length - 1)] - ret.xs[0], ret.ys[Math.min(1, ret.ys.length - 1)] - ret.ys[0]);
    const reversed = angleDiff(firstBearing, parkedBearing) > 100;
    const parkedOffset = parkOffset(net, finalEdge);
    const back = buildLeg(net, {
      xs: [...ret.xs, bay[0]], ys: [...ret.ys, bay[1]], edges: [...ret.edges, -1], nodes: [...ret.nodes, -1],
      startOffset: reversed ? -parkedOffset : parkedOffset, emergency: false, kind: c.unit.kind, start: release,
      initialBearing: parkedBearing,
    }, signals);
    units.push({
      id: c.unit.id, kind: c.unit.kind, name: c.unit.name, label: `BFD ${c.unit.name}`, station: c.station,
      alarm: alarm.start, lightsOn, depart, arrive, release, home: back.end, out, back, hydrant,
      eta: arrive - alarm.start, flashOffset: hash01(c.unit.id) * 0.8,
    });
  }
  units.sort((a, b) => a.arrive - b.arrive);
  return {
    incidentId: alarm.id, targetName: alarm.targetName, units,
    from: alarm.start, until: Math.max(alarm.start, ...units.map((u) => u.home)), source: net.source,
  };
}

// --------------------------------------------------------------------------------------------
// State at a time
// --------------------------------------------------------------------------------------------

export interface ApparatusState {
  unit: ApparatusPlan;
  /** [lng, lat, 0], reused between frames. */
  position: [number, number, number];
  bearing: number;
  phase: ApparatusPhase | null;
  lights: boolean;
}

const scratch: [number, number] = [0, 0];
/** Updates `state` in place for sim time `time`; phase null means in quarters (not drawn). */
export function apparatusAt(unit: ApparatusPlan, time: number, state: ApparatusState = { unit, position: [0, 0, 0], bearing: 0, phase: null, lights: false }): ApparatusState {
  state.unit = unit;
  if (time < unit.alarm || time >= unit.home) { state.phase = null; state.lights = false; return state; }
  const leg = time < unit.release ? unit.out : unit.back;
  state.bearing = legAt(leg, time, scratch);
  const [lng, lat] = toLngLat(scratch[0], scratch[1]);
  state.position[0] = lng; state.position[1] = lat; state.position[2] = 0;
  state.phase = time < unit.depart ? 'turnout' : time < unit.arrive ? 'responding' : time < unit.release ? 'on-scene' : 'returning';
  state.lights = time >= unit.lightsOn && time < unit.release;
  return state;
}

/** "BFD Ladder 15 · responding to Photonics Center". */
export function apparatusLabel(state: ApparatusState, targetName: string): string {
  const u = state.unit;
  switch (state.phase) {
    case 'turnout': return `${u.label} · turning out from ${u.station.address}`;
    case 'responding': return `${u.label} · responding to ${targetName}`;
    case 'on-scene': return `${u.label} · on scene at ${targetName}`;
    case 'returning': return `${u.label} · returning to quarters, ${u.station.address}`;
    default: return `${u.label} · in quarters`;
  }
}

/**
 * Which strobe groups are lit, as a bitmask (bit 0: group A, bit 1: group B, bit 2: slow rear
 * group). Red/white alternate side to side with a quick double flash, on a 0.8 s cycle of real
 * (wall-clock) time, so the flashing reads the same at any playback speed. `reduced` (the
 * reader asked for reduced motion) swaps the strobes for a slow side-to-side alternation, well
 * under the 3 flashes a second photosensitivity guidance allows.
 */
export function strobeMask(seconds: number, reduced = false): number {
  if (reduced) return (((seconds % 2) + 2) % 2) < 1 ? 1 | 4 : 2;
  const step = Math.floor((((seconds % 0.8) + 0.8) % 0.8) / 0.05); // 16 steps of 50 ms
  const a = step === 0 || step === 1 || step === 3 || step === 4 ? 1 : 0;
  const b = step === 8 || step === 9 || step === 11 || step === 12 ? 2 : 0;
  const c = step < 8 ? 4 : 0;
  return a | b | c;
}
