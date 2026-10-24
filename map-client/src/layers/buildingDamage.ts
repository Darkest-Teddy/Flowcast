// Damaged-building rendering for the merged campus GLBs (see buildings.ts).
//
// Each campus is one GLB with every building batched into a few primitives, so a building can't be
// hidden or swapped on its own. Instead, once per campus, every triangle is tagged with the building
// whose footprint it belongs to (a per-vertex `_FLOW_BUILDING` index, added to a shallow copy of the
// parsed glTF; the original buffers are shared). From then on a small uniform block maps building
// index -> damage slot and holds each slot's current state, and the vertex shader collapses, leans and
// shakes only the vertices of damaged buildings while the fragment shader chars them and dims or
// burns their lit windows. Per frame the CPU only rewrites that block when a value changes; geometry
// is never rebuilt or re-uploaded per frame, and neighbours keep their own (zero) slot.
//
// Pure CPU code and shader strings only: no deck.gl imports, so Node tests can run it directly.
import type { BuildingDamageFrame, DamageFootprint } from '../sim/disasterDamage';

/** Damage slots per campus (slot 0 = undamaged). More damaged buildings share slots (warned). */
export const MAX_DAMAGE_SLOTS = 255;
/** Building indices per campus the slot map can address (two 8-bit slots per float). */
export const MAX_TAGGED_BUILDINGS = 2047;
const MAP_VEC4S = 256; // 256 vec4 * 4 floats * 2 slots = 2048 entries

// --------------------------------------------------------------------------------------------
// Geometry tagging
// --------------------------------------------------------------------------------------------

interface Accessor { bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean; min?: number[]; max?: number[]; sparse?: unknown }
interface Gltf {
  json: {
    nodes?: { matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; children?: number[] }[];
    buffers: { byteLength: number }[];
    bufferViews: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
    accessors: Accessor[];
    meshes: { primitives: { attributes: Record<string, number>; indices?: number; mode?: number }[] }[];
  };
  buffers: { arrayBuffer: ArrayBuffer; byteOffset?: number; byteLength: number }[];
}
const WIDTH: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const ARRAY: Record<number, { BYTES_PER_ELEMENT: number; new (b: ArrayBuffer, o: number, n: number): ArrayLike<number> }> = {
  5121: Uint8Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};

/** Accessor values as a flat array (handles interleaved views by copying). */
function read(g: Gltf, index: number): ArrayLike<number> | null {
  const a = g.json.accessors[index];
  const T = a && ARRAY[a.componentType];
  if (!a || !T || a.bufferView === undefined || a.sparse) return null;
  const view = g.json.bufferViews[a.bufferView];
  const buffer = g.buffers[view.buffer];
  const width = WIDTH[a.type];
  const start = (buffer.byteOffset ?? 0) + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = view.byteStride ?? width * T.BYTES_PER_ELEMENT;
  if (stride === width * T.BYTES_PER_ELEMENT && start % T.BYTES_PER_ELEMENT === 0) return new T(buffer.arrayBuffer, start, a.count * width);
  const out = new Float64Array(a.count * width);
  const dv = new DataView(buffer.arrayBuffer);
  const get = (o: number) => a.componentType === 5126 ? dv.getFloat32(o, true) : a.componentType === 5125 ? dv.getUint32(o, true) : a.componentType === 5123 ? dv.getUint16(o, true) : dv.getUint8(o);
  for (let i = 0; i < a.count; i++) for (let k = 0; k < width; k++) out[i * width + k] = get(start + i * stride + k * T.BYTES_PER_ELEMENT);
  return out;
}

