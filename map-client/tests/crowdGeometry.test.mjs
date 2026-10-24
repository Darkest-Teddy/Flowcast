import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { volumeGeometry } from '../src/layers/crowdGeometry.ts';

const LNG0 = -71.1;
const LAT0 = 42.35;
const kx = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const lngLat = ([x, y]) => [LNG0 + x / kx, LAT0 + y / 110_540];
const metres = ([lng, lat]) => [(lng - LNG0) * kx, (lat - LAT0) * 110_540];
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(lngLat);
const near = (a, b, d = 1.5) => Math.hypot(a[0] - b[0], a[1] - b[1]) < d;

test('stacked volumes: each roof edge is drawn only where it is in the open', () => {
  // A 40 x 20 m podium, 10 m tall, with a 20 x 20 m tower on its west half, flush with its west,
  // north and south walls.
  const podium = { ring: box(0, 0, 40, 20), base: 0, top: 10 };
  const tower = { ring: box(0, 0, 20, 20), base: 10, top: 30 };
  const { rims, edges } = volumeGeometry([podium, tower]);

  const towerRims = rims.filter((r) => r.top === 30);
  assert.equal(towerRims.length, 1);
  const loop = towerRims[0].path;
  assert.ok(near(loop[0], loop[loop.length - 1], 0.01), "the tower's rim is a closed loop");

  // The podium's rim runs only round its open (east) half, as one path: none of it lies along
  // the tower's walls.
  const podiumRims = rims.filter((r) => r.top === 10);
  assert.equal(podiumRims.length, 1);
  const xs = podiumRims[0].path.map((p) => metres(p)[0]);
  assert.ok(Math.min(...xs) > 19 && Math.min(...xs) < 21.5, `starts at the tower's east wall (${Math.min(...xs)})`);
  assert.ok(Math.max(...xs) > 40);

  // Corners: the flush west corners run from the ground to the tower's top in one edge; the
  // tower's east corners start on the podium roof; the podium's east corners stop at its roof.
  const at = (x, y) => edges.filter((e) => near(metres(e.at), [x, y]));
  for (const [x, y] of [[0, 0], [0, 20]]) {
    assert.deepEqual(at(x, y).map((e) => [e.z0, e.z1]), [[0, 30]], `corner ${x},${y}`);
  }
  for (const [x, y] of [[20, 0], [20, 20]]) {
    assert.deepEqual(at(x, y).map((e) => [e.z0, e.z1]), [[10, 30]], `corner ${x},${y}`);
  }
  for (const [x, y] of [[40, 0], [40, 20]]) {
    assert.deepEqual(at(x, y).map((e) => [e.z0, e.z1]), [[0, 10]], `corner ${x},${y}`);
  }
  assert.equal(edges.length, 6);
});

test('the same volumes array is traced once', () => {
  const vols = [{ ring: box(0, 0, 10, 10), base: 0, top: 5 }, { ring: box(10, 0, 20, 10), base: 0, top: 9 }];
  assert.equal(volumeGeometry(vols), volumeGeometry(vols));
});

test("CDS's stacked pieces come from the model manifest", () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/data/building-models.json', import.meta.url), 'utf8'));
  const entries = manifest.campuses.flatMap((c) => c.buildings);
  const cds = entries.find((b) => b.osm === 'way/277434241').volumes;
  assert.ok(cds && cds.length >= 8, 'CDS is several volumes');
  const tops = cds.map((v) => v.top);
  assert.ok(Math.max(...tops) > 90 && Math.min(...tops) < 10, `from the lobby to the crown (${tops})`);
  const { rims, edges } = volumeGeometry(cds);
  // The pieces are offset, Jenga style, so each one above the podium shows roof edge at its own
  // height (the glazed lobby is tucked under the podium, so its roof edge is hidden).
  const rimTops = new Set(rims.map((r) => r.top));
  assert.ok([...rimTops].every((t) => tops.includes(t)));
  for (const t of tops) if (t > 20) assert.ok(rimTops.has(t), `a rim at ${t} m`);
  assert.ok(!rims.some((r) => r.top === 94 && r.path.length > 6), 'the crown keeps its own small outline');
  assert.ok(edges.every((e) => e.z1 > e.z0));
  // A plain box isn't listed: the footprint at the model's height fits it.
  const listed = entries.filter((b) => b.volumes);
  assert.ok(listed.length < entries.filter((b) => !b.partOf).length / 2);
  assert.ok(listed.every((b) => !b.partOf && b.volumes.every((v) => v.ring.length >= 3 && v.top > v.base)));
});
