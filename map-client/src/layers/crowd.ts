// The prediction, drawn on the map as light rather than paint, so it never hides the buildings
// (Mapbox's own, or the detailed models drawn over them):
//  - a soft pool of light on the ground around each tracked building: its reach and brightness
//    grow with how full the building is; Packed buildings breathe and send out a slow ping,
//  - a thin glowing rim along the roof edge and a faint tint on the roof, in the level's colour,
//  - fine light edges up the building's sharp corners, fading out towards the street,
//  (where the detailed model is several volumes, e.g. CDS's stacked pieces, the rims and edges
//  trace each volume rather than one box over the footprint),
//  - fading trails behind walkers show the flows between buildings.
// The tags above the buildings ("CDS · 87% · Packed", never colour alone, plan Section 10.3) are
// HTML, in BuildingTags.tsx. Everything here works in deck.gl's interleaved mode, so buildings
// still hide what's behind them (HeatmapLayer doesn't render in interleaved mode).
import { LineLayer, PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Color } from '@deck.gl/core';
import type { BuildingFootprint, BuildingOccupancy, Trip } from '../sim/playback';
import { footprintGeometry, roundedOffset, volumeGeometry, type FootprintGeometry } from './crowdGeometry';
import type { ModelVolumes, RoofHeights } from './crowdGeometry';
import { GlowFadeExtension, HALO_Z, HALO_Z_RANGE } from './crowdGlow';

type RGB = readonly [number, number, number];

import { crowdLevel, type CrowdLevelInfo } from './crowdLevels';
export { crowdLevel, type CrowdLevelInfo };

/**
 * CSS custom properties for a level. On the always-dark tags: `--lv` ("r, g, b" for rgb()/rgba())
 * and its pale text twin `--lv-text`. On the panels, which follow the light or dark theme:
 * `--lv-ink` and `--lv-fill`, the theme's --crowd-* tokens (theme/tokens.css).
 */
export function crowdLevelStyle(share: number): Record<string, string> {
  const level = crowdLevel(share);
  return {
    '--lv': level.glow.slice(0, 3).join(', '),
    '--lv-text': level.text,
    '--lv-ink': `var(--crowd-${level.key}-text)`,
    '--lv-fill': `var(--crowd-${level.key})`,
  };
}

/** The selected building is outlined in white: every hue already means a level. */
const SELECTED: RGB = [255, 255, 255];
/** A building an event's "Show on map" picked: the whole glow turns this orange (styles.css --tag-spotlight-rgb). */
export const SPOTLIGHT: RGB = [251, 146, 60];
/** A building closed by its published hours: a faint slate glow with no level colour (the tag says Closed). */
const CLOSED_LEVEL: CrowdLevelInfo = { ...crowdLevel(0), glow: [148, 163, 184, 140], halo: 36, rim: 3 };
/** Roof glow floats just above the roof (the detailed models' roofs sit 0.5 m above Mapbox's). */
const ROOF_LIFT = 0.9;
const BREATH_MS = 2400;
const PING_MS = 2600;

const reducedMotion = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** How far the ground glow reaches past the building, in metres: grows with how full it is. */
function haloReach(share: number) {
  return 6 + 24 * Math.min(Math.max(share, 0), 1.2);
}

// Model heights and volumes by OSM id, read from building-models.json without its context
// (scenery) buildings, which never glow (crowdGeometry.ts, so the tests can reach them).
export { modelRoofHeights, modelVolumes, type ModelVolumes, type RoofHeights } from './crowdGeometry';

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
  level: CrowdLevelInfo;
  selected: boolean;
  /** Picked by an event: drawn in SPOTLIGHT orange rather than its crowd level's colour. */
  spotlit: boolean;
  /** The glow's colour: the crowd level's, or orange for an event's building. */
  tint: readonly number[];
  /** Ground halo: outer ring (fade 0) and inner ring (fade 1), with the fade carried in z. */
  halo: [number, number, number][][];
}

interface Edge {
  source: [number, number, number];
  target: [number, number, number];
  glow: Glow;
}

/** One stretch of roof rim: the footprint outline, or one volume's visible roof edge. */
interface Rim {
  path: [number, number, number][];
  glow: Glow;
}