/** Accessor elements as tightly packed bytes (copied when the view is interleaved). */
function elementBytes(g: Gltf, index: number): Uint8Array | null {
  const a = g.json.accessors[index];
  const T = a && (ARRAY[a.componentType] ?? (a.componentType === 5120 ? Int8Array : a.componentType === 5122 ? Int16Array : undefined));
  if (!a || !T || a.bufferView === undefined || a.sparse) return null;
  const view = g.json.bufferViews[a.bufferView];
  const buffer = g.buffers[view.buffer];
  const size = WIDTH[a.type] * T.BYTES_PER_ELEMENT;
  const start = (buffer.byteOffset ?? 0) + (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const stride = view.byteStride ?? size;
  const src = new Uint8Array(buffer.arrayBuffer);
  if (stride === size) return src.slice(start, start + a.count * size);
  const out = new Uint8Array(a.count * size);
  for (let i = 0; i < a.count; i++) out.set(src.subarray(start + i * stride, start + i * stride + size), i * size);
  return out;
}

const EARTH = 40.03e6; // @math.gl/web-mercator's circumference, as data-pipeline/make_building_models.py's Frame
/** [lng, lat] -> model metres (x east, z south) for a campus origin, exactly as the GLBs were built. */
export function toModel(origin: readonly [number, number], lngLat: readonly [number, number]): [number, number] {
  const k = EARTH / (2 * Math.PI) * Math.cos(origin[1] * Math.PI / 180);
  const merc = (lat: number) => Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
  return [(lngLat[0] - origin[0]) * Math.PI / 180 * k, -(merc(lngLat[1]) - merc(origin[1])) * k];
}

interface Ring { owner: number; xs: Float64Array; zs: Float64Array; minX: number; maxX: number; minZ: number; maxZ: number }
function insideRing(r: Ring, x: number, z: number): boolean {
  if (x < r.minX || x > r.maxX || z < r.minZ || z > r.maxZ) return false;
  let c = false;
  for (let i = 0, j = r.xs.length - 1; i < r.xs.length; j = i++) {
    if ((r.zs[j] > z) !== (r.zs[i] > z) && x < (r.xs[i] - r.xs[j]) * (z - r.zs[j]) / (r.zs[i] - r.zs[j]) + r.xs[j]) c = !c;
  }
  return c;
}
function ringDistance(r: Ring, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0, j = r.xs.length - 1; i < r.xs.length; j = i++) {
    const ax = r.xs[j] - x, az = r.zs[j] - z, dx = r.xs[i] - r.xs[j], dz = r.zs[i] - r.zs[j];
    const l2 = dx * dx + dz * dz;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + az * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, az + t * dz));
  }
  return best;
}

/** How far facade probes step in from a wall, and how far outside a footprint an overhang
 *  (cornice, window glass, eave) can still belong to it, metres. */
const PROBE = 0.35;
const OVERHANG = 2;
/** A wall face this far inside a footprint is that building's, whichever way it faces. */
const INSET = 0.15;
/** Faces within this of a footprint edge and turned toward it may be a neighbour's party wall. */
const PARTY_WALL = 0.25;
const CELL = 16;

export interface TaggedModel<T = unknown> {
  /** Shallow copy of the glTF with a `_FLOW_BUILDING` float attribute (0 = no building). */
  gltf: T;
  /** Building id -> 1-based index used in `_FLOW_BUILDING`. */
  index: Map<string, number>;
  /** Triangles tagged per index (index 0: untagged), for tests and diagnostics. */
  triangles: Uint32Array;
  /** Wall-clock milliseconds the tagging took. */
  ms: number;
}

/**
 * Tag every triangle of a campus glTF with the footprint it belongs to. A wall belongs to the
 * building its inward probe (centroid minus 0.35 m along the outward normal) falls in, so the two
 * faces of a party wall go to their own buildings; roofs and floors to the footprint under their
 * centroid; faces outside every footprint (cornices, eaves) to the nearest one within 2 m that
 * they face away from. The lit-window mesh has no normals, but its quads wind outward like the
 * walls, so the same rule applies. Runs once per campus and GLB, ~60-150 ms for Charles River.
 */
