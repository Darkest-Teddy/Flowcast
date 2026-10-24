import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignTrackPair, distanceMetres, TRACK_HALF_SPACING } from '../src/transit/tracks.ts';

const LAT = 42.35;
const KX = 111320 * Math.cos((LAT * Math.PI) / 180);
const at = (x, y) => [-71.1 + x / KX, LAT + y / 110540];

function distToLine(p, line) {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const [ax, ay] = [(line[i - 1][0] - p[0]) * KX, (line[i - 1][1] - p[1]) * 110540];
    const [bx, by] = [(line[i][0] - p[0]) * KX, (line[i][1] - p[1]) * 110540];
    const [sx, sy] = [bx - ax, by - ay];
    const f = Math.max(0, Math.min(1, -(ax * sx + ay * sy) / (sx * sx + sy * sy || 1)));
    best = Math.min(best, Math.hypot(ax + sx * f, ay + sy * f));
  }
  return best;
}

// A 300 m line heading east. The two directions wander 0-6 m apart and cross at x = 150 m (as
// OSM's rails did at a crossover); direction 1 runs west.
const wobble = (x, seed) => Math.sin(x / 13 + seed) * 0.8 + Math.sin(x / 5 + seed * 2) * 0.3;
const east = Array.from({ length: 61 }, (_, i) => at(i * 5, -2.5 * Math.cos((i * 5 * Math.PI) / 300) + wobble(i * 5, 1)));
const west = Array.from({ length: 61 }, (_, i) => at(300 - i * 5, 2.5 * Math.cos(((300 - i * 5) * Math.PI) / 300) + wobble(300 - i * 5, 4)));

test('two wandering, crossing directions become parallel tracks a fixed distance apart', () => {
  const [a, b] = alignTrackPair(east, west);
  assert.equal(a.length, east.length);
  assert.equal(b.length, west.length);
  // Away from the ends (where the projection is clipped), every point is 2 x half-spacing from the other track.
  for (const p of a.slice(3, -3)) assert.ok(Math.abs(distToLine(p, b) - 2 * TRACK_HALF_SPACING) < 0.15, `spacing ${distToLine(p, b)}`);
  // Right-hand running: eastbound on the south side (y < 0), westbound on the north side.
  const y = (p) => (p[1] - LAT) * 110540;
  assert.ok(a.slice(3, -3).every((p) => y(p) < 0));
  assert.ok(b.slice(3, -3).every((p) => y(p) > 0));
  // Straight: the wobble is gone (no point more than 0.3 m off a straight line here).
  for (const p of a.slice(3, -3)) assert.ok(Math.abs(y(p) + TRACK_HALF_SPACING) < 0.3);
});

test('directions that run far apart keep their own paths', () => {
  const far = west.map(([lng, lat]) => [lng, lat + 40 / 110540]);
  const [a, b] = alignTrackPair(east, far);
  assert.deepEqual(a, east);
  assert.deepEqual(b, far);
  assert.ok(distanceMetres(a[0], b[b.length - 1]) > 30);
});