const withAlpha = (rgb: readonly number[], a: number): Color => [rgb[0], rgb[1], rgb[2], Math.round(a)];
const ring3d = (ring: [number, number][], z: number) => ring.map(([x, y]) => [x, y, z] as [number, number, number]);

// The glow geometry only changes when the counts (or the selection) do, twice a second at most;
// between those, every frame reuses the same arrays so deck.gl doesn't re-tessellate anything.
let cached: {
  key: string;
  footprints: BuildingFootprint[];
  glows: Glow[];
  flatRoofs: Glow[];
  packed: Glow[];
  edges: Edge[];
  rims: Rim[];
  packedRims: Rim[];
} | null = null;

function buildGlows(footprints: BuildingFootprint[], buildings: BuildingOccupancy[], selectedId: string | null, spotlitId: string | null, roofs?: RoofHeights, volumes?: ModelVolumes) {
  const key = `${selectedId}|${spotlitId}|${roofs?.size}|${volumes?.size}|${buildings.map((b) => `${b.id}:${b.count}:${b.share}${b.closed ? ':c' : ''}`).join()}`;
  if (cached && cached.key === key && cached.footprints === footprints) return cached;
  const shares = new Map(buildings.map((b) => [b.id, b.share]));
  const closed = new Set(buildings.filter((b) => b.closed).map((b) => b.id));
  const glows: Glow[] = [];
  for (const f of footprints) {
    if (!shares.has(f.id)) continue;
    const geo = footprintGeometry(f);
    if (!geo) continue;
    const share = shares.get(f.id) ?? 0;
    const outer = roundedOffset(geo.hull, haloReach(share)).map(geo.toLngLat);
    const inner = roundedOffset(geo.hull, 0.5).map(geo.toLngLat);
    const level = closed.has(f.id) ? CLOSED_LEVEL : crowdLevel(share);
    const spotlit = f.id === spotlitId;
    glows.push({
      id: f.id,
      geo,
      top: ringTop(f, footprints, roofs),
      share,
      level,
      selected: f.id === selectedId,
      spotlit,
      tint: spotlit ? SPOTLIGHT : level.glow,
      halo: [ring3d(outer, HALO_Z), ring3d(inner, HALO_Z + HALO_Z_RANGE)],
    });
  }
  const edges: Edge[] = [];
  const rims: Rim[] = [];
  const traced = new Set<string>();
  for (const glow of glows) {
    const massing = volumes?.get(glow.id);
    if (!massing) {
      for (const [x, y] of glow.geo.corners) edges.push({ source: [x, y, 0], target: [x, y, glow.top + ROOF_LIFT], glow });
      rims.push({ path: ring3d(glow.geo.outline, glow.top + ROOF_LIFT), glow });
      continue;
    }
    // A modelled building's volumes are traced once, on its first ring (Warren has seven).
    if (traced.has(glow.id)) continue;
    traced.add(glow.id);
    const { rims: volumeRims, edges: volumeEdges } = volumeGeometry(massing);
    for (const r of volumeRims) rims.push({ path: ring3d(r.path, r.top + ROOF_LIFT), glow });
    for (const { at: [x, y], z0, z1 } of volumeEdges) edges.push({ source: [x, y, z0], target: [x, y, z1 + ROOF_LIFT], glow });
  }
  // The roof wash only where the model's top is its roof. Where a tower, spire or pitched roof
  // rises well above the footprint (CAS's tower, CDS's crown), a tinted plane up there would float
  // over the real roof, so those keep just the outline cage around the whole model.
  const flatRoofs = glows.filter((g) => g.top <= g.geo.height * 1.2 + 3);
  // An event's orange building doesn't also pulse in its crowd colour.
  const packed = glows.filter((g) => g.level.key === 'packed' && !g.spotlit);
  const packedRims = rims.filter((r) => r.glow.level.key === 'packed' && !r.glow.spotlit);
  cached = { key, footprints, glows, flatRoofs, packed, edges, rims, packedRims };
  return cached;
}

export interface CrowdLayerInput {
  footprints: BuildingFootprint[];
  buildings: BuildingOccupancy[];
  trips: Trip[];
  time: number;
  speed: number;
  selectedId: string | null;
  /** The selected building when an event's Show on map picked it: glows orange. */
  spotlitId?: string | null;
  /** Map zoom: the overview gets a stronger wash so it reads as a heat map from afar. */
  zoom: number;
  /** Detailed-model heights, when the models are drawn (modelRoofHeights). */
  roofHeights?: RoofHeights;
  /** Detailed-model massing, when the models are drawn (modelVolumes). */
  volumes?: ModelVolumes;
}

