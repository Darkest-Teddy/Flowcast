// MBTA on the map: route lines in the official colours, stops, live trains and buses as 3D
// blocks at true scale (exaggerated so they read from campus height), and next-arrival labels
// under each Green Line station.
import { LineLayer, PathLayer, ScatterplotLayer, TextLayer } from '@deck.gl/layers';
import { ScenegraphLayer, SimpleMeshLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import { CubeGeometry } from '@luma.gl/engine';
import type { Color } from '@deck.gl/core';
import { minutesUntil, type Arrival, type TransitSource, type TransitData, type TransitRoute, type TransitStop, type Vehicle } from '../transit/mbta';
import { BU_RED } from '../transit/buShuttle';
import { trackGeometry, type Track, type TrackGeometry } from '../transit/tracks';
import { labelWidth, type LabelPlacer } from './placement';
import { boxAround, setCullBox } from './culling';
import { headingsKey, stableList } from './stable';

const CUBE = new CubeGeometry(); // spans -1..1 on each axis; getScale gives half-dimensions in metres
// True scale vanishes from campus height (a train is under a pixel wide at zoom 15.5), so
// vehicles grow as the camera pulls back: real size at street level, up to ~5x on the overview.
// Buses are a quarter of a train's length, so they start growing a little earlier.
type VehicleKind = 'subway' | 'bus' | 'shuttle';

function vehicleScale(zoom: number, kind: VehicleKind) {
  return kind !== 'subway' ? Math.min(7, Math.max(1, 2 ** (18.4 - zoom))) : Math.min(5, Math.max(1, 2 ** (17.8 - zoom)));
}
// Half-dimensions in metres: a two-car Green Line train (~45 m) and a 40-ft bus.
const HALF_SIZE = { subway: [1.35, 22.5, 1.8], bus: [1.3, 6.1, 1.6], shuttle: [1.3, 6.1, 1.6] } as const;
const STATION_LABEL_HEIGHT = 38;

// Real models when public/models has them (metres, Y-up, front +Z, like the Kenney
// characters); plain blocks otherwise.
const VEHICLE_MODEL_URLS = {
  subway: '/models/mbta-green-line-train.glb',
  bus: '/models/mbta-bus.glb',
  shuttle: '/models/bu-shuttle.glb', // BU red
};
// Same convention as agents.ts: a model facing +Z, stood upright with a 90° roll.
const MODEL_YAW_OFFSET = 180;

export type VehicleModels = Partial<Record<VehicleKind, unknown>>;

export async function loadVehicleModels(): Promise<VehicleModels> {
  const entries = await Promise.all(
    Object.entries(VEHICLE_MODEL_URLS).map(async ([kind, url]) => {
      const head = await fetch(url, { method: 'HEAD' }).catch(() => null);
      // Vite's dev server answers unknown paths with index.html, so check the type too.
      if (!head?.ok || head.headers.get('content-type')?.includes('text/html')) return [kind, undefined];
      return [kind, await load(url, GLTFLoader).catch(() => undefined)];
    }),
  );
  return Object.fromEntries(entries);
}

export function hexToColor(hex: string, alpha = 255): Color {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, alpha];
}

export interface TransitLayerInput {
  data: TransitData;
  feed: TransitSource;
  now: number; // performance.now(), for easing vehicles
  zoom: number;
  placer: LabelPlacer;
  models: VehicleModels;
}

interface RoutePath {
  route: TransitRoute;
  path: [number, number][];
}

// Track geometry only depends on the static route shapes, so build it once per feed.
const geometryCache = new WeakMap<Track[], TrackGeometry>();
function subwayTracks(feed: TransitSource, routes: Map<string, TransitRoute>): TrackGeometry {
  let geometry = geometryCache.get(feed.tracks);
  if (!geometry) {
    geometry = trackGeometry(feed.tracks.filter((t) => routes.get(t.route)?.kind === 'subway'));
    geometryCache.set(feed.tracks, geometry);
  }
  return geometry;
}

