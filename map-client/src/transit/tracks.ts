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

export function makeTrack(route: string, direction: 0 | 1, points: [number, number][], offsetMetres: number): Track {
  const shifted = offsetPath(points, offsetMetres);
  const cumulative = [0];
  for (let i = 1; i < shifted.length; i++) cumulative.push(cumulative[i - 1] + distanceMetres(shifted[i - 1], shifted[i]));
  return { route, direction, points: shifted, cumulative, length: cumulative[cumulative.length - 1] };
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
    beds.push({ track, path: track.points });
    rails.push(offsetPath(track.points, -RAIL_HALF_GAUGE), offsetPath(track.points, RAIL_HALF_GAUGE));
    for (let s = TIE_SPACING / 2; s < track.length; s += TIE_SPACING) {
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
