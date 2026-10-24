// The prediction, drawn on the map:
//  - each tracked building's real footprint glows from cool to hot with relative simulated activity,
//  - fading trails behind walkers show the flows between buildings,
//  - a label on every building gives its simulated student count.
// All three work in deck.gl's interleaved mode, so buildings still hide what's behind them.
// (HeatmapLayer doesn't render in interleaved mode, which is why there isn't one.)
import { PolygonLayer, TextLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import type { Color } from '@deck.gl/core';
import type { BuildingFootprint, BuildingOccupancy, Trip } from '../sim/playback';
import { labelWidth, type LabelPlacer } from './placement';

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

export interface CrowdLayerInput {
  footprints: BuildingFootprint[];
  buildings: BuildingOccupancy[];
  trips: Trip[];
  time: number;
  speed: number;
  selectedId: string | null;
  /** Shared with the other label layers so no two labels overlap. */
  placer: LabelPlacer;
}

export function crowdLayers({ footprints, buildings, trips, time, speed, selectedId, placer }: CrowdLayerInput) {
  const byId = new Map(buildings.map((b) => [b.id, b]));
  const countsKey = buildings.map((b) => b.count).join();
  // Selected first, then busiest: if labels must be dropped, the quiet ones go (the dashboard
  // list still has every building).
  const order = [...buildings].sort((a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || b.share - a.share);
  const lifts = placer.place(order, {
    position: (d) => d.position,
    width: (d) => labelWidth(`${d.short}\n1200 students`, 13),
    height: LABEL_HEIGHT,
    direction: -1,
  });
  const visible = order.filter((b) => lifts.has(b));
  const liftKey = visible.map((b) => `${b.id}:${lifts.get(b)}`).join();

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
    new TextLayer<BuildingOccupancy>({
      id: 'crowd-labels',
      data: visible,
      // Anchored at the building's base so the screen-space placement above lines up with it.
      getPosition: (d) => d.position,
      getText: (d) => `${d.short}\n${d.count} ${d.count === 1 ? 'student' : 'students'}`,
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
      getPixelOffset: (d) => [0, -LABEL_HEIGHT * (lifts.get(d) ?? 0) - 6],
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
