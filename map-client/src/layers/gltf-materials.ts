interface Accessor {
  bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string;
  normalized?: boolean; min?: number[]; max?: number[]; sparse?: unknown; extensions?: unknown;
}
interface Primitive {
  attributes: Record<string, number>; indices?: number; material?: number; mode?: number;
  targets?: unknown; extensions?: unknown; extras?: unknown;
}
interface Material {
  name?: string; alphaMode?: string; extensions?: unknown;
  pbrMetallicRoughness?: { baseColorFactor?: number[]; [key: string]: unknown };
  [key: string]: unknown;
}
interface Gltf {
  flowMaterialAttributes?: boolean;
  json: {
    animations?: unknown[];
    buffers: { byteLength: number }[];
    bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number; extensions?: unknown }[];
    accessors: Accessor[]; materials: Material[]; meshes: { primitives: Primitive[] }[];
  };
  buffers: { arrayBuffer: ArrayBuffer; byteOffset?: number; byteLength: number }[];
}
const widths: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const sizes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

function bytes(g: Gltf, index: number): Uint8Array | null {
  const a = g.json.accessors[index];
  if (!a || a.bufferView === undefined || a.sparse || a.extensions || !Number.isInteger(a.count) || a.count <= 0) return null;
  const v = g.json.bufferViews[a.bufferView];
  const stride = widths[a.type] * sizes[a.componentType];
  if (!v || v.extensions || !stride || (v.byteStride !== undefined && v.byteStride !== stride)) return null;
  const b = g.buffers[v.buffer];
  const offset = a.byteOffset ?? 0;
  const length = a.count * stride;
  const start = (b?.byteOffset ?? 0) + (v.byteOffset ?? 0) + offset;
  if (!b || offset < 0 || offset + length > v.byteLength || (v.byteOffset ?? 0) + offset + length > b.byteLength || start < 0 || start + length > b.arrayBuffer.byteLength) return null;
  return new Uint8Array(b.arrayBuffer, start, length);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

interface Part { primitive: Primitive; material: Material; factor: number[]; indices: number[]; count: number; names: string[] }
function part(g: Gltf, p: Primitive): Part | null {
  if ((p.mode ?? 4) !== 4 || p.targets || p.extensions || p.extras || p.indices === undefined || p.material === undefined || p.attributes.COLOR_0 !== undefined) return null;
  const material = g.json.materials[p.material];
  if (!material || material.extensions || (material.alphaMode ?? 'OPAQUE') !== 'OPAQUE') return null;
  const factor = material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1];
  if (factor.length !== 4 || factor.some(v => !Number.isFinite(v) || v < 0 || v > 1)) return null;
  const position = g.json.accessors[p.attributes.POSITION];
  if (!position || position.type !== 'VEC3' || position.componentType !== 5126) return null;
  const names = Object.keys(p.attributes).sort();
  for (const name of names) {
    const a = g.json.accessors[p.attributes[name]];
    if (!a || a.count !== position.count || !bytes(g, p.attributes[name])) return null;
  }
  const a = g.json.accessors[p.indices];
  const raw = bytes(g, p.indices);
  if (!a || !raw || a.type !== 'SCALAR' || a.normalized || a.count % 3 || ![5121, 5123, 5125].includes(a.componentType)) return null;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const indices = Array.from({ length: a.count }, (_, i) => a.componentType === 5121 ? view.getUint8(i) : a.componentType === 5123 ? view.getUint16(i * 2, true) : view.getUint32(i * 4, true));
  if (indices.some(i => i >= position.count)) return null;
  return { primitive: p, material, factor, indices, count: position.count, names };
}

