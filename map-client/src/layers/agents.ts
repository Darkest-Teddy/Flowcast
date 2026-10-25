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
import { addPanicClip, PANIC_CLIP, PANIC_CYCLE_SECONDS } from './gltf-panic';

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
 *  Body and head are merged into one primitive (one draw per layer instead of two), and the
 *  `panic` clip Kenney has no equivalent of is appended (layers/gltf-panic.ts). */
export function loadCharacterModels(): Promise<LoadedModels> {
  return Promise.all(CHARACTER_MODELS.map((url) => load(url, GLTFLoader).then(mergeSkinnedMeshes).then(addPanicClip)));
}

const phaseCache = new Map<string, number>();
/** phaseOf for the default phase count, computed once per id (it runs for every walker every frame). */
function cachedPhase(id: string, phases: number): number {
  if (phases !== PHASES) return phaseOf(id, phases);
  let phase = phaseCache.get(id);
  if (phase === undefined) phaseCache.set(id, (phase = phaseOf(id, phases)));
  return phase;
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
  runningIds?: ReadonlySet<string>;
}

/** Clips for walking, standing, fleeing, and standing in fright (gltf-panic.ts). */
export type CharacterClip = 'walk' | 'idle' | 'sprint' | 'panic';

export interface CharacterLayerOptions extends AgentLayerOptions {
  /** Layer id prefix; one layer per model and phase, `${id}-${model}-${phase}`. */
  id: string;
  clip?: CharacterClip;
  pickable?: boolean;
  /** Kept for callers; empty model/phase layers are now never drawn. */
  hideEmpty?: boolean;
}

const NOBODY: WalkingAgent[] = [];

/** A character that is drawn but never picked (no hover, no tooltip), even inside a pickable layer:
 *  people sitting by the river share the idle layers of riders waiting at stops. */
export type Character = WalkingAgent & { unpickable?: true };

/**
 * ScenegraphLayer whose `unpickable` instances are left out of the picking pass (collapsed outside
 * the clip volume there, drawn as usual otherwise): they neither answer a pick nor hide what's
 * behind them, exactly as if drawn in a layer of their own with `pickable: false`, but without that
 * layer's extra draws. (deck picks ScenegraphLayer instances by gl_InstanceID, with no per-instance
 * picking colours to clear.)
 */
class CharacterLayer extends ScenegraphLayer<Character, { getUnpickable?: (d: Character) => number }> {
  static layerName = 'CharacterLayer';
  static defaultProps = {
    ...ScenegraphLayer.defaultProps,
    getUnpickable: { type: 'accessor', value: (d: Character) => (d.unpickable ? 1 : 0) },
  } as typeof ScenegraphLayer.defaultProps;

  initializeState() {
    super.initializeState();
    this.getAttributeManager()!.addInstanced({ instanceUnpickable: { size: 1, accessor: 'getUnpickable' } });
  }

  getShaders() {
    const shaders = super.getShaders();
    const inject = shaders.inject ?? {};
    return {
      ...shaders,
      inject: {
        ...inject,
        'vs:#decl': `${inject['vs:#decl'] ?? ''}\nin float instanceUnpickable;\n`,
        'vs:DECKGL_FILTER_GL_POSITION': `${inject['vs:DECKGL_FILTER_GL_POSITION'] ?? ''}
  if (picking.isActive > 0.5 && instanceUnpickable > 0.5) position = vec4(0.0, 0.0, 2.0, 1.0);
`,
      },
    };
  }
}

function* positionsOf(agents: WalkingAgent[]) {
  for (const a of agents) yield a.position;
}

