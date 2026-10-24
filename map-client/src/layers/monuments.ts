// BU's monuments and landmarks: real-scale 3D models (Free at Last, the Rhett bench, the Citgo
// sign, the Harry Agganis statue, the BU seal set into Marsh Plaza), a dot for other public art, and the named open spaces (BU
// Beach, Marsh Plaza) as faint outlines. Their name tags are HTML, in PlaceTags.tsx.
//
// Data: public/data/monuments.json (positions and sources, mostly OpenStreetMap; see each entry's
// `source`). Models: scripts/make_monument_models.py (metres, +Y up, front +Z), turned to face each
// entry's compass bearing the same way agents.ts turns the walkers.
import { PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import type { Color } from '@deck.gl/core';
import { citgoLightLayers, type CitgoLights } from './citgo';

export interface Monument {
  id: string;
  /** monument / landmark: modelled or a notable building; artwork: label only; area: outline + label. */
  kind: 'monument' | 'landmark' | 'artwork' | 'area';
  name: string;
  subtitle: string | null;
  /** URL of the GLB, or null for label-only entries. */
  model: string | null;
  position: [number, number];
  /** Compass bearing the model's front faces. */
  bearing: number;
  /** Metres above the ground the model (or label) stands on, e.g. a roof. */
  altitude?: number;
  /** Height of the model itself, for placing its label just above it. */
  height?: number;
  polygon?: [number, number][];
  source: { position: string; details: string; unverified?: string };
}

export interface MonumentData {
  monuments: Monument[];
  /** Parsed GLBs, keyed by model URL. */
  models: Record<string, unknown>;
  /** The Citgo sign's light layout (scripts/make_monument_models.py), if it loaded. */
  citgoLights: CitgoLights | null;
}

/** Fetch the list and every model it names; a model that fails to load is simply skipped. */
export async function loadMonuments(url = '/data/monuments.json'): Promise<MonumentData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  const monuments: Monument[] = await res.json();
  const urls = [...new Set(monuments.flatMap((m) => (m.model ? [m.model] : [])))];
  const [loaded, citgoLights] = await Promise.all([
    Promise.all(urls.map(async (u) => [u, await load(u, GLTFLoader).catch(() => null)] as const)),
    fetch('/data/citgo-lights.json').then((r) => (r.ok ? (r.json() as Promise<CitgoLights>) : null)).catch(() => null),
  ]);
  return { monuments, models: Object.fromEntries(loaded.filter(([, m]) => m)), citgoLights };
}

export type MonumentLight = 'dawn' | 'day' | 'dusk' | 'night';

export interface MonumentLayerOptions {
  zoom: number;
  /** Mapbox Standard's lightPreset: unlit surfaces darken at night while the Citgo sign glows. */
  lightPreset?: MonumentLight;
  /** Shown time, seconds since local midnight: the Citgo sign is lit from sunset to midnight. */
  time?: number;
}

// Same multipliers as the building models, so bronze and granite sit in the scene at dusk and
// night. The Citgo sign's lights are drawn separately (citgo.ts), so they are not tinted.
const LIGHT_TINT: Record<MonumentLight, Color> = {
  day: [255, 255, 255, 255],
  dawn: [236, 220, 214, 255],
  dusk: [206, 196, 214, 255],
  night: [110, 116, 146, 255],
};

const CITGO_NIGHT_TINT: Color = [4, 4, 6, 255];

// Tags (PlaceTags.tsx) appear as the camera comes in: landmarks first, single artworks last.
export const LABEL_MIN_ZOOM: Record<Monument['kind'], number> = { landmark: 15.8, monument: 16.8, area: 16.5, artwork: 17.8 };
const ACCENT: Color = [214, 178, 112, 255]; // warm bronze, distinct from crowd and transit colours

/** Where a monument's tag stands: just above the model (or its spot, for areas and artworks). */
export function labelPosition(m: Monument): [number, number, number] {
  return [m.position[0], m.position[1], (m.altitude ?? 0) + (m.height ?? 0) + 1];
}

export function monumentLayers({ monuments, models, citgoLights }: MonumentData, { zoom, lightPreset = 'dusk', time }: MonumentLayerOptions) {
  const citgo = monuments.find((m) => m.id === 'citgo-sign');
  const tint = LIGHT_TINT[lightPreset];
  const byModel = new Map<string, Monument[]>();
  for (const m of monuments) if (m.model && models[m.model]) byModel.set(m.model, [...(byModel.get(m.model) ?? []), m]);

  const areas = monuments.filter((m) => m.kind === 'area' && m.polygon);
  const artworks = monuments.filter((m) => m.kind === 'artwork');

  return [
    new PolygonLayer<Monument>({
      id: 'monument-areas',
      data: areas,
      getPolygon: (m) => m.polygon!,
      getFillColor: [214, 178, 112, 28],
      getLineColor: [214, 178, 112, 150],
      getLineWidth: 1.5,
      lineWidthUnits: 'pixels',
      stroked: true,
      filled: true,
      pickable: false,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    ...[...byModel].map(
      ([url, data]) =>
        new ScenegraphLayer<Monument>({
          id: `monument-${data[0].id}`,
          data,
          scenegraph: models[url] as never,
          sizeScale: 1, // real size: these are metres
          _lighting: 'pbr',
          getPosition: (m) => [m.position[0], m.position[1], m.altitude ?? 0],
          // Model front is +Z; the 90° roll stands it up, and 180 - bearing turns +Z to the bearing.
          getOrientation: (m) => [0, 180 - m.bearing, 90],
          // A function (not a constant) so the update trigger really refreshes the colour.
          // The Citgo sign's white enamel would glare at night, unlit: it sits darker still.
          getColor: (m) => (m.id === 'citgo-sign' && lightPreset === 'night' ? CITGO_NIGHT_TINT : tint),
          pickable: false,
          updateTriggers: { getColor: lightPreset },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
    ),
    // The Citgo sign's lights, dusk to midnight.
    ...(citgo && citgoLights && time !== undefined
      ? citgoLightLayers(
          citgoLights,
          { position: citgo.position, bearing: citgo.bearing, altitude: citgo.altitude ?? 0 },
          { time, lightPreset, zoom, now: performance.now() },
        )
      : []),
    // A small bronze dot marks artworks we label but don't model.
    new ScatterplotLayer<Monument>({
      id: 'monument-artwork-dots',
      data: zoom >= LABEL_MIN_ZOOM.artwork - 0.8 ? artworks : [],
      getPosition: (m) => m.position,
      getRadius: 0.9,
      radiusMinPixels: 3,
      radiusMaxPixels: 7,
      getFillColor: ACCENT,
      getLineColor: [17, 20, 28, 220],
      getLineWidth: 1,
      lineWidthUnits: 'pixels',
      stroked: true,
      pickable: false,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
  ];
}