// Everything derived from the static route and stop lists, built once. These layers are rebuilt
// every frame, and a fresh `data` array each time made deck.gl re-tesselate every bus route and
// re-upload the stops every frame.
interface StaticTransit {
  routeCount: number;
  stopCount: number;
  routes: Map<string, TransitRoute>;
  busPaths: RoutePath[];
  stops: TransitStop[]; // stations drawn on top of bus stops
  stations: TransitStop[];
  labelled: TransitStop[]; // station labels placed last frame, reused while unchanged
  labelKey: string;
}
const staticCache = new WeakMap<TransitData, StaticTransit>();
function staticTransit(data: TransitData): StaticTransit {
  const cached = staticCache.get(data);
  // BU shuttle routes and stops are merged into the data at runtime: rebuild if the lists grew.
  if (cached && cached.routeCount === data.routes.length && cached.stopCount === data.stops.length) return cached;
  // Draw order, bottom to top: BU shuttle lines, MBTA buses, and the 57 last. It's the primary
  // line along Comm Ave, so nothing covers it where routes share the street.
  const lineRank = (r: TransitRoute) => (r.id === '57' ? 2 : r.kind === 'bus' ? 1 : 0);
  const built: StaticTransit = {
    routeCount: data.routes.length,
    stopCount: data.stops.length,
    routes: new Map(data.routes.map((r) => [r.id, r])),
    busPaths: data.routes
      .filter((r) => r.kind !== 'subway')
      .sort((a, b) => lineRank(a) - lineRank(b))
      .flatMap((route) => route.paths.map(({ path }) => ({ route, path }))),
    stops: [...data.stops].sort((a, b) => Number(a.kind === 'station') - Number(b.kind === 'station')),
    stations: data.stops.filter((s) => s.kind === 'station'),
    labelled: [],
    labelKey: '',
  };
  staticCache.set(data, built);
  return built;
}

