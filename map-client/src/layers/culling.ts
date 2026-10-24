// Skip drawing layers whose contents are entirely outside the camera's view.
//
// deck.gl doesn't cull: a ScenegraphLayer pays one full draw (uniforms, bindings, GL state) per
// model primitive per frame even when its instances are kilometres off-screen, and that per-draw
// cost is most of this app's frame time. Layers that register a box here are tested against the
// view frustum in the overlay's `layerFilter`, using the exact viewport being drawn, so nothing
// that could be on screen is ever skipped. Layers without a box always draw.

import type { FilterContext } from '@deck.gl/core';

/** [minLng, minLat, minZ, maxLng, maxLat, maxZ], z in metres. */
export type CullBox = [number, number, number, number, number, number];

const boxes = new Map<string, CullBox>();

// Extra room around the view, as a fraction of its half-size (0.25 = an eighth of the screen on
// each side), for things drawn bigger than their box: characters and vehicles keep a minimum
// pixel size when the camera pulls back, and labels hang off their anchors.
const MARGIN = 0.25;

/** Give a layer a box to be culled by (null: always draw it). Call when building the layer. */
export function setCullBox(layerId: string, box: CullBox | null) {
  if (box) boxes.set(layerId, box);
  else boxes.delete(layerId);
}

/** Box around lng/lat points, `pad` metres out on every side and up to `height` metres. */
export function boxAround(points: Iterable<readonly number[]>, pad: number, height: number, base = 0): CullBox | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of points) {
    if (p[0] < w) w = p[0];
    if (p[0] > e) e = p[0];
    if (p[1] < s) s = p[1];
    if (p[1] > n) n = p[1];
  }
  if (w > e) return null;
  const dLat = pad / 110_540;
  const dLng = pad / (111_320 * Math.cos((((s + n) / 2) * Math.PI) / 180));
  return [w - dLng, s - dLat, base, e + dLng, n + dLat, base + height];
}

/** POSITION bounds of a parsed glTF (model space: metres, +y up), ignoring node transforms. */
export function gltfExtent(gltf: unknown): { min: number[]; max: number[] } | null {
  const json = (gltf as { json?: { meshes?: { primitives: { attributes: Record<string, number> }[] }[]; accessors?: { min?: number[]; max?: number[] }[] } })?.json;
  if (!json?.meshes || !json.accessors) return null;
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const mesh of json.meshes) {
    for (const prim of mesh.primitives) {
      const acc = json.accessors[prim.attributes.POSITION];
      if (!acc?.min || !acc.max) return null;
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(min[i], acc.min[i]);
        max[i] = Math.max(max[i], acc.max[i]);
      }
    }
  }
  return min[0] <= max[0] ? { min, max } : null;
}

// Invisible click targets (transparent fills that exist only to be picked): skipped when drawing
// the picture, drawn only in deck.gl's picking passes.
const PICK_ONLY = new Set(['crowd-buildings', 'place-hit-areas', 'place-hit-points']);

const corner = new Array(4);
/**
 * deck.gl `layerFilter`: false for pick-only layers outside picking, for layers with nothing to
 * draw, and when the layer's box is wholly outside the view frustum.
 */
export function cullLayers({ layer, viewport, isPicking }: FilterContext): boolean {
  if (!isPicking && PICK_ONLY.has(layer.id)) return false;
  // An empty layer still pays the full per-draw setup (uniforms, bindings, GL state).
  if (!layer.isComposite && layer.getNumInstances() === 0) return false;
  const box = boxes.get(layer.id);
  if (!box) return true;
  const m = viewport.viewProjectionMatrix;
  // A box is out of view if all 8 corners are beyond the same clip plane (homogeneous test,
  // so corners behind the camera are handled correctly).
  let outside = 0b111111;
  for (let i = 0; i < 8; i++) {
    const p = viewport.projectPosition([i & 1 ? box[3] : box[0], i & 2 ? box[4] : box[1], i & 4 ? box[5] : box[2]]);
    for (let r = 0; r < 4; r++) corner[r] = m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r];
    const [x, y, z, w] = corner as number[];
    const wm = w * (1 + MARGIN);
    let flags = 0;
    if (x < -wm) flags |= 1;
    if (x > wm) flags |= 2;
    if (y < -wm) flags |= 4;
    if (y > wm) flags |= 8;
    if (z < -w) flags |= 16;
    if (z > w) flags |= 32;
    outside &= flags;
    if (!outside) return true;
  }
  return false;
}
