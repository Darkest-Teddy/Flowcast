import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { damageAt, damageCurves } = await import('../src/sim/disasterDamage.ts');
const { tagBuildings, damageUniforms, toModel, NO_CUT, MAX_DAMAGE_SLOTS } = await import('../src/layers/buildingDamage.ts');

// Buildings along latitude 42 (0.001° longitude ≈ 82.7 m): A target, B ≈ 41 m, C ≈ 165 m.
const square = (x, id, height = 20) => ({ id, polygon: [[x - 0.0001, 41.9999], [x + 0.0001, 41.9999], [x + 0.0001, 42.0001], [x - 0.0001, 42.0001]], height });
const FOOTPRINTS = [square(-71, 'A'), square(-70.9995, 'B'), square(-70.998, 'C'), square(-70.99, 'D')];
const run = (kind, radiusMetres, ids, start = 1000) => ({
  incident: { kind, start },
  hazard: { radiusMetres, affectedBuildingIds: ids, activeUntil: start + 1800 },
  location: { position: [-71, 42], building: 'A' },
});
const pick = frames => frames.map(f => ({ id: f.id, collapse: f.collapse, scorch: f.scorch, lean: f.lean }));

test('no damage before the start, for non-disaster kinds, or without a run', () => {
  assert.deepEqual(damageAt(run('meteor', 100, ['A']), 999.9, FOOTPRINTS), []);
  assert.deepEqual(damageAt({ ...run('fire', 0, ['A']), incident: { kind: 'fire-drill', start: 1000 } }, 2000, FOOTPRINTS), []);
  assert.deepEqual(damageAt(null, 2000, FOOTPRINTS), []);
});

test('the damaged set is fixed from the start, and only covers affected buildings', () => {
  const r = run('earthquake', 250, ['A', 'B', 'C']);
  const ids = t => damageAt(r, t, FOOTPRINTS).map(f => f.id);
  assert.deepEqual(ids(1000), ['A', 'B', 'C']);
  assert.deepEqual(ids(1030), ['A', 'B', 'C']);
  assert.deepEqual(ids(80000), ['A', 'B', 'C']);
  assert.ok(!ids(1030).includes('D'));
});

test('deterministic: rewinding and replaying gives identical frames', () => {
  for (const kind of ['fire', 'earthquake', 'meteor']) {
    const r = run(kind, kind === 'fire' ? 0 : 250, kind === 'fire' ? ['A'] : ['A', 'B', 'C']);
    const times = [1001, 1020, 1045, 1500, 2600, 5000];
    const first = times.map(t => pick(damageAt(r, t, FOOTPRINTS)));
    damageAt(r, 70000, FOOTPRINTS); // play far ahead
    const rewound = [...times].reverse().map(t => pick(damageAt(r, t, FOOTPRINTS))).reverse();
    assert.deepEqual(rewound, first, kind);
    assert.deepEqual(pick(damageAt(r, 999, FOOTPRINTS)), [], `${kind} rewound before start`);
  }
});

test('damage is monotonic and persists after the hazard ends', () => {
  for (const kind of ['fire', 'earthquake', 'meteor']) {
    const r = run(kind, kind === 'fire' ? 0 : 250, kind === 'fire' ? ['A'] : ['A', 'B', 'C']);
    let prev = null;
    for (let t = 1000; t <= 4000; t += 7) {
      const now = damageAt(r, t, FOOTPRINTS);
      if (prev) now.forEach((f, i) => {
        assert.ok(f.collapse >= prev[i].collapse - 1e-12 && f.scorch >= prev[i].scorch - 1e-12, `${kind} ${f.id} at ${t}`);
      });
      prev = now;
    }
    const after = pick(damageAt(r, r.hazard.activeUntil + 1, FOOTPRINTS));
    assert.deepEqual(pick(damageAt(r, 86000, FOOTPRINTS)), after, `${kind} persists to the end of the day`);
    // Each frame's current state is its final state at the end.
    for (const f of damageAt(r, 86000, FOOTPRINTS)) {
      assert.equal(f.collapse, f.finalCollapse);
      assert.equal(f.scorch, f.finalScorch);
      assert.equal(f.remainingHeight, f.height * (1 - f.collapse));
    }
  }
});

test('fire chars first, then partially collapses the target only', () => {
  const r = run('fire', 0, ['A']);
  const at = t => damageAt(r, t, FOOTPRINTS)[0];
  assert.equal(damageAt(r, 1300, FOOTPRINTS).length, 1);
  assert.ok(at(1300).scorch > 0.3 && at(1300).collapse === 0, 'scorched, still standing at 5 min');
  assert.ok(at(1000 + 1200).collapse > 0 && at(1000 + 1200).collapse < at(1000 + 1800).collapse);
  assert.equal(at(4000).collapse, 0.4);
  assert.equal(at(4000).scorch, 1);
});

