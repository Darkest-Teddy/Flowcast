// Parking lots on the map, tinted by how full they are on the app's one four-step scale
// (crowdLevel: the tags carry the words and numbers, never the colour alone). Two layers for every
// lot together, whatever the count: one SolidPolygonLayer for the fills (surface lots on the
// ground, garage structures on their roofs) and one PathLayer for the outlines (garages under
// another building, Agganis and Warren, are only outlined at street level). The data arrays are
// built once per data load and never change, so deck.gl uploads the geometry once and only
// re-runs the colour accessors when a lot changes level (the `levelKey` trigger). Nothing is
// created when the Parking toggle is off: App doesn't call this.
import { PathLayer, SolidPolygonLayer } from '@deck.gl/layers';
import type { Color, Layer } from '@deck.gl/core';
import { crowdLevel } from './crowd';
import { setCullBox, boxAround } from './culling';
import type { ParkingData, ParkingState } from '../sim/parking';

interface LotShape {
  index: number;
  ring: [number, number, number][];
  fill: boolean;
}

/** Surface lots sit just above the street; garage roofs just above the structure. */
const GROUND_Z = 0.3;
const ROOF_LIFT = 1;
const FILL_ALPHA = { surface: 120, roof: 150 } as const;

const UNDER_BUILDING_GAP = 3.5;

/** Scale about the centroid that moves the ring out by about `metres` on average. */
function outwardScale(ring: [number, number][], metres: number): number {
  if (!ring.length) return 1;
  const cx = ring.reduce((a, p) => a + p[0], 0) / ring.length;
  const cy = ring.reduce((a, p) => a + p[1], 0) / ring.length;
  const kx = 111_320 * Math.cos((cy * Math.PI) / 180);
  const mean = ring.reduce((a, [x, y]) => a + Math.hypot((x - cx) * kx, (y - cy) * 110_540), 0) / ring.length;
  return mean > 1 ? 1 + metres / mean : 1;
}

let shapesFor: ParkingData | null = null;
let shapes: LotShape[] = [];

/** One shape per lot, the same array for as long as the data stands. */
export function parkingShapes(data: ParkingData): LotShape[] {
  if (data === shapesFor) return shapes;
  shapesFor = data;
  shapes = data.lots.map((lot, index) => {
    const z = lot.underBuilding || lot.kind === 'surface' ? GROUND_Z : lot.height + ROOF_LIFT;
    // A garage under another building is outlined a few metres outside its walls, or they hide the line.
    const grow = lot.underBuilding ? outwardScale(lot.polygon, UNDER_BUILDING_GAP) : 1;
    const [cx, cy] = lot.position;
    const ring = lot.polygon.map(([x, y]) => [cx + (x - cx) * grow, cy + (y - cy) * grow, z] as [number, number, number]);
    if (ring.length && (ring[0][0] !== ring.at(-1)![0] || ring[0][1] !== ring.at(-1)![1])) ring.push(ring[0]);
    return { index, ring, fill: !lot.underBuilding };
  });
  const box = boxAround(data.lots.flatMap((l) => l.polygon), 30, Math.max(5, ...data.lots.map((l) => l.height + 2)));
  setCullBox('parking-fills', box);
  setCullBox('parking-outlines', box);
  return shapes;
}

export function lotColor(share: number, full: boolean, alpha: number): Color {
  const [r, g, b] = crowdLevel(full ? 1 : share).glow;
  return [r, g, b, alpha];
}

export function parkingLayers(data: ParkingData, state: ParkingState): Layer[] {
  const all = parkingShapes(data);
  const lots = state.lots;
  return [
    new SolidPolygonLayer<LotShape>({
      id: 'parking-fills',
      data: all,
      getPolygon: (d) => d.ring,
      getFillColor: (d) => {
        const s = lots[d.index];
        if (!d.fill || !s) return [0, 0, 0, 0];
        return lotColor(s.share, s.full, s.lot.kind === 'surface' ? FILL_ALPHA.surface : FILL_ALPHA.roof);
      },
      updateTriggers: { getFillColor: state.levelKey },
      pickable: true,
      parameters: { depthWriteEnabled: false },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new PathLayer<LotShape>({
      id: 'parking-outlines',
      data: all,
      getPath: (d) => d.ring,
      getColor: (d) => {
        const s = lots[d.index];
        return s ? lotColor(s.share, s.full, 230) : [0, 0, 0, 0];
      },
      getWidth: (d) => (d.fill ? 1.6 : 4),
      widthUnits: 'meters',
      widthMinPixels: 1.5,
      updateTriggers: { getColor: state.levelKey },
      parameters: { depthWriteEnabled: false },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
  ];
}

/** The lot index under the pointer (the fills are pickable), or null. */
export function parkingUnder(object: unknown): number | null {
  return object && typeof object === 'object' && 'fill' in object && 'index' in object && 'ring' in object ? (object as LotShape).index : null;
}
