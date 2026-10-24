// Track geometry: each route direction becomes its own track, offset to the right of the
// shared centreline (Boston runs right-hand, like the two B-branch tracks down Comm Ave).
// Vehicles snap onto the track for their direction, face along it, and glide along its curve
// between MBTA reports instead of cutting corners in a straight line.

export interface Track {
  route: string;
  direction: 0 | 1;
  points: [number, number][]; // lng/lat, in travel order
  cumulative: number[]; // metres from the start, one per point
  length: number;
  underground: [number, number][]; // [from, to] metres along the track that run in a tunnel
}

export interface TrackPosition {
  track: Track;
  s: number; // metres along the track
  distance: number; // metres from the reported position to the track
}

const METRES_PER_DEG_LAT = 110_540;
const metresPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Offset a lng/lat polyline sideways by `metres` (positive = right of travel direction). */
export function offsetPath(points: [number, number][], metres: number): [number, number][] {
  if (points.length < 2 || metres === 0) return points;
  const lat0 = points[0][1];
  const kx = metresPerDegLng(lat0);
  const xy = points.map(([lng, lat]) => [lng * kx, lat * METRES_PER_DEG_LAT]);
  return xy.map((_, i) => {
    // Average the directions of the segments either side so corners stay joined.
    const a = xy[Math.max(0, i - 1)];
    const b = xy[Math.min(xy.length - 1, i + 1)];
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    // Right-hand normal of (dx, dy) with x east and y north.
    const x = xy[i][0] + dy * metres;
    const y = xy[i][1] - dx * metres;
    return [x / kx, y / METRES_PER_DEG_LAT] as [number, number];
  });
}

// ---------------------------------------------------------------------------------------------
// Two parallel tracks per line. The Green Line paths are snapped onto OpenStreetMap's rails, whose
// nodes wander: along Comm Ave the two directions came out anywhere from 0 to 6 m apart, merging
// into one line at crossovers (BU Central) and drifting elsewhere. Where the two directions run
// together they're rebuilt from one straightened, smoothed centreline, each exactly
// TRACK_HALF_SPACING to the right of it (right-hand running), so they're straight and parallel.
// Where they really part (tunnel portals, junctions) each keeps its own path, blended in over a
// few metres. Point counts and order are kept, so tunnel spans (point indices) stay valid.
// ---------------------------------------------------------------------------------------------

/** Half the distance between the two tracks' centres (Green Line track centres are ~3.9 m apart). */
export const TRACK_HALF_SPACING = 1.95;
const PAIR_MAX_METRES = 9; // the two directions count as running together when closer than this
const FULL_SNAP_METRES = 4; // ...and are fully rebuilt this close to the shared centreline
const BLEND_END_METRES = 6.5; // blended back to their own path out to here
const CENTRELINE_TOLERANCE = 0.5; // metres: wobble straightened out of the centreline

type XY = [number, number];

function nearestOnPolyline(p: XY, line: XY[]): { point: XY; distance: number; segment: number } {
  let best = { point: line[0], distance: Infinity, segment: 0 };
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = line[i - 1];
    const sx = line[i][0] - ax;
    const sy = line[i][1] - ay;
    const len2 = sx * sx + sy * sy || 1;
    const f = Math.max(0, Math.min(1, ((p[0] - ax) * sx + (p[1] - ay) * sy) / len2));
    const q: XY = [ax + sx * f, ay + sy * f];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best.distance) best = { point: q, distance: d, segment: i };
  }
  return best;
}

/** Douglas-Peucker: keep only the points that bend the line by more than `tolerance` metres. */
function simplify(line: XY[], tolerance: number): XY[] {
  if (line.length < 3) return line;
  const keep = new Uint8Array(line.length);
  keep[0] = keep[line.length - 1] = 1;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = line[a];
    const dx = line[b][0] - ax;
    const dy = line[b][1] - ay;
    const len = Math.hypot(dx, dy) || 1;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((line[i][0] - ax) * dy - (line[i][1] - ay) * dx) / len;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return line.filter((_, i) => keep[i]);
}

