// Detailed 3D models of BU's buildings.
//
// data-pipeline/make_building_models.py turns every BU footprint in OpenStreetMap into a
// procedurally detailed model (per-building facades from reference photos, cornices, mansards,
// fins, hand-tuned landmarks such as CDS, Marsh Chapel and Warren Towers) and merges each campus
// into ONE GLB, so the whole of BU costs three ScenegraphLayer instances and a handful of draw
// calls. A second GLB per campus holds every window that can light up after dark; each window
// carries its own on/off times (in TEXCOORD_0), and a clock uniform switches them in the shader,
// so lights come on through dusk, peak in the evening and go off through the small hours as the
// sim clock moves, at no per-frame CPU cost.
//
// Model frame: metres, +x east, +y up, +z south (glTF convention), relative to the campus origin.
// Every OSM id in the manifest (buildings, their building:part pieces and relation members) is
// left out of the app's city-buildings layer, so nothing is drawn underneath the models.
import { PolygonLayer } from '@deck.gl/layers';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import { mergeMaterialPrimitives } from './gltf-materials';
import { MaterialScenegraphLayer } from './material-scenegraph';
import { daylightAt } from '../map/daylight';
import { gltfExtent, setCullBox, type CullBox } from './culling';
import {
  buildingDamageModule, damageUniforms, tagBuildings, DAMAGE_FS, DAMAGE_FS_DECL, DAMAGE_VS, DAMAGE_VS_DECL, DAMAGE_WINDOW_FS,
  type DamageUniforms, type TaggedModel,
} from './buildingDamage';
import type { BuildingDamageFrame, DamageFootprint } from '../sim/disasterDamage';

export interface BuildingModelEntry {
  osm: string; // e.g. "way/277434241", the same ids as demo-day.json's buildings
  name: string | null;
  center: [number, number];
  height: number; // top of the model, metres
  landmark?: string;
  /** Set on building:part / relation-member ids listed only so the city layer excludes them. */
  partOf?: string;
  /** The model's massing, where it isn't one box up to `height`: CDS's stacked pieces, Warren's
   *  towers on their podium, CAS's tower, pitched roofs and masts above the walls. */
  volumes?: BuildingVolume[];
  /** Scenery: a building that isn't BU's, modelled so the streets around campus (Comm Ave out to
   *  1019, Kenmore Square, Fenway Park) aren't plain grey boxes. Never glows, never gets a tag or
   *  occupancy (modelRoofHeights / modelVolumes leave it out). */
  context?: boolean;
  /** Its shopfront, where the ground storey is shops: top of the shop storey (m; its sign band is
   *  the top 12/64 of it) and the wall carrying its canopy, if any. Read by make_signs.py. */
  storefront?: { top: number; canopy?: [[number, number], [number, number]] };
  /** [lng, lat] ring under which the base map's own 3D model of this landmark is hidden
   *  (Mapbox Standard's Fenway Park), so it doesn't overlap ours. */
  clip?: [number, number][];
  /** A landmark's floodlights (Fenway Park's light towers): drawn in the lit-window mesh; this
   *  is for the fields layer's glow and the lit field (fields.ts). */
  floodlights?: Floodlights;
}

export interface Floodlights {
  /** When they burn, hours on the lit-window schedules' 12..36 axis (see windowHour). */
  on: number;
  off: number;
  /** [lng, lat, metres up] of each lamp bank's centre. */
  lamps: [number, number, number][];
  /** [lng, lat] ring of the playing field they light. */
  field: [number, number][];
  /** [lng, lat] ring of the seating bowl round the field, lit with it (absent from older manifests). */
  stands?: [number, number][];
  /** The bowl's slope: its front edge (on the field) at `low` metres, its back edge at `high`, vertex by vertex. */
  bowl?: { front: [number, number][]; back: [number, number][]; low: number; high: number };
}

/** The base map's own 3D models that our landmark models replace (see `clip`), as closed rings. */
export function landmarkClips(manifest?: BuildingModelManifest | null): [number, number][][] {
  return manifest?.campuses.flatMap((c) => c.buildings.flatMap((b) => (b.clip?.length ? [[...b.clip, b.clip[0]]] : []))) ?? [];
}

