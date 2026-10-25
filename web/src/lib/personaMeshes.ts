// Turns the shared PrimitiveSpec recipes in @map/sim/personaParts into real Three.js geometry --
// the phone-side twin of map-client/src/layers/personaMeshes.ts. Both read the exact same
// PrimitiveSpec data (imported straight from map-client via the `@map/*` Vite alias already used
// by web/src/map-entry.ts), so a part can never look different on the phone than it does on the map.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { PartLayer, PrimitiveSpec } from '@map/sim/personaParts';

function primitiveGeometry(spec: PrimitiveSpec): THREE.BufferGeometry {
  let geom: THREE.BufferGeometry;
  switch (spec.kind) {
    case 'box':
      geom = new THREE.BoxGeometry(...spec.size);
      break;
    case 'cylinder':
      geom = new THREE.CylinderGeometry(spec.radius, spec.radius, spec.height, spec.segments ?? 8);
      break;
    case 'cone':
      geom = new THREE.CylinderGeometry(spec.radiusTop, spec.radiusBottom, spec.height, spec.segments ?? 10);
      break;
    case 'sphere':
      geom = new THREE.SphereGeometry(spec.radius, 12, 10, 0, Math.PI * 2, spec.thetaStart ?? 0, spec.thetaLength ?? Math.PI);
      break;
  }
  const [rx, ry, rz] = ('rotateDeg' in spec ? spec.rotateDeg : undefined) ?? [0, 0, 0];
  if (rx) geom.rotateX((rx * Math.PI) / 180);
  if (ry) geom.rotateY((ry * Math.PI) / 180);
  if (rz) geom.rotateZ((rz * Math.PI) / 180);
  geom.translate(spec.pos[0], spec.pos[1], spec.pos[2]);
  return geom;
}

const meshCache = new Map<string, THREE.BufferGeometry>();

/** One merged geometry per (category, optionId, layerIndex) -- built once and reused, same
 * discipline as the map-client mesh cache, though here it's about avoiding repeated geometry
 * construction across re-renders rather than instancing across many agents. */
export function geometryForLayer(key: string, layer: PartLayer): THREE.BufferGeometry {
  let geom = meshCache.get(key);
  if (!geom) {
    const parts = layer.primitives.map(primitiveGeometry);
    geom = parts.length === 1 ? parts[0] : mergeGeometries(parts, false);
    meshCache.set(key, geom);
  }
  return geom;
}

/** Builds the full set of Three.js Meshes for a resolved layer list (see @map/sim/personaParts's
 * resolveLayers), ready to add to a THREE.Group. Each layer gets its own mesh and material since
 * each layer carries its own flat color -- cheap at this scale (one assembled character, or one
 * single-part thumbnail; never hundreds like the map). */
export function buildPersonaGroup(resolved: { category: string; optionId: string; layerIndex: number; layer: PartLayer }[]): THREE.Group {
  const group = new THREE.Group();
  for (const { category, optionId, layerIndex, layer } of resolved) {
    if (!layer.primitives.length) continue;
    const key = `${category}:${optionId}:${layerIndex}`;
    const geom = geometryForLayer(key, layer);
    const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(layer.color[0] / 255, layer.color[1] / 255, layer.color[2] / 255), roughness: 0.55, metalness: 0.05 });
    group.add(new THREE.Mesh(geom, material));
  }
  return group;
}