/** Chaikin corner cutting: rounds the simplified line's corners into curves (ends stay put). */
function smooth(line: XY[], rounds = 2): XY[] {
  let out = line;
  for (let r = 0; r < rounds && out.length > 2; r++) {
    const next: XY[] = [out[0]];
    for (let i = 0; i < out.length - 1; i++) {
      const [ax, ay] = out[i];
      const [bx, by] = out[i + 1];
      if (i > 0) next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25]);
      if (i < out.length - 2) next.push([ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    next.push(out[out.length - 1]);
    out = next;
  }
  return out;
}

/**
 * Rebuild a line's two directions (each in its own travel order) as parallel tracks where they
 * run together (see above). Returns new paths with the same number of points as the inputs.
 */
export function alignTrackPair(
  path0: [number, number][],
  path1: [number, number][],
  halfSpacing = TRACK_HALF_SPACING,
): [[number, number][], [number, number][]] {
  if (path0.length < 2 || path1.length < 2) return [path0, path1];
  const lat0 = path0[0][1];
  const kx = metresPerDegLng(lat0);
  const toXY = ([lng, lat]: [number, number]): XY => [lng * kx, lat * METRES_PER_DEG_LAT];
  const toLngLat = ([x, y]: XY): [number, number] => [x / kx, y / METRES_PER_DEG_LAT];
  const a = path0.map(toXY);
  const b = path1.map(toXY);

  // The shared centreline: midway between the two directions wherever they run together.
  const runs: XY[][] = [];
  let run: XY[] = [];
  for (const p of a) {
    const q = nearestOnPolyline(p, b);
    if (q.distance < PAIR_MAX_METRES) {
      run.push([(p[0] + q.point[0]) / 2, (p[1] + q.point[1]) / 2]);
    } else {
      if (run.length > 1) runs.push(run);
      run = [];
    }
  }
  if (run.length > 1) runs.push(run);
  const centrelines = runs.map((r) => smooth(simplify(r, CENTRELINE_TOLERANCE)));
  if (!centrelines.length) return [path0, path1];

  const place = (path: XY[]): [number, number][] =>
    path.map((p, i) => {
      let best: { point: XY; distance: number; segment: number; line: XY[] } | null = null;
      for (const line of centrelines) {
        const q = nearestOnPolyline(p, line);
        if (!best || q.distance < best.distance) best = { ...q, line };
      }
      if (!best || best.distance >= BLEND_END_METRES) return toLngLat(p);
      // The centreline's direction at that point, turned to this track's direction of travel.
      const s0 = best.line[best.segment - 1];
      const s1 = best.line[best.segment];
      let tx = s1[0] - s0[0];
      let ty = s1[1] - s0[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const prev = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      if ((next[0] - prev[0]) * tx + (next[1] - prev[1]) * ty < 0) {
        tx = -tx;
        ty = -ty;
      }
      // Right-hand normal of the direction of travel (x east, y north).
      const target: XY = [best.point[0] + ty * halfSpacing, best.point[1] - tx * halfSpacing];
      const w = best.distance <= FULL_SNAP_METRES ? 1 : 1 - (best.distance - FULL_SNAP_METRES) / (BLEND_END_METRES - FULL_SNAP_METRES);
      return toLngLat([p[0] + (target[0] - p[0]) * w, p[1] + (target[1] - p[1]) * w]);
    });
  return [place(a), place(b)];
}

export function makeTrack(
  route: string,
  direction: 0 | 1,
  points: [number, number][],
  offsetMetres: number,
  undergroundSpans: [number, number][] = [],
): Track {
  const shifted = offsetPath(points, offsetMetres);
  const cumulative = [0];
  for (let i = 1; i < shifted.length; i++) cumulative.push(cumulative[i - 1] + distanceMetres(shifted[i - 1], shifted[i]));
  // Offsetting keeps point indices, so index spans map straight onto distances along the track.
  const underground = undergroundSpans.map(([a, b]) => [cumulative[a], cumulative[b]] as [number, number]);
  return { route, direction, points: shifted, cumulative, length: cumulative[cumulative.length - 1], underground };
}

export function isUnderground(track: Track, s: number): boolean {
  return track.underground.some(([a, b]) => s >= a && s <= b);
}

/** The track's points split into its above-ground stretches. */
function surfaceRuns(track: Track): [number, number][][] {
  const runs: [number, number][][] = [];
  let run: [number, number][] = [];
  track.points.forEach((p, i) => {
    if (isUnderground(track, track.cumulative[i])) {
      if (run.length > 1) runs.push(run);
      run = [];
    } else {
      run.push(p);
    }
  });
  if (run.length > 1) runs.push(run);
  return runs;
}

export function distanceMetres(a: [number, number], b: [number, number]): number {
  const kx = metresPerDegLng((a[1] + b[1]) / 2);
  return Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * METRES_PER_DEG_LAT);
}

// When a source reports a trustworthy heading, segments pointing the other way count as this
// much further away, so a looping shuttle route doesn't snap onto the opposite side of the street.
const WRONG_WAY_PENALTY_METRES = 60;

/** Nearest point on any of these tracks to a reported position (optionally heading-aware). */
export function snapToTracks(tracks: Track[], at: [number, number], heading?: number): TrackPosition | null {
  let best: TrackPosition | null = null;
  const kx = metresPerDegLng(at[1]);
  for (const track of tracks) {
    const p = track.points;
    for (let i = 1; i < p.length; i++) {
      const ax = (p[i - 1][0] - at[0]) * kx;
      const ay = (p[i - 1][1] - at[1]) * METRES_PER_DEG_LAT;
      const bx = (p[i][0] - at[0]) * kx;
      const by = (p[i][1] - at[1]) * METRES_PER_DEG_LAT;
      const segX = bx - ax;
      const segY = by - ay;
      const segLen2 = segX * segX + segY * segY || 1;
      const f = Math.max(0, Math.min(1, -(ax * segX + ay * segY) / segLen2));
      let distance = Math.hypot(ax + segX * f, ay + segY * f);
      if (heading !== undefined) {
        const segBearing = (Math.atan2(segX, segY) * 180) / Math.PI;
        const diff = Math.abs(((segBearing - heading + 540) % 360) - 180);
        if (diff > 100) distance += WRONG_WAY_PENALTY_METRES;
      }
      if (!best || distance < best.distance) {
        best = { track, s: track.cumulative[i - 1] + f * (track.cumulative[i] - track.cumulative[i - 1]), distance };
      }
    }
  }
  return best;
}

/** Position and heading (degrees clockwise from north) `s` metres along a track. */
export function pointAlong(track: Track, s: number): { position: [number, number]; bearing: number } {
  const c = track.cumulative;
  const clamped = Math.max(0, Math.min(track.length, s));
  let i = 1;
  while (i < c.length - 1 && c[i] < clamped) i++;
  const a = track.points[i - 1];
  const b = track.points[i];
  const f = c[i] === c[i - 1] ? 0 : (clamped - c[i - 1]) / (c[i] - c[i - 1]);
  const kx = metresPerDegLng(a[1]);
  const bearing = (Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * METRES_PER_DEG_LAT) * 180) / Math.PI;
  return { position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f], bearing: (bearing + 360) % 360 };
}