export function tagBuildings<T>(loaded: T, origin: readonly [number, number], footprints: readonly Pick<DamageFootprint, 'id' | 'polygon'>[]): TaggedModel<T> | null {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const g = loaded as unknown as Gltf;
  if (!g?.json?.meshes || !g.buffers) return null;
  // The building GLBs have one untransformed node; refuse anything else rather than mis-tag it.
  if (g.json.nodes?.some(n => n.matrix || n.translation || n.rotation || n.scale)) return null;
  const index = new Map<string, number>();
  const rings: Ring[] = [];
  for (const f of footprints) {
    if (!f.id || f.polygon.length < 3) continue;
    let owner = index.get(f.id);
    if (owner === undefined) {
      if (index.size >= MAX_TAGGED_BUILDINGS) continue;
      owner = index.size + 1;
      index.set(f.id, owner);
    }
    const xs = new Float64Array(f.polygon.length), zs = new Float64Array(f.polygon.length);
    f.polygon.forEach((p, i) => { [xs[i], zs[i]] = toModel(origin, p); });
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < xs.length; i++) { minX = Math.min(minX, xs[i]); maxX = Math.max(maxX, xs[i]); minZ = Math.min(minZ, zs[i]); maxZ = Math.max(maxZ, zs[i]); }
    rings.push({ owner, xs, zs, minX, maxX, minZ, maxZ });
  }
  // Uniform grid of candidate rings (padded by the overhang reach).
  const grid = new Map<number, Ring[]>();
  const key = (cx: number, cz: number) => (cx + 32768) * 65536 + (cz + 32768);
  for (const r of rings) {
    for (let cx = Math.floor((r.minX - OVERHANG) / CELL); cx <= Math.floor((r.maxX + OVERHANG) / CELL); cx++)
      for (let cz = Math.floor((r.minZ - OVERHANG) / CELL); cz <= Math.floor((r.maxZ + OVERHANG) / CELL); cz++) {
        const list = grid.get(key(cx, cz)) ?? [];
        list.push(r); grid.set(key(cx, cz), list);
      }
  }
  const candidates = (x: number, z: number) => grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  const containing = (x: number, z: number) => {
    const list = candidates(x, z);
    if (list) for (const r of list) if (insideRing(r, x, z)) return r.owner;
    return 0;
  };
  const distanceTo = (owner: number, x: number, z: number) => {
    let d = Infinity;
    for (const r of rings) if (r.owner === owner) d = Math.min(d, insideRing(r, x, z) ? 0 : ringDistance(r, x, z));
    return d;
  };
  const boxes = new Map<number, [number, number, number, number]>();
  for (const r of rings) {
    const b = boxes.get(r.owner) ?? [Infinity, Infinity, -Infinity, -Infinity];
    boxes.set(r.owner, [Math.min(b[0], r.minX), Math.min(b[1], r.minZ), Math.max(b[2], r.maxX), Math.max(b[3], r.maxZ)]);
  }
  const near3 = (owner: number, x: number, z: number) => {
    const b = boxes.get(owner)!;
    return x >= b[0] - OVERHANG && x <= b[2] + OVERHANG && z >= b[1] - OVERHANG && z <= b[3] + OVERHANG;
  };
  /** Distance from a point inside `owner` to the nearest edge of the ring containing it. */
  const edgeDistance = (owner: number, x: number, z: number) => {
    let d = 0;
    for (const r of rings) if (r.owner === owner && insideRing(r, x, z)) d = Math.max(d, ringDistance(r, x, z));
    return d;
  };
  const nearest = (x: number, z: number) => {
    let best = 0, bestD = OVERHANG;
    const list = candidates(x, z);
    if (list) for (const r of list) {
      if (x < r.minX - OVERHANG || x > r.maxX + OVERHANG || z < r.minZ - OVERHANG || z > r.maxZ + OVERHANG) continue;
      const d = ringDistance(r, x, z);
      if (d < bestD) { bestD = d; best = r.owner; }
    }
    return best;
  };

  const triangles = new Uint32Array(index.size + 1);
  const json = { ...g.json, accessors: [...g.json.accessors], bufferViews: [...g.json.bufferViews], buffers: [...g.json.buffers] };
  const buffers = [...g.buffers];
  json.meshes = g.json.meshes.map(mesh => ({
    ...mesh,
    primitives: mesh.primitives.map(p => {
      const posIndex = p.attributes.POSITION;
      const pos = posIndex === undefined ? null : read(g, posIndex);
      if (!pos || (p.mode ?? 4) !== 4) return p;
      const count = g.json.accessors[posIndex].count;
      const idx = p.indices === undefined ? null : read(g, p.indices);
      const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(count / 3);
      const triOwner = new Uint16Array(triCount);
      for (let t = 0; t < triCount; t++) {
        const a = idx ? idx[t * 3] : t * 3, b = idx ? idx[t * 3 + 1] : t * 3 + 1, c = idx ? idx[t * 3 + 2] : t * 3 + 2;
        const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
        const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
        const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const cx = ax + (ux + vx) / 3, cz = az + (uz + vz) / 3;
        const nh = Math.hypot(nx, nz), n = Math.hypot(nx, ny, nz);
        let owner = 0;
        if (n > 0 && nh > 0.5 * n) {
          // Wall: trust the winding (outward normal) first, so party walls split correctly.
          const ox = nx / nh * PROBE, oz = nz / nh * PROBE;
          owner = containing(cx - ox, cz - oz);
          const centre = owner ? 0 : containing(cx, cz);
          // Inward-facing faces (inner sides of glass, fins, stacked volumes' undersides of walls)
          // well inside a footprint belong to it; a party wall sits on the edge and is left to its winding.
          if (!owner && centre && edgeDistance(centre, cx, cz) > INSET) owner = centre;
          if (!owner && !centre) {
            // Outside every known footprint: an overhang (cornice, eave) belongs to the nearest
            // footprint within 2 m. A face turned toward that footprint is accepted only if it stands
            // clear of the edge (the inner skin of a double facade, the back of a fin): a neighbour's
            // party wall, whose own footprint may be unknown, lies on the edge facing in and is left alone.
            const near = nearest(cx - ox, cz - oz);
            if (near && (distanceTo(near, cx + ox, cz + oz) > distanceTo(near, cx - ox, cz - oz) || distanceTo(near, cx, cz) > PARTY_WALL)) owner = near;
          }
        } else {
          owner = containing(cx, cz) || nearest(cx, cz);
        }
        // A triangle reaching well past its building (a shared ground plane, a long sliver) stays untagged.
        if (owner && !(near3(owner, ax, az) && near3(owner, ax + ux, az + uz) && near3(owner, ax + vx, az + vz))) owner = 0;
        triangles[owner]++;
        triOwner[t] = owner;
      }
      // Every triangle needs one tag on all three corners, or the shader would stretch it between
      // a collapsed and a standing vertex. Corners shared by triangles of different owners (or an
      // owner and untagged geometry) are duplicated, once, for each extra owner.
      const vertexOwner = new Int32Array(count).fill(-1);
      const split = new Map<number, number>(); // vertex * 4096 + owner -> new vertex
      const sources: number[] = []; // source vertex of each appended vertex
      const corners = new Uint32Array(triCount * 3);
      for (let t = 0; t < triCount; t++) for (let k = 0; k < 3; k++) {
        const v = idx ? idx[t * 3 + k] : t * 3 + k, owner = triOwner[t];
        if (vertexOwner[v] === -1) vertexOwner[v] = owner;
        if (vertexOwner[v] === owner) { corners[t * 3 + k] = v; continue; }
        const key = v * 4096 + owner;
        let dup = split.get(key);
        if (dup === undefined) { dup = count + sources.length; sources.push(v); split.set(key, dup); }
        corners[t * 3 + k] = dup;
      }
      const total = count + sources.length;
      const tag = new Float32Array(total);
      for (let v = 0; v < count; v++) tag[v] = Math.max(0, vertexOwner[v]);
      for (const [key, dup] of split) tag[dup] = key % 4096;
      const add = (bytes: Uint8Array, accessor: Accessor) => {
        const bufferIndex = buffers.push({ arrayBuffer: bytes.buffer as ArrayBuffer, byteOffset: bytes.byteOffset, byteLength: bytes.byteLength }) - 1;
        json.buffers.push({ byteLength: bytes.byteLength });
        const view = json.bufferViews.push({ buffer: bufferIndex, byteOffset: 0, byteLength: bytes.byteLength }) - 1;
        return json.accessors.push({ ...accessor, bufferView: view, byteOffset: 0 }) - 1;
      };
      const attributes: Record<string, number> = { ...p.attributes };
      let indices = p.indices;
      if (sources.length) {
        for (const [name, accessorIndex] of Object.entries(p.attributes)) {
          const src = g.json.accessors[accessorIndex];
          const bytes = elementBytes(g, accessorIndex);
          if (!bytes) return p; // unreadable layout: leave this primitive untagged rather than mis-split it
          const size = bytes.length / src.count;
          const out = new Uint8Array(total * size);
          out.set(bytes);
          sources.forEach((v, i) => out.copyWithin((count + i) * size, v * size, (v + 1) * size));
          attributes[name] = add(out, { componentType: src.componentType, type: src.type, count: total, normalized: src.normalized, min: src.min, max: src.max });
        }
        indices = add(new Uint8Array(corners.buffer), { componentType: 5125, type: 'SCALAR', count: corners.length });
      }
      attributes._FLOW_BUILDING = add(new Uint8Array(tag.buffer), { componentType: 5126, type: 'SCALAR', count: total });
      return indices === undefined ? { ...p, attributes } : { ...p, attributes, indices };
    }),
  }));
  const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0;
  return { gltf: { ...(loaded as object), json, buffers } as T, index, triangles, ms };
}