/** Characters bucketed by model and animation phase into GPU-instanced layers, all playing one clip. */
export function characterLayers(items: Character[], models: LoadedModels, time: number, options: CharacterLayerOptions) {
  const { zoom, highlightId = null, id, clip = 'walk', pickable = true } = options;
  // Idle: one layer per model (each model sways at its own offset), since every extra layer is
  // another render pass in interleaved mode.
  const phases = clip === 'walk' ? PHASES : 1;
  // From the overview, one walk layer per model (each model keeps its own stride offset and
  // cadence, so the crowd still doesn't march in step): 12 draws instead of 36. The other phase
  // layers stay in the list, empty and hidden, so zooming back in re-uploads nothing.
  const usedPhases = clip === 'walk' && zoom < PHASED_FROM_ZOOM ? 1 : phases;
  const animationFor = (model: number, phase: number) => (clip === 'walk' ? WALK_ANIMATIONS[model % WALK_ANIMATIONS.length][phase]
    : clip === 'sprint' ? SPRINT_ANIMATIONS[model % SPRINT_ANIMATIONS.length]
    : clip === 'panic' ? PANIC_ANIMATIONS[model % PANIC_ANIMATIONS.length] : IDLE_ANIMATIONS[model % IDLE_ANIMATIONS.length]);
  const sizeScale = walkerScale(zoom);
  // Bucket index model * phases + phase (the phase is a hash of the id, remembered per id).
  const buckets: Character[][] = [];
  for (const agent of items) {
    const key = (agent.model % models.length) * phases + (usedPhases > 1 ? cachedPhase(agent.id, phases) : 0);
    (buckets[key] ??= []).push(agent);
  }

  const layers = [];
  for (let model = 0; model < models.length; model++) {
    for (let phase = 0; phase < phases; phase++) {
      const key = `${model}-${phase}`;
      const layerId = `${id}-${key}`;
      // Same people as last frame: same array, so only positions (and headings, when one turns)
      // are re-uploaded instead of every attribute of the model.
      const data = stableList(layerId, buckets[model * phases + phase] ?? NOBODY, (a) => a.id);
      // Off-screen buckets skip their draws. A character is under a model unit wide and tall, so
      // sizeScale metres all round is ample (culling.ts adds a screen margin for sizeMinPixels).
      setCullBox(layerId, boxAround(positionsOf(data), sizeScale, sizeScale));
      layers.push(
        new CharacterLayer({
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

/** Everyone whose id is in `ids`, then everyone else; each list keeps its order. One clip plays
 *  per layer, so a crowd doing two things has to be split before it is drawn. */
export function splitOut<T extends { id: string }>(people: T[], ids: ReadonlySet<string>): [T[], T[]] {
  const inside: T[] = [], outside: T[] = [];
  for (const person of people) (ids.has(person.id) ? inside : outside).push(person);
  return [inside, outside];
}

export function agentLayers(walking: WalkingAgent[], models: LoadedModels, time: number, options: AgentLayerOptions) {
  if (options.runningIds?.size) {
    const [runners, others] = splitOut(walking, options.runningIds);
    return [...characterLayers(others, models, time, { ...options, id: 'agents', clip: 'walk' }),
      ...characterLayers(runners, models, time, { ...options, id: 'agents-running', clip: 'sprint' })];
  }
  return characterLayers(walking, models, time, { ...options, id: 'agents', clip: 'walk' });
}

const SPRINT_ANIMATIONS = CHARACTER_MODELS.map((_, model) => ({
  '*': { playing: false },
  sprint: { playing: true, startTime: model * 0.047, speed: 1 + (model % 4) * 0.06 },
}));

// Frightened and rooted to the spot (layers/gltf-panic.ts). Offset and paced per character model,
// like the other clips, so a crowd outside a fire doesn't flail in unison.
const PANIC_ANIMATIONS = CHARACTER_MODELS.map((_, model) => ({
  '*': { playing: false },
  [PANIC_CLIP]: {
    playing: true,
    startTime: (((model * 7) % CHARACTER_MODELS.length) / CHARACTER_MODELS.length) * PANIC_CYCLE_SECONDS,
    speed: 0.95 + (model % 5) * 0.07,
  },
}));

// Per model and phase: phases a third of a stride apart, and each model offset and paced a little
// differently, so even with one layer per model (the overview) neighbours don't share a stride.
const PHASED_FROM_ZOOM = 16;
const WALK_ANIMATIONS = CHARACTER_MODELS.map((_, model) =>
  Array.from({ length: PHASES }, (_, phase) => ({
    '*': { playing: false },
    walk: {
      playing: true,
      startTime: ((((model * 5) % CHARACTER_MODELS.length) / CHARACTER_MODELS.length + phase / PHASES) % 1) * WALK_CYCLE_SECONDS,
      speed: 1.15 + phase * 0.07 + (model % 4) * 0.025,
    },
  })),
);

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
