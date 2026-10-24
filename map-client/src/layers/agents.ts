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
import { boxAround, setCullBox } from './culling';
import { headingsKey, stableList } from './stable';
import { mergeSkinnedMeshes } from './gltf-merge';

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

/** Fetch and parse every character once; each layer then builds its own GPU copy and clock.
 *  Body and head are merged into one primitive (one draw per layer instead of two). */
export function loadCharacterModels(): Promise<LoadedModels> {
  return Promise.all(CHARACTER_MODELS.map((url) => load(url, GLTFLoader).then(mergeSkinnedMeshes)));
}

export function phaseOf(id: string, phases = PHASES): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % phases;
}

// Metres per model unit for a real ~1.8 m person (the Kenney characters are ~0.78 units tall).
const REAL_SCALE = 2.3;

/** True size at street level; grows as the camera pulls back so people stay visible on the
 *  campus overview (sizeMinPixels then keeps them at least ~17 px tall). */
export function walkerScale(zoom: number) {
  return REAL_SCALE * Math.min(8, Math.max(1, 2 ** (18.6 - zoom)));
}

export interface AgentLayerOptions {
  zoom: number;
  highlightId?: string | null;
}

/** Which Kenney clip a set of characters plays: 'walk' for walkers, 'idle' for people standing about. */
export type CharacterClip = 'walk' | 'idle';

export interface CharacterLayerOptions extends AgentLayerOptions {
  /** Layer id prefix; one layer per model and phase, `${id}-${model}-${phase}`. */
  id: string;
  clip?: CharacterClip;
  pickable?: boolean;
  /** Kept for callers; empty model/phase layers are now never drawn. */
  hideEmpty?: boolean;
}

const NOBODY: WalkingAgent[] = [];

function* positionsOf(agents: WalkingAgent[]) {
  for (const a of agents) yield a.position;
}

/** Characters bucketed by model and animation phase into GPU-instanced layers, all playing one clip. */
export function characterLayers(items: WalkingAgent[], models: LoadedModels, time: number, options: CharacterLayerOptions) {
  const { zoom, highlightId = null, id, clip = 'walk', pickable = true } = options;
  // Idle: one layer per model (each model sways at its own offset), since every extra layer is
  // another render pass in interleaved mode.
  const phases = clip === 'walk' ? PHASES : 1;
  const animationFor = (model: number, phase: number) => (clip === 'walk' ? ANIMATIONS[phase] : IDLE_ANIMATIONS[model % IDLE_ANIMATIONS.length]);
  const sizeScale = walkerScale(zoom);
  const buckets = new Map<string, WalkingAgent[]>();
  for (const agent of items) {
    const key = `${agent.model % models.length}-${phaseOf(agent.id, phases)}`;
    const list = buckets.get(key) ?? [];
    list.push(agent);
    buckets.set(key, list);
  }

  const layers = [];
  for (let model = 0; model < models.length; model++) {
    for (let phase = 0; phase < phases; phase++) {
      const key = `${model}-${phase}`;
      const layerId = `${id}-${key}`;
      // Same people as last frame: same array, so only positions (and headings, when one turns)
      // are re-uploaded instead of every attribute of the model.
      const data = stableList(layerId, buckets.get(key) ?? NOBODY, (a) => a.id);
      // Off-screen buckets skip their draws. A character is under a model unit wide and tall, so
      // sizeScale metres all round is ample (culling.ts adds a screen margin for sizeMinPixels).
      setCullBox(layerId, boxAround(positionsOf(data), sizeScale, sizeScale));
      layers.push(
        new ScenegraphLayer<WalkingAgent>({
          id: layerId,
          data,
          scenegraph: models[model] as never,
          // Layers persist across frames, so these stay referentially stable and the clock
          // is only configured once per layer.
          _animations: animationFor(model, phase),
          _lighting: 'pbr',
          sizeScale,
          sizeMinPixels: 22,
          getPosition: (d) => d.position,
          getOrientation: (d) => [0, YAW_OFFSET - d.bearing, 90],
          getColor: (d) => (d.id === highlightId ? [255, 214, 10, 255] : [255, 255, 255, 255]),
          updateTriggers: { getColor: highlightId, getPosition: time, getOrientation: headingsKey(data, (a) => a.bearing) },
          pickable,
          // An empty layer still costs a full model draw a frame, so it is never drawn (it stays in
          // the list either way, so its GPU copy of the model and its animation clock persist).
          visible: data.length > 0,
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
      );
    }
  }
  return layers;
}

export function agentLayers(walking: WalkingAgent[], models: LoadedModels, time: number, options: AgentLayerOptions) {
  return characterLayers(walking, models, time, { ...options, id: 'agents', clip: 'walk' });
}

const ANIMATIONS = Array.from({ length: PHASES }, (_, phase) => ({
  '*': { playing: false },
  walk: {
    playing: true,
    startTime: (phase / PHASES) * WALK_CYCLE_SECONDS,
    speed: 1.15 + phase * 0.07,
  },
}));

// Standing about: Kenney's 'idle' clip (a slow sway), offset per character model so a waiting
// crowd of mixed characters doesn't sway in step.
const IDLE_CYCLE_SECONDS = 1.333;
const IDLE_ANIMATIONS = CHARACTER_MODELS.map((_, model) => ({
  '*': { playing: false },
  idle: {
    playing: true,
    startTime: (((model * 5) % CHARACTER_MODELS.length) / CHARACTER_MODELS.length) * IDLE_CYCLE_SECONDS,
    speed: 0.85 + (model % 4) * 0.08,
  },
}));
