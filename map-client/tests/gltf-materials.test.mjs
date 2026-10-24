import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, readdirSync } from 'node:fs';
import { mergeMaterialPrimitives } from '../src/layers/gltf-materials.ts';

function fixture() {
  const g = { json: { buffers: [], bufferViews: [], accessors: [], materials: [], meshes: [{ primitives: [] }] }, buffers: [] };
  function accessor(values, type, componentType = 5126) {
    const source = componentType === 5123 ? new Uint16Array(values) : new Float32Array(values);
    // Exercise offsets at the loaded buffer, buffer view and accessor levels.
    const raw = new Uint8Array(source.byteLength + 16); raw.set(new Uint8Array(source.buffer), 12);
    const buffer = g.buffers.push({ arrayBuffer: raw.buffer, byteOffset: 4, byteLength: raw.length - 4 }) - 1;
    g.json.buffers.push({ byteLength: raw.length - 4 });
    const bufferView = g.json.bufferViews.push({ buffer, byteOffset: 4, byteLength: source.byteLength + 4 }) - 1;
    return g.json.accessors.push({ bufferView, byteOffset: 4, type, componentType, count: values.length / ({ SCALAR: 1, VEC2: 2, VEC3: 3 }[type]) }) - 1;
  }
  for (let i = 0; i < 2; i++) {
    g.json.materials.push({ name: `part-${i}`, pbrMetallicRoughness: { baseColorFactor: i ? [0.2, 0.5, 0.8, 1] : [1, 0, 0, 1], roughnessFactor: 0.8, metallicFactor: 0.1, baseColorTexture: { index: 0 } }, emissiveFactor: [0.1, 0, 0], doubleSided: true });
    const POSITION = accessor([i, 0, 0, i + 1, 0, 0, i, 1, 0], 'VEC3');
    Object.assign(g.json.accessors[POSITION], { min: [i, 0, 0], max: [i + 1, 1, 0] });
    g.json.meshes[0].primitives.push({ attributes: { POSITION, NORMAL: accessor([0, 0, 1, 0, 0, 1, 0, 0, 1], 'VEC3'), TEXCOORD_0: accessor([0, 0, 1, 0, 0, 1], 'VEC2') }, indices: accessor([0, 1, 2], 'SCALAR', 5123), material: i });
  }
  return g;
}
function values(g, index) {
  const a = g.json.accessors[index], v = g.json.bufferViews[a.bufferView], b = g.buffers[v.buffer];
  const Type = a.componentType === 5126 ? Float32Array : a.componentType === 5125 ? Uint32Array : Uint16Array;
  return Array.from(new Type(b.arrayBuffer, (b.byteOffset ?? 0) + (v.byteOffset ?? 0) + (a.byteOffset ?? 0), a.count * ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type])));
}