export interface TrackGeometry {
  beds: { track: Track; path: [number, number][] }[];
  rails: [number, number][][];
  ties: { from: [number, number]; to: [number, number] }[];
}

const RAIL_HALF_GAUGE = 0.72; // standard gauge is 1.435 m
const TIE_HALF_LENGTH = 1.3; // 2.6 m crossties
const TIE_SPACING = 1.2;

/** Ballast bed, two steel rails and crossties for each track, computed once. */
export function trackGeometry(tracks: Track[]): TrackGeometry {
  const beds: TrackGeometry['beds'] = [];
  const rails: TrackGeometry['rails'] = [];
  const ties: TrackGeometry['ties'] = [];
  for (const track of tracks) {
    // Nothing is drawn over the tunnels: the track starts and ends at the portals.
    for (const run of surfaceRuns(track)) {
      beds.push({ track, path: run });
      rails.push(offsetPath(run, -RAIL_HALF_GAUGE), offsetPath(run, RAIL_HALF_GAUGE));
    }
    for (let s = TIE_SPACING / 2; s < track.length; s += TIE_SPACING) {
      if (isUnderground(track, s)) continue;
      const { position, bearing } = pointAlong(track, s);
      // Perpendicular to travel: the right-hand normal of the heading, in metres -> degrees.
      const rad = (bearing * Math.PI) / 180;
      const east = Math.cos(rad) * TIE_HALF_LENGTH;
      const north = -Math.sin(rad) * TIE_HALF_LENGTH;
      const dLng = east / metresPerDegLng(position[1]);
      const dLat = north / METRES_PER_DEG_LAT;
      ties.push({ from: [position[0] - dLng, position[1] - dLat], to: [position[0] + dLng, position[1] + dLat] });
    }
  }
  return { beds, rails, ties };
}

/** Polygons hugging each above-ground track, `halfWidth` metres either side of it. */
export function trackCorridors(tracks: Track[], halfWidth: number): [number, number][][] {
  return tracks.flatMap((track) =>
    surfaceRuns(track).map((run) => {
      const left = offsetPath(run, -halfWidth);
      const right = offsetPath(run, halfWidth);
      return [...left, ...right.reverse(), left[0]];
    }),
  );
}