/** One modelled volume: its OSM footprint ring and the heights its walls run between. */
export interface BuildingVolume {
  /** [lng, lat], open, counter-clockwise. */
  ring: [number, number][];
  /** Bottom of its walls, metres (0 on the ground; above it where a piece sits on another). */
  base: number;
  /** Top of its walls or parapet, metres (below a pitched roof, spire or rooftop crown). */
  top: number;
}

export interface CampusModel {
  id: string;
  name: string;
  origin: [number, number]; // [lng, lat] of the model's (0, 0, 0)
  model: string; // URL of the GLB
  /** Lit-window mesh with per-window schedules. */
  lights?: { scheduled?: string };
  buildings: BuildingModelEntry[];
}

export interface BuildingModelManifest {
  frame: string;
  campuses: CampusModel[];
}

/** Parsed GLBs, keyed by campus id (the lit-window mesh as `<id>:scheduled`). */
export type BuildingModels = Record<string, unknown>;

export async function loadBuildingManifest(url = '/data/building-models.json'): Promise<BuildingModelManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  return res.json();
}

/**
 * Fetch and parse campus GLBs (all, or just `only`), plus their lit-window meshes unless `lights`
 * is false: a touch device never draws those (perf/quality.ts), so it doesn't hold them either.
 */
export async function loadBuildingModels(manifest: BuildingModelManifest, only?: string[], lights = true): Promise<BuildingModels> {
  const jobs: [string, string][] = [];
  for (const c of manifest.campuses) {
    if (only && !only.includes(c.id)) continue;
    jobs.push([c.id, c.model]);
    if (lights) for (const [when, url] of Object.entries(c.lights ?? {})) if (url) jobs.push([`${c.id}:${when}`, url]);
  }
  const entries = await Promise.all(jobs.map(async ([key, url]) => [key, mergeMaterialPrimitives(await load(url, GLTFLoader), { materialAttributes: true })] as const));
  return Object.fromEntries(entries);
}

// Level of detail by campus: the Medical Campus is ~2.5 km from the main views and most sessions
// never look at it, so its models (~1.4 MB) load only when it's about to come into view (or its
// campus button is pressed), well before it's on screen.
export const DEFERRED_CAMPUSES = ['medical'];

/**
 * Convenience: manifest + the models of every campus that isn't deferred, in one call; or of
 * `only` those campuses (none for the bare map on a phone, which needs the manifest alone).
 */
export async function loadBuildings(url?: string, only?: string[], lights = true) {
  const manifest = await loadBuildingManifest(url);
  const models = await loadBuildingModels(manifest, only ?? manifest.campuses.map((c) => c.id).filter((id) => !DEFERRED_CAMPUSES.includes(id)), lights);
  return { manifest, models };
}

/** The detailed models' stand-in on the bare map: a campus's footprints, extruded. */
const FOOTPRINT_COLOR: [number, number, number] = [186, 174, 162];
const footprintsByCampus = new WeakMap<object, Map<string, { polygon: [number, number][]; height: number }[]>>();

/**
 * The bare map on a phone or tablet (App.tsx, perf/quality.ts LOW_MEMORY): a campus is one cheap
 * extruded polygon per building in place of its detailed models, at the models' roof heights and
 * tinted by the same light.
 */
export function campusFootprintLayer(
  manifest: BuildingModelManifest,
  campus: string,
  footprints: readonly { id: string; polygon: [number, number][]; height: number }[],
  lightPreset: BuildingLight = 'day',
) {
  let byCampus = footprintsByCampus.get(footprints);
  if (!byCampus) footprintsByCampus.set(footprints, (byCampus = new Map()));
  let data = byCampus.get(campus);
  if (!data) {
    const ids = new Set(manifest.campuses.find((c) => c.id === campus)?.buildings.map((b) => b.osm) ?? []);
    data = footprints.filter((f) => ids.has(f.id)).map((f) => ({ polygon: f.polygon, height: f.height }));
    byCampus.set(campus, data);
  }
  const tint = LIGHT_TINT[lightPreset];
  const color: [number, number, number, number] = [
    Math.round((FOOTPRINT_COLOR[0] * tint[0]) / 255),
    Math.round((FOOTPRINT_COLOR[1] * tint[1]) / 255),
    Math.round((FOOTPRINT_COLOR[2] * tint[2]) / 255),
    255,
  ];
  return new PolygonLayer({
    id: `campus-footprints-${campus}`,
    data,
    getPolygon: (d) => d.polygon,
    extruded: true,
    getElevation: (d) => Math.max(3, d.height),
    getFillColor: color,
    stroked: false,
    pickable: false,
    slot: 'middle',
    updateTriggers: { getFillColor: lightPreset },
  });
}