export function transitLayers({ data, feed, now, zoom, placer, models }: TransitLayerInput) {
  const cached = staticTransit(data);
  const { routes, busPaths, stations } = cached;
  const kindOf = (routeId: string) => routes.get(routeId)?.kind ?? 'bus';
  const tracks = subwayTracks(feed, routes);
  const vehicles = feed.positionsAt(now);
  // Same vehicles as last frame: same arrays, so only positions (and headings, when they change)
  // are re-uploaded instead of every attribute of each model's 16 primitives.
  const trains = stableList('transit-trains', vehicles.filter((v) => kindOf(v.route) === 'subway'), (v) => v.id);
  const buses = stableList('transit-buses', vehicles.filter((v) => kindOf(v.route) === 'bus'), (v) => v.id);
  const shuttles = stableList('transit-shuttles', vehicles.filter((v) => kindOf(v.route) === 'shuttle'), (v) => v.id);

  const labelText = (s: TransitStop) => {
    // Trains only: Kenmore is also a stop for the 57 and other buses.
    const next: Partial<Record<0 | 1, Arrival>> = {};
    for (const a of feed.nextArrivals(s.id)) {
      if (routes.get(a.route)?.kind === 'subway' && (!next[a.direction] || a.time < next[a.direction]!.time)) next[a.direction] = a;
    }
    const branches = s.routes.filter((r) => routes.get(r)?.kind === 'subway');
    const parts = ([1, 0] as const).flatMap((dir) => {
      const a = next[dir];
      if (!a) return [];
      const route = routes.get(a.route)!;
      // Name the branch where more than one stops here (Kenmore: B, C, D).
      const branch = branches.length > 1 ? `${route.name} ` : '';
      return [`${route.directions[dir]} ${branch}${minutesUntil(a.time)}`];
    });
    return `${s.short}\n${parts.length ? parts.join(' · ') : 'No predictions'}`;
  };
  const texts = new Map(stations.map((s) => [s, labelText(s)]));
  const lifts = placer.place(stations, {
    position: (s) => s.position,
    width: (s) => labelWidth(texts.get(s)!, 12),
    height: STATION_LABEL_HEIGHT,
    direction: 1,
    gap: 12,
    maxLift: 1,
  });
  const labelKey = stations.filter((s) => lifts.has(s)).map((s) => `${s.id}:${lifts.get(s)}:${texts.get(s)}`).join();
  // Same labels, texts and places as last frame: keep the same array, so nothing re-uploads.
  if (labelKey !== cached.labelKey) {
    cached.labelKey = labelKey;
    cached.labelled = stations.filter((s) => lifts.has(s));
  }
  const labelled = cached.labelled;

  const vehicleLayer = (id: string, kind: VehicleKind, data: Vehicle[]) => {
    // Off-screen vehicles skip the model's ~16 draws. Pad by the longest half-length, scaled.
    const scale = vehicleScale(zoom, kind);
    setCullBox(id, models[kind] ? boxAround(data.map((v) => v.position), HALF_SIZE[kind][1] * scale + 5, HALF_SIZE[kind][2] * 2 * scale + 5) : null);
    return models[kind]
      ? new ScenegraphLayer<Vehicle>({
          id,
          data,
          scenegraph: models[kind] as never,
          // No vehicles of this kind on the map: skip the model's ~16 draws.
          visible: data.length > 0,
          sizeScale: vehicleScale(zoom, kind),
          _lighting: 'pbr',
          getPosition: (v) => [v.position[0], v.position[1], 0],
          getOrientation: (v) => [0, MODEL_YAW_OFFSET - v.bearing, 90],
          pickable: true,
          updateTriggers: { getPosition: now, getOrientation: headingsKey(data, (v) => v.bearing) },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        })
      : new SimpleMeshLayer<Vehicle>({
      id,
      data,
      mesh: CUBE,
      sizeScale: vehicleScale(zoom, kind),
      getPosition: (v) => [v.position[0], v.position[1], HALF_SIZE[kind][2] * vehicleScale(zoom, kind)],
      getScale: () => HALF_SIZE[kind] as unknown as [number, number, number],
      // MBTA bearing is clockwise from north; deck.gl yaw is counter-clockwise from the mesh's +y.
      getOrientation: (v) => [0, -v.bearing, 0],
      getColor: (v) => hexToColor(routes.get(v.route)?.color ?? '#888888'),
      material: { ambient: 0.5, diffuse: 0.6, shininess: 32, specularColor: [255, 255, 255] },
      pickable: true,
      updateTriggers: { getPosition: [now, Math.round(zoom * 4)], getOrientation: now },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    });
  };

  return [
    // A light casing under every bus line, so dark ones (BU's black Albany St line) still read.
    new PathLayer<RoutePath>({
      id: 'transit-bus-casing',
      data: busPaths,
      getPath: (d) => d.path,
      getColor: [255, 255, 255, 150],
      getWidth: (d) => (d.route.id === '57' ? 7 : 5.5),
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new PathLayer<RoutePath>({
      id: 'transit-bus-routes',
      data: busPaths,
      getPath: (d) => d.path,
      getColor: (d) => hexToColor(d.route.color, d.route.id === '57' ? 255 : 210),
      getWidth: (d) => (d.route.id === '57' ? 5 : 3.5),
      widthUnits: 'pixels',
      capRounded: true,
      jointRounded: true,
      pickable: true,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // Green Line track: ballast bed, crossties, two steel rails per direction. Real widths in
    // metres, with pixel minimums so the line still reads on the campus overview.
    new PathLayer<{ track: Track; path: [number, number][] }>({
      id: 'transit-track-bed',
      data: tracks.beds,
      getPath: (d) => d.path,
      getColor: [86, 82, 76, 255],
      getWidth: 3.4,
      widthUnits: 'meters',
      widthMinPixels: 4,
      jointRounded: true,
      pickable: true,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new LineLayer<{ from: [number, number]; to: [number, number] }>({
      id: 'transit-track-ties',
      data: tracks.ties,
      getSourcePosition: (d) => d.from,
      getTargetPosition: (d) => d.to,
      getColor: [128, 108, 88, 255],
      getWidth: 0.26,
      widthUnits: 'meters',
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new PathLayer<[number, number][]>({
      id: 'transit-track-rails',
      data: tracks.rails,
      getPath: (d) => d,
      getColor: [196, 200, 206, 255],
      getWidth: 0.12,
      widthUnits: 'meters',
      widthMinPixels: 1,
      jointRounded: true,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new ScatterplotLayer<TransitStop>({
      id: 'transit-stops',
      // Stations on top of bus stops.
      data: cached.stops,
      getPosition: (s) => s.position,
      getRadius: (s) => (s.kind === 'station' ? 9 : s.kind === 'shuttle' ? 6 : 5),
      radiusUnits: 'pixels',
      getFillColor: [255, 255, 255, 255],
      getLineColor: (s) =>
        s.kind === 'station' ? hexToColor('#00843D') : s.kind === 'shuttle' ? hexToColor(BU_RED) : [30, 30, 30, 255],
      getLineWidth: (s) => (s.kind === 'station' ? 3.5 : 2),
      lineWidthUnits: 'pixels',
      stroked: true,
      pickable: true,
      parameters: { depthCompare: 'always' },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'top',
    }),
    vehicleLayer('transit-shuttles', 'shuttle', shuttles),
    vehicleLayer('transit-buses', 'bus', buses),
    vehicleLayer('transit-trains', 'subway', trains),
    new TextLayer<TransitStop>({
      id: 'transit-station-labels',
      data: labelled,
      getPosition: (s) => s.position,
      getText: (s) => texts.get(s)!,
      getSize: 12,
      getColor: [255, 255, 255, 255],
      getBackgroundColor: hexToColor('#00843D', 240), // white on MBTA green: 5.1:1
      getBorderColor: [255, 255, 255, 140],
      getBorderWidth: 1,
      background: true,
      backgroundPadding: [6, 3],
      getTextAnchor: 'middle',
      getAlignmentBaseline: 'top',
      getPixelOffset: (s) => [0, 12 + STATION_LABEL_HEIGHT * (lifts.get(s) ?? 0)],
      fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
      fontWeight: 600,
      characterSet: 'auto',
      lineHeight: 1.25,
      billboard: true,
      pickable: true,
      parameters: { depthCompare: 'always' },
      updateTriggers: { getText: labelKey, getPixelOffset: labelKey },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'top',
    }),
  ];
}

/** Hover text for transit objects; null for anything else. */
export function transitTooltip(object: unknown, data: TransitData, feed: TransitSource): string | null {
  if (!object || typeof object !== 'object') return null;
  const routes = new Map(data.routes.map((r) => [r.id, r]));
  if ('receivedAt' in object) {
    const v = object as Vehicle;
    const route = routes.get(v.route);
    const status = { STOPPED_AT: 'Stopped', INCOMING_AT: 'Arriving', IN_TRANSIT_TO: 'Moving' }[v.status] ?? v.status;
    if (route?.kind === 'shuttle') return `BU Shuttle · ${route.longName}\n${status} · bus ${v.label}`;
    const line = route?.kind === 'subway' ? `Green Line ${route.name}` : `Bus ${route?.name}`;
    return `${line} · ${route?.directions[v.direction] ?? ''}\n${status} · vehicle ${v.label}`;
  }
  if ('platforms' in object) {
    const s = object as TransitStop;
    const lines = feed.nextArrivals(s.id).map((a) => {
      const route = routes.get(a.route)!;
      if (route.kind === 'shuttle') return `${route.longName}: ${minutesUntil(a.time)}`;
      return `${route.kind === 'subway' ? `Green ${route.name}` : route.name} ${route.directions[a.direction]}: ${minutesUntil(a.time)}`;
    });
    return [s.name, ...(lines.length ? lines : ['No predictions right now'])].join('\n');
  }
  if ('path' in object && 'track' in object) {
    const t = (object as { track: Track }).track;
    const r = routes.get(t.route);
    return `Green Line ${r?.name} branch · ${r?.directions[t.direction]} track`;
  }
  if ('path' in object && 'route' in object) {
    const r = (object as RoutePath).route;
    return r.kind === 'shuttle' ? `BU Shuttle · ${r.longName}` : `Bus ${r.name}: ${r.longName}`;
  }
  return null;
}
