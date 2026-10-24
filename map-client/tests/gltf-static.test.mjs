import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeStaticPose } from '../src/layers/gltf-static.ts';

// Two animated parts sharing a material, under a translated parent: the still copy should be one
// primitive, in world space, with the animations dropped and the original left untouched.
function fixture() {
  const g = { json: { buffers: [], bufferViews: [], accessors: [], materials: [{ name: 'paint' }], meshes: [], nodes: [], scenes: [{ nodes: [0] }], scene: 0, animations: [{ channels: [] }] }, buffers: [] };
  const accessor = (values, type, componentType = 5126) => {
    const data = componentType === 5123 ? new Uint16Array(values) : new Float32Array(values);
    const buffer = g.buffers.push({ arrayBuffer: data.buffer, byteOffset: 0, byteLength: data.byteLength }) - 1;
    g.json.buffers.push({ byteLength: data.byteLength });
    const bufferView = g.json.bufferViews.push({ buffer, byteOffset: 0, byteLength: data.byteLength }) - 1;
    return g.json.accessors.push({ bufferView, componentType, type, count: values.length / { SCALAR: 1, VEC2: 2, VEC3: 3 }[type] }) - 1;
  };
  for (let i = 0; i < 2; i++) {
    g.json.meshes.push({ primitives: [{ attributes: { POSITION: accessor([0, 0, 0, 1, 0, 0, 0, 1, 0], 'VEC3'), NORMAL: accessor([0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3') }, indices: accessor([0, 1, 2], 'SCALAR', 5123), material: 0 }] });
  }
  // Root (moved +10 x) -> part 0 (no transform) and part 1 (moved +5 y, turned 90 degrees about z).
  const s = Math.SQRT1_2;
  g.json.nodes.push({ translation: [10, 0, 0], children: [1, 2] }, { mesh: 0 }, { mesh: 1, translation: [0, 5, 0], rotation: [0, 0, s, s] });
  return g;
}

function floats(g, index) {
  const a = g.json.accessors[index], v = g.json.bufferViews[a.bufferView], b = g.buffers[v.buffer];
  return Array.from(new Float32Array(b.arrayBuffer, (b.byteOffset ?? 0) + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * ({ VEC2: 2, VEC3: 3 }[a.type])));
}

test('bakes node transforms into one still primitive per material', () => {
  const g = fixture();
  const original = structuredClone(g.json);
  const still = bakeStaticPose(g);
  assert.ok(still);
  assert.deepEqual(g.json, original, 'the animated original is untouched');
  assert.equal(still.json.animations.length, 0);
  const root = still.json.scenes[still.json.scene].nodes;
  assert.equal(root.length, 1);
  const node = still.json.nodes[root[0]];
  assert.equal(node.translation, undefined);
  const prims = still.json.meshes[node.mesh].primitives;
  assert.equal(prims.length, 1);
  const pos = floats(still, prims[0].attributes.POSITION).map((x) => Math.round(x * 1e5) / 1e5);
  // part 0: shifted +10 x; part 1: turned 90 degrees (x -> y), shifted +5 y, then +10 x.
  assert.deepEqual(pos, [10, 0, 0, 11, 0, 0, 10, 1, 0, 10, 5, 0, 10, 6, 0, 9, 5, 0]);
  const nor = floats(still, prims[0].attributes.NORMAL).map((x) => Math.round(x * 1e5) / 1e5);
  assert.deepEqual(nor, Array(6).fill([0, 0, 1]).flat());
  assert.deepEqual(still.json.accessors[prims[0].attributes.POSITION].max, [11, 6, 0]);
});

test('skinned models are left to their animated form', () => {
  const g = fixture();
  g.json.skins = [{ joints: [0] }];
  assert.equal(bakeStaticPose(g), null);
});
