import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { layoutAtlas, signMatrix, signsLit, signScale, signTooltip } = await import('../src/layers/signs.ts');

const json = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const { signs } = json('../public/data/signs.json');
const manifest = json('../public/data/building-models.json');
const footprints = new Map(json('../public/data/building-footprints.json').map((f) => [f.osm, f.rings]));
const entries = new Map(manifest.campuses.flatMap((c) => c.buildings.map((b) => [b.osm, b])));

const KX = 111320 * Math.cos((42.349 * Math.PI) / 180);
const KY = 110540;
const metres = ([lng, lat]) => [lng * KX, lat * KY];

/** Distance from p to the nearest edge of the ring (metres), that edge's outward normal, and whether p is outside. */
function nearestWall(ring, p) {
  const r = ring.map(metres);
  let area = 0;
  for (let i = 0; i < r.length; i++) area += r[(i + r.length - 1) % r.length][0] * r[i][1] - r[i][0] * r[(i + r.length - 1) % r.length][1];
  let best = { d: Infinity };
  for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
    const q = [a[0] + t * dx, a[1] + t * dy];
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d < best.d) {
      const L = Math.sqrt(L2);
      const n = area > 0 ? [dy / L, -dx / L] : [-dy / L, dx / L];
      best = { d, n, outside: (p[0] - q[0]) * n[0] + (p[1] - q[1]) * n[1] > 0 };
    }
  }
  return best;
}

test('every sign is complete, uniquely named and in Kenmore Square or on Comm Ave by BU', () => {
  assert.ok(signs.length >= 11 && signs.length <= 21, `${signs.length} signs`);
  assert.equal(new Set(signs.map((s) => s.id)).size, signs.length);
  for (const s of signs) {
    assert.ok(s.name && s.text, s.id);
    assert.ok(s.position[0] > -71.125 && s.position[0] < -71.092 && s.position[1] > 42.347 && s.position[1] < 42.353, `${s.id} is off Comm Ave`);
    assert.ok(s.bearing >= 0 && s.bearing < 360, s.id);
    assert.ok(s.width > 1 && s.height > 0.3, s.id);
    assert.match(s.style.fg, /^#[0-9a-f]{6}$/i, s.id);
    if (s.style.frame === 'panel') assert.match(s.style.bg, /^#[0-9a-f]{6}$/i, s.id);
    assert.ok(entries.has(s.building), `${s.id}: ${s.building} is not a modelled building`);
  }
  const whoop = signs.find((s) => s.id === 'whoop');
  assert.equal(whoop.kind, 'rooftop');
  assert.equal(signs.filter((s) => s.kind === 'storefront').every((s) => s.info.address), true, 'every restaurant has an address');
});

test('shop signs hang flush on their building, 0.15 m proud of the modelled wall, facing out', () => {
  for (const s of signs.filter((x) => x.kind === 'storefront')) {
    const wall = nearestWall(footprints.get(s.building)[0], metres(s.position));
    // Models stand 0.3 m outside their OSM footprints; the sign 0.15 m in front of that.
    assert.ok(wall.outside && Math.abs(wall.d - 0.45) < 0.05, `${s.id} is ${wall.d.toFixed(2)} m from its wall`);
    const facing = [Math.sin((s.bearing * Math.PI) / 180), Math.cos((s.bearing * Math.PI) / 180)];
    assert.ok(facing[0] * wall.n[0] + facing[1] * wall.n[1] > 0.99, `${s.id} doesn't face out of its wall`);
    assert.ok(s.altitude > 2.8 && s.altitude < 5.5, `${s.id} at ${s.altitude} m is not over the shopfront`);
  }
});

test("WHOOP's letters stand on the roof of One Kenmore Square's glass top storeys, facing Comm Ave", () => {
  const whoop = signs.find((s) => s.id === 'whoop');
  const entry = entries.get(whoop.building);
  const top = Math.max(...entry.volumes.map((v) => v.top));
  assert.ok(Math.abs(whoop.altitude - whoop.height / 2 - top) < 0.01);
  assert.ok(Math.abs(whoop.bearing - 180) < 10, `faces ${whoop.bearing}`);
  assert.ok(whoop.height >= 3.5 && whoop.height <= 4.5 && whoop.width >= 18 && whoop.width <= 25);
  // Next to the Citgo sign (on 660 Beacon St, about 50 m east).
  const citgo = json('../public/data/monuments.json').find((m) => m.id === 'citgo-sign');
  const [dx, dy] = [metres(whoop.position)[0] - metres(citgo.position)[0], metres(whoop.position)[1] - metres(citgo.position)[1]];
  assert.ok(Math.hypot(dx, dy) < 70);
});

test('atlas cells never overlap, stay inside the texture and put each night face under its day face', () => {
  const { width, height, cells } = layoutAtlas(signs);
  const rects = cells.flatMap((c) => [c.day, c.night]).map(([u, v, du, dv]) => [u * width, v * height, (u + du) * width, (v + dv) * height]);
  for (const [x0, y0, x1, y1] of rects) assert.ok(x0 >= 0 && y0 >= 0 && x1 <= width && y1 <= height);
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [a, b] = [rects[i], rects[j]];
      assert.ok(a[2] <= b[0] || b[2] <= a[0] || a[3] <= b[1] || b[3] <= a[1], `cells ${i} and ${j} overlap`);
    }
  }
  cells.forEach((c, i) => {
    assert.equal(c.night[0], c.day[0]);
    assert.ok(c.night[1] > c.day[1]);
    // The quad is the sign plus its glow margin.
    assert.ok(c.quad[0] > signs[i].width && c.quad[1] > signs[i].height);
  });
});

test("the sign quad runs along the wall to the viewer's right and faces the bearing", () => {
  // A sign facing south: the viewer looks north, so its text runs east.
  const m = signMatrix(180, 4, 1);
  assert.ok(Math.abs(m[0] - 4) < 1e-9 && Math.abs(m[1]) < 1e-9);
  assert.ok(Math.abs(m[4]) < 1e-9 && Math.abs(m[5] + 1) < 1e-9);
  assert.equal(m[10], 1);
  // Facing east: the viewer looks west, so its text runs north.
  const e = signMatrix(90, 2, 1);
  assert.ok(Math.abs(e[0]) < 1e-9 && Math.abs(e[1] - 2) < 1e-9);
});

test('shop signs light after dark until 2 am, WHOOP all night, and grow a little only from afar', () => {
  assert.equal(signsLit(13 * 3600, 'day', 'storefront'), false);
  assert.equal(signsLit(21.5 * 3600, 'night', 'storefront'), true);
  assert.equal(signsLit(3 * 3600, 'night', 'storefront'), false);
  assert.equal(signsLit(3 * 3600, 'night', 'rooftop'), true);
  assert.equal(signScale('rooftop', 16), 1);
  assert.equal(signScale('storefront', 20), 1);
  assert.ok(signScale('storefront', 16) > 1 && signScale('storefront', 16) <= 1.5);
});

test('the tooltip names the restaurant, what it serves, where and when', () => {
  const s = signs.find((x) => x.id === 'india-quality');
  const tip = signTooltip(s);
  assert.match(tip, /^India Quality\n/);
  assert.match(tip, /Indian/);
  assert.match(tip, /484 Commonwealth Avenue/);
  assert.match(tip, /Hours: /);
  assert.equal(signTooltip({ bearing: 0, id: 'walker' }), null);
});