// --------------------------------------------------------------------------------------------
// Per-frame uniforms
// --------------------------------------------------------------------------------------------

export interface DamageUniforms {
  elapsed: number;
  /** 256 vec4: building index i -> slot, two 8-bit slots per float (even index in the high byte). */
  map: Float32Array;
  /** Per slot: (cut height m, scorch 0..1, lean east, lean north). Slot 0 unused. */
  slotA: Float32Array;
  /** Per slot: (kind 1 fire / 2 earthquake / 3 meteor + 0.9 * seed, window power 0..1, fire glow 0..1, shake). */
  slotB: Float32Array;
}

const KIND = { fire: 1, earthquake: 2, meteor: 3 } as const;
const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
/** A cut height meaning "standing": far above any building. */
export const NO_CUT = 1e4;

/**
 * Pack the damage frames of one campus into the shader's uniform arrays. Buildings the campus
 * wasn't tagged with are skipped (they belong to another campus). Pure: same inputs, same arrays.
 */
export function damageUniforms(frames: readonly BuildingDamageFrame[], index: ReadonlyMap<string, number>, clock: number | undefined): DamageUniforms & { slots: number; shared: number } {
  const map = new Float32Array(MAP_VEC4S * 4);
  const slotA = new Float32Array((MAX_DAMAGE_SLOTS + 1) * 4);
  const slotB = new Float32Array((MAX_DAMAGE_SLOTS + 1) * 4);
  const slotOf = new Uint8Array(MAX_TAGGED_BUILDINGS + 1);
  let slots = 0, shared = 0, elapsed = 0;
  // Most severe first, so if slots run out the mildest buildings share.
  const mine = frames.filter(f => index.has(f.id)).sort((a, b) => b.severity - a.severity || (a.id < b.id ? -1 : 1));
  for (const f of mine) {
    elapsed = clock === undefined ? 1e6 : clock - f.onset;
    const i = index.get(f.id)!;
    if (slots >= MAX_DAMAGE_SLOTS) {
      // Share the slot of the most similar already-placed building of the same kind.
      let best = 1, bestD = Infinity;
      for (const g of mine.slice(0, MAX_DAMAGE_SLOTS)) {
        const d = Math.abs(g.severity - f.severity) + (g.kind === f.kind ? 0 : 10);
        if (d < bestD) { bestD = d; best = slotOf[index.get(g.id)!]; }
      }
      slotOf[i] = best; shared++;
      continue;
    }
    const s = ++slots;
    slotOf[i] = s;
    const standing = f.collapse <= 1e-3;
    slotA.set([standing ? NO_CUT : f.remainingHeight, f.scorch, Math.cos(f.leanDirection) * f.lean, Math.sin(f.leanDirection) * f.lean], s * 4);
    const t = f.timing;
    // Windows: power fails as the building is damaged; a fire shows in its windows while it burns
    // (until the partial collapse is complete) and then they go dark.
    const power = f.kind === 'fire' ? 1 - smooth(0, t.scorchEnd * 0.5, elapsed) : 1 - Math.min(1, f.severity * 1.5) * f.progress;
    const glow = f.kind === 'fire' ? smooth(0, 90, elapsed) * (1 - 0.85 * smooth(t.collapseEnd, t.collapseEnd + 900, elapsed)) : 0;
    const shake = f.kind === 'earthquake' ? 0.012 * f.severity * (1 - smooth(t.collapseEnd - 10, t.collapseEnd + 5, elapsed)) : 0;
    slotB.set([KIND[f.kind] + 0.9 * f.seed, power, glow, shake], s * 4);
  }
  for (let i = 1; i <= MAX_TAGGED_BUILDINGS; i++) {
    if (!slotOf[i]) continue;
    const e = i >> 1, hi = (i & 1) === 0;
    map[e] += hi ? slotOf[i] * 256 : slotOf[i];
  }
  return { elapsed, map, slotA, slotB, slots, shared };
}