const loading = new Set<string>();
/** Load a deferred campus into `models` (once; later calls are no-ops). Resolves when it's drawable. */
export async function loadCampusModels(manifest: BuildingModelManifest, models: BuildingModels, campus: string, lights = true): Promise<void> {
  if (models[campus] || loading.has(campus)) return;
  loading.add(campus);
  try {
    Object.assign(models, await loadBuildingModels(manifest, [campus], lights));
  } finally {
    loading.delete(campus);
  }
}

/** [west, south, east, north] around a campus's buildings (from the manifest's building centres). */
export function campusBounds(manifest: BuildingModelManifest, campus: string, padMetres = 300): [number, number, number, number] | null {
  const c = manifest.campuses.find((x) => x.id === campus);
  if (!c?.buildings.length) return null;
  const lngs = c.buildings.map((b) => b.center[0]);
  const lats = c.buildings.map((b) => b.center[1]);
  const dLat = padMetres / 110_540;
  const dLng = padMetres / (111_320 * Math.cos((c.origin[1] * Math.PI) / 180));
  return [Math.min(...lngs) - dLng, Math.min(...lats) - dLat, Math.max(...lngs) + dLng, Math.max(...lats) + dLat];
}

export type BuildingLight = 'dawn' | 'day' | 'dusk' | 'night';

export interface BuildingLayerOptions {
  /** The current Mapbox light preset: tints the models when `clock` isn't given or in manual mode. */
  lightPreset?: BuildingLight;
  /** False drops the lit-window meshes (the Performance setting's Speed level). Default true. */
  litWindows?: boolean;
  /** Sim time, seconds since Boston midnight. Drives the window lights (and, with `auto`, the tint). */
  clock?: number;
  /** Auto lighting: tint and window brightness follow the sun's altitude at `clock`. */
  auto?: boolean;
  /** Only draw these campuses (ids from the manifest). Default: all. */
  campuses?: string[];
  visible?: boolean;
  opacity?: number;
  /** Depth-buffer units to pull the models forward. Only needed if Mapbox Standard's own 3D
   *  buildings are left on underneath them (then ~1200 at normal pitch); 0 by default because
   *  basemap.excludeBuildings() drops BU's buildings from the city layer. */
  depthBias?: number;
  /** Modeled disaster damage (sim/disasterDamage.ts damageAt). Damaged buildings collapse, lean,
   *  char and lose or burn their lit windows in the shader; neighbours are untouched. */
  damage?: readonly BuildingDamageFrame[];
  /** Every saved footprint (day.buildings). With it each campus is tagged once, on first damage,
   *  and overhangs are told apart from neighbours exactly; without it only damaged ids are tagged
   *  (re-tagged when a new one appears). */
  footprints?: readonly Pick<DamageFootprint, 'id' | 'polygon'>[];
}

// deck.gl lights the models with its own default lights, which are brighter than Mapbox's dusk
// and night presets; these multipliers keep them sitting in the scene (manual presets).
const LIGHT_TINT: Record<BuildingLight, [number, number, number, number]> = {
  day: [255, 255, 255, 255],
  dawn: [236, 220, 214, 255],
  dusk: [206, 196, 214, 255],
  night: [120, 128, 158, 255],
};
// How strongly windows show under each manual preset.
const WINDOW_STRENGTH: Record<BuildingLight, number> = { day: 0, dawn: 0.6, dusk: 0.85, night: 1 };

interface Instance {
  position: [number, number, number];
}

/** Polygon-offset units added as the camera flattens towards top-down (0 at 30 deg and above). */
export function lowPitchDepthBias(pitch: number): number {
  if (pitch >= 30) return 0;
  const t = (30 - pitch) / 30;
  return 3e6 * t * t;
}

