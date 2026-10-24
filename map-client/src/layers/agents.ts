// Walking students as Kenney Mini Characters, GPU-instanced with deck.gl's ScenegraphLayer.
//
// A ScenegraphLayer plays one animation clock for every instance it draws, so one layer
// would make the whole crowd step in perfect unison. We split each character model across
// PHASES layers whose walk cycles start at different offsets (and run at slightly different
// speeds); with 12 models x PHASES, no two neighbours visibly share a stride.
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import type { WalkingAgent } from '../sim/playback';

export const CHARACTER_MODELS = [
  'female-a', 'female-b', 'female-c', 'female-d', 'female-e', 'female-f',
  'male-a', 'male-b', 'male-c', 'male-d', 'male-e', 'male-f',
].map((name) => `/models/character-${name}.glb`);

const PHASES = 3;
const WALK_CYCLE_SECONDS = 0.667; // length of the Kenney 'walk' clip

// Kenney models face +Z in glTF space; after the 90° roll that stands them upright on the
// map, yaw = 0 points them east-ish. This offset turns a compass bearing into deck.gl yaw.
const YAW_OFFSET = 180;

export type LoadedModels = unknown[];

/** Fetch and parse every character once; each layer then builds its own GPU copy and clock. */
export function loadCharacterModels(): Promise<LoadedModels> {
  return Promise.all(CHARACTER_MODELS.map((url) => load(url, GLTFLoader)));
}

function phaseOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % PHASES;
}

// Metres per model unit for a real ~1.8 m person (the Kenney characters are ~0.78 units tall).
const REAL_SCALE = 2.3;

/** True size at street level; grows as the camera pulls back so people stay visible on the
 *  campus overview (sizeMinPixels then keeps them at least ~14 px tall). */
export function walkerScale(zoom: number) {
  return REAL_SCALE * Math.min(8, Math.max(1, 2 ** (18.6 - zoom)));
}

export interface AgentLayerOptions {
  zoom: number;
  highlightId?: string | null;
}

export function agentLayers(walking: WalkingAgent[], models: LoadedModels, time: number, options: AgentLayerOptions) {
  const { zoom, highlightId = null } = options;
  const sizeScale = walkerScale(zoom);
  const buckets = new Map<string, WalkingAgent[]>();
  for (const agent of walking) {
    const key = `${agent.model % models.length}-${phaseOf(agent.id)}`;
    const list = buckets.get(key) ?? [];
    list.push(agent);
    buckets.set(key, list);
  }

  const layers = [];
  for (let model = 0; model < models.length; model++) {
    for (let phase = 0; phase < PHASES; phase++) {
      const key = `${model}-${phase}`;
      layers.push(
        new ScenegraphLayer<WalkingAgent>({
          id: `agents-${key}`,
          data: buckets.get(key) ?? [],
          scenegraph: models[model] as never,
          // Layers persist across frames, so these stay referentially stable and the clock
          // is only configured once per layer.
          _animations: ANIMATIONS[phase],
          _lighting: 'pbr',
          sizeScale,
          sizeMinPixels: 22,
          getPosition: (d) => d.position,
          getOrientation: (d) => [0, YAW_OFFSET - d.bearing, 90],
          getColor: (d) => (d.id === highlightId ? [255, 214, 10, 255] : [255, 255, 255, 255]),
          updateTriggers: { getColor: highlightId, getPosition: time, getOrientation: time },
          pickable: true,
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
      );
    }
  }
  return layers;
}

const ANIMATIONS = Array.from({ length: PHASES }, (_, phase) => ({
  '*': { playing: false },
  walk: {
    playing: true,
    startTime: (phase / PHASES) * WALK_CYCLE_SECONDS,
    speed: 1.15 + phase * 0.07,
  },
}));
