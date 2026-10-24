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
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import { mergeMaterialPrimitives } from './gltf-materials';
import { MaterialScenegraphLayer } from './material-scenegraph';
import { daylightAt } from '../map/daylight';
import { gltfExtent, setCullBox, type CullBox } from './culling';

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

/** Fetch and parse campus GLBs (all, or just `only`), plus their lit-window meshes. */
export async function loadBuildingModels(manifest: BuildingModelManifest, only?: string[]): Promise<BuildingModels> {
  const jobs: [string, string][] = [];
  for (const c of manifest.campuses) {
    if (only && !only.includes(c.id)) continue;
    jobs.push([c.id, c.model]);
    for (const [when, url] of Object.entries(c.lights ?? {})) if (url) jobs.push([`${c.id}:${when}`, url]);
  }
  const entries = await Promise.all(jobs.map(async ([key, url]) => [key, mergeMaterialPrimitives(await load(url, GLTFLoader), { materialAttributes: true })] as const));
  return Object.fromEntries(entries);
}

// Level of detail by campus: the Medical Campus is ~2.5 km from the main views and most sessions
// never look at it, so its models (~1.4 MB) load only when it's about to come into view (or its
// campus button is pressed), well before it's on screen.
export const DEFERRED_CAMPUSES = ['medical'];

/** Convenience: manifest + the models of every campus that isn't deferred, in one call. */
export async function loadBuildings(url?: string) {
  const manifest = await loadBuildingManifest(url);
  const models = await loadBuildingModels(manifest, manifest.campuses.map((c) => c.id).filter((id) => !DEFERRED_CAMPUSES.includes(id)));
  return { manifest, models };
}

const loading = new Set<string>();
/** Load a deferred campus into `models` (once; later calls are no-ops). Resolves when it's drawable. */
export async function loadCampusModels(manifest: BuildingModelManifest, models: BuildingModels, campus: string): Promise<void> {
  if (models[campus] || loading.has(campus)) return;
  loading.add(campus);
  try {
    Object.assign(models, await loadBuildingModels(manifest, [campus]));
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

const WINDOW_FILTER = `
  {
    float on = geometry.uv.x;
    float off = geometry.uv.y;
    float h = windowLights.hour;
    // ~15 sim minutes to switch, so a fast-forward reads as lights gradually going on and off
    float k = smoothstep(on, on + 0.25, h) * (1.0 - smoothstep(off - 0.25, off, h)) * windowLights.strength;
    if (k < 0.02) discard;
    color.rgb *= k;
  }
`;

interface ExtraProps {
  extraDepthBias: number;
  /** Lit-window mesh: set the schedule uniforms. Hour on the 12..36 axis; strength 0..1. */
  windowClock: { hour: number; strength: number } | null;
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
    if (!this.props.windowClock) return shaders;
    return {
      ...shaders,
      modules: [...shaders.modules, windowLights],
      inject: { ...(shaders.inject ?? {}), 'fs:DECKGL_FILTER_COLOR': WINDOW_FILTER },
    };
  }
  draw(opts: Parameters<ScenegraphLayer<Instance>['draw']>[0]) {
    const pitch = (this.context.viewport as unknown as { pitch?: number }).pitch ?? 60;
    const units = this.props.extraDepthBias + lowPitchDepthBias(pitch);
    // luma.gl: gl.polygonOffset(factor = depthBias, units = depthBiasSlopeScale)
    const offset = { depthBias: units ? -1 : 0, depthBiasSlopeScale: -units };
    const clock = this.props.windowClock;
    const scenegraph = (this.state as { scenegraph?: { traverse(cb: (node: SceneNode) => void): void } }).scenegraph;
    scenegraph?.traverse((node) => {
      node.model?.setParameters?.({ ...node.model.parameters, ...offset });
      if (clock) node.model?.shaderInputs?.setProps({ windowLights: clock });
    });
    super.draw(opts);
  }
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
          scenegraph: models[part.key] as never,
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
          updateTriggers: { getColor: part.color.map(Math.round).join(',') },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
      );
    }
  }
  return layers;
}