// --------------------------------------------------------------------------------------------
// Shaders (WebGL2 / GLSL ES 3.00)
// --------------------------------------------------------------------------------------------

const DAMAGE_UNIFORMS = `\
uniform buildingDamageUniforms {
  float elapsed;
  vec4 map[${MAP_VEC4S}];
  vec4 slotA[${MAX_DAMAGE_SLOTS + 1}];
  vec4 slotB[${MAX_DAMAGE_SLOTS + 1}];
} buildingDamage;
`;

/** luma.gl shader module; `uniformTypes` order matches the GLSL block (std140). */
export const buildingDamageModule = {
  name: 'buildingDamage',
  vs: DAMAGE_UNIFORMS,
  fs: DAMAGE_UNIFORMS,
  uniformTypes: {
    elapsed: 'f32',
    map: ['vec4<f32>', MAP_VEC4S],
    slotA: ['vec4<f32>', MAX_DAMAGE_SLOTS + 1],
    slotB: ['vec4<f32>', MAX_DAMAGE_SLOTS + 1],
  },
  defaultUniforms: {
    elapsed: 0,
    map: new Float32Array(MAP_VEC4S * 4),
    slotA: new Float32Array((MAX_DAMAGE_SLOTS + 1) * 4),
    slotB: new Float32Array((MAX_DAMAGE_SLOTS + 1) * 4),
  },
} as const;

