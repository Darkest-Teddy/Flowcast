// Boston Fire Department apparatus answering a fire alarm (sim/fireResponse.ts plans them).
//
// Performance: no layers at all unless a response is under way; then one ScenegraphLayer per
// apparatus model that's on the map (engine, ladder, chief: each model is one batched draw) and
// one halo layer for the strobes. Data arrays stay the same between frames (layers/stable.ts),
// so deck.gl only re-uploads positions while trucks move. The strobes flash in the vertex
// shader: each lens's material puts it in a flash group, and a per-truck bitmask in the instance
// colour's alpha (a tiny attribute) says which groups are lit, so flashing never touches geometry.
import { LayerExtension, type Layer } from '@deck.gl/core';
import { ScatterplotLayer } from '@deck.gl/layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import { MaterialScenegraphLayer } from './material-scenegraph';
import { mergeMaterialPrimitives } from './gltf-materials';
import { boxAround, setCullBox } from './culling';
import { stableList } from './stable';
import { apparatusAt, apparatusLabel, strobeMask, type ApparatusKind, type ApparatusState, type FireResponse } from '../sim/fireResponse';

const MODEL_URLS: Record<ApparatusKind, string> = {
  engine: '/models/bfd-engine.glb',
  ladder: '/models/bfd-ladder.glb',
  chief: '/models/bfd-chief.glb',
};
export type FireModels = Partial<Record<ApparatusKind, unknown>>;

export async function loadFireModels(): Promise<FireModels> {
  const entries = await Promise.all((Object.entries(MODEL_URLS) as [ApparatusKind, string][]).map(async ([kind, url]) => {
    const model = await load(url, GLTFLoader).then((m) => mergeMaterialPrimitives(m, { materialAttributes: true })).catch(() => undefined);
    return [kind, model] as const;
  }));
  return Object.fromEntries(entries);
}

// Lit strobes glow at 4x their lens colour, readable in daylight; unlit lenses stay dark.
const STROBE_VS = `
#ifdef HAS_COLORS
{
  float flashCode = (_FLOW_EMISSIVE.r + _FLOW_EMISSIVE.g) < 0.001 ? floor(_FLOW_EMISSIVE.b * 4.0 + 0.5) : 0.0;
  int flashMask = int(instanceColors.a * 255.0 + 0.5);
  if (flashCode > 0.5) {
    bool lit = ((flashMask >> (int(flashCode) - 1)) & 1) == 1;
    flowEmissive = lit ? colors.rgb * 4.0 : colors.rgb * 0.06;
  }
  vColor.a = colors.a;
}
#endif`;

/** MaterialScenegraphLayer whose strobe lenses follow the instance's flash bitmask (alpha byte). */
class ApparatusLayer<DataT> extends MaterialScenegraphLayer<DataT> {
  static layerName = 'ApparatusLayer';
  getShaders() {
    const shaders = super.getShaders();
    // Needs the batched per-vertex emissive (gltf-materials.ts); an unbatched model just stays unlit.
    if (this.props.scenegraph?.flowMaterialAttributes !== true) return shaders;
    return { ...shaders, inject: { ...shaders.inject, 'vs:#main-end': `${shaders.inject['vs:#main-end']}\n${STROBE_VS}` } };
  }
}

/** Soft radial falloff for the strobe halos (no offscreen pass, so it works interleaved). */
class RadialFade extends LayerExtension {
  static extensionName = 'RadialFade';
  getShaders(this: Layer) {
    return { inject: { 'fs:DECKGL_FILTER_COLOR': 'color.a *= pow(max(0.0, 1.0 - length(geometry.uv)), 1.7);' } };
  }
}
const radialFade = new RadialFade();

// Same growth as the buses in transit.ts: true size at street level, larger on the overview.
const apparatusScale = (zoom: number) => Math.min(6, Math.max(1, 2 ** (18.4 - zoom)));
const MODEL_YAW_OFFSET = 180;
const HALF_LENGTH: Record<ApparatusKind, number> = { engine: 5.4, ladder: 6.7, chief: 2.7 };
// Light bar position in model space (metres ahead of centre, height).
const LIGHTBAR: Record<ApparatusKind, [number, number]> = { engine: [4.65, 3.1], ladder: [5.95, 3.05], chief: [0.16, 1.95] };

export interface FireTruckState extends ApparatusState { mask: number; apparatus: true; targetName: string }
interface Halo { id: string; position: [number, number, number]; color: [number, number, number, number] }

// Per response: one reused state per apparatus and two halos (left/right of the light bar).
const states = new WeakMap<FireResponse, { trucks: FireTruckState[]; halos: Halo[] }>();