test('meteor flattens the inner area within seconds and partly collapses the outer', () => {
  const r = run('meteor', 100, ['A', 'B', 'C']);
  const final = Object.fromEntries(damageAt(r, 1010, FOOTPRINTS).map(f => [f.id, f]));
  assert.equal(final.A.collapse, 1); // target
  assert.equal(final.B.collapse, 1); // 41 m < 45 m inner area
  assert.ok(final.C.finalCollapse > 0 && final.C.finalCollapse < 1); // outer edge
  assert.ok(damageAt(r, 1000.5, FOOTPRINTS)[0].collapse < 1, 'collapse takes time');
});

test('earthquake damage happens during the 60 s of shaking and varies by building', () => {
  const ids = Array.from({ length: 30 }, (_, i) => `q${i}`);
  const fps = ids.map((id, i) => square(-71 + i * 0.00003, id));
  const r = run('earthquake', 250, ids);
  const end = damageAt(r, 1060, fps);
  assert.deepEqual(pick(end), pick(damageAt(r, 3000, fps)), 'complete by the end of shaking');
  assert.ok(end.some(f => f.collapse > 0.5) && end.some(f => f.collapse < 0.2), 'some collapse, some only crack');
  assert.ok(end.every(f => f.lean > 0));
  assert.ok(damageAt(r, 1004, fps).every(f => f.collapse === 0), 'nothing falls in the first seconds');
});

test('damageCurves (the shader curves) reproduce the frames', () => {
  const r = run('earthquake', 250, ['A', 'B', 'C']);
  for (const t of [1010, 1033, 1050, 1200]) for (const f of damageAt(r, t, FOOTPRINTS)) {
    const c = damageCurves(f, t - f.onset);
    assert.equal(c.collapse, f.collapse);
    assert.equal(c.scorch, f.scorch);
  }
});

test('heights from the model manifest override saved footprint heights', () => {
  const r = run('fire', 0, ['A']);
  assert.equal(damageAt(r, 2000, [square(-71, 'A', 0)])[0].height, 12);
  assert.equal(damageAt(r, 2000, [square(-71, 'A', 0)], new Map([['A', 94]]))[0].height, 94);
});

// ---- geometry tagging ------------------------------------------------------------------------

