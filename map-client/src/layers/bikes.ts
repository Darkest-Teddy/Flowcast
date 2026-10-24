// Bluebikes on the map: the replayed day's real rides as Kenney characters pedalling Bluebikes
// (classic or e-bike, as the ride was), with fading trails, and BU's docks as rings (their tags
// are HTML, in TransitTags.tsx).
//
// Each rider model (scripts/make_bike_models.py: bike + seated character, with wheels, cranks and
// legs animated in one 'ride' clip) is one GPU-instanced ScenegraphLayer, and every such layer is
// its own render pass in interleaved mode, so there are just six: three characters on classic
// bikes, three on e-bikes. Each layer runs its pedalling clock at its own offset and speed.
import { ScatterplotLayer } from '@deck.gl/layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { ScenegraphLayer, SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { CubeGeometry } from '@luma.gl/engine';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
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
import { phaseOf } from './agents';
import { headingsKey, stableList } from './stable';
import { bakeStaticPose } from './gltf-static';

// Dock ring colour: blue normally, red when no bikes, amber when there's nowhere to park.
const DOCK_EMPTY: Color = [220, 38, 38, 255];
const DOCK_FULL: Color = [245, 166, 35, 255];
import { formatClock } from '../sim/playback';

export const BIKE_BLUE: Color = [37, 99, 235, 255];
const TRAIL_BLUE: [number, number, number] = [96, 165, 250];
// Fallback until (or if) the models load: blocks at bike-and-rider proportions.
const CUBE = new CubeGeometry(); // spans -1..1; getScale gives half-dimensions in metres
const HALF_SIZE: [number, number, number] = [0.35, 0.9, 0.6]; // a bike and rider, ~1.8 m long

// The rider models (metres, real size), classic bikes then e-bikes; see make_bike_models.py.
const CLASSIC_RIDERS = ['female-b', 'male-a', 'female-c'];
const ELECTRIC_RIDERS = ['male-f', 'female-e', 'male-b'];
const RIDER_MODELS = [
  ...CLASSIC_RIDERS.map((c) => `/models/bluebike-rider-${c}.glb`),
  ...ELECTRIC_RIDERS.map((c) => `/models/bluebike-electric-rider-${c}.glb`),
];
const RIDE_CLIP_SECONDS = 0.9; // one pedal stroke
// One clock per layer, with staggered starts and slightly different cadences.
const RIDE_ANIMATIONS = RIDER_MODELS.map((_, i) => ({
  '*': { playing: true, startTime: (((i * 5) % RIDER_MODELS.length) / RIDER_MODELS.length) * RIDE_CLIP_SECONDS, speed: 0.9 + (i % 3) * 0.08 },
}));
// The models face +Z with +Y up, like the Kenney walkers: roll 90 stands them up, and this
// offset turns a compass heading into deck.gl yaw (cf. agents.ts).
const YAW_OFFSET = 180;
// The walkers' minimum size (agents.ts: 22 px per 2.3 m model unit) in pixels per metre, so
// riders and walkers share one scale at street zoom; pulled back, riders grow up to 1.5x that
// so the bikes still read on the campus overview.
const WALKER_PIXELS_PER_METRE = 22 / 2.3;
const minPixelsPerMetre = (zoom: number) => WALKER_PIXELS_PER_METRE * Math.min(1.5, Math.max(1, 1 + (18.6 - zoom) * 0.2));

let riderModels: unknown[] | null = null;
// Still copies (gltf-static.ts) for the overview, where pedalling and the rider's face are a few
// pixels: one classic and one e-bike rider, 2 draws each instead of 7 for each of six models, and
// no animation to update. The six animated models take over from here in.
let stillRiderModels: unknown[] | null = null;
const ANIMATED_FROM_ZOOM = 17;

/** Fetch and parse the rider models once; riders are drawn as blocks until they arrive. */
export async function loadBikeModels(): Promise<void> {
  riderModels = await Promise.all(RIDER_MODELS.map((url) => load(url, GLTFLoader)));
  const still = [riderModels[0], riderModels[CLASSIC_RIDERS.length]].map((m) => bakeStaticPose(m));
  stillRiderModels = still.every(Boolean) ? still : null;
}

// A ride's model: its bike type, then a character picked from the ride (the same all ride long).
const modelOfTrip = new WeakMap<BikeTrip, number>();
function riderModel(trip: BikeTrip): number {
  let model = modelOfTrip.get(trip);
  if (model === undefined) {
    const pick = phaseOf(`${trip.from}|${trip.to}|${trip.timestamps[0]}`, CLASSIC_RIDERS.length * ELECTRIC_RIDERS.length);
    model = trip.type === 'electric' ? CLASSIC_RIDERS.length + (pick % ELECTRIC_RIDERS.length) : pick % CLASSIC_RIDERS.length;
    modelOfTrip.set(trip, model);
  }
  return model;
}