type ModelLike = {
  parameters?: Record<string, unknown>;
  setParameters?: (p: Record<string, unknown>) => void;
  shaderInputs?: { setProps(props: Record<string, unknown>): void };
};
type SceneNode = { model?: ModelLike };

const WINDOW_UNIFORMS = `\
uniform windowLightsUniforms {
  float hour;
  float strength;
} windowLights;
`;

/** Window schedules: TEXCOORD_0 = (on hour, off hour) on a 12..36 h axis; `hour` on the same axis. */
const windowLights = {
  name: 'windowLights',
  vs: WINDOW_UNIFORMS,
  fs: WINDOW_UNIFORMS,
  uniformTypes: { hour: 'f32', strength: 'f32' },
  defaultUniforms: { hour: 21, strength: 1 },
} as const;

const windowFilter = (damage: boolean) => `
  {
    float on = geometry.uv.x;
    float off = geometry.uv.y;
    float h = windowLights.hour;
    // ~15 sim minutes to switch, so a fast-forward reads as lights gradually going on and off
    float k = smoothstep(on, on + 0.25, h) * (1.0 - smoothstep(off - 0.25, off, h)) * windowLights.strength;
${damage ? DAMAGE_WINDOW_FS : '    float flowGlow = 0.0;\n'}    if (k < 0.02 && flowGlow < 0.02) discard;
    color.rgb = color.rgb * k + vec3(1.0, 0.45, 0.12) * flowGlow;
  }
`;

interface ExtraProps {
  extraDepthBias: number;
  /** Lit-window mesh: set the schedule uniforms. Hour on the 12..36 axis; strength 0..1. */
  windowClock: { hour: number; strength: number } | null;
  /** Set (with a tagged scenegraph) once the campus has damage: the slot uniforms and a version
   *  that changes only when they do, so unchanged frames upload nothing but `elapsed`. */
  damageUniforms: { version: number; uniforms: DamageUniforms } | null;
}

/**
 * ScenegraphLayer with two additions:
 * - pulls itself forward in the depth buffer when the camera looks almost straight down (in
 *   interleaved mode Mapbox's depth for flat views drifts from deck.gl's, and Standard's 2D
 *   building footprints then paint over the roofs);
 * - for the lit-window mesh, a tiny shader module that switches each window on and off by its
 *   own schedule against a clock uniform.
 */
class BuildingModelLayer extends MaterialScenegraphLayer<Instance, ExtraProps> {
  static layerName = 'BuildingModelLayer';
  getShaders() {
    const shaders = super.getShaders();
    const damage = !!this.props.damageUniforms && this.context.device?.type !== 'webgpu';
    if (!this.props.windowClock && !damage) return shaders;
    const inject: Record<string, string> = { ...(shaders.inject ?? {}) };
    const modules = [...shaders.modules];
    if (damage) {
      modules.push(buildingDamageModule);
      inject['vs:#decl'] = (inject['vs:#decl'] ?? '') + DAMAGE_VS_DECL;
      inject['fs:#decl'] = (inject['fs:#decl'] ?? '') + DAMAGE_FS_DECL;
      inject['vs:DECKGL_FILTER_SIZE'] = (inject['vs:DECKGL_FILTER_SIZE'] ?? '') + DAMAGE_VS;
    }
    if (this.props.windowClock) {
      modules.push(windowLights);
      inject['fs:DECKGL_FILTER_COLOR'] = windowFilter(damage);
    } else {
      inject['fs:DECKGL_FILTER_COLOR'] = (inject['fs:DECKGL_FILTER_COLOR'] ?? '') + DAMAGE_FS;
    }
    return { ...shaders, modules, inject };
  }
  draw(opts: Parameters<ScenegraphLayer<Instance>['draw']>[0]) {
    const pitch = (this.context.viewport as unknown as { pitch?: number }).pitch ?? 60;
    const units = this.props.extraDepthBias + lowPitchDepthBias(pitch);
    // luma.gl: gl.polygonOffset(factor = depthBias, units = depthBiasSlopeScale)
    const offset = { depthBias: units ? -1 : 0, depthBiasSlopeScale: -units };
    const clock = this.props.windowClock;
    const damage = this.props.damageUniforms;
    const scenegraph = (this.state as { scenegraph?: { traverse(cb: (node: SceneNode) => void): void } }).scenegraph;
    scenegraph?.traverse((node) => {
      node.model?.setParameters?.({ ...node.model.parameters, ...offset });
      if (clock) node.model?.shaderInputs?.setProps({ windowLights: clock });
      if (damage && node.model?.shaderInputs) {
        const { elapsed, map, slotA, slotB } = damage.uniforms;
        // Arrays only when they changed (or for a newly built model); the clock every frame.
        const fresh = uploadedDamage.get(node.model) !== damage.version;
        node.model.shaderInputs.setProps({ buildingDamage: fresh ? { elapsed, map, slotA, slotB } : { elapsed } });
        if (fresh) uploadedDamage.set(node.model, damage.version);
      }
    });
    super.draw(opts);
  }
}