export const DAMAGE_VS_DECL = `
in float _FLOW_BUILDING;
flat out vec4 flowDamageA;
flat out vec4 flowDamageB;
out float flowDamageY;
out float flowDamageCut;
`;
export const DAMAGE_FS_DECL = `
flat in vec4 flowDamageA;
flat in vec4 flowDamageB;
in float flowDamageY;
in float flowDamageCut;
`;

/**
 * vs:DECKGL_FILTER_SIZE. `size` is the vertex offset from the campus origin after the model's
 * rotation (x east, y north, z up), in common units (metres when composeModelMatrix is on). One
 * uniform-array lookup per vertex; undamaged buildings exit after it.
 */
export const DAMAGE_VS = `
  {
    flowDamageA = vec4(${NO_CUT.toFixed(1)}, 0.0, 0.0, 0.0);
    flowDamageB = vec4(0.0);
    flowDamageY = 0.0;
    flowDamageCut = ${NO_CUT.toFixed(1)};
    int building = int(_FLOW_BUILDING + 0.5);
    float packed = building > 0 ? buildingDamage.map[building >> 3][(building >> 1) & 3] : 0.0;
    int slot = (building & 1) == 0 ? int(floor(packed / 256.0)) : int(mod(packed, 256.0));
    if (slot > 0) {
      vec4 a = buildingDamage.slotA[slot];
      vec4 b = buildingDamage.slotB[slot];
      vec3 unit = scenegraph.composeModelMatrix > 0.5 ? vec3(1.0) : project_size(vec3(1.0));
      vec3 m = size / unit;
      float y = max(m.z, 0.0);
      float seed = fract(b.x);
      // Broken, uneven top: the cut wanders by up to ~8% of the remaining height (+0.6 m) per 2.5 m cell.
      float jag = fract(sin(dot(floor(m.xy * 0.4), vec2(12.9898, 78.233)) + seed * 43.0) * 43758.5453);
      float cut = a.x < ${(NO_CUT / 2).toFixed(1)} ? a.x + jag * (0.08 * a.x + 0.6) : a.x;
      flowDamageA = a; flowDamageB = b; flowDamageY = y; flowDamageCut = cut;
      // Everything above the cut is crushed onto it (floors pancaking), so roofs and upper storeys
      // come down instead of floating; a full collapse leaves a low, ragged slab.
      if (y > cut) m.z = cut + (y - cut) * 0.04;
      // Lean (shear with height) plus earthquake shaking, both scaled by the standing height.
      float sway = b.w * sin(buildingDamage.elapsed * 11.0 + seed * 6.2832);
      m.xy += (a.zw + vec2(sway, 0.6 * sway)) * min(y, cut);
      size = m * unit;
    }
  }
`;

