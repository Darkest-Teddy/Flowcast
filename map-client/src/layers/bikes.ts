// Bluebikes on the map: the replayed day's real rides as blue riders with fading trails, and
// BU's docks as rings (their tags are HTML, in TransitTags.tsx). Riders are blocks at true bike proportions (exaggerated as the camera pulls
// back, like the MBTA vehicles) so they read differently from the walking characters.
import { ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CubeGeometry } from '@luma.gl/engine';
import type { Color } from '@deck.gl/core';
import {
  formatDate,
  typicalAt,
  type BikeData,
  type BikeStation,
  type BikeTrip,
  type BluebikesFeed,
  type DockEstimate,
  type RidingBike,
} from '../bikes/bluebikes';

// Dock ring colour: blue normally, red when no bikes, amber when there's nowhere to park.
const DOCK_EMPTY: Color = [220, 38, 38, 255];
const DOCK_FULL: Color = [245, 166, 35, 255];
import { formatClock } from '../sim/playback';

export const BIKE_BLUE: Color = [37, 99, 235, 255];
const TRAIL_BLUE: [number, number, number] = [96, 165, 250];
const CUBE = new CubeGeometry(); // spans -1..1; getScale gives half-dimensions in metres
const HALF_SIZE: [number, number, number] = [0.35, 0.9, 0.6]; // a bike and rider, ~1.8 m long

// Real size vanishes from campus height, so riders grow as the camera pulls back (cf. transit.ts).
function riderScale(zoom: number) {
  return Math.min(10, Math.max(2.5, 2 ** (19.8 - zoom)));
}

export interface BikeLayerInput {
  data: BikeData;
  trips: BikeTrip[];
  riding: RidingBike[];
  time: number;
  speed: number;
  zoom: number;
  /** Bikes and empty docks per station id at the shown time (live, or estimated). */
  dockStatus?: Map<string, DockEstimate>;
}

const dockRing = (e: DockEstimate | undefined): Color => (!e ? BIKE_BLUE : e.bikes === 0 ? DOCK_EMPTY : e.docks === 0 ? DOCK_FULL : BIKE_BLUE);

export function bikeLayers({ data, trips, riding, time, speed, zoom, dockStatus }: BikeLayerInput) {
  const scale = riderScale(zoom);
  const statusKey = dockStatus ? [...dockStatus.values()].map((e) => `${e.bikes}/${e.docks}/${+e.estimated}`).join() : '';
  return [
    new TripsLayer<BikeTrip>({
      id: 'bike-trails',
      data: trips,
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: TRAIL_BLUE,
      currentTime: time,
      trailLength: Math.max(60, speed * 4),
      fadeTrail: true,
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
      opacity: 0.85,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new SimpleMeshLayer<RidingBike>({
      id: 'bike-riders',
      data: riding,
      mesh: CUBE,
      sizeScale: scale,
      getPosition: (d) => [d.position[0], d.position[1], HALF_SIZE[2] * scale],
      getScale: () => HALF_SIZE,
      // Heading is clockwise from north; deck.gl yaw is counter-clockwise from the mesh's +y.
      getOrientation: (d) => [0, -d.heading, 0],
      getColor: BIKE_BLUE,
      material: { ambient: 0.55, diffuse: 0.6, shininess: 32, specularColor: [255, 255, 255] },
      pickable: true,
      updateTriggers: { getPosition: [time, Math.round(zoom * 4)], getOrientation: time },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new ScatterplotLayer<BikeStation>({
      id: 'bike-docks',
      data: data.stations,
      getPosition: (s) => s.position,
      getRadius: 7,
      radiusUnits: 'pixels',
      getFillColor: [255, 255, 255, 255],
      getLineColor: (s) => dockRing(dockStatus?.get(s.id)),
      getLineWidth: 3,
      updateTriggers: { getLineColor: statusKey },
      lineWidthUnits: 'pixels',
      stroked: true,
      pickable: true,
      parameters: { depthCompare: 'always' },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'top',
    }),
  ];
}

/** Hover text for riders and docks; null for anything else. */
export function bikeTooltip(object: unknown, data: BikeData, feed: BluebikesFeed | null, time: number): string | null {
  if (!object || typeof object !== 'object') return null;
  if ('heading' in object && 'trip' in object) {
    const { trip } = object as RidingBike;
    const bike = trip.type === 'electric' ? 'E-bike' : 'Classic bike';
    const rider = trip.member ? 'member' : 'casual rider';
    // The BU end's time is the real one: the undocking for rides leaving BU, the docking otherwise.
    const leavesBu = trip.from !== null && data.stations.some((s) => s.id === trip.from);
    const at = leavesBu ? trip.timestamps[0] : trip.timestamps[trip.timestamps.length - 1];
    return [
      `Bluebikes · ${bike} · ${rider}`,
      `${trip.fromName} → ${trip.toName}`,
      `${leavesBu ? 'Undocked' : 'Docks'} at ${formatClock(at)}, ${formatDate(data.replayDate)}`,
      'Real ride; street route inferred',
    ].join('\n');
  }
  if ('profile' in object && 'gbfsId' in object) {
    const s = object as BikeStation;
    const live = feed?.status(s);
    const typical = typicalAt([s], data.binSeconds, time);
    const lines = [`${s.name} (Bluebikes)`];
    if (live) {
      lines.push(`Now: ${live.bikes} bikes (${live.ebikes} e-bikes) · ${live.docks} empty docks${live.renting ? '' : ' · not renting'}`);
    } else {
      lines.push(feed?.state.error ?? 'Live status loading…');
    }
    lines.push(`Typical ${data.weekday}, next hour: ${Math.round(typical.arrivals)} docked · ${Math.round(typical.departures)} undocked`);
    return lines.join('\n');
  }
  return null;
}