const ORIGIN = [-71, 42];
/** Metres (x east, z south) -> [lng, lat] for ORIGIN, inverting toModel by Newton steps. */
function toLngLat([x, z]) {
  let p = [ORIGIN[0] + x / 82700, ORIGIN[1] - z / 111000];
  for (let i = 0; i < 6; i++) {
    const [mx, mz] = toModel(ORIGIN, p);
    p = [p[0] + (x - mx) / 82700, p[1] - (z - mz) / 111000];
  }
  return p;
}
const rect = (id, x0, z0, x1, z1) => ({ id, polygon: [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(toLngLat) });

/** A glTF with one primitive from quads [[x,y,z] x4], wound so the normal follows `n`. */
function gltfOf(quads) {
  const pos = [], idx = [];
  for (const q of quads) {
    const base = pos.length / 3;
    for (const v of q) pos.push(...v);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const p = new Float32Array(pos), i = new Uint32Array(idx);
  const buf = new Uint8Array(p.byteLength + i.byteLength);
  buf.set(new Uint8Array(p.buffer), 0); buf.set(new Uint8Array(i.buffer), p.byteLength);
  return {
    json: {
      nodes: [{ mesh: 0 }],
      buffers: [{ byteLength: buf.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: p.byteLength }, { buffer: 0, byteOffset: p.byteLength, byteLength: i.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: pos.length / 3, type: 'VEC3' }, { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    },
    buffers: [{ arrayBuffer: buf.buffer, byteOffset: 0, byteLength: buf.byteLength }],
  };
}
// Wall at x = const from z0..z1, facing +x (outward east) when `east`, else west.
const wallX = (x, z0, z1, h, east) => east
  ? [[x, 0, z1], [x, 0, z0], [x, h, z0], [x, h, z1]]
  : [[x, 0, z0], [x, 0, z1], [x, h, z1], [x, h, z0]];
const roof = (x0, z0, x1, z1, h) => [[x0, h, z0], [x0, h, z1], [x1, h, z1], [x1, h, z0]];
const tagsOf = t => {
  const a = t.gltf.json.accessors[t.gltf.json.meshes[0].primitives[0].attributes._FLOW_BUILDING];
  const v = t.gltf.json.bufferViews[a.bufferView];
  return Array.from(new Float32Array(t.gltf.buffers[v.buffer].arrayBuffer, v.byteOffset ?? 0, a.count));
};

// A: x 0..10 (20 m tall), B: x 10..20 (12 m) sharing the wall at x = 10; z -5..5.
const QUADS = {
  aWest: wallX(0, -5, 5, 20, false),
  aParty: wallX(10, -5, 5, 20, true), // A's side of the party wall, facing B
  bParty: wallX(10, -5, 5, 12, false), // B's side, facing A
  bEast: wallX(20, -5, 5, 12, true),
  aRoof: roof(0, -5, 10, 5, 20),
  bRoof: roof(10, -5, 20, 5, 12),
  aCornice: wallX(-0.8, -5, 5, 20, false), // 0.8 m proud of A's west wall, facing out
  aInnerSkin: wallX(-0.4, -5, 5, 20, true), // inner face of a double facade, facing A
  far: [[-40, 0, -40], [-40, 0, 40], [40, 0, 40], [40, 0, -40]].map(([x, y, z]) => [x, 0.01, z]), // shared ground plane
};
const NAMES = Object.keys(QUADS);
const tagByQuad = t => { const tags = tagsOf(t); return Object.fromEntries(NAMES.map((n, i) => [n, tags[i * 4]])); };

test('tagging: party walls split by winding; overhangs and inner skins join their building; neighbours untouched', () => {
  const g = gltfOf(Object.values(QUADS));
  // Only A known (the neighbour's footprint unknown, the worst case).
  const onlyA = tagBuildings(g, ORIGIN, [rect('A', 0, -5, 10, 5)]);
  const a = onlyA.index.get('A');
  const tags = tagByQuad(onlyA);
  for (const n of ['aWest', 'aParty', 'aRoof', 'aCornice', 'aInnerSkin']) assert.equal(tags[n], a, n);
  for (const n of ['bParty', 'bEast', 'bRoof', 'far']) assert.equal(tags[n], 0, n);
  // Both known: B's pieces get B.
  const both = tagBuildings(g, ORIGIN, [rect('A', 0, -5, 10, 5), rect('B', 10, -5, 20, 5)]);
  const t2 = tagByQuad(both);
  for (const n of ['bParty', 'bEast', 'bRoof']) assert.equal(t2[n], both.index.get('B'), n);
  assert.equal(t2.aParty, both.index.get('A'));
  // The original glTF is untouched (shared buffers, new attribute only on the copy).
  assert.equal(g.json.meshes[0].primitives[0].attributes._FLOW_BUILDING, undefined);
  assert.equal(both.gltf.buffers[0], g.buffers[0]);
});

test('tagging: every triangle has one tag on all corners; shared vertices are split, attributes copied', () => {
  // Two roofs (A at x 0..10, B at 10..20) and a ground triangle, sharing vertices 1 and 2 (x = 10).
  const pos = new Float32Array([0, 10, -5, 10, 10, -5, 10, 10, 5, 0, 10, 5, 20, 10, -5, 20, 10, 5, 30, 0, 30]);
  const uv = new Float32Array(Array.from({ length: 7 }, (_, i) => [i, -i]).flat());
  const idx = new Uint32Array([0, 3, 2, 0, 2, 1, /* B */ 1, 2, 5, 1, 5, 4, /* ground, outside every footprint */ 1, 6, 2]);
  const buf = new Uint8Array(pos.byteLength + uv.byteLength + idx.byteLength);
  buf.set(new Uint8Array(pos.buffer), 0); buf.set(new Uint8Array(uv.buffer), pos.byteLength); buf.set(new Uint8Array(idx.buffer), pos.byteLength + uv.byteLength);
  const g = {
    json: {
      nodes: [{ mesh: 0 }], buffers: [{ byteLength: buf.byteLength }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pos.byteLength }, { buffer: 0, byteOffset: pos.byteLength, byteLength: uv.byteLength }, { buffer: 0, byteOffset: pos.byteLength + uv.byteLength, byteLength: idx.byteLength }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 7, type: 'VEC3', min: [0, 0, -5], max: [30, 10, 30] }, { bufferView: 1, componentType: 5126, count: 7, type: 'VEC2' }, { bufferView: 2, componentType: 5125, count: idx.length, type: 'SCALAR' }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, TEXCOORD_0: 1 }, indices: 2 }] }],
    },
    buffers: [{ arrayBuffer: buf.buffer, byteOffset: 0, byteLength: buf.byteLength }],
  };
  const t = tagBuildings(g, ORIGIN, [rect('A', 0, -5, 10, 5), rect('B', 10, -5, 20, 5)]);
  const p = t.gltf.json.meshes[0].primitives[0];
  const read = (i, T = Float32Array) => { const a = t.gltf.json.accessors[i], v = t.gltf.json.bufferViews[a.bufferView], b = t.gltf.buffers[v.buffer]; return new T(b.arrayBuffer, (b.byteOffset ?? 0) + (v.byteOffset ?? 0), a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3 })[a.type]); };
  const tag = read(p.attributes._FLOW_BUILDING), ids = read(p.indices, Uint32Array), P = read(p.attributes.POSITION), UV = read(p.attributes.TEXCOORD_0);
  const A = t.index.get('A'), B = t.index.get('B');
  const owners = [];
  for (let k = 0; k < ids.length; k += 3) {
    const [a, b, c] = [ids[k], ids[k + 1], ids[k + 2]];
    assert.ok(tag[a] === tag[b] && tag[b] === tag[c], `triangle ${k / 3} has mixed tags`);
    owners.push(tag[a]);
    // Corners still sit where they did, with their own attributes.
    for (const [j, v] of [[k, a], [k + 1, b], [k + 2, c]]) {
      const src = idx[j];
      assert.deepEqual([...P.subarray(v * 3, v * 3 + 3)], [...pos.subarray(src * 3, src * 3 + 3)]);
      assert.deepEqual([...UV.subarray(v * 2, v * 2 + 2)], [...uv.subarray(src * 2, src * 2 + 2)]);
    }
  }
  assert.deepEqual(owners, [A, A, B, B, 0]);
  assert.equal(t.gltf.json.accessors[p.attributes.POSITION].count, 7 + 2 + 2, 'vertices 1 and 2 split for B and for the ground');
});

