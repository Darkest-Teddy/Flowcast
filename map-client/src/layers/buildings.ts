// Detailed 3D models of BU's buildings, drawn over Mapbox's plain extrusions.
//
// data-pipeline/make_building_models.py turns every BU footprint in OpenStreetMap into a
// procedurally detailed model (window rows, cornices, mansards, hand-tuned landmarks such as CDS,
// Marsh Chapel and Warren Towers) and merges each campus into ONE GLB, so the whole of BU costs
// three ScenegraphLayer instances and a handful of draw calls.
//
// Model frame: metres, +x east, +y up, +z south (glTF convention), relative to the campus origin.
// The walls sit ~0.3 m outside each OSM footprint and the roofs ~0.5 m above Mapbox's own
// extrusion height, so the models cover Mapbox's grey boxes instead of z-fighting with them.
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';

export interface BuildingModelEntry {
  osm: string; // e.g. "way/277434241", the same ids as demo-day.json's buildings
  name: string | null;
  center: [number, number];
  height: number; // top of the model, metres
  landmark?: string;
}

export interface CampusModel {
  id: string;
  name: string;
  origin: [number, number]; // [lng, lat] of the model's (0, 0, 0)
  model: string; // URL of the GLB
  buildings: BuildingModelEntry[];
}

export interface BuildingModelManifest {
  frame: string;
  campuses: CampusModel[];
}

/** Parsed GLBs, keyed by campus id. */
export type BuildingModels = Record<string, unknown>;

export async function loadBuildingManifest(url = '/data/building-models.json'): Promise<BuildingModelManifest> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  return res.json();
}

/** Fetch and parse every campus GLB once (about 6 MB in total). */
export async function loadBuildingModels(manifest: BuildingModelManifest): Promise<BuildingModels> {
  const entries = await Promise.all(
    manifest.campuses.map(async (c) => [c.id, await load(c.model, GLTFLoader)] as const),
  );
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
  /** Match Mapbox Standard's lightPreset so the models don't glow at dusk or night. */
  lightPreset?: BuildingLight;
  /** Only draw these campuses (ids from the manifest). Default: all. */
  campuses?: string[];
  visible?: boolean;
  opacity?: number;
  /** Depth-buffer units the models are pulled forward to beat Mapbox's own boxes. Default 1200. */
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

export function buildingModelLayers(
  manifest: BuildingModelManifest,
  models: BuildingModels,
  options: BuildingLayerOptions = {},
) {
  const { lightPreset = 'dusk', campuses, visible = true, opacity = 1, depthBias = 1200 } = options;
  const tint = LIGHT_TINT[lightPreset];
  return manifest.campuses
    .filter((c) => models[c.id] && (!campuses || campuses.includes(c.id)))
    .map(
      (c) =>
        new ScenegraphLayer<Instance>({
          id: `building-models-${c.id}`,
          data: [{ position: [c.origin[0], c.origin[1], 0] }],
          scenegraph: models[c.id] as never,
          getPosition: (d) => d.position,
          // glTF is y-up; roll 90 stands it on the map: +x east, +y up, -z north.
          getOrientation: [0, 0, 90],
          getColor: tint,
          sizeScale: 1,
          _lighting: 'pbr',
          visible,
          opacity,
          pickable: false,
          // Win depth ties against Mapbox's own extrusion of the same building (see header).
          // Mapbox draws its own 3D buildings a small constant step nearer in the depth buffer
          // than deck.gl's layers, so far-away or tall models (CDS's upper blocks) lose to the
          // plain box they cover. A polygon offset of the same size restores the tie. luma.gl
          // passes these to gl.polygonOffset(factor = depthBias, units = depthBiasSlopeScale).
          parameters: { depthBias: -1, depthBiasSlopeScale: -depthBias },
          updateTriggers: { getColor: lightPreset },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
    );
}
