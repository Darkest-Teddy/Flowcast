// A still copy of an animated (node-animated, unskinned) glTF: every mesh node's rest transform is
// baked into its vertices and the primitives are merged per material, with the animations dropped.
//
// For level of detail: a Bluebikes rider is 7 separately animated parts (wheels, cranks, legs), so
// 7 draws a frame plus 7 attribute re-binds whenever the riders move. From the campus overview the
// pedalling is a few pixels; there the still copy draws in 2 (one per texture) at no animation cost.

interface Accessor { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; sparse?: unknown; min?: number[]; max?: number[] }
interface BufferView { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; target?: number }
interface Primitive { attributes: Record<string, number>; indices?: number; material?: number; mode?: number; targets?: unknown[] }
interface GltfNode { mesh?: number; skin?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }
interface GltfJson {
  buffers: { byteLength: number }[];
  bufferViews: BufferView[];
  accessors: Accessor[];
  meshes?: { primitives: Primitive[] }[];
  nodes?: GltfNode[];
  scenes?: { nodes: number[] }[];
  scene?: number;
  animations?: unknown[];
  skins?: unknown[];
}
interface LoadedGltf { json: GltfJson; buffers: { arrayBuffer: ArrayBuffer; byteOffset?: number; byteLength: number }[]; images?: unknown[] }

const FLOAT = 5126;
type Mat4 = number[]; // column-major

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

function localMatrix(n: GltfNode): Mat4 {
  if (n.matrix?.length === 16) return n.matrix.slice();
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

/** Upper 3x3 (column-major) for normals: exact for rotation and uniform scale, which is all these
 *  models use; normals are renormalised after. */
function normalMatrix(m: Mat4): number[] {
  return [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]];
}

function read(gltf: LoadedGltf, index: number, components: number): Float32Array | null {
  const a = gltf.json.accessors[index];
  if (!a || a.bufferView === undefined || a.sparse || a.componentType !== FLOAT || a.normalized) return null;
  const view = gltf.json.bufferViews[a.bufferView];
  const stride = view.byteStride ?? components * 4;
  const buffer = gltf.buffers[view.buffer];
  const start = (buffer.byteOffset ?? 0) + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const dv = new DataView(buffer.arrayBuffer);
  const out = new Float32Array(a.count * components);
  for (let i = 0; i < a.count; i++) for (let c = 0; c < components; c++) out[i * components + c] = dv.getFloat32(start + i * stride + c * 4, true);
  return out;
}

function readIndices(gltf: LoadedGltf, index: number): Uint32Array | null {
  const a = gltf.json.accessors[index];
  if (!a || a.bufferView === undefined || a.sparse) return null;
  const size = a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : a.componentType === 5121 ? 1 : 0;
  if (!size) return null;
  const view = gltf.json.bufferViews[a.bufferView];
  const buffer = gltf.buffers[view.buffer];
  const start = (buffer.byteOffset ?? 0) + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const dv = new DataView(buffer.arrayBuffer);
  const out = new Uint32Array(a.count);
  for (let i = 0; i < a.count; i++) out[i] = size === 4 ? dv.getUint32(start + i * 4, true) : size === 2 ? dv.getUint16(start + i * 2, true) : dv.getUint8(start + i);
  return out;
}

interface Part { positions: Float32Array; normals: Float32Array | null; uvs: Float32Array | null; indices: Uint32Array }

