import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { Color } from '@deck.gl/core';
import { countText, type MobilityPoint, type MobilityView } from '../data/mobility';
import { labelWidth, type LabelPlacer } from './placement';
import { labelFont } from './labelFont';

const ROAD: Color = [245, 180, 62, 220];
const WALKING: Color = [232, 121, 163, 220];
const SELECTED: Color = [255, 214, 10, 255];

function label(point: MobilityPoint): string {
  return point.mobilityKind === 'road'
    ? `${countText(point.value)} vehicles/h\n${countText(point.bikes ?? 0)} bikes/h`
    : `${countText(point.value)} crossings/h`;
}

/** Count-site markers; existing Bluebikes layers retain ownership of riders and docks. */
export function mobilityLayers(view: MobilityView, { selectedId = null, placer }: {
  selectedId?: string | null;
  placer?: LabelPlacer;
} = {}) {
  if (view.mode === 'off' || view.mode === 'bikes') return [];
  const color = view.mode === 'roads' ? ROAD : WALKING;
  const points = view.points;
  const lifts = placer?.place(points, {
    position: (point) => point.position,
    width: (point) => labelWidth(label(point), 12),
    height: 34,
    direction: 1,
    gap: 10,
    maxLift: 2,
  });
  const tagged = lifts ? points.filter((point) => lifts.has(point)) : points;
  return [
    new ScatterplotLayer<MobilityPoint>({
      id: 'mobility-count-sites',
      data: points,
      getPosition: (point) => point.position,
      getRadius: (point) => 5 + Math.min(15, Math.sqrt(point.value) / 3),
      radiusUnits: 'pixels',
      getFillColor: color,
      getLineColor: (point) => point.id === selectedId ? SELECTED : [255, 255, 255, 220],
      getLineWidth: (point) => point.id === selectedId ? 3 : 1,
      lineWidthUnits: 'pixels',
      stroked: true,
      pickable: true,
      parameters: { depthCompare: 'always' },
      updateTriggers: { getLineColor: selectedId, getLineWidth: selectedId },
      // @ts-expect-error Mapbox reads slot to place counts above city geometry.
      slot: 'top',
    }),
    new TextLayer<MobilityPoint>({
      id: 'mobility-count-labels',
      data: tagged,
      getPosition: (point) => point.position,
      getText: label,
      getPixelOffset: (point) => [0, 12 + (lifts?.get(point) ?? 0) * 34],
      getSize: 12,
      getColor: [255, 255, 255, 255],
      getBackgroundColor: [24, 28, 36, 240],
      getBorderColor: color,
      getBorderWidth: 1,
      background: true,
      backgroundPadding: [5, 3],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      fontFamily: labelFont(),
      fontWeight: 600,
      characterSet: 'auto',
      billboard: true,
      pickable: true,
      parameters: { depthCompare: 'always' },
      updateTriggers: { getPixelOffset: tagged.map((point) => lifts?.get(point)).join() },
      // @ts-expect-error Mapbox reads slot to place counts above city geometry.
      slot: 'top',
    }),
  ];
}

export function mobilityTooltip(object: unknown): string | null {
  if (!object || typeof object !== 'object' || !('mobilityKind' in object)) return null;
  const point = object as MobilityPoint;
  if (point.mobilityKind !== 'road' && point.mobilityKind !== 'pedestrian') return null;
  return `${point.name}\n${label(point)}\n${point.details}\nSurvey: ${point.period}`;
}