test('uniforms: only damaged buildings get a slot; standing ones never cut; packing round-trips', () => {
  const index = new Map([['A', 1], ['B', 2], ['C', 3], ['D', 4]]);
  const r = run('meteor', 100, ['A', 'B', 'C']);
  const frames = damageAt(r, 1010, FOOTPRINTS);
  const u = damageUniforms(frames, index, 1010);
  const slot = i => { const v = u.map[i >> 1]; return (i & 1) === 0 ? Math.floor(v / 256) : v % 256; };
  assert.equal(slot(4), 0, 'D (undamaged neighbour) has no slot');
  for (const [id, i] of index) if (id !== 'D') {
    const s = slot(i), f = frames.find(x => x.id === id);
    assert.ok(s > 0);
    assert.equal(u.slotA[s * 4], f.collapse > 1e-3 ? Math.fround(f.remainingHeight) : NO_CUT);
    assert.equal(u.slotA[s * 4 + 1], Math.fround(f.scorch));
  }
  assert.equal(u.elapsed, 10);
  // Same frame twice: identical arrays (so the layer uploads nothing new).
  assert.deepEqual(damageUniforms(frames, index, 1010).slotA, u.slotA);
  // Reset: all slots zero.
  assert.ok(damageUniforms([], index, 1010).map.every(v => v === 0));
});

test('uniforms: more damaged buildings than slots share the closest slot instead of being dropped', () => {
  const n = MAX_DAMAGE_SLOTS + 20;
  const ids = Array.from({ length: n }, (_, i) => `b${i}`);
  const fps = ids.map((id, i) => square(-71 + (i % 40) * 0.00002, id));
  const frames = damageAt(run('earthquake', 500, ids), 1100, fps);
  const index = new Map(ids.map((id, i) => [id, i + 1]));
  const u = damageUniforms(frames, index, 1100);
  assert.equal(u.slots, MAX_DAMAGE_SLOTS);
  assert.equal(u.shared, 20);
  for (let i = 1; i <= n; i++) { const v = u.map[i >> 1]; assert.ok(((i & 1) === 0 ? Math.floor(v / 256) : v % 256) > 0, `b${i - 1}`); }
});

// ---- real campus GLB -------------------------------------------------------------------------