const RED: [number, number, number] = [255, 36, 36], WHITE: [number, number, number] = [255, 246, 236];
const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Metres from `center` ([lng, lat]) to the nearest apparatus running lights-and-siren in the last drawn frame; null if none. */
export function nearestResponding(response: FireResponse | null, center: readonly number[]): number | null {
  const cache = response && states.get(response);
  if (!cache) return null;
  let best: number | null = null;
  const mPerLng = 111_320 * Math.cos((center[1] * Math.PI) / 180);
  for (const truck of cache.trucks) {
    if (truck.phase !== 'responding') continue;
    const d = Math.hypot((truck.position[0] - center[0]) * mPerLng, (truck.position[1] - center[1]) * 110_540);
    if (best === null || d < best) best = d;
  }
  return best;
}

export function fireLayers(response: FireResponse | null, { time, now, zoom, night, models }: { time: number; now: number; zoom: number; night: boolean; models: FireModels }) {
  if (!response || time < response.from || time >= response.until) return [];
  let cache = states.get(response);
  if (!cache) {
    cache = {
      trucks: response.units.map((unit) => ({ ...apparatusAt(unit, response.from - 1), mask: 0, apparatus: true as const, targetName: response.targetName })),
      halos: response.units.flatMap((unit) => [0, 1].map((side) => ({ id: `${unit.id}-${side}`, position: [0, 0, 0] as [number, number, number], color: [0, 0, 0, 0] as [number, number, number, number] }))),
    };
    states.set(response, cache);
  }
  const scale = apparatusScale(zoom);
  const visible: FireTruckState[] = [];
  const halos: Halo[] = [];
  let masks = '';
  const wall = now / 1000;
  for (let i = 0; i < cache.trucks.length; i++) {
    const truck = cache.trucks[i];
    apparatusAt(truck.unit, time, truck);
    if (!truck.phase) continue;
    truck.mask = truck.lights ? strobeMask(wall + truck.unit.flashOffset, reducedMotion) : 0;
    masks += `${truck.mask},`;
    visible.push(truck);
    if (!truck.lights) continue;
    // Halos at each end of the light bar, alternating red and white like the lenses.
    const [ahead, height] = LIGHTBAR[truck.unit.kind];
    const b = (truck.bearing * Math.PI) / 180;
    const fx = Math.sin(b), fy = Math.cos(b); // forward (east, north)
    const mPerLng = 111_320 * Math.cos((truck.position[1] * Math.PI) / 180);
    for (let side = 0; side < 2; side++) {
      const halo = cache.halos[i * 2 + side];
      const lateral = (side === 0 ? -0.75 : 0.75) * scale; // 0: left, 1: right
      const ex = fx * ahead * scale + fy * lateral, ny = fy * ahead * scale - fx * lateral;
      halo.position[0] = truck.position[0] + ex / mPerLng;
      halo.position[1] = truck.position[1] + ny / 110_540;
      halo.position[2] = height * scale;
      // Left: red on A, white on B; right the other way round.
      const red = side === 0 ? truck.mask & 1 : truck.mask & 2;
      const white = side === 0 ? truck.mask & 2 : truck.mask & 1;
      const rgb = red ? RED : WHITE;
      halo.color[0] = rgb[0]; halo.color[1] = rgb[1]; halo.color[2] = rgb[2];
      halo.color[3] = red || white ? (night ? 200 : 150) : 0;
      halos.push(halo);
    }
  }
  if (!visible.length) return [];
  const layers: Layer[] = [];
  for (const kind of ['engine', 'ladder', 'chief'] as const) {
    const id = `fire-${kind}`;
    const data = stableList(id, visible.filter((t) => t.unit.kind === kind), (t) => t.unit.id);
    if (!data.length || !models[kind]) { setCullBox(id, null); continue; }
    setCullBox(id, boxAround(data.map((t) => t.position), HALF_LENGTH[kind] * scale + 5, 4 * scale + 5));
    layers.push(new ApparatusLayer<FireTruckState>({
      id,
      data,
      scenegraph: models[kind] as never,
      sizeScale: scale,
      _lighting: 'pbr',
      getPosition: (t) => t.position,
      getOrientation: (t) => [0, MODEL_YAW_OFFSET - t.bearing, 90],
      getColor: (t) => [255, 255, 255, t.mask],
      pickable: true,
      updateTriggers: { getPosition: [time, scale], getOrientation: time, getColor: masks },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }));
  }
  if (halos.length) {
    const data = stableList('fire-strobe-halos', halos, (h) => h.id);
    layers.push(new ScatterplotLayer<Halo>({
      id: 'fire-strobe-halos',
      data,
      getPosition: (h) => h.position,
      getRadius: 2.2 * scale,
      radiusUnits: 'meters',
      radiusMinPixels: 7,
      getFillColor: (h) => h.color,
      billboard: true,
      extensions: [radialFade],
      parameters: { depthWriteEnabled: false },
      updateTriggers: { getPosition: [time, scale], getFillColor: masks, getRadius: scale },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }));
  }
  return layers;
}

/** "BFD Ladder 15 · responding to Photonics Center" for a hovered apparatus; null otherwise. */
export function fireTooltip(object: unknown): string | null {
  if (!object || typeof object !== 'object' || !('apparatus' in object)) return null;
  const truck = object as FireTruckState;
  return apparatusLabel(truck, truck.targetName);
}
