// Turns the shared PrimitiveSpec recipes in sim/personaParts.ts into real luma.gl Geometry --
// composing box/cylinder/cone/sphere primitives (luma.gl's own, not hand-rolled vertex math) into
// one merged mesh per part layer. See web/src/lib/personaMeshes.ts for the Three.js twin of this
// file; both read the exact same PrimitiveSpec data, so a part can never look different on the
// phone than it does on the map.
import { CubeGeometry, ConeGeometry, CylinderGeometry, SphereGeometry, Geometry } from '@luma.gl/engine';
import type { GeometryAttribute } from '@luma.gl/engine';
import type { PartLayer, PrimitiveSpec } from '../sim/personaParts';

function rotatePoint(x: number, y: number, z: number, rxDeg: number, ryDeg: number, rzDeg: number): [number, number, number] {
  const rx = (rxDeg * Math.PI) / 180, ry = (ryDeg * Math.PI) / 180, rz = (rzDeg * Math.PI) / 180;
  // X
  let y1 = y * Math.cos(rx) - z * Math.sin(rx);
  let z1 = y * Math.sin(rx) + z * Math.cos(rx);
  let x1 = x;
  // Y
  let x2 = x1 * Math.cos(ry) + z1 * Math.sin(ry);
  let z2 = -x1 * Math.sin(ry) + z1 * Math.cos(ry);
  let y2 = y1;
  // Z
  const x3 = x2 * Math.cos(rz) - y2 * Math.sin(rz);
  const y3 = x2 * Math.sin(rz) + y2 * Math.cos(rz);
  const z3 = z2;
  return [x3, y3, z3];
}

function primitiveGeometry(spec: PrimitiveSpec): Geometry {
  let geom: Geometry;
  switch (spec.kind) {
    case 'box': {
      geom = new CubeGeometry({ indices: true });
      const pos = geom.attributes.POSITION!.value as Float32Array;
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] *= spec.size[0] / 2;
        pos[i + 1] *= spec.size[1] / 2;
        pos[i + 2] *= spec.size[2] / 2;
      }
      break;
    }
    case 'cylinder':
      geom = new CylinderGeometry({ radius: spec.radius, height: spec.height, nradial: spec.segments ?? 8 });
      break;
    case 'cone':
      geom = new ConeGeometry({ topRadius: spec.radiusTop, bottomRadius: spec.radiusBottom, height: spec.height, nradial: spec.segments ?? 10 } as any);
      break;
    case 'sphere': {
      geom = new SphereGeometry({ radius: spec.radius, nlat: 8, nlong: 10 });
      if (spec.thetaStart !== undefined || spec.thetaLength !== undefined) {
        // SphereGeometry has no partial-sphere option; approximate a cap by keeping only vertices
        // within the requested latitude band and collapsing the rest toward the pole, which reads
        // fine at this small scale (a hair cap, never seen edge-on up close).
        const thetaStart = spec.thetaStart ?? 0;
        const thetaLength = spec.thetaLength ?? Math.PI;
        const pos = geom.attributes.POSITION!.value as Float32Array;
        for (let i = 0; i < pos.length; i += 3) {
          const y = pos[i + 1];
          const theta = Math.acos(Math.max(-1, Math.min(1, y / spec.radius)));
          if (theta < thetaStart || theta > thetaStart + thetaLength) {
            const scale = 0.001;
            pos[i] *= scale; pos[i + 1] = spec.radius * Math.cos(thetaStart < Math.PI / 2 ? thetaStart : thetaStart + thetaLength); pos[i + 2] *= scale;
          }
        }
      }
      break;
    }
  }
  // Translate + rotate in place (metres; indices/normals untouched by translate, rotated below).
  const pos = geom.attributes.POSITION!.value as Float32Array;
  const nrm = geom.attributes.NORMAL?.value as Float32Array | undefined;
  const [rx, ry, rz] = ('rotateDeg' in spec ? spec.rotateDeg : undefined) ?? [0, 0, 0];
  const rotating = rx !== 0 || ry !== 0 || rz !== 0;
  for (let i = 0; i < pos.length; i += 3) {
    let x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (rotating) [x, y, z] = rotatePoint(x, y, z, rx, ry, rz);
    pos[i] = x + spec.pos[0];
    pos[i + 1] = y + spec.pos[1];
    pos[i + 2] = z + spec.pos[2];
    if (nrm && rotating) {
      const [nx, ny, nz] = rotatePoint(nrm[i], nrm[i + 1], nrm[i + 2], rx, ry, rz);
      nrm[i] = nx; nrm[i + 1] = ny; nrm[i + 2] = nz;
    }
  }
  return geom;
}

function toIndexArray(geom: Geometry): Uint32Array {
  if (geom.indices?.value) return new Uint32Array(geom.indices.value as ArrayLike<number>);
  const count = geom.attributes.POSITION!.value.length / 3;
  const arr = new Uint32Array(count);
  for (let i = 0; i < count; i++) arr[i] = i;
  return arr;
}

/** Merges several primitive geometries (each already positioned) into one indexed triangle mesh. */
function mergePrimitives(specs: PrimitiveSpec[]): Geometry {
  const geoms = specs.map(primitiveGeometry);
  let vertexTotal = 0, indexTotal = 0;
  for (const g of geoms) {
    vertexTotal += g.attributes.POSITION!.value.length / 3;
    indexTotal += toIndexArray(g).length;
  }
  const positions = new Float32Array(vertexTotal * 3);
  const normals = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  let vOff = 0, iOff = 0;
  for (const g of geoms) {
    const pos = g.attributes.POSITION!.value as Float32Array;
    const nrm = g.attributes.NORMAL?.value as Float32Array | undefined;
    positions.set(pos, vOff * 3);
    if (nrm) normals.set(nrm, vOff * 3);
    const idx = toIndexArray(g);
    for (let i = 0; i < idx.length; i++) indices[iOff + i] = idx[i] + vOff;
    vOff += pos.length / 3;
    iOff += idx.length;
  }
  return new Geometry({
    topology: 'triangle-list',
    attributes: {
      POSITION: { size: 3, value: positions } as GeometryAttribute,
      NORMAL: { size: 3, value: normals } as GeometryAttribute,
    },
    indices: { value: indices } as GeometryAttribute,
  });
}

const meshCache = new Map<string, Geometry>();

/** One merged mesh per (category, optionId, layerIndex) -- built once, reused by every persona
 * wearing that option, so the draw-call count never grows with the number of personas on the map. */
export function meshForLayer(key: string, layer: PartLayer): Geometry {
  let mesh = meshCache.get(key);
  if (!mesh) {
    mesh = mergePrimitives(layer.primitives);
    meshCache.set(key, mesh);
  }
  return mesh;
}