const heightFade = new GlowFadeExtension({ mode: 'height', power: 1.4 });
const lineFade = new GlowFadeExtension({ mode: 'line', power: 1.6 });
// Light adds to the scene instead of covering it, and never blocks what's drawn after it.
// The detailed models (buildings.ts) are pulled 1200 depth units towards the camera so they beat
// Mapbox's own boxes; the glow is pulled a little further, so a rim on a model's roof line or an
// edge just outside its walls is never swallowed by the model it outlines.
const GLOW_PARAMETERS = { depthWriteEnabled: false, depthBias: -1, depthBiasSlopeScale: -1600 } as const;

export function crowdLayers({ footprints, buildings, trips, time, speed, selectedId, spotlitId = null, zoom, roofHeights, volumes }: CrowdLayerInput) {
  const { glows, packed, edges, rims, packedRims, key } = buildGlows(footprints, buildings, selectedId, spotlitId, roofHeights, volumes);
  // 1 from street level to zoom 17.5, rising to 1.9 at the zoom 15.5 overview.
  const far = Math.min(Math.max((17.5 - zoom) / 2, 0), 1);
  const roofBoost = 1 + 0.9 * far;
  const haloBoost = 1 + 0.35 * far;
  const zoomKey = far.toFixed(2);
  const now = performance.now();
  const breath = reducedMotion ? 0.6 : 0.5 + 0.5 * Math.sin((now / BREATH_MS) * 2 * Math.PI);
  const ping = (now % PING_MS) / PING_MS;
  const rimColor = (g: Glow, a: number) => (g.spotlit ? withAlpha(SPOTLIGHT, 255) : g.selected ? withAlpha(SELECTED, 255) : withAlpha(g.level.glow, a));

  return [
    // Ground: a soft pool of light around each building.
    new SolidPolygonLayer<Glow>({
      id: 'crowd-halo',
      data: glows,
      getPolygon: (d) => d.halo,
      getFillColor: (d) => withAlpha(d.tint, Math.min(255, (d.spotlit ? Math.max(d.level.halo, 110) : d.level.halo) * haloBoost)),
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
    // (No roof wash: a filled plane at the model's top floated as a tinted sheet wherever the top
    // isn't a flat roof over the whole footprint, e.g. over Marsh Plaza next to CAS. The rim,
    // edges and halo carry the level.)
    // Corners: hairlines of light from the roof, fading out before they reach the street.
    new LineLayer<Edge>({
      id: 'crowd-edges',
      data: edges,
      getSourcePosition: (d) => d.source,
      getTargetPosition: (d) => d.target,
      getColor: (d) => (d.glow.selected ? withAlpha(d.glow.spotlit ? SPOTLIGHT : SELECTED, 235) : withAlpha(d.glow.level.glow, 90 + d.glow.level.halo * 0.6)),
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
    new PathLayer<Rim>({
      id: 'crowd-rim-glow',
      data: rims,
      getPath: (d) => d.path,
      getColor: ({ glow: d }) => withAlpha(d.tint, d.selected ? 150 : 70),
      getWidth: ({ glow: d }) => (d.selected ? 14 : d.level.rim),
      widthUnits: 'pixels',
      billboard: true,
      jointRounded: true,
      parameters: GLOW_PARAMETERS,
      updateTriggers: { getColor: key, getWidth: key },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new PathLayer<Rim>({
      id: 'crowd-rim-breath',
      data: packedRims,
      getPath: (d) => d.path,
      getColor: (d) => withAlpha(d.glow.level.glow, 110),
      getWidth: 16,
      widthUnits: 'pixels',
      billboard: true,
      jointRounded: true,
      opacity: breath,
      parameters: GLOW_PARAMETERS,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new PathLayer<Rim>({
      id: 'crowd-rim',
      data: rims,
      getPath: (d) => d.path,
      getColor: ({ glow: d }) => rimColor(d, d.level.key === 'quiet' ? 200 : 245),
      getWidth: ({ glow: d }) => (d.selected ? 3.5 : d.level.key === 'quiet' ? 1.25 : 2),
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