/** A still copy of `loaded` (see the header), or null if it has skins or unsupported data. */
export function bakeStaticPose<T>(loaded: T): T | null {
  const src = loaded as unknown as LoadedGltf;
  if (!src?.json?.nodes || !src.json.meshes || src.json.skins?.length) return null;
  const gltf: LoadedGltf = { ...src, json: structuredClone(src.json), buffers: [...src.buffers] };
  const json = gltf.json;
  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? [];
  const groups = new Map<string, { material: number | undefined; parts: Part[] }>();
  const visit = (index: number, parent: Mat4): boolean => {
    const node = json.nodes![index];
    const world = multiply(parent, localMatrix(node));
    if (node.mesh !== undefined) {
      const nm = normalMatrix(world);
      for (const p of json.meshes![node.mesh].primitives) {
        if ((p.mode ?? 4) !== 4 || p.indices === undefined || p.targets?.length) return false;
        const pos = read(gltf, p.attributes.POSITION, 3);
        const nor = p.attributes.NORMAL !== undefined ? read(gltf, p.attributes.NORMAL, 3) : null;
        const uv = p.attributes.TEXCOORD_0 !== undefined ? read(gltf, p.attributes.TEXCOORD_0, 2) : null;
        const idx = readIndices(gltf, p.indices);
        if (!pos || !idx || (p.attributes.NORMAL !== undefined && !nor) || (p.attributes.TEXCOORD_0 !== undefined && !uv)) return false;
        for (let i = 0; i < pos.length; i += 3) {
          const [x, y, z] = [pos[i], pos[i + 1], pos[i + 2]];
          pos[i] = world[0] * x + world[4] * y + world[8] * z + world[12];
          pos[i + 1] = world[1] * x + world[5] * y + world[9] * z + world[13];
          pos[i + 2] = world[2] * x + world[6] * y + world[10] * z + world[14];
          if (nor) {
            const [a, b, c] = [nor[i], nor[i + 1], nor[i + 2]];
            const nx = nm[0] * a + nm[3] * b + nm[6] * c;
            const ny = nm[1] * a + nm[4] * b + nm[7] * c;
            const nz = nm[2] * a + nm[5] * b + nm[8] * c;
            const len = Math.hypot(nx, ny, nz) || 1;
            nor[i] = nx / len;
            nor[i + 1] = ny / len;
            nor[i + 2] = nz / len;
          }
        }
        const key = `${p.material}|${nor ? 1 : 0}|${uv ? 1 : 0}`;
        if (!groups.has(key)) groups.set(key, { material: p.material, parts: [] });
        groups.get(key)!.parts.push({ positions: pos, normals: nor, uvs: uv, indices: idx });
      }
    }
    return (node.children ?? []).every((c) => visit(c, world));
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  if (!roots.every((r) => visit(r, identity)) || !groups.size) return null;

  const primitives: Primitive[] = [];
  for (const { material, parts } of groups.values()) {
    const vertexCount = parts.reduce((n, p) => n + p.positions.length / 3, 0);
    const indexCount = parts.reduce((n, p) => n + p.indices.length, 0);
    const positions = new Float32Array(vertexCount * 3);
    const normals = parts[0].normals ? new Float32Array(vertexCount * 3) : null;
    const uvs = parts[0].uvs ? new Float32Array(vertexCount * 2) : null;
    const wide = vertexCount > 65535;
    const indices = wide ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let v = 0;
    let k = 0;
    for (const p of parts) {
      positions.set(p.positions, v * 3);
      if (normals && p.normals) normals.set(p.normals, v * 3);
      if (uvs && p.uvs) uvs.set(p.uvs, v * 2);
      for (let i = 0; i < p.positions.length; i++) {
        const c = i % 3;
        if (p.positions[i] < min[c]) min[c] = p.positions[i];
        if (p.positions[i] > max[c]) max[c] = p.positions[i];
      }
      for (let i = 0; i < p.indices.length; i++) indices[k + i] = p.indices[i] + v;
      v += p.positions.length / 3;
      k += p.indices.length;
    }
    const chunks: [Uint8Array, Omit<Accessor, 'bufferView'>, number][] = [
      [new Uint8Array(positions.buffer), { componentType: FLOAT, type: 'VEC3', count: vertexCount, min, max }, 34962],
      ...(normals ? [[new Uint8Array(normals.buffer), { componentType: FLOAT, type: 'VEC3', count: vertexCount }, 34962] as [Uint8Array, Omit<Accessor, 'bufferView'>, number]] : []),
      ...(uvs ? [[new Uint8Array(uvs.buffer), { componentType: FLOAT, type: 'VEC2', count: vertexCount }, 34962] as [Uint8Array, Omit<Accessor, 'bufferView'>, number]] : []),
      [new Uint8Array(indices.buffer), { componentType: wide ? 5125 : 5123, type: 'SCALAR', count: indexCount }, 34963],
    ];
    let size = 0;
    const offsets = chunks.map(([bytes]) => {
      const at = size;
      size += Math.ceil(bytes.length / 4) * 4;
      return at;
    });
    const data = new Uint8Array(size);
    chunks.forEach(([bytes], i) => data.set(bytes, offsets[i]));
    const buffer = gltf.buffers.push({ arrayBuffer: data.buffer, byteOffset: 0, byteLength: size }) - 1;
    json.buffers.push({ byteLength: size });
    const ids = chunks.map(([bytes, accessor, target], i) => {
      const view = json.bufferViews.push({ buffer, byteOffset: offsets[i], byteLength: bytes.length, target }) - 1;
      return json.accessors.push({ ...accessor, bufferView: view, byteOffset: 0 }) - 1;
    });
    const attributes: Record<string, number> = { POSITION: ids.shift()! };
    if (normals) attributes.NORMAL = ids.shift()!;
    if (uvs) attributes.TEXCOORD_0 = ids.shift()!;
    primitives.push({ attributes, indices: ids.shift()!, material, mode: 4 });
  }
  const mesh = json.meshes!.push({ primitives }) - 1;
  const node = json.nodes!.push({ mesh }) - 1;
  json.scenes = [{ nodes: [node] }];
  json.scene = 0;
  json.animations = [];
  return gltf as unknown as T;
}
