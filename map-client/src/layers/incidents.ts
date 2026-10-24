import { PolygonLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { BuildingFootprint, CampusLocation, Occupancy } from '../sim/playback';
import type { Incident } from '../sim/incidents';
import { labelWidth, type LabelPlacer } from './placement';

interface IncidentMapState {
  incident: Incident;
  location: CampusLocation;
  assemblyLocation: CampusLocation | null;
  endsAt: number;
}

/** The marker represents an aggregate count, not a measured assembly-area boundary. */
export function incidentLayers(run: IncidentMapState | null, time: number, occupancy: Occupancy[], footprints: BuildingFootprint[], placer: LabelPlacer) {
  if (!run || time < run.incident.start) return [];
  const closed = time < run.endsAt;
  const outline = new PolygonLayer<BuildingFootprint>({
    id: 'incident-building-outline',
    data: closed ? footprints.filter(footprint => footprint.id === run.location.building) : [],
    getPolygon: footprint => footprint.polygon,
    filled: false,
    stroked: true,
    getLineColor: [255, 214, 10, 255],
    lineWidthMinPixels: 3,
    getLineWidth: 1,
    pickable: false,
    parameters: { depthCompare: 'always' },
  });
  const assembly = run.assemblyLocation;
  if (!assembly || run.incident.kind === 'building-closure') return closed ? [outline] : [];
  const count = occupancy.find(entry => entry.location.id === assembly.id)?.count ?? 0;
  if (!closed && count === 0) return [];
  const point = { position: [...assembly.position, 1] as [number, number, number], count };
  const label = `Assembly · ${count.toLocaleString()} outdoors`;
  placer.place([point], { position: () => assembly.position,
    width: () => labelWidth(label, 14), height: 28, gap: 8, direction: -1 });
  return [
    outline,
    new ScatterplotLayer({
      id: 'incident-assembly-marker',
      data: [point],
      getPosition: item => item.position,
      getRadius: 5,
      radiusMinPixels: 6,
      radiusMaxPixels: 12,
      stroked: true,
      getFillColor: [255, 214, 10, 200],
      getLineColor: [255, 255, 255, 255],
      lineWidthMinPixels: 2,
      pickable: false,
      parameters: { depthCompare: 'always' },
      slot: 'top',
    }),
    new TextLayer({
      id: 'incident-assembly-label',
      data: [point],
      getPosition: item => item.position,
      getText: () => label,
      getSize: 14,
      getPixelOffset: [0, -22],
      getColor: [255, 255, 255, 255],
      background: true,
      getBackgroundColor: [17, 20, 28, 235],
      backgroundPadding: [8, 5],
      billboard: true,
      pickable: false,
      characterSet: 'auto',
      parameters: { depthCompare: 'always' },
      updateTriggers: { getText: label },
      slot: 'top',
    }),
  ];
}