/** Bake opaque material colors into vertices so otherwise identical mesh primitives share a draw. */
export function mergeMaterialPrimitives<T>(loaded: T, options: { materialAttributes?: boolean } = {}): T {
  if (import.meta.env?.DEV && new URLSearchParams(window.location.search).get('batchMaterials') === '0') return loaded;
  const g = loaded as unknown as Gltf;
  if (!g?.json?.meshes || !g.json.materials || !g.json.accessors || !g.json.bufferViews || !g.json.buffers || !g.buffers) return loaded;
  const physical = options.materialAttributes === true;
  if (physical) {
    if (g.flowMaterialAttributes || g.json.animations?.length) return loaded;
    // Every draw uses the same shader, including groups that cannot be merged.
    for (const mesh of g.json.meshes) for (const primitive of mesh.primitives) {
      const p = part(g, primitive);
      if (!p || p.names.some(name => name.startsWith('_FLOW_'))) return loaded;
      const pbr = p.material.pbrMetallicRoughness;
      const factors = [pbr?.metallicFactor ?? 1, pbr?.roughnessFactor ?? 1];
      const emissive = p.material.emissiveFactor ?? [0, 0, 0];
      if (factors.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) ||
        !Array.isArray(emissive) || emissive.length !== 3 || emissive.some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) return loaded;
    }
  }
  for (const mesh of g.json.meshes) {
    const groups = new Map<string, Part[]>();
    for (const primitive of mesh.primitives) {
      const p = part(g, primitive);
      if (!p) continue;
      const { name: _name, pbrMetallicRoughness, ...rest } = p.material;
      const { baseColorFactor: _factor, ...pbr } = pbrMetallicRoughness ?? {};
      if (physical) { delete pbr.metallicFactor; delete pbr.roughnessFactor; delete rest.emissiveFactor; }
      const layout = p.names.map(name => {
        const a = g.json.accessors[primitive.attributes[name]];
        return [name, a.type, a.componentType, !!a.normalized];
      });
      const key = canonical([rest, pbr, layout]);
      const group = groups.get(key) ?? [];
      group.push(p); groups.set(key, group);
    }
    const replacements = new Map<Primitive, Primitive>();
    const removed = new Set<Primitive>();
    for (const parts of groups.values()) {
      if (parts.length < 2 && !physical) continue;
      const first = parts[0];
      const count = parts.reduce((n, p) => n + p.count, 0);
      const chunks: { name: string; bytes: Uint8Array; accessor: Accessor }[] = [];
      for (const name of first.names) {
        const arrays = parts.map(p => bytes(g, p.primitive.attributes[name])!);
        const data = new Uint8Array(arrays.reduce((n, b) => n + b.length, 0));
        let at = 0;
        for (const b of arrays) { data.set(b, at); at += b.length; }
        const sources = parts.map(p => g.json.accessors[p.primitive.attributes[name]]);
        const base = sources[0];
        const accessor: Accessor = { componentType: base.componentType, type: base.type, count, normalized: base.normalized };
        if (sources.every(a => a.min && a.max)) {
          accessor.min = base.min!.map((_, i) => Math.min(...sources.map(a => a.min![i])));
          accessor.max = base.max!.map((_, i) => Math.max(...sources.map(a => a.max![i])));
        }
        chunks.push({ name, bytes: data, accessor });
      }
      const colors = new Float32Array(count * 4);
      let vertex = 0;
      for (const p of parts) for (let i = 0; i < p.count; i++) colors.set(p.factor, vertex++ * 4);
      chunks.push({ name: 'COLOR_0', bytes: new Uint8Array(colors.buffer), accessor: { componentType: 5126, type: 'VEC4', count } });
      if (physical) {
        for (const [name, width] of [['_FLOW_METALLIC_ROUGHNESS', 2], ['_FLOW_EMISSIVE', 3]] as const) {
          const data = new Float32Array(count * width);
          let vertex = 0;
          for (const p of parts) {
            const pbr = p.material.pbrMetallicRoughness;
            const values = width === 2 ? [pbr?.metallicFactor ?? 1, pbr?.roughnessFactor ?? 1] : p.material.emissiveFactor ?? [0, 0, 0];
            for (let i = 0; i < p.count; i++) data.set(values as number[], vertex++ * width);
          }
          chunks.push({ name, bytes: new Uint8Array(data.buffer), accessor: { componentType: 5126, type: `VEC${width}`, count } });
        }
      }
      const indices = new Uint32Array(parts.reduce((n, p) => n + p.indices.length, 0));
      let at = 0, offset = 0;
      for (const p of parts) { for (const i of p.indices) indices[at++] = i + offset; offset += p.count; }
      chunks.push({ name: 'indices', bytes: new Uint8Array(indices.buffer), accessor: { componentType: 5125, type: 'SCALAR', count: indices.length } });
      let length = 0;
      const offsets = chunks.map(c => { const start = length; length += Math.ceil(c.bytes.length / 4) * 4; return start; });
      const data = new Uint8Array(length);
      const buffer = g.buffers.length;
      const merged: Primitive = { mode: 4, attributes: {}, material: g.json.materials.length };
      chunks.forEach((c, i) => {
        data.set(c.bytes, offsets[i]);
        const bufferView = g.json.bufferViews.push({ buffer, byteOffset: offsets[i], byteLength: c.bytes.length }) - 1;
        const accessor = g.json.accessors.push({ ...c.accessor, bufferView }) - 1;
        if (c.name === 'indices') merged.indices = accessor;
        else merged.attributes[c.name] = accessor;
      });
      g.buffers.push({ arrayBuffer: data.buffer, byteOffset: 0, byteLength: length });
      g.json.buffers.push({ byteLength: length });
      g.json.materials.push({ ...first.material, pbrMetallicRoughness: { ...first.material.pbrMetallicRoughness, baseColorFactor: [1, 1, 1, 1] } });
      replacements.set(first.primitive, merged);
      for (const p of parts.slice(1)) removed.add(p.primitive);
    }
    if (replacements.size) mesh.primitives = mesh.primitives.filter(p => !removed.has(p)).map(p => replacements.get(p) ?? p);
  }
  if (physical) g.flowMaterialAttributes = true;
  return loaded;
}
