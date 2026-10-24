// The prediction, drawn on the map as light rather than paint, so it never hides the buildings
// (Mapbox's own, or the detailed models drawn over them):
//  - a soft pool of light on the ground around each tracked building: its reach and brightness
//    grow with how full the building is; Packed buildings breathe and send out a slow ping,
//  - a thin glowing rim along the roof edge and a faint tint on the roof, in the level's colour,
//  - fine light edges up the building's sharp corners, fading out towards the street,
//  - fading trails behind walkers show the flows between buildings.
// The tags above the buildings ("CDS · 87% · Packed", never colour alone, plan Section 10.3) are
// HTML, in BuildingTags.tsx. Everything here works in deck.gl's interleaved mode, so buildings
// still hide what's behind them (HeatmapLayer doesn't render in interleaved mode).
import { LineLayer, PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Color } from '@deck.gl/core';
import type { BuildingFootprint, BuildingOccupancy, Trip } from '../sim/playback';
import { footprintGeometry, roundedOffset, type FootprintGeometry } from './crowdGeometry';
import { GlowFadeExtension, HALO_Z, HALO_Z_RANGE } from './crowdGlow';

type RGB = readonly [number, number, number];

// One scale for the whole UI: the map glow, the tags and the dashboard bars always agree.
// `glow` is the light colour; `text` is its pale twin, which keeps 4.5:1 or better on the dark
// glass of the tags and panel (5.8:1 worst case, over a white map).
const LEVELS = [
  { min: 0.85, key: 'packed', label: 'Packed', glow: [244, 63, 94, 200], text: '#fda4af', halo: 180, roof: 72, rim: 9 },
  { min: 0.6, key: 'busy', label: 'Busy', glow: [249, 115, 22, 195], text: '#fdba74', halo: 150, roof: 60, rim: 7 },
  { min: 0.3, key: 'moderate', label: 'Moderate', glow: [250, 204, 21, 185], text: '#fde047', halo: 120, roof: 48, rim: 6 },
  { min: 0, key: 'quiet', label: 'Quiet', glow: [45, 212, 191, 150], text: '#5eead4', halo: 80, roof: 30, rim: 4 },
] as const satisfies readonly { min: number; key: string; label: string; glow: Color; text: string; halo: number; roof: number; rim: number }[];

export type CrowdLevel = (typeof LEVELS)[number];

export function crowdLevel(share: number): CrowdLevel {
  return LEVELS.find((level) => share >= level.min) ?? LEVELS[LEVELS.length - 1];
}

/** CSS custom properties for a level (`--lv` is "r, g, b" for rgb()/rgba(); `--lv-text` a colour). */
export function crowdLevelStyle(share: number): Record<string, string> {
  const level = crowdLevel(share);
  return { '--lv': level.glow.slice(0, 3).join(', '), '--lv-text': level.text };
}

/** The selected building is outlined in white: every hue already means a level. */
const SELECTED: RGB = [255, 255, 255];
/** Roof glow floats just above the roof (the detailed models' roofs sit 0.5 m above Mapbox's). */
const ROOF_LIFT = 0.9;
const BREATH_MS = 2400;
const PING_MS = 2600;

const reducedMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** How far the ground glow reaches past the building, in metres: grows with how full it is. */
function haloReach(share: number) {
  return 6 + 24 * Math.min(Math.max(share, 0), 1.2);
}

/** Top of each building's detailed model, by OSM id (building-models.json). */
export type RoofHeights = ReadonlyMap<string, number>;

/** Reads model heights from the building-model manifest (any object of that shape). */
export function modelRoofHeights(manifest?: { campuses: { buildings: { osm: string; height: number }[] }[] } | null): RoofHeights {
  return new Map(manifest?.campuses.flatMap((c) => c.buildings.map((b) => [b.osm, b.height] as const)) ?? []);
}

/**
 * Where the glow sits on one footprint ring: the detailed model's height where there is one
 * (CDS's model is 95 m against a 68 m footprint, CAS's 40 m against 18 m). Multi-ring buildings
 * scale each ring by the same ratio, so Warren's podium stays a podium under its towers. Mapbox's
 * own boxes are off for modelled buildings, so the model is the only thing to sit on.
 */
export function ringTop(f: BuildingFootprint, footprints: BuildingFootprint[], roofs?: RoofHeights): number {
  const model = roofs?.get(f.id);
  if (!model) return f.height;
  let tallest = 0;
  for (const g of footprints) if (g.id === f.id) tallest = Math.max(tallest, g.height);
  return (f.height * model) / (tallest || f.height);
}

interface Glow {
  /** The building id, as App's click handler reads it. */
  id: string;
  geo: FootprintGeometry;
  /** Roof height for this ring, metres (see ringTop). */
  top: number;
  share: number;
  level: CrowdLevel;
  selected: boolean;
  /** Ground halo: outer ring (fade 0) and inner ring (fade 1), with the fade carried in z. */
  halo: [number, number, number][][];
}