const uploadedDamage = new WeakMap<object, number>();

// Damage tagging per campus GLB: built lazily on the campus's first damage and kept (also after a
// reset, with zeroed slots) so later scenarios and rewinds reuse the same GPU geometry. With
// `footprints` every building of the campus is tagged the first time; a damaged id the tags don't
// cover (no footprint list, or a building missing from it) triggers one re-tag.
interface CampusDamage {
  tagged: Map<string, TaggedModel>; // by model key (campus id, `<id>:scheduled`)
  ids: Set<string>;
  last: DamageUniforms | null;
  version: number;
}
const damageCache = new WeakMap<CampusModel, CampusDamage>();
const inBox = (box: CullBox, p: readonly number[]) => p[0] >= box[0] && p[0] <= box[3] && p[1] >= box[1] && p[1] <= box[4];
const sameArray = (a: Float32Array, b: Float32Array) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

function campusDamage(c: CampusModel, models: BuildingModels, box: CullBox | null, options: BuildingLayerOptions): CampusDamage | null {
  const frames = box ? (options.damage ?? []).filter(f => inBox(box, f.center)) : [];
  let state = damageCache.get(c);
  if (!state && !frames.length) return null;
  const missing = frames.some(f => !state?.ids.has(f.id));
  if (!state || missing) {
    const footprints: Pick<DamageFootprint, 'id' | 'polygon'>[] = [];
    for (const f of options.footprints ?? []) if (box && f.polygon.some(p => inBox(box, p))) footprints.push(f);
    for (const f of frames) if (!footprints.some(p => p.id === f.id)) for (const ring of f.rings) footprints.push({ id: f.id, polygon: ring });
    // The model's own massing rings (CDS's stacked pieces, Warren's towers) cover what the saved ground ring misses.
    const known = new Set(footprints.map(f => f.id));
    for (const b of c.buildings) {
      const id = b.partOf ?? b.osm;
      if (known.has(id)) for (const v of b.volumes ?? []) footprints.push({ id, polygon: v.ring });
    }
    const tagged = new Map<string, TaggedModel>();
    for (const key of [c.id, `${c.id}:scheduled`]) {
      if (!models[key]) continue;
      const t = tagBuildings(models[key], c.origin, footprints);
      if (t) tagged.set(key, t);
    }
    if (!tagged.size) return null;
    // Ids that couldn't be tagged (no usable ring) count as covered, so they don't re-tag every frame.
    const ids = new Set([...tagged.values().next().value!.index.keys(), ...frames.map(f => f.id)]);
    state = { tagged, ids, last: null, version: (state?.version ?? 0) + 1 };
    damageCache.set(c, state);
  }
  const index = state.tagged.get(c.id)?.index ?? state.tagged.values().next().value!.index;
  const next = damageUniforms(frames, index, options.clock);
  if (next.shared && !state.last) console.warn(`Building damage: ${next.shared} buildings in ${c.id} share damage slots (more than the shader's limit).`);
  const last = state.last;
  if (!last || !sameArray(last.map, next.map) || !sameArray(last.slotA, next.slotA) || !sameArray(last.slotB, next.slotB)) state.version++;
  state.last = next;
  return state;
}

