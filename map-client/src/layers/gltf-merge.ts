// Merge a character's skinned meshes into one primitive, at load time.
//
// Each Kenney character is two skinned meshes (body and head) with the same material and the
// same skeleton. ScenegraphLayer draws every primitive separately and per-draw overhead dominates
// our frame time, so with 36 walker layers that was 72 draws (and 72 skin palette updates) a
// frame. Appending the head's vertices to the body's and dropping the head node gives one draw
// per layer with an identical picture: same material, same joints, same triangles in the same
// order. Anything that doesn't match that shape exactly is left untouched.

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
interface BufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
  target?: number;
}
interface Primitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: unknown[];
}
interface GltfJson {
  buffers: { byteLength: number }[];
  bufferViews: BufferView[];
  accessors: Accessor[];
  meshes: { primitives: Primitive[] }[];
  nodes: { mesh?: number; skin?: number }[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
}
interface LoadedGltf {
  json: GltfJson;
  buffers: { arrayBuffer: ArrayBuffer; byteOffset?: number; byteLength: number }[];
}

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** The tightly packed bytes of an accessor, or null if it's strided, sparse or bufferless. */
function accessorBytes(gltf: LoadedGltf, index: number): Uint8Array | null {
  const accessor = gltf.json.accessors[index];
  if (!accessor || accessor.bufferView === undefined || accessor.sparse) return null;
  const view = gltf.json.bufferViews[accessor.bufferView];
  const elementBytes = COMPONENTS[accessor.type] * COMPONENT_BYTES[accessor.componentType];
  if (!elementBytes || (view.byteStride && view.byteStride !== elementBytes)) return null;
  const buffer = gltf.buffers[view.buffer];
  const start = (buffer.byteOffset ?? 0) + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  return new Uint8Array(buffer.arrayBuffer, start, accessor.count * elementBytes);
}

function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function readIndices(gltf: LoadedGltf, index: number): Uint16Array | Uint32Array | null {
  const accessor = gltf.json.accessors[index];
  const bytes = accessorBytes(gltf, index);
  if (!bytes) return null;
  const copy = bytes.slice(); // aligned copy
  if (accessor.componentType === UNSIGNED_SHORT) return new Uint16Array(copy.buffer);
  if (accessor.componentType === UNSIGNED_INT) return new Uint32Array(copy.buffer);
  return null;
}

/** Merges every skinned mesh into the first one when they share material, layout and skeleton. */
export function mergeSkinnedMeshes<T>(loaded: T): T {
  const gltf = loaded as unknown as LoadedGltf;
  const json = gltf?.json;
  if (!json?.nodes || !json.meshes || !json.skins || !gltf.buffers) return loaded;
  const nodes = json.nodes.filter((n) => n.mesh !== undefined && n.skin !== undefined);
  if (nodes.length < 2) return loaded;
  const prims = nodes.map((n) => json.meshes[n.mesh!].primitives);
  if (prims.some((p) => p.length !== 1)) return loaded;
  const parts = prims.map((p) => p[0]);
  const first = parts[0];
  const names = Object.keys(first.attributes).sort();
  const skin0 = json.skins[nodes[0].skin!];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const skin = json.skins[nodes[i].skin!];
    if ((p.mode ?? 4) !== 4 || p.targets?.length || p.indices === undefined || p.material !== first.material) return loaded;
    if (Object.keys(p.attributes).sort().join() !== names.join()) return loaded;
    for (const name of names) {
      const a = json.accessors[p.attributes[name]];
      const b = json.accessors[first.attributes[name]];
      if (a.componentType !== b.componentType || a.type !== b.type || Boolean(a.normalized) !== Boolean(b.normalized)) return loaded;
    }
    if (skin.joints.join() !== skin0.joints.join()) return loaded;
    if (i > 0 && (skin.inverseBindMatrices === undefined) !== (skin0.inverseBindMatrices === undefined)) return loaded;
    if (i > 0 && skin.inverseBindMatrices !== undefined && !sameBytes(accessorBytes(gltf, skin.inverseBindMatrices), accessorBytes(gltf, skin0.inverseBindMatrices!))) return loaded;
  }

  // Gather the merged data: attributes back to back, indices offset by the vertices before them.
  const chunks: { bytes: Uint8Array; accessor: Accessor; target: number; name: string }[] = [];
  const vertexCounts = parts.map((p) => json.accessors[p.attributes.POSITION].count);
  const totalVertices = vertexCounts.reduce((a, b) => a + b, 0);
  for (const name of names) {
    const pieces = parts.map((p) => accessorBytes(gltf, p.attributes[name]));
    if (pieces.some((b) => !b)) return loaded;
    const bytes = new Uint8Array(pieces.reduce((n, b) => n + b!.length, 0));
    let at = 0;
    for (const b of pieces) {
      bytes.set(b!, at);
      at += b!.length;
    }
    const sources = parts.map((p) => json.accessors[p.attributes[name]]);
    const base = sources[0];
    const merged: Accessor = { componentType: base.componentType, type: base.type, count: totalVertices };
    if (base.normalized) merged.normalized = true;
    if (sources.every((s) => s.min && s.max)) {
      merged.min = base.min!.map((_, k) => Math.min(...sources.map((s) => s.min![k])));
      merged.max = base.max!.map((_, k) => Math.max(...sources.map((s) => s.max![k])));
    }
    chunks.push({ bytes, accessor: merged, target: ARRAY_BUFFER, name });
  }
  const indexLists = parts.map((p) => readIndices(gltf, p.indices!));
  if (indexLists.some((l) => !l)) return loaded;
  const indexCount = indexLists.reduce((n, l) => n + l!.length, 0);
  const wide = totalVertices > 65535;
  const indices = wide ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let at = 0;
  let offset = 0;
  indexLists.forEach((list, i) => {
    for (let k = 0; k < list!.length; k++) indices[at + k] = list![k] + offset;
    at += list!.length;
    offset += vertexCounts[i];
  });
  chunks.push({
    bytes: new Uint8Array(indices.buffer),
    accessor: { componentType: wide ? UNSIGNED_INT : UNSIGNED_SHORT, type: 'SCALAR', count: indexCount },
    target: ELEMENT_ARRAY_BUFFER,
    name: 'indices',
  });

  // One new binary buffer holding every merged chunk (4-byte aligned), appended to the glTF.
  const offsets: number[] = [];
  let size = 0;
  for (const c of chunks) {
    offsets.push(size);
    size += Math.ceil(c.bytes.length / 4) * 4;
  }
  const data = new Uint8Array(size);
  chunks.forEach((c, i) => data.set(c.bytes, offsets[i]));
  const bufferIndex = gltf.buffers.length;
  gltf.buffers.push({ arrayBuffer: data.buffer, byteOffset: 0, byteLength: size });
  json.buffers.push({ byteLength: size });
  const primitive: Primitive = { ...first, attributes: {} };
  chunks.forEach((c, i) => {
    const view = json.bufferViews.push({ buffer: bufferIndex, byteOffset: offsets[i], byteLength: c.bytes.length, target: c.target }) - 1;
    const accessor = json.accessors.push({ ...c.accessor, bufferView: view, byteOffset: 0 }) - 1;
    if (c.name === 'indices') primitive.indices = accessor;
    else primitive.attributes[c.name] = accessor;
  });
  json.meshes[nodes[0].mesh!].primitives = [primitive];
  // The other mesh nodes stay in the hierarchy as plain (empty) nodes.
  for (const node of nodes.slice(1)) {
    delete node.mesh;
    delete node.skin;
  }
  return loaded;
}