const ROOT = new URL('../', import.meta.url).pathname;
const GLB = `${ROOT}public/models/buildings-charles-river.glb`;
test('real Charles River GLB: one-off tagging is bounded and stays inside each building', { skip: !existsSync(GLB) && 'GLB not built' }, async () => {
  const { parse } = await import('@loaders.gl/core');
  const { GLTFLoader } = await import('@loaders.gl/gltf');
  const { mergeMaterialPrimitives } = await import('../src/layers/gltf-materials.ts');
  const day = JSON.parse(readFileSync(`${ROOT}public/data/demo-day.json`, 'utf8'));
  const campus = JSON.parse(readFileSync(`${ROOT}public/data/building-models.json`, 'utf8')).campuses.find(c => c.id === 'charles-river');
  for (const file of [GLB, GLB.replace('.glb', '-lights.glb')]) {
    const g = mergeMaterialPrimitives(await parse(readFileSync(file).buffer, GLTFLoader, { gltf: { loadImages: false } }), { materialAttributes: true });
    const t = tagBuildings(g, campus.origin, day.buildings);
    assert.ok(t.ms < 2000, `${file}: ${t.ms} ms`);
    const boxes = new Map();
    for (const b of day.buildings) {
      const bb = boxes.get(b.id) ?? [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of b.polygon) { const [x, z] = toModel(campus.origin, p); bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], z); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], z); }
      boxes.set(b.id, bb);
    }
    const byIndex = []; for (const [id, i] of t.index) byIndex[i] = boxes.get(id);
    let tagged = 0;
    for (const p of t.gltf.json.meshes.flatMap(m => m.primitives)) {
      const read = a => { const v = t.gltf.json.bufferViews[a.bufferView]; const b = t.gltf.buffers[v.buffer]; return new Float32Array(b.arrayBuffer, (b.byteOffset ?? 0) + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * (a.type === 'VEC3' ? 3 : 1)); };
      const pos = read(t.gltf.json.accessors[p.attributes.POSITION]), tag = read(t.gltf.json.accessors[p.attributes._FLOW_BUILDING]);
      for (let i = 0; i < tag.length; i++) {
        if (!tag[i]) continue;
        tagged++;
        const bb = byIndex[tag[i]], x = pos[i * 3], z = pos[i * 3 + 2];
        assert.ok(Math.max(bb[0] - x, x - bb[2], bb[1] - z, z - bb[3]) <= 2.5, `${file}: vertex ${i} outside its building`);
      }
    }
    assert.ok(tagged > 20000, `${file}: ${tagged} tagged vertices`);
    // No triangle mixes tags (a mixed one would stretch between a collapsed and a standing corner).
    for (const p of t.gltf.json.meshes.flatMap(m => m.primitives)) {
      const a = t.gltf.json.accessors[p.attributes._FLOW_BUILDING], v = t.gltf.json.bufferViews[a.bufferView], b = t.gltf.buffers[v.buffer];
      const tag = new Float32Array(b.arrayBuffer, (b.byteOffset ?? 0) + (v.byteOffset ?? 0), a.count);
      const ia = t.gltf.json.accessors[p.indices], iv = t.gltf.json.bufferViews[ia.bufferView], ib = t.gltf.buffers[iv.buffer];
      const T = ia.componentType === 5125 ? Uint32Array : Uint16Array;
      const ids = new T(ib.arrayBuffer, (ib.byteOffset ?? 0) + (iv.byteOffset ?? 0) + (ia.byteOffset ?? 0), ia.count);
      let mixed = 0;
      for (let k = 0; k < ids.length; k += 3) if (tag[ids[k]] !== tag[ids[k + 1]] || tag[ids[k]] !== tag[ids[k + 2]]) mixed++;
      assert.equal(mixed, 0, `${file}: ${mixed} mixed triangles`);
    }
    // CDS: nearly every vertex inside its ring's box above 20 m belongs to it.
    const cds = t.index.get('way/277434241'), bb = boxes.get('way/277434241');
    let mine = 0, other = 0;
    for (const p of t.gltf.json.meshes.flatMap(m => m.primitives)) {
      const read = a => { const v = t.gltf.json.bufferViews[a.bufferView]; const b = t.gltf.buffers[v.buffer]; return new Float32Array(b.arrayBuffer, (b.byteOffset ?? 0) + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * (a.type === 'VEC3' ? 3 : 1)); };
      const pos = read(t.gltf.json.accessors[p.attributes.POSITION]), tag = read(t.gltf.json.accessors[p.attributes._FLOW_BUILDING]);
      for (let i = 0; i < tag.length; i++) {
        const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
        if (y < 20 || x < bb[0] || x > bb[2] || z < bb[1] || z > bb[3]) continue;
        if (tag[i] === cds) mine++; else other++;
      }
    }
    assert.ok(other < 0.05 * (mine + other), `${file}: CDS above 20 m: ${mine} tagged, ${other} not`);
  }
});
