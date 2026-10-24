// Merge a model's flat-coloured parts into one primitive, at load time.
//
// Most of our models are one mesh with one primitive per colour: a bus is 16 primitives with 16
// materials, a sailboat 11, the Citgo sign 10. ScenegraphLayer pays a full draw for every
// primitive every frame, plus a full attribute re-bind for every primitive whenever a moving
// model's positions update, and those GL calls (queued through Chrome's single GPU-process
// thread) are what limit this app's frame rate. Here every untextured primitive of a mesh that
// shares its alpha mode and sidedness is folded into one: each material becomes a texel in three
// tiny palette textures (base colour, metallic/roughness, emissive), and its vertices get a
// TEXCOORD_0 pointing at that texel. The PBR shader then reads exactly the material's own values
// (nearest sampling, no mipmaps), so the picture is the same and the bus is one draw.
//
// Only plain shapes are touched: triangles, indexed, float positions and normals, no morph
// targets, skins or textures. Anything else in the model is left as it was.

interface Accessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  count: number;
  type: string;
  normalized?: boolean;
  min?: number[];
  max?: number[];
  sparse?: unknown;
}
interface BufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }
interface Primitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: unknown[]; extensions?: object }
interface TextureInfo { index: number; texCoord?: number }
interface Material {
  pbrMetallicRoughness?: { baseColorFactor?: number[]; metallicFactor?: number; roughnessFactor?: number; baseColorTexture?: TextureInfo; metallicRoughnessTexture?: TextureInfo };
  emissiveFactor?: number[];
  normalTexture?: TextureInfo;
  occlusionTexture?: TextureInfo;
  emissiveTexture?: TextureInfo;
  alphaMode?: string;
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: object;
  name?: string;
}
interface GltfJson {
  buffers: { byteLength: number }[];
  bufferViews: BufferView[];
  accessors: Accessor[];
  meshes?: { primitives: Primitive[] }[];
  nodes?: { mesh?: number; skin?: number }[];
  materials?: Material[];
  textures?: { sampler?: number; source?: number }[];
  images?: object[];
  samplers?: object[];
}
interface LoadedGltf {
  json: GltfJson;
  buffers: { arrayBuffer: ArrayBuffer; byteOffset?: number; byteLength: number }[];
  images?: unknown[];
}

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const UNSIGNED_BYTE = 5121;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;
const NEAREST = 9728;
const CLAMP_TO_EDGE = 33071;

function floatData(gltf: LoadedGltf, index: number, components: number): Float32Array | null {
  const a = gltf.json.accessors[index];
  if (!a || a.bufferView === undefined || a.sparse || a.componentType !== FLOAT || a.normalized) return null;
  const view = gltf.json.bufferViews[a.bufferView];
  const stride = view.byteStride ?? components * 4;
  const buffer = gltf.buffers[view.buffer];
  const start = (buffer.byteOffset ?? 0) + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = new Float32Array(a.count * components);
  const dv = new DataView(buffer.arrayBuffer);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < components; c++) out[i * components + c] = dv.getFloat32(start + i * stride + c * 4, true);
  return out;
}

function indexData(gltf: LoadedGltf, index: number): Uint32Array | null {
  const a = gltf.json.accessors[index];
  if (!a || a.bufferView === undefined || a.sparse || a.type !== 'SCALAR') return null;
  const view = gltf.json.bufferViews[a.bufferView];
  const buffer = gltf.buffers[view.buffer];
  const start = (buffer.byteOffset ?? 0) + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const dv = new DataView(buffer.arrayBuffer);
  const out = new Uint32Array(a.count);
  const size = a.componentType === UNSIGNED_INT ? 4 : a.componentType === UNSIGNED_SHORT ? 2 : a.componentType === UNSIGNED_BYTE ? 1 : 0;
  if (!size) return null;
  for (let i = 0; i < a.count; i++) {
    const at = start + i * size;
    out[i] = size === 4 ? dv.getUint32(at, true) : size === 2 ? dv.getUint16(at, true) : dv.getUint8(at);
  }
  return out;
}

/** Linear 0..1 -> sRGB-encoded byte (the shader decodes base colour and emissive textures). */
function srgbByte(linear: number): number {
  const v = Math.min(Math.max(linear, 0), 1);
  const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(s * 255);
}
const linearByte = (v: number) => Math.round(Math.min(Math.max(v, 0), 1) * 255);