interface Edge {
  source: [number, number, number];
  target: [number, number, number];
  glow: Glow;
}

const withAlpha = (rgb: readonly number[], a: number): Color => [rgb[0], rgb[1], rgb[2], Math.round(a)];
const ring3d = (ring: [number, number][], z: number) => ring.map(([x, y]) => [x, y, z] as [number, number, number]);

// The glow geometry only changes when the counts (or the selection) do, twice a second at most;
// between those, every frame reuses the same arrays so deck.gl doesn't re-tessellate anything.
let cached: { key: string; footprints: BuildingFootprint[]; glows: Glow[]; flatRoofs: Glow[]; packed: Glow[]; edges: Edge[] } | null = null;

function buildGlows(footprints: BuildingFootprint[], buildings: BuildingOccupancy[], selectedId: string | null, roofs?: RoofHeights) {
  const key = `${selectedId}|${roofs?.size}|${buildings.map((b) => `${b.id}:${b.count}:${b.share}`).join()}`;
  if (cached && cached.key === key && cached.footprints === footprints) return cached;
  const shares = new Map(buildings.map((b) => [b.id, b.share]));
  const glows: Glow[] = [];
  for (const f of footprints) {
    if (!shares.has(f.id)) continue;
    const geo = footprintGeometry(f);
    if (!geo) continue;
    const share = shares.get(f.id) ?? 0;
    const outer = roundedOffset(geo.hull, haloReach(share)).map(geo.toLngLat);
    const inner = roundedOffset(geo.hull, 0.5).map(geo.toLngLat);
    glows.push({
      id: f.id,
      geo,
      top: ringTop(f, footprints, roofs),
      share,
      level: crowdLevel(share),
      selected: f.id === selectedId,
      halo: [ring3d(outer, HALO_Z), ring3d(inner, HALO_Z + HALO_Z_RANGE)],
    });
  }
  const edges = glows.flatMap((glow) =>
    glow.geo.corners.map(([x, y]): Edge => ({ source: [x, y, 0], target: [x, y, glow.top + ROOF_LIFT], glow })),
  );
  // The roof wash only where the model's top is its roof. Where a tower, spire or pitched roof
  // rises well above the footprint (CAS's tower, CDS's crown), a tinted plane up there would float
  // over the real roof, so those keep just the outline cage around the whole model.
  const flatRoofs = glows.filter((g) => g.top <= g.geo.height * 1.2 + 3);
  cached = { key, footprints, glows, flatRoofs, packed: glows.filter((g) => g.level.key === 'packed'), edges };
  return cached;
}

export interface CrowdLayerInput {
  footprints: BuildingFootprint[];
  buildings: BuildingOccupancy[];
  trips: Trip[];
  time: number;
  speed: number;
  selectedId: string | null;
  /** Map zoom: the overview gets a stronger wash so it reads as a heat map from afar. */
  zoom: number;
  /** Detailed-model heights, when the models are drawn (modelRoofHeights). */
  roofHeights?: RoofHeights;
}

const heightFade = new GlowFadeExtension({ mode: 'height', power: 1.4 });
const lineFade = new GlowFadeExtension({ mode: 'line', power: 1.6 });
// Light adds to the scene instead of covering it, and never blocks what's drawn after it.
// The detailed models (buildings.ts) are pulled 1200 depth units towards the camera so they beat
// Mapbox's own boxes; the glow is pulled a little further, so a rim on a model's roof line or an
// edge just outside its walls is never swallowed by the model it outlines.
const GLOW_PARAMETERS = { depthWriteEnabled: false, depthBias: -1, depthBiasSlopeScale: -1600 } as const;