// Real size vanishes from campus height, so riders grow as the camera pulls back (cf. transit.ts),
// down to true size at street zoom.
function riderScale(zoom: number) {
  return Math.min(10, Math.max(1, 2 ** (19.8 - zoom)));
}

function riderLayers(riding: RidingBike[], time: number, zoom: number) {
  const scale = riderScale(zoom);
  const models = riderModels;
  if (!models) {
    const size = Math.max(2.5, scale);
    return [
      new SimpleMeshLayer<RidingBike>({
        id: 'bike-riders',
        data: riding,
        mesh: CUBE,
        sizeScale: size,
        getPosition: (d) => [d.position[0], d.position[1], HALF_SIZE[2] * size],
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
    ];
  }
  const animated = !stillRiderModels || zoom >= ANIMATED_FROM_ZOOM;
  const buckets: RidingBike[][] = models.map(() => []);
  const stillBuckets: RidingBike[][] = [[], []]; // classic, electric
  for (const r of riding) {
    if (animated) buckets[riderModel(r.trip)].push(r);
    else stillBuckets[r.trip.type === 'electric' ? 1 : 0].push(r);
  }
  // Both sets of layers stay in the list (the unused one empty and hidden), so crossing the zoom
  // threshold doesn't re-upload the models.
  const sets = [
    { prefix: 'bike-riders', models, groups: buckets, active: animated },
    ...(stillRiderModels ? [{ prefix: 'bike-riders-still', models: stillRiderModels, groups: stillBuckets, active: !animated }] : []),
  ];
  return sets.flatMap(({ prefix, models: set, groups, active }) => groups.map(
    (bucket, i) => {
      // Same riders as last frame: same array, so only positions (and headings, when one turns)
      // are re-uploaded, not every attribute of every part of the model.
      const data = stableList(`${prefix}-${i}`, active ? bucket : NOBODY, (r) => `${r.trip.from}|${r.trip.to}|${r.trip.timestamps[0]}`);
      return new ScenegraphLayer<RidingBike>({
        id: `${prefix}-${i}`,
        data,
        scenegraph: set[i] as never,
        // Stable per layer, so each clock is configured once.
        ...(prefix === 'bike-riders' ? { _animations: RIDE_ANIMATIONS[i] } : {}),
        _lighting: 'pbr',
        sizeScale: scale,
        sizeMinPixels: minPixelsPerMetre(zoom),
        getPosition: (d) => d.position,
        getOrientation: (d) => [0, YAW_OFFSET - d.heading, 90],
        pickable: true,
        updateTriggers: { getPosition: time, getOrientation: headingsKey(data, (r) => Math.round(r.heading)) },
        // Empty layers keep their GPU copies and clocks but aren't drawn.
        visible: data.length > 0,
        // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
        slot: 'middle',
      });
    },
  ));
}
const NOBODY: RidingBike[] = [];

// The trails layer only gets the rides under way near the shown time (picked per window, so the
// array, and deck.gl's buffers, stay the same between windows) rather than the whole day's.
let trailWindow: { trips: BikeTrip[]; start: number; size: number; trail: number; out: BikeTrip[] } | null = null;
function activeTrips(trips: BikeTrip[], time: number, speed: number, trail: number): BikeTrip[] {
  const size = Math.min(1800, Math.max(60, Math.abs(speed) * 2));
  const start = Math.floor(time / size) * size;
  const w = trailWindow;
  if (w && w.trips === trips && w.start === start && w.size === size && w.trail >= trail) return w.out;
  const from = start - trail;
  const to = start + size;
  const out = trips.filter((t) => t.timestamps[0] <= to && t.timestamps[t.timestamps.length - 1] >= from);
  trailWindow = { trips, start, size, trail, out };
  return out;
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
  const trailLength = Math.max(60, speed * 4);
  const statusKey = dockStatus ? [...dockStatus.values()].map((e) => `${e.bikes}/${e.docks}/${+e.estimated}`).join() : '';
  return [
    new TripsLayer<BikeTrip>({
      id: 'bike-trails',
      data: activeTrips(trips, time, speed, trailLength),
      getPath: (d) => d.path,
      getTimestamps: (d) => d.timestamps,
      getColor: TRAIL_BLUE,
      currentTime: time,
      trailLength,
      fadeTrail: true,
      widthMinPixels: 3,
      capRounded: true,
      jointRounded: true,
      opacity: 0.85,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    ...riderLayers(riding, time, zoom),
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
