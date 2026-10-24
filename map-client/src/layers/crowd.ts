// The prediction, drawn on the map:
//  - each tracked building's real footprint glows from cool to hot with how full it is,
//  - fading trails behind walkers show the flows between buildings,
//  - a label on every building gives the exact "% full" (never colour alone — plan Section 10.3).
// All three work in deck.gl's interleaved mode, so buildings still hide what's behind them.
// (HeatmapLayer doesn't render in interleaved mode, which is why there isn't one.)
import { PolygonLayer, TextLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Color } from '@deck.gl/core';
import type { BuildingFootprint, BuildingOccupancy, Trip } from '../sim/playback';

// One scale for the whole UI: the glow, the label and the dashboard bar always agree.
// Label backgrounds keep white text above 4.5:1 contrast; glows are the brighter twin.
const LEVELS = [
  { min: 0.85, label: 'Packed', color: [189, 0, 38, 240], glow: [239, 68, 68, 200] },
  { min: 0.6, label: 'Busy', color: [180, 60, 8, 240], glow: [249, 115, 22, 195] },
  { min: 0.3, label: 'Moderate', color: [113, 84, 0, 240], glow: [250, 204, 21, 185] },
  { min: 0, label: 'Quiet', color: [30, 34, 44, 230], glow: [45, 212, 191, 150] },
] as const satisfies readonly { min: number; label: string; color: Color; glow: Color }[];

export function crowdLevel(share: number) {
  return LEVELS.find((level) => share >= level.min) ?? LEVELS[LEVELS.length - 1];
}

const LABEL_HEIGHT = 40; // px, two lines plus padding
const MAX_LIFT = 2;

/**
 * Screen-space label placement, busiest (and selected) first: each label sits at its building,
 * or is lifted up to MAX_LIFT label-heights to clear neighbours; if it still overlaps, it's
 * hidden — the dashboard list always has every building. Not CollisionFilterExtension: like
 * HeatmapLayer, it renders nothing in interleaved mode.
 */
function placeLabels(buildings: BuildingOccupancy[], selectedId: string | null, project: Projector) {
  const placed: { x0: number; x1: number; y0: number; y1: number }[] = [];
  const lifts = new Map<string, number>();
  const order = [...buildings].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || b.share - a.share);
  for (const b of order) {
    const [x, y] = project(b.position);
    const half = (Math.max(b.short.length, 16) * 7.5 + 16) / 2;
    for (let lift = 0; lift <= MAX_LIFT; lift++) {
      const box = { x0: x - half, x1: x + half, y0: y - (lift + 1) * LABEL_HEIGHT, y1: y - lift * LABEL_HEIGHT };
      if (!placed.some((p) => box.x0 < p.x1 && p.x0 < box.x1 && box.y0 < p.y1 && p.y0 < box.y1)) {
        placed.push(box);
        lifts.set(b.id, lift);
        break;
      }
    }
  }
  return lifts;
}

export type Projector = (lngLat: [number, number]) => [number, number];

export interface CrowdLayerInput {
  footprints: BuildingFootprint[];
  buildings: BuildingOccupancy[];
  trips: Trip[];
  time: number;
  speed: number;
  selectedId: string | null;
  project: Projector;
}

export function crowdLayers({ footprints, buildings, trips, time, speed, selectedId, project }: CrowdLayerInput) {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const countsKey = buildings.map((b) => b.count).join();
  const lifts = placeLabels(buildings, selectedId, project);
  const visible = buildings.filter((b) => lifts.has(b.id));
  const liftKey = visible.map((b) => `${b.id}:${lifts.get(b.id)}`).join();

  return [
    new PolygonLayer<BuildingFootprint>({
      id: 'crowd-buildings',
      data: footprints,
      getPolygon: (d) => d.polygon,
      extruded: true,
      // A metre taller than the real building so the glow wraps it instead of z-fighting with it.
      getElevation: (d) => d.height + 1,
      getFillColor: (d) => crowdLevel(byId.get(d.id)?.share ?? 0).glow,
      getLineColor: [255, 214, 10, 255],
      getLineWidth: (d) => (d.id === selectedId ? 3 : 0),
      lineWidthUnits: 'pixels',
      stroked: true,
      material: { ambient: 0.6, diffuse: 0.5, shininess: 16, specularColor: [255, 255, 255] },
      pickable: true,
      updateTriggers: { getFillColor: countsKey, getLineWidth: selectedId },
      transitions: { getFillColor: 400 },
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
      // Trails cover a few real seconds of motion whatever the playback speed.
      trailLength: Math.max(90, speed * 5),
      fadeTrail: true,
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
      opacity: 0.75,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new TextLayer<BuildingOccupancy>({
      id: 'crowd-labels',
      data: visible,
      // Anchored at the building's base so the screen-space placement above lines up with it.
      getPosition: (d) => d.position,
      getText: (d) => `${d.short}\n${Math.round(d.share * 100)}% · ${crowdLevel(d.share).label}`,
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'bottom',
      getSize: (d) => (d.id === selectedId ? 16 : 13),
      getColor: [255, 255, 255, 255],
      getBackgroundColor: (d) => crowdLevel(d.share).color,
      getBorderColor: (d) => (d.id === selectedId ? [255, 214, 10, 255] : [255, 255, 255, 90]),
      getBorderWidth: (d) => (d.id === selectedId ? 2 : 1),
      background: true,
      backgroundPadding: [7, 4],
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      fontWeight: 600,
      characterSet: 'auto',
      lineHeight: 1.25,
      billboard: true,
      pickable: true,
      // Draw over buildings rather than being hidden behind them.
      parameters: { depthCompare: 'always' },
      getPixelOffset: (d) => [0, -LABEL_HEIGHT * (lifts.get(d.id) ?? 0) - 6],
      updateTriggers: {
        getText: [countsKey, liftKey],
        getBackgroundColor: [countsKey, liftKey],
        getPixelOffset: liftKey,
        getSize: selectedId,
        getBorderColor: selectedId,
        getBorderWidth: selectedId,
      },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'top',
    }),
  ];
}
