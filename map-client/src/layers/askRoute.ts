import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';

/** What an Ask answer draws: the walk it describes, and the two ends. */
export interface AskRoute {
  path: [number, number][];
  /** True when the path is a straight-line estimate rather than a bundled walking route. */
  estimate: boolean;
}

const ROUTE: [number, number, number, number] = [0, 122, 255, 255];
const CASING: [number, number, number, number] = [17, 17, 17, 200];

/** A blue walking line with a dark casing, drawn above the crowd rings so it stays readable. */
export function askRouteLayers(route: AskRoute | null): Layer[] {
  if (!route || route.path.length < 2) return [];
  const ends = [route.path[0], route.path[route.path.length - 1]];
  const common = { data: [route], getPath: (r: AskRoute) => r.path, widthUnits: 'pixels' as const, capRounded: true, jointRounded: true, parameters: { depthCompare: 'always' as const } };
  return [
    new PathLayer<AskRoute>({ id: 'ask-route-casing', ...common, getColor: CASING, getWidth: 9 }),
    new PathLayer<AskRoute>({ id: 'ask-route', ...common, getColor: ROUTE, getWidth: route.estimate ? 3 : 5 }),
    new ScatterplotLayer<[number, number]>({
      id: 'ask-route-ends',
      data: ends,
      getPosition: (p) => p,
      getRadius: 7,
      radiusUnits: 'pixels',
      getFillColor: ROUTE,
      getLineColor: CASING,
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      stroked: true,
      parameters: { depthCompare: 'always' as const },
    }),
  ];
}