function isFlat(m: Material | undefined): m is Material {
  if (!m || m.extensions && Object.keys(m.extensions).length) return false;
  const p = m.pbrMetallicRoughness ?? {};
  if (p.baseColorTexture || p.metallicRoughnessTexture || m.normalTexture || m.occlusionTexture || m.emissiveTexture) return false;
  // Opaque only: blended parts keep their own draw (and draw order).
  return (m.alphaMode ?? 'OPAQUE') === 'OPAQUE' && (p.baseColorFactor?.[3] ?? 1) >= 1;
}

function canMerge(gltf: LoadedGltf, p: Primitive): boolean {
  if ((p.mode ?? 4) !== 4 || p.indices === undefined || p.targets?.length || (p.extensions && Object.keys(p.extensions).length)) return false;
  if (p.material === undefined || !isFlat(gltf.json.materials?.[p.material])) return false;
  const names = Object.keys(p.attributes);
  if (!names.includes('POSITION') || names.some((n) => n !== 'POSITION' && n !== 'NORMAL' && n !== 'TEXCOORD_0')) return false;
  const pos = gltf.json.accessors[p.attributes.POSITION];
  return pos?.type === 'VEC3' && pos.componentType === FLOAT;
}

/** A W x 1 RGBA canvas from bytes (luma.gl uploads canvases as textures). */
function paletteImage(pixels: number[][]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = pixels.length;
  canvas.height = 1;
  const ctx = canvas.getContext('2d')!;
  const data = ctx.createImageData(pixels.length, 1);
  pixels.forEach((px, i) => data.data.set(px, i * 4));
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/** Folds each mesh's flat-coloured primitives into one (see the header). Returns the same object. */
export function mergeFlatMaterials<T>(loaded: T): T {
  if (typeof document === 'undefined') return loaded;
  const gltf = loaded as unknown as LoadedGltf;
  const json = gltf?.json;
  if (!json?.meshes || !json.materials || !gltf.buffers) return loaded;
  const skinned = new Set((json.nodes ?? []).filter((n) => n.skin !== undefined).map((n) => n.mesh));
  for (let m = 0; m < json.meshes.length; m++) {
    if (skinned.has(m)) continue;
    const mesh = json.meshes[m];
    // Group mergeable primitives by sidedness and whether they have normals.
    const groups = new Map<string, Primitive[]>();
    for (const p of mesh.primitives) {
      if (!canMerge(gltf, p)) continue;
      const mat = json.materials[p.material!];
      const key = `${mat.doubleSided ? 1 : 0}|${'NORMAL' in p.attributes ? 1 : 0}`;
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    for (const parts of groups.values()) {
      if (parts.length < 2) continue;
      const merged = mergeGroup(gltf, parts);
      if (!merged) continue;
      mesh.primitives = [...mesh.primitives.filter((p) => !parts.includes(p)), merged];
    }
  }
  return loaded;
}

function mergeGroup(gltf: LoadedGltf, parts: Primitive[]): Primitive | null {
  const json = gltf.json;
  const hasNormals = 'NORMAL' in parts[0].attributes;
  // One texel per distinct material.
  const materialIds = [...new Set(parts.map((p) => p.material!))];
  const texel = new Map(materialIds.map((id, i) => [id, i]));
  const width = materialIds.length;

  const positions: Float32Array[] = [];
  const normals: Float32Array[] = [];
  const indices: Uint32Array[] = [];
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of parts) {
    const pos = floatData(gltf, p.attributes.POSITION, 3);
    const nor = hasNormals ? floatData(gltf, p.attributes.NORMAL, 3) : null;
    const idx = indexData(gltf, p.indices!);
    if (!pos || (hasNormals && (!nor || nor.length !== pos.length)) || !idx) return null;
    positions.push(pos);
    if (nor) normals.push(nor);
    indices.push(idx);
    vertexCount += pos.length / 3;
    indexCount += idx.length;
  }
  const outPos = new Float32Array(vertexCount * 3);
  const outNor = hasNormals ? new Float32Array(vertexCount * 3) : null;
  const outUv = new Float32Array(vertexCount * 2);
  const wide = vertexCount > 65535;
  const outIdx = wide ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let v = 0;
  let k = 0;
  parts.forEach((p, i) => {
    const pos = positions[i];
    const n = pos.length / 3;
    outPos.set(pos, v * 3);
    if (outNor) outNor.set(normals[i], v * 3);
    const u = (texel.get(p.material!)! + 0.5) / width;
    for (let j = 0; j < n; j++) {
      outUv[(v + j) * 2] = u;
      outUv[(v + j) * 2 + 1] = 0.5;
      for (let c = 0; c < 3; c++) {
        const x = pos[j * 3 + c];
        if (x < min[c]) min[c] = x;
        if (x > max[c]) max[c] = x;
      }
    }
    const idx = indices[i];
    for (let j = 0; j < idx.length; j++) outIdx[k + j] = idx[j] + v;
    v += n;
    k += idx.length;
  });

  // Palettes. glTF: baseColorFactor and emissiveFactor are linear (the shader decodes the
  // textures from sRGB); metallic/roughness are linear in the B/G channels.
  const mats = materialIds.map((id) => json.materials![id]);
  const base = mats.map((mat) => {
    const c = mat.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
    return [srgbByte(c[0]), srgbByte(c[1]), srgbByte(c[2]), 255];
  });
  const mr = mats.map((mat) => [0, linearByte(mat.pbrMetallicRoughness?.roughnessFactor ?? 1), linearByte(mat.pbrMetallicRoughness?.metallicFactor ?? 1), 255]);
  const emissive = mats.map((mat) => {
    const e = mat.emissiveFactor ?? [0, 0, 0];
    return [srgbByte(e[0]), srgbByte(e[1]), srgbByte(e[2]), 255];
  });
  const glows = mats.some((mat) => (mat.emissiveFactor ?? [0, 0, 0]).some((x) => x > 0));

  // New binary chunks, appended as one buffer.
  const chunks: { bytes: Uint8Array; target: number; accessor: Omit<Accessor, 'bufferView'> }[] = [
    { bytes: new Uint8Array(outPos.buffer), target: ARRAY_BUFFER, accessor: { componentType: FLOAT, type: 'VEC3', count: vertexCount, min, max } },
    ...(outNor ? [{ bytes: new Uint8Array(outNor.buffer), target: ARRAY_BUFFER, accessor: { componentType: FLOAT, type: 'VEC3', count: vertexCount } }] : []),
    { bytes: new Uint8Array(outUv.buffer), target: ARRAY_BUFFER, accessor: { componentType: FLOAT, type: 'VEC2', count: vertexCount } },
    { bytes: new Uint8Array(outIdx.buffer), target: ELEMENT_ARRAY_BUFFER, accessor: { componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, type: 'SCALAR', count: indexCount } },
  ];
  const offsets: number[] = [];
  let size = 0;
  for (const c of chunks) {
    offsets.push(size);
    size += Math.ceil(c.bytes.length / 4) * 4;
  }
  const data = new Uint8Array(size);
  chunks.forEach((c, i) => data.set(c.bytes, offsets[i]));
  const bufferIndex = gltf.buffers.push({ arrayBuffer: data.buffer, byteOffset: 0, byteLength: size }) - 1;
  json.buffers.push({ byteLength: size });
  const accessorIds = chunks.map((c, i) => {
    const view = json.bufferViews.push({ buffer: bufferIndex, byteOffset: offsets[i], byteLength: c.bytes.length, target: c.target }) - 1;
    return json.accessors.push({ ...c.accessor, bufferView: view, byteOffset: 0 }) - 1;
  });

  // Palette textures: nearest, clamped, no mipmaps, so each texel is exactly its material.
  json.samplers ??= [];
  const sampler = json.samplers.push({ magFilter: NEAREST, minFilter: NEAREST, wrapS: CLAMP_TO_EDGE, wrapT: CLAMP_TO_EDGE }) - 1;
  json.images ??= [];
  json.textures ??= [];
  gltf.images ??= [];
  while (gltf.images.length < json.images.length) gltf.images.push(undefined);
  const texture = (pixels: number[][]) => {
    const image = json.images!.push({ mimeType: 'image/png', name: 'flowcast-palette' }) - 1;
    gltf.images![image] = paletteImage(pixels);
    return json.textures!.push({ sampler, source: image }) - 1;
  };
  const first = mats[0];
  const material: Material = {
    name: 'flowcast-palette',
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: { index: texture(base), texCoord: 0 },
      metallicFactor: 1,
      roughnessFactor: 1,
      metallicRoughnessTexture: { index: texture(mr), texCoord: 0 },
    },
    emissiveFactor: glows ? [1, 1, 1] : [0, 0, 0],
    ...(glows ? { emissiveTexture: { index: texture(emissive), texCoord: 0 } } : {}),
    alphaMode: 'OPAQUE',
    doubleSided: Boolean(first.doubleSided),
  };
  const materialIndex = json.materials!.push(material) - 1;
  const [posId, ...rest] = accessorIds;
  const attributes: Record<string, number> = { POSITION: posId };
  if (outNor) attributes.NORMAL = rest.shift()!;
  attributes.TEXCOORD_0 = rest.shift()!;
  return { attributes, indices: rest.shift()!, material: materialIndex, mode: 4 };
}
