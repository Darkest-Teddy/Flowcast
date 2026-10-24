// Detailed 3D models of BU's buildings.
//
// data-pipeline/make_building_models.py turns every BU footprint in OpenStreetMap into a
// procedurally detailed model (per-building facades from reference photos, cornices, mansards,
// fins, hand-tuned landmarks such as CDS, Marsh Chapel and Warren Towers) and merges each campus
// into ONE GLB, so the whole of BU costs three ScenegraphLayer instances and a handful of draw
// calls. At dusk and night two small extra GLBs per campus add warm lit windows.
//
// Model frame: metres, +x east, +y up, +z south (glTF convention), relative to the campus origin.
// Every OSM id in the manifest (buildings, their building:part pieces and relation members) is
// left out of the app's city-buildings layer, so nothing is drawn underneath the models.
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';

export interface BuildingModelEntry {
  osm: string; // e.g. "way/277434241", the same ids as demo-day.json's buildings
  name: string | null;
  center: [number, number];
  height: number; // top of the model, metres
  landmark?: string;
  /** Set on building:part / relation-member ids listed only so the city layer excludes them. */
  partOf?: string;
}

export interface CampusModel {
  id: string;
  name: string;
  origin: [number, number]; // [lng, lat] of the model's (0, 0, 0)
  model: string; // URL of the GLB
  /** Lit-window meshes: `dusk` glows at dusk and night, `night` adds more windows at night. */
  lights?: { dusk?: string; night?: string };
  buildings: BuildingModelEntry[];
}

export interface BuildingModelManifest {
  frame: string;
  campuses: CampusModel[];
}

/** Parsed GLBs, keyed by campus id (lit-window meshes as `<id>:dusk` and `<id>:night`). */
export type BuildingModels = Record<string, unknown>;

export async function loadBuildingManifest(url = '/data/building-models.json'): Promise<BuildingModelManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  return res.json();
}

/** Fetch and parse every campus GLB once, plus its lit-window meshes. */
export async function loadBuildingModels(manifest: BuildingModelManifest): Promise<BuildingModels> {
  const jobs: [string, string][] = [];
  for (const c of manifest.campuses) {
    jobs.push([c.id, c.model]);
    for (const [when, url] of Object.entries(c.lights ?? {})) if (url) jobs.push([`${c.id}:${when}`, url]);
  }
  const entries = await Promise.all(jobs.map(async ([key, url]) => [key, await load(url, GLTFLoader)] as const));
  return Object.fromEntries(entries);
}

/** Convenience: manifest + models in one call. */
export async function loadBuildings(url?: string) {
  const manifest = await loadBuildingManifest(url);
  const models = await loadBuildingModels(manifest);
  return { manifest, models };
}

export type BuildingLight = 'dawn' | 'day' | 'dusk' | 'night';

export interface BuildingLayerOptions {
  /** Match Mapbox Standard's lightPreset: tints the models, and lights a random share of windows
   *  at dusk (warm glow) and more of them at night. */
  lightPreset?: BuildingLight;
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
// and night presets; these multipliers keep them sitting in the scene.
const LIGHT_TINT: Record<BuildingLight, [number, number, number, number]> = {
  day: [255, 255, 255, 255],
  dawn: [236, 220, 214, 255],
  dusk: [206, 196, 214, 255],
  night: [120, 128, 158, 255],
};

interface Instance {
  position: [number, number, number];
}

/** Polygon-offset units added as the camera flattens towards top-down (0 at 30 deg and above). */
export function lowPitchDepthBias(pitch: number): number {
  if (pitch >= 30) return 0;
  const t = (30 - pitch) / 30;
  return 3e6 * t * t;
}

type ModelWithParameters = { parameters?: Record<string, unknown>; setParameters?: (p: Record<string, unknown>) => void };
type SceneNode = { model?: ModelWithParameters };

/**
 * ScenegraphLayer that pulls itself forward in the depth buffer when the camera looks almost
 * straight down. In interleaved mode Mapbox's depth for flat or nearly flat views drifts far from
 * deck.gl's, and Standard's 2D building footprints then paint over the roofs (the "Top" camera
 * showed beige footprints instead of the models). Above ~30 deg pitch nothing changes.
 */
class BuildingModelLayer extends ScenegraphLayer<Instance, { extraDepthBias: number }> {
  static layerName = 'BuildingModelLayer';
  draw(opts: Parameters<ScenegraphLayer<Instance>['draw']>[0]) {
    const pitch = (this.context.viewport as unknown as { pitch?: number }).pitch ?? 60;
    const units = this.props.extraDepthBias + lowPitchDepthBias(pitch);
    // luma.gl: gl.polygonOffset(factor = depthBias, units = depthBiasSlopeScale)
    const offset = { depthBias: units ? -1 : 0, depthBiasSlopeScale: -units };
    const scenegraph = (this.state as { scenegraph?: { traverse(cb: (node: SceneNode) => void): void } }).scenegraph;
    scenegraph?.traverse((node) => node.model?.setParameters?.({ ...node.model.parameters, ...offset }));
    super.draw(opts);
  }
}

export function buildingModelLayers(
  manifest: BuildingModelManifest,
  models: BuildingModels,
  options: BuildingLayerOptions = {},
) {
  const { lightPreset = 'dusk', campuses, visible = true, opacity = 1, depthBias = 0 } = options;
  const tint = LIGHT_TINT[lightPreset];
  const lit = lightPreset === 'night' ? ['dusk', 'night'] : lightPreset === 'dusk' ? ['dusk'] : [];
  const layers: BuildingModelLayer[] = [];
  for (const c of manifest.campuses) {
    if (!models[c.id] || (campuses && !campuses.includes(c.id))) continue;
    const parts = [{ id: c.id, key: c.id, color: tint }];
    // Lit windows: emissive, so they glow whatever the tint; untinted.
    for (const when of lit) {
      if (models[`${c.id}:${when}`]) parts.push({ id: `${c.id}-lights-${when}`, key: `${c.id}:${when}`, color: [255, 255, 255, 255] });
    }
    for (const part of parts) {
      layers.push(
        new BuildingModelLayer({
          id: `building-models-${part.id}`,
          data: [{ position: [c.origin[0], c.origin[1], 0] }],
          scenegraph: models[part.key] as never,
          getPosition: (d) => d.position,
          // glTF is y-up; roll 90 stands it on the map: +x east, +y up, -z north.
          getOrientation: [0, 0, 90],
          // An accessor, not a constant: deck only re-evaluates it (on lightPreset change, via
          // updateTriggers) when it's a function.
          getColor: () => part.color as [number, number, number, number],
          sizeScale: 1,
          _lighting: 'pbr',
          visible,
          opacity,
          pickable: false,
          extraDepthBias: depthBias,
          updateTriggers: { getColor: lightPreset },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
      );
    }
  }
  return layers;
}