export function crowdLayers({ footprints, buildings, trips, time, speed, selectedId, zoom, roofHeights }: CrowdLayerInput) {
  const { glows, flatRoofs, packed, edges, key } = buildGlows(footprints, buildings, selectedId, roofHeights);
  // 1 from street level to zoom 17.5, rising to 1.9 at the zoom 15.5 overview.
  const far = Math.min(Math.max((17.5 - zoom) / 2, 0), 1);
  const roofBoost = 1 + 0.9 * far;
  const haloBoost = 1 + 0.35 * far;
  const zoomKey = far.toFixed(2);
  const now = performance.now();
  const breath = reducedMotion ? 0.6 : 0.5 + 0.5 * Math.sin((now / BREATH_MS) * 2 * Math.PI);
  const ping = (now % PING_MS) / PING_MS;
  const rimColor = (g: Glow, a: number) => (g.selected ? withAlpha(SELECTED, 255) : withAlpha(g.level.glow, a));

  return [
    // Ground: a soft pool of light around each building.
    new SolidPolygonLayer<Glow>({
      id: 'crowd-halo',
      data: glows,
      getPolygon: (d) => d.halo,
      getFillColor: (d) => withAlpha(d.level.glow, Math.min(255, d.level.halo * haloBoost)),
      extensions: [heightFade],
      parameters: GLOW_PARAMETERS,
      updateTriggers: { getFillColor: [key, zoomKey] },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // Packed: the pool breathes, and a ring of light ripples outwards.
    new SolidPolygonLayer<Glow>({
      id: 'crowd-halo-breath',
      data: packed,
      getPolygon: (d) => d.halo,
      getFillColor: (d) => withAlpha(d.level.glow, 120),
      extensions: [heightFade],
      opacity: 0.25 + 0.75 * breath,
      parameters: GLOW_PARAMETERS,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    ...(reducedMotion
      ? []
      : [
          new PathLayer<Glow>({
            id: 'crowd-ping',
            data: packed,
            getPath: (d) => {
              const ring = roundedOffset(d.geo.hull, 0.5 + ping * (haloReach(d.share) + 14), 20).map(d.geo.toLngLat);
              return ring3d([...ring, ring[0]], HALO_Z + HALO_Z_RANGE);
            },
            getColor: (d) => withAlpha(d.level.glow, 230 * (1 - ping) ** 1.6),
            getWidth: 1.4,
            widthUnits: 'meters',
            widthMinPixels: 1.5,
            jointRounded: true,
            parameters: GLOW_PARAMETERS,
            updateTriggers: { getPath: now, getColor: now },
            // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
            slot: 'middle',
          }),
        ]),
    // Invisible: what a click on a building hits (App selects by the `polygon` field). Kept just
    // inside the walls so it never wins the depth test against the building it stands in.
    new SolidPolygonLayer<Glow>({
      id: 'crowd-buildings',
      data: glows,
      getPolygon: (d) => d.geo.inset,
      extruded: true,
      getElevation: (d) => Math.max(d.top - 0.5, 1),
      getFillColor: [0, 0, 0, 0],
      pickable: true,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // Roof: a faint wash of the level's colour, just above the roof.
    new SolidPolygonLayer<Glow>({
      id: 'crowd-roofs',
      data: flatRoofs,
      getPolygon: (d) => ring3d(d.geo.outline, d.top + ROOF_LIFT),
      getFillColor: (d) => withAlpha(d.level.glow, Math.min(255, d.level.roof * roofBoost)),
      parameters: GLOW_PARAMETERS,
      updateTriggers: { getFillColor: [key, zoomKey] },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // Corners: hairlines of light from the roof, fading out before they reach the street.
    new LineLayer<Edge>({
      id: 'crowd-edges',
      data: edges,
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getColor: (d) => (d.glow.selected ? withAlpha(SELECTED, 235) : withAlpha(d.glow.level.glow, 90 + d.glow.level.halo * 0.6)),
      getWidth: (d) => (d.glow.selected ? 2 : 1.25),
      widthUnits: 'pixels',
      extensions: [lineFade],
      parameters: GLOW_PARAMETERS,
      updateTriggers: { getColor: key, getWidth: key },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // Roof edge: a soft bloom under a crisp neon line. Fixed pixel widths, so it reads from the
    // overview and stays fine close up.
    new PathLayer<Glow>({
      id: 'crowd-rim-glow',
      data: glows,
      getPath: (d) => ring3d(d.geo.outline, d.top + ROOF_LIFT),
      getColor: (d) => withAlpha(d.level.glow, d.selected ? 150 : 70),
      getWidth: (d) => (d.selected ? 14 : d.level.rim),
      widthUnits: 'pixels',
      billboard: true,
      jointRounded: true,
      parameters: GLOW_PARAMETERS,
      updateTriggers: { getColor: key, getWidth: key },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new PathLayer<Glow>({
      id: 'crowd-rim-breath',
      data: packed,
      getPath: (d) => ring3d(d.geo.outline, d.top + ROOF_LIFT),
      getColor: (d) => withAlpha(d.level.glow, 110),
      getWidth: 16,
      widthUnits: 'pixels',
      billboard: true,
      jointRounded: true,
      opacity: breath,
      parameters: GLOW_PARAMETERS,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new PathLayer<Glow>({
      id: 'crowd-rim',
      data: glows,
      getPath: (d) => ring3d(d.geo.outline, d.top + ROOF_LIFT),
      getColor: (d) => rimColor(d, d.level.key === 'quiet' ? 200 : 245),
      getWidth: (d) => (d.selected ? 3.5 : d.level.key === 'quiet' ? 1.25 : 2),
      widthUnits: 'pixels',
      billboard: true,
      jointRounded: true,
      parameters: GLOW_PARAMETERS,
      updateTriggers: { getColor: key, getWidth: key },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new TripsLayer<Trip>({
      id: 'flow-trails',
      data: trips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: [255, 214, 10],
      currentTime: time,
      // A short, faint wake behind each walker (about 3 real seconds at any playback speed):
      // enough to hint at flow without streaking along the streets.
      trailLength: Math.min(600, Math.max(20, speed * 3)),
      fadeTrail: true,
      widthMinPixels: 2,
      capRounded: true,
      jointRounded: true,
      opacity: 0.35,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
  ];
}