// One instance per campus, built once, with the campus model's real extent. The layers are rebuilt
// every frame, and a new `data` array each time made deck.gl re-upload every attribute of all the
// model's primitives per frame. Model frame: +x east, +y up, +z south.
const instanceCache = new WeakMap<CampusModel, { data: Instance[]; box: CullBox | null }>();
function campusInstance(c: CampusModel, model: unknown) {
  let cached = instanceCache.get(c);
  if (!cached) {
    const extent = gltfExtent(model);
    const pad = 5;
    const kx = 111_320 * Math.cos((c.origin[1] * Math.PI) / 180);
    const ky = 110_540;
    const box: CullBox | null = extent && [
      c.origin[0] + (extent.min[0] - pad) / kx,
      c.origin[1] - (extent.max[2] + pad) / ky,
      extent.min[1] - pad,
      c.origin[0] + (extent.max[0] + pad) / kx,
      c.origin[1] - (extent.min[2] - pad) / ky,
      extent.max[1] + pad,
    ];
    cached = { data: [{ position: [c.origin[0], c.origin[1], 0] }], box };
    instanceCache.set(c, cached);
  }
  return cached;
}

/** Sim seconds since midnight -> hours on the 12..36 axis the window schedules use. */
function scheduleHour(seconds: number): number {
  const h = (((seconds / 3600) % 24) + 24) % 24;
  return h < 12 ? h + 24 : h;
}

/**
 * The hour (12..36 axis) the lit-window schedules are read at: the sim clock, except that a
 * manual dusk or night preset at a daytime clock shows a typical evening instead.
 */
export function windowHour(clock: number | undefined, lightPreset: BuildingLight, auto: boolean): number {
  const hour = scheduleHour(clock ?? 21 * 3600);
  if (!(auto && clock !== undefined) && WINDOW_STRENGTH[lightPreset] > 0 && hour >= 12 && hour < 17.5) {
    return lightPreset === 'night' ? 21.5 : 19;
  }
  return hour;
}

export function buildingModelLayers(
  manifest: BuildingModelManifest,
  models: BuildingModels,
  options: BuildingLayerOptions = {},
) {
  const { lightPreset = 'dusk', clock, auto = false, campuses, visible = true, opacity = 1, depthBias = 0 } = options;
  let tint = LIGHT_TINT[lightPreset];
  let strength = WINDOW_STRENGTH[lightPreset];
  const hour = windowHour(clock, lightPreset, auto);
  if (auto && clock !== undefined) {
    const d = daylightAt(clock);
    tint = d.tint;
    strength = d.windows;
  }
  const layers: BuildingModelLayer[] = [];
  for (const c of manifest.campuses) {
    if (!models[c.id] || (campuses && !campuses.includes(c.id))) continue;
    const { data, box } = campusInstance(c, models[c.id]);
    const damage = campusDamage(c, models, box, options);
    const parts: { id: string; key: string; color: [number, number, number, number]; windowClock: ExtraProps['windowClock'] }[] = [
      { id: c.id, key: c.id, color: tint, windowClock: null },
    ];
    // Lit windows: emissive, so untinted; skipped entirely in daylight.
    if (strength > 0.01 && models[`${c.id}:scheduled`] && options.litWindows !== false) {
      parts.push({ id: `${c.id}-lights`, key: `${c.id}:scheduled`, color: [255, 255, 255, 255], windowClock: { hour, strength } });
    }
    for (const part of parts) {
      // An off-screen campus (Fenway and Medical from the Charles River views) skips its draws.
      setCullBox(`building-models-${part.id}`, box);
      layers.push(
        new BuildingModelLayer({
          id: `building-models-${part.id}`,
          data,
          scenegraph: (damage?.tagged.get(part.key)?.gltf ?? models[part.key]) as never,
          getPosition: (d) => d.position,
          // glTF is y-up; roll 90 stands it on the map: +x east, +y up, -z north.
          getOrientation: [0, 0, 90],
          // An accessor, not a constant: deck only re-evaluates it (on change, via updateTriggers)
          // when it's a function.
          getColor: () => part.color,
          sizeScale: 1,
          _lighting: 'pbr',
          visible,
          opacity,
          pickable: false,
          extraDepthBias: depthBias,
          windowClock: part.windowClock,
          damageUniforms: damage?.tagged.has(part.key) && damage.last ? { version: damage.version, uniforms: damage.last } : null,
          updateTriggers: { getColor: part.color.map(Math.round).join(',') },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
      );
    }
  }
  return layers;
}