test('merges material colors while preserving triangles, UVs, normals and material properties', () => {
  const g = fixture(), originals = structuredClone(g.json.materials);
  const parts = g.json.meshes[0].primitives;
  const geometry = Object.fromEntries(['POSITION', 'NORMAL', 'TEXCOORD_0'].map(name => [name, parts.flatMap(p => values(g, p.attributes[name]))]));
  assert.equal(mergeMaterialPrimitives(g), g);
  assert.equal(g.json.meshes[0].primitives.length, 1);
  const p = g.json.meshes[0].primitives[0];
  for (const [name, data] of Object.entries(geometry)) assert.deepEqual(values(g, p.attributes[name]), data);
  assert.deepEqual(values(g, p.indices), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(values(g, p.attributes.COLOR_0), originals.flatMap(m => Array.from({ length: 3 }, () => m.pbrMetallicRoughness.baseColorFactor.map(Math.fround)).flat()));
  assert.deepEqual(g.json.materials.slice(0, 2), originals);
  assert.deepEqual(g.json.materials[p.material], { ...originals[0], pbrMetallicRoughness: { ...originals[0].pbrMetallicRoughness, baseColorFactor: [1, 1, 1, 1] } });
  assert.deepEqual(g.json.accessors[p.attributes.POSITION].max, [2, 1, 0]);
  for (const index of [...Object.values(p.attributes), p.indices]) assert.equal(g.json.bufferViews[g.json.accessors[index].bufferView].byteOffset % 4, 0);
});

test('unsupported layouts, material differences and transparent geometry remain unchanged', () => {
  const edits = [
    g => g.json.materials[1].alphaMode = 'BLEND',
    g => g.json.materials[1].alphaMode = 'MASK',
    g => g.json.materials[1].pbrMetallicRoughness.roughnessFactor = 0.2,
    g => g.json.materials[1].extensions = { KHR_materials_unlit: {} },
    g => g.json.meshes[0].primitives[1].extensions = {},
    g => g.json.meshes[0].primitives[1].targets = [],
    g => g.json.meshes[0].primitives[1].mode = 1,
    g => g.json.meshes[0].primitives[1].attributes.COLOR_0 = 0,
    g => delete g.json.meshes[0].primitives[1].indices,
    g => g.json.accessors[0].sparse = {},
    g => g.json.bufferViews[0].byteStride = 16,
    g => g.json.bufferViews[0].byteLength = 1,
    g => g.json.accessors[1].count = 2,
    g => { const a = g.json.accessors[3], v = g.json.bufferViews[a.bufferView], b = g.buffers[v.buffer]; new DataView(b.arrayBuffer).setUint16(12, 99, true); },
  ];
  for (const edit of edits) { const g = fixture(); edit(g); const before = structuredClone(g); mergeMaterialPrimitives(g); assert.deepEqual(g, before); }
});

test('unsupported primitive can share an original material without being mutated', () => {
  const g = fixture();
  const untouched = { ...g.json.meshes[0].primitives[0], mode: 1 };
  g.json.meshes[0].primitives.push(untouched);
  const original = structuredClone(g.json.materials[0]);
  mergeMaterialPrimitives(g);
  assert.equal(g.json.meshes[0].primitives[1], untouched);
  assert.deepEqual(g.json.materials[0], original);
});

test('bundled building GLBs retain indices and reduce supported primitive counts', () => {
  const dir = new URL('../public/models/', import.meta.url);
  const names = readdirSync(dir).filter(n => n.startsWith('buildings-') && n.endsWith('.glb'));
  let before = 0, after = 0;
  for (const name of names) {
    const raw = readFileSync(new URL(name, dir));
    const jsonLength = raw.readUInt32LE(12);
    const json = JSON.parse(raw.subarray(20, 20 + jsonLength).toString());
    const binStart = 20 + jsonLength + 8;
    const bin = raw.subarray(binStart);
    const g = { json, buffers: [{ arrayBuffer: bin.buffer, byteOffset: bin.byteOffset, byteLength: bin.byteLength }] };
    before += json.meshes.reduce((n, m) => n + m.primitives.length, 0);
    mergeMaterialPrimitives(g);
    after += json.meshes.reduce((n, m) => n + m.primitives.length, 0);
    for (const mesh of json.meshes) for (const p of mesh.primitives) if (p.attributes.COLOR_0 !== undefined) {
      assert.ok(values(g, p.indices).every(i => i < json.accessors[p.attributes.POSITION].count));
    }
  }
  assert.ok(names.length > 0);
  assert.ok(after < before, `${before} -> ${after}`);
  console.log(`Building primitives: ${before} -> ${after}`);
});

test('physical batching preserves every triangle material factor including defaults and singleton groups', () => {
  const g = fixture();
  g.json.materials[1].pbrMetallicRoughness.metallicFactor = 0.9;
  g.json.materials[1].pbrMetallicRoughness.roughnessFactor = 0.2;
  g.json.materials[1].emissiveFactor = [0.3, 0.7, 0.9];
  const originals = structuredClone(g.json.materials);
  mergeMaterialPrimitives(g, { materialAttributes: true });
  assert.equal(g.flowMaterialAttributes, true);
  assert.equal(g.json.meshes[0].primitives.length, 1);
  const p = g.json.meshes[0].primitives[0];
  assert.deepEqual(values(g, p.attributes._FLOW_METALLIC_ROUGHNESS), originals.flatMap(m => Array.from({ length: 3 }, () => [m.pbrMetallicRoughness.metallicFactor, m.pbrMetallicRoughness.roughnessFactor].map(Math.fround)).flat()));
  assert.deepEqual(values(g, p.attributes._FLOW_EMISSIVE), originals.flatMap(m => Array.from({ length: 3 }, () => m.emissiveFactor.map(Math.fround)).flat()));
  assert.deepEqual(g.json.materials.slice(0, 2), originals);
  const once = structuredClone(g);
  mergeMaterialPrimitives(g, { materialAttributes: true });
  assert.deepEqual(g, once);
  const separate = fixture();
  separate.json.materials[1].doubleSided = false;
  delete separate.json.materials[1].emissiveFactor;
  delete separate.json.materials[1].pbrMetallicRoughness.metallicFactor;
  delete separate.json.materials[1].pbrMetallicRoughness.roughnessFactor;
  mergeMaterialPrimitives(separate, { materialAttributes: true });
  assert.equal(separate.json.meshes[0].primitives.length, 2);
  const singleton = separate.json.meshes[0].primitives[1];
  assert.deepEqual(values(separate, singleton.attributes._FLOW_METALLIC_ROUGHNESS), [1, 1, 1, 1, 1, 1]);
  assert.deepEqual(values(separate, singleton.attributes._FLOW_EMISSIVE), Array(9).fill(0));
});

test('physical batching preflight rejects the whole asset without mutation', () => {
  for (const edit of [
    g => g.json.materials[1].alphaMode = 'BLEND',
    g => g.json.materials[1].extensions = { KHR_materials_unlit: {} },
    g => g.json.materials[1].emissiveFactor = [NaN, 0, 0],
    g => g.json.materials[1].pbrMetallicRoughness.roughnessFactor = -1,
    g => g.json.meshes[0].primitives[1].attributes.COLOR_0 = 0,
    g => g.json.meshes[0].primitives[1].attributes._FLOW_EMISSIVE = 0,
    g => g.json.animations = [{}],
  ]) {
    const g = fixture(); edit(g); const before = structuredClone(g);
    mergeMaterialPrimitives(g, { materialAttributes: true });
    assert.deepEqual(g, before);
  }
});

test('PBR shader uses vertex factors and retains the original module', async () => {
  const { pbrMaterial } = await import('@luma.gl/shadertools');
  const { materialAttributeFragmentShader } = await import('../src/layers/material-scenegraph.ts');
  const original = pbrMaterial.fs;
  const modified = materialAttributeFragmentShader(original);
  assert.match(modified, /in vec2 flowMetallicRoughness;/);
  assert.match(modified, /float metallic = flowMetallicRoughness.x/);
  assert.match(modified, /float perceptualRoughness = flowMetallicRoughness.y/);
  assert.match(modified, /vec3 emissive = flowEmissive/);
  assert.doesNotMatch(modified, /pbrMaterial\.(emissiveFactor|metallicRoughnessValues)/);
  assert.equal(pbrMaterial.fs, original);
  assert.throws(() => materialAttributeFragmentShader('changed upstream shader'), /Unsupported PBR shader/);
});
