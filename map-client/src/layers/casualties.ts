// Aggregate markers for modeled injuries in disaster scenarios. Each marker merges injured events
// within a fixed grid cell (see injuryClusters) and sits at the mean of their recorded positions.
// Fatalities are a panel count, with no marker; a meteor's are also drawn as ragdolls thrown from the
// impact (layers/ragdolls.ts). Markers are plain, non-interactive
// circles with a count; there is no per-person marker. Uncalibrated scenario output, not a prediction.
import type { Layer } from '@deck.gl/core';
import { ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import type { CasualtyEvent } from '../sim/casualties';
import { injuryClusters, type InjuryCluster } from '../sim/incidentProgress';

/** Clusters below this size get no number, which keeps the map to a handful of labels. */
const MIN_LABEL_COUNT = 2;
const MAX_LABELS = 12;

interface Frame { visible: number; clusters: InjuryCluster[]; labelled: InjuryCluster[]; key: string }
// Keyed by the run's event array, so steady frames reuse the same data and deck.gl skips updates.
const cache = new WeakMap<readonly CasualtyEvent[], Frame>();

export function casualtyLayers(events: readonly CasualtyEvent[] | undefined, time: number): Layer[] {
  if (!events?.length) return [];
  const visible = events.reduce((count, event) => count + (event.at <= time ? 1 : 0), 0);
  let frame = cache.get(events);
  if (!frame || frame.visible !== visible) {
    const clusters = injuryClusters(events, time);
    frame = { visible, clusters, labelled: clusters.filter((cluster: InjuryCluster) => cluster.count >= MIN_LABEL_COUNT).slice(0, MAX_LABELS),
      key: clusters.map((cluster: InjuryCluster) => cluster.count).join(',') };
    cache.set(events, frame);
  }
  const { clusters, labelled, key } = frame;
  if (!clusters.length) return [];
  return [
    new ScatterplotLayer({
      id: 'incident-injury-markers',
      data: clusters,
      getPosition: (cluster: InjuryCluster) => [cluster.position[0], cluster.position[1], 1],
      getRadius: (cluster: InjuryCluster) => cluster.radiusPixels,
      radiusUnits: 'pixels',
      stroked: true,
      getFillColor: [244, 236, 220, 170],
      getLineColor: [196, 120, 64, 235],
      lineWidthUnits: 'pixels',
      getLineWidth: 2,
      pickable: false,
      parameters: { depthCompare: 'always' },
      updateTriggers: { getRadius: key },
      slot: 'top',
    }),
    new TextLayer({
      id: 'incident-injury-counts',
      data: labelled,
      getPosition: (cluster: InjuryCluster) => [cluster.position[0], cluster.position[1], 1],
      getText: (cluster: InjuryCluster) => cluster.count.toLocaleString(),
      getSize: 11,
      getColor: [40, 32, 28, 255],
      fontWeight: 600,
      billboard: true,
      pickable: false,
      characterSet: 'auto',
      parameters: { depthCompare: 'always' },
      updateTriggers: { getText: key },
      slot: 'top',
    }),
  ];
}