/** fs:DECKGL_FILTER_COLOR for the building meshes: soot and dust with height streaks, fire embers. */
export const DAMAGE_FS = `
  if (flowDamageB.x > 0.5) {
    float kind = floor(flowDamageB.x);
    float streak = 0.75 + 0.25 * sin(flowDamageY * 1.7 + fract(flowDamageB.x) * 20.0);
    vec3 soot = kind < 1.5 ? vec3(0.045, 0.04, 0.035) : kind < 2.5 ? vec3(0.42, 0.39, 0.35) : vec3(0.08, 0.06, 0.05);
    color.rgb = mix(color.rgb, soot * (color.r + color.g + color.b + 0.3), clamp(flowDamageA.y * streak, 0.0, 0.9));
    if (flowDamageB.z > 0.01) {
      float flicker = 0.65 + 0.35 * sin(buildingDamage.elapsed * 7.0 + flowDamageY * 0.9);
      float low = 1.0 - smoothstep(0.0, max(flowDamageCut, 1.0), flowDamageY) * 0.6;
      color.rgb += vec3(0.9, 0.28, 0.04) * flowDamageB.z * 0.22 * flicker * low;
    }
  }
`;

/** Window-filter fragment: runs after the schedule computes `k`. Crushed windows vanish; power
 *  failure dims them; burning buildings glow orange whatever their schedule says. */
export const DAMAGE_WINDOW_FS = `
    float flowGlow = 0.0;
    if (flowDamageB.x > 0.5) {
      if (flowDamageY > flowDamageCut - 0.4) discard;
      k *= flowDamageB.y;
      flowGlow = flowDamageB.z * (0.6 + 0.4 * sin(buildingDamage.elapsed * 9.0 + flowDamageY * 1.3 + fract(flowDamageB.x) * 30.0));
    }
`;
