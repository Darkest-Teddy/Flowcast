// Street furniture at real scale: traffic signals (from OpenStreetMap, placed per approach by
// data-pipeline/fetch_street.py) with simulated, animated lamps; raised Green Line platforms
// and shelters at the surface stations; and a sign (plus a shelter at busier stops) at every
// MBTA bus and BU shuttle stop, turned to face its street.
//
// Orientation (verified against @deck.gl/mesh-layers' utils/matrix.js and on screen): with
// getOrientation [0, yaw, 90] the 90° roll stands a Y-up model upright, and then model +Z points
// at compass bearing 180 - yaw and model +X at bearing 90 - yaw (that is, +Z bearing - 90:
// glTF is right-handed, so with +Y up, +X is 90° anticlockwise of +Z seen from above).
// So to point a model's +X at bearing b: yaw = 90 - b.
import { PathLayer, PolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import type { Color } from '@deck.gl/core';
import type { MbtaFeed, TransitData, TransitRoute, TransitStop } from '../transit/mbta';
import { offsetPath, pointAlong, snapToTracks, type Track } from '../transit/tracks';
import { PLATFORM_LENGTH, platformCentre } from '../transit/motion';
import { lampAt, registerSignals, secondsToChange, splitFor, timingFor, timingLabel, type IntersectionTiming, type Lamp } from '../sim/signals';
import { transitTooltip } from './transit';

/** Below this zoom the 3D furniture is too small to matter, so none of it draws. */
export const STREET_DETAIL_ZOOM = 16.5;

export interface StreetSignal {
  id: string;
  position: [number, number];
  bearing: number; // compass direction the heads face (toward oncoming traffic)
  group: string; // intersection id
  axis: 0 | 1; // 0 = main road, 1 = crossing road
  road: string;
  campus: string;
  flash?: boolean;
  stopLine?: [number, number]; // where this approach's traffic stops
  approach?: number; // its direction of travel (compass degrees)
  movement?: string; // "EB", "WB"... where a published plan names movements
}

type ModelName = 'signal' | 'stop' | 'stopSign' | 'shelter';
const MODEL_URLS: Record<ModelName, string> = {
  signal: '/models/traffic-signal.glb',
  stop: '/models/bus-stop.glb',
  stopSign: '/models/bus-stop-sign.glb',
  shelter: '/models/green-line-shelter.glb',
};

export interface Street {
  signals: (StreetSignal & { streetKind: 'signal' })[];
  models: Partial<Record<ModelName, unknown>>;
}

export async function loadStreet(url = '/data/street.json'): Promise<Street> {
  const [json, models] = await Promise.all([
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
      return r.json() as Promise<{ signals: StreetSignal[]; intersections?: IntersectionTiming[] }>;
    }),
    Promise.all(
      (Object.entries(MODEL_URLS) as [ModelName, string][]).map(async ([name, modelUrl]) => {
        const head = await fetch(modelUrl, { method: 'HEAD' }).catch(() => null);
        // Vite's dev server answers unknown paths with index.html, so check the type too.
        if (!head?.ok || head.headers.get('content-type')?.includes('text/html')) return [name, undefined];
        return [name, await load(modelUrl, GLTFLoader).catch(() => undefined)];
      }),
    ),
  ]);
  // Timing plans and stop lines go to the signal clock, which transit motion also reads.
  registerSignals(json.signals, json.intersections ?? []);
  return { signals: json.signals.map((s) => ({ ...s, streetKind: 'signal' as const })), models: Object.fromEntries(models) };
}

// --------------------------------------------------------------------------------------------
// Geometry helpers
// --------------------------------------------------------------------------------------------

const METRES_PER_DEG_LAT = 110_540;
const metresPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);
const RAD = Math.PI / 180;

/** World position of model point (x, y, z) for a model at `origin` whose +X faces `bearingX`. */
function modelToWorld(origin: [number, number], bearingX: number, [x, y, z]: readonly number[], altitude = 0): [number, number, number] {
  const bx = bearingX * RAD;
  const bz = (bearingX + 90) * RAD; // +Z is 90° clockwise of +X
  const east = x * Math.sin(bx) + z * Math.sin(bz);
  const north = x * Math.cos(bx) + z * Math.cos(bz);
  return [origin[0] + east / metresPerDegLng(origin[1]), origin[1] + north / METRES_PER_DEG_LAT, altitude + y];
}

/** `right` metres to the right of travel along `bearing` from `p`. */
function rightOf(p: [number, number], bearing: number, right: number): [number, number] {
  const b = bearing * RAD;
  return [p[0] + (Math.cos(b) * right) / metresPerDegLng(p[1]), p[1] - (Math.sin(b) * right) / METRES_PER_DEG_LAT];
}

/** Signed metres of `q` to the right of travel along `bearing` from `p`. */
function lateral(p: [number, number], bearing: number, q: [number, number]): number {
  const b = bearing * RAD;
  const dx = (q[0] - p[0]) * metresPerDegLng(p[1]);
  const dy = (q[1] - p[1]) * METRES_PER_DEG_LAT;
  return dx * Math.cos(b) - dy * Math.sin(b);
}

/** The piece of a track between s0 and s1 metres. */
function subTrack(track: Track, s0: number, s1: number): [number, number][] {
  const out: [number, number][] = [pointAlong(track, s0).position];
  for (let i = 0; i < track.points.length; i++) {
    if (track.cumulative[i] > s0 && track.cumulative[i] < s1) out.push(track.points[i]);
  }
  out.push(pointAlong(track, s1).position);
  return out;
}

/** deck.gl yaw that points a model's +X at compass bearing `b` (see the header comment). */
const yawForX = (b: number) => 90 - b;

// --------------------------------------------------------------------------------------------
// Traffic signals
// --------------------------------------------------------------------------------------------

// Lens centres in traffic-signal.glb (model space, metres; also in nodes[0].extras.lamps),
// nudged 4 cm proud of the glass so the glow isn't lost in it.
const LENS_PROUD = 0.04;
const LENSES: Record<'arm' | 'pole', Record<Lamp, readonly number[]>> = {
  arm: { red: [0.145, 5.135, 4.3], amber: [0.145, 4.785, 4.3], green: [0.145, 4.435, 4.3] },
  pole: { red: [0.345, 3.1, 0], amber: [0.345, 2.84, 0], green: [0.345, 2.58, 0] },
};
const LENS_RADIUS = { arm: 0.15, pole: 0.105 };
const LAMP_COLOR: Record<Lamp, [number, number, number]> = {
  red: [255, 48, 36],
  amber: [255, 176, 0],
  green: [60, 255, 140],
};

interface Glow {
  signal: StreetSignal;
  lamp: Lamp;
  head: 'arm' | 'pole';
  position: [number, number, number];
}

interface SignalCache {
  lenses: Record<'arm' | 'pole', Record<Lamp, [number, number, number]>>[];
  key: string;
  glows: Glow[];
}
const signalCache = new WeakMap<Street['signals'], SignalCache>();

function signalGlows(signals: Street['signals'], time: number): Glow[] {
  let cache = signalCache.get(signals);
  if (!cache) {
    const lenses = signals.map((s) => {
      const at = (head: 'arm' | 'pole') =>
        Object.fromEntries(
          (Object.keys(LENSES[head]) as Lamp[]).map((lamp) => {
            const [x, y, z] = LENSES[head][lamp];
            return [lamp, modelToWorld(s.position, s.bearing, [x + LENS_PROUD, y, z])];
          }),
        ) as Record<Lamp, [number, number, number]>;
      return { arm: at('arm'), pole: at('pole') };
    });
    cache = { lenses, key: '', glows: [] };
    signalCache.set(signals, cache);
  }
  const lamps = signals.map((s) => lampAt(time, s.group, s.axis, s.flash, s.movement));
  // Only rebuild the glow list (and re-upload it) when some lamp actually changed.
  const key = lamps.map((l) => (l ? l[0] : '-')).join('');
  if (key !== cache.key) {
    cache.key = key;
    cache.glows = signals.flatMap((signal, i) => {
      const lamp = lamps[i];
      if (!lamp) return [];
      return (['arm', 'pole'] as const).map((head) => ({ signal, lamp, head, position: cache!.lenses[i][head][lamp] }));
    });
  }
  return cache.glows;
}

// --------------------------------------------------------------------------------------------
// Green Line platforms and shelters
// --------------------------------------------------------------------------------------------

// Underground stations (no surface platform to draw): Kenmore, and Fenway on the D branch.
const UNDERGROUND = new Set(['place-kencl', 'place-fenwy']);
const PLATFORM_INNER = 1.7; // metres right of the track centreline (beyond the rails)
const PLATFORM_OUTER = 4.4;
const PLATFORM_HEIGHT = 0.35;
const TACTILE_WIDTH = 0.6;
const SNAP_MAX_METRES = 40;
// Platforms stop short of the street they're beside (motion.ts `platformCentre`, which trains
// also use to know where to stop): their near end stays clear of a signalised crossing.

interface Platform {
  streetKind: 'platform';
  station: TransitStop;
  track: Track;
  polygon: [number, number][];
  tactile: [number, number, number][];
  shelter: { position: [number, number, number]; bearing: number };
}

// --------------------------------------------------------------------------------------------
// Bus stops
// --------------------------------------------------------------------------------------------

const STOP_CURB_DEFAULT = 3.5; // metres right of the bus track when the stop's own position isn't usable
const STOP_CURB_RANGE: [number, number] = [1.5, 9];
const STOP_DEDUPE_METRES = 6;

interface BusStop {
  streetKind: 'bus-stop';
  stop: TransitStop;
  position: [number, number];
  bearing: number; // the street (model +X) faces this way
  shelter: boolean;
}

interface Placements {
  stopCount: number;
  platforms: Platform[];
  busStops: BusStop[];
  // Split once here rather than per frame: a fresh array each frame made deck.gl re-upload the
  // shelter and sign models' attributes every frame.
  shelters: BusStop[];
  signs: BusStop[];
}
const placementCache = new WeakMap<Track[], Placements>();

function placeTransitFurniture(data: TransitData, tracks: Track[], signals: StreetSignal[]): Placements {
  const cached = placementCache.get(tracks);
  // BU shuttle stops are merged into the data at runtime; recompute if the stop list grew.
  if (cached && cached.stopCount === data.stops.length) return cached;
  const routes = new Map(data.routes.map((r) => [r.id, r]));
  const kind = (t: Track) => routes.get(t.route)?.kind;
  const crossings = new Map<string, [number, number][]>();
  for (const sig of signals) crossings.set(sig.group, [...(crossings.get(sig.group) ?? []), sig.position]);
  const crossingCentres = [...crossings.values()].map((ps): [number, number] => [
    ps.reduce((a, p) => a + p[0], 0) / ps.length,
    ps.reduce((a, p) => a + p[1], 0) / ps.length,
  ]);

  const platforms: Platform[] = [];
  for (const station of data.stops) {
    if (station.kind !== 'station' || UNDERGROUND.has(station.id)) continue;
    for (const track of tracks) {
      if (kind(track) !== 'subway' || !station.routes.includes(track.route)) continue;
      const snap = snapToTracks([track], station.position);
      if (!snap || snap.distance > SNAP_MAX_METRES) continue;
      const s = platformCentre(track, snap.s, crossingCentres);
      const piece = subTrack(track, s - PLATFORM_LENGTH / 2, s + PLATFORM_LENGTH / 2);
      const inner = offsetPath(piece, PLATFORM_INNER);
      const outer = offsetPath(piece, PLATFORM_OUTER);
      const edge = offsetPath(piece, PLATFORM_INNER + TACTILE_WIDTH / 2);
      const at = pointAlong(track, s);
      const middle = rightOf(at.position, at.bearing, (PLATFORM_INNER + PLATFORM_OUTER) / 2);
      platforms.push({
        streetKind: 'platform',
        station,
        track,
        polygon: [...inner, ...outer.reverse()],
        tactile: edge.map(([lng, lat]) => [lng, lat, PLATFORM_HEIGHT + 0.01]),
        // Long axis along the track; +X (benches, open side) faces the track, to the left of travel.
        shelter: { position: [middle[0], middle[1], PLATFORM_HEIGHT], bearing: (at.bearing + 270) % 360 },
      });
    }
  }

  const busStops: BusStop[] = [];
  const roadTracks = tracks.filter((t) => kind(t) === 'bus' || kind(t) === 'shuttle');
  // MBTA stops first, so a BU shuttle stop at the same curb doesn't add a second sign.
  const stops = data.stops.filter((s) => s.kind === 'bus' || s.kind === 'shuttle').sort((a, b) => Number(a.kind === 'shuttle') - Number(b.kind === 'shuttle'));
  for (const stop of stops) {
    const own = roadTracks.filter((t) => stop.routes.includes(t.route));
    let snap = snapToTracks(own, stop.position);
    if (!snap || snap.distance > SNAP_MAX_METRES) snap = snapToTracks(roadTracks, stop.position);
    if (!snap || snap.distance > SNAP_MAX_METRES) continue;
    const at = pointAlong(snap.track, snap.s);
    const side = lateral(at.position, at.bearing, stop.position);
    const curb = side >= STOP_CURB_RANGE[0] && side <= STOP_CURB_RANGE[1] ? side : STOP_CURB_DEFAULT;
    const position = rightOf(at.position, at.bearing, curb);
    const shelter = stop.routes.length >= 2 || stop.kind === 'shuttle' || /\bComm(onwealth)?\.? Ave/i.test(stop.name);
    const near = busStops.find((b) => Math.hypot((b.position[0] - position[0]) * metresPerDegLng(position[1]), (b.position[1] - position[1]) * METRES_PER_DEG_LAT) < STOP_DEDUPE_METRES);
    if (near) {
      near.shelter ||= shelter;
      continue;
    }
    // The street is to the left of travel, back toward the track: model +X faces it.
    busStops.push({ streetKind: 'bus-stop', stop, position, bearing: (at.bearing + 270) % 360, shelter });
  }

  const placements = {
    stopCount: data.stops.length,
    platforms,
    busStops,
    shelters: busStops.filter((b) => b.shelter),
    signs: busStops.filter((b) => !b.shelter),
  };
  placementCache.set(tracks, placements);
  return placements;
}

// --------------------------------------------------------------------------------------------
// Layers
// --------------------------------------------------------------------------------------------

export interface StreetLayerInput {
  street: Street;
  transit: { data: TransitData; feed: MbtaFeed } | null;
  time: number; // app clock, seconds since midnight
  zoom: number;
}

const CONCRETE: Color = [178, 176, 170, 255];
const NO_PLACEMENTS: Omit<Placements, 'stopCount'> = { platforms: [], busStops: [], shelters: [], signs: [] };
const NO_GLOWS: Glow[] = [];
const TACTILE_YELLOW: Color = [255, 199, 44, 255];
let lastTime = 0;

export function streetLayers({ street, transit, time, zoom }: StreetLayerInput) {
  lastTime = time;
  const detail = zoom >= STREET_DETAIL_ZOOM;
  const { platforms, shelters, signs } = transit
    ? placeTransitFurniture(transit.data, transit.feed.tracks, street.signals)
    : NO_PLACEMENTS;
  // Signal lamps go with the rest of the street detail: zoomed out they were just noise.
  const glows = detail ? signalGlows(street.signals, time) : NO_GLOWS;
  const { models } = street;

  const model = <T,>(id: string, name: ModelName, data: T[], getPosition: (d: T) => [number, number, number], bearingX: (d: T) => number) =>
    models[name]
      ? [
          new ScenegraphLayer<T>({
            id,
            data,
            scenegraph: models[name] as never,
            sizeScale: 1, // real scale, no exaggeration
            _lighting: 'pbr',
            getPosition,
            getOrientation: (d) => [0, yawForX(bearingX(d)), 90],
            pickable: true,
            visible: detail,
            // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
            slot: 'middle',
          }),
        ]
      : [];

  return [
    new PolygonLayer<Platform>({
      id: 'street-platforms',
      data: platforms,
      getPolygon: (p) => p.polygon,
      extruded: true,
      getElevation: PLATFORM_HEIGHT,
      getFillColor: CONCRETE,
      material: { ambient: 0.55, diffuse: 0.55, shininess: 8, specularColor: [40, 40, 40] },
      stroked: false,
      pickable: true,
      visible: detail,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new PathLayer<Platform>({
      id: 'street-platform-edges',
      data: platforms,
      getPath: (p) => p.tactile,
      getColor: TACTILE_YELLOW,
      getWidth: TACTILE_WIDTH,
      widthUnits: 'meters',
      capRounded: false,
      visible: detail,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    ...model('street-gl-shelters', 'shelter', platforms, (p) => p.shelter.position, (p) => p.shelter.bearing),
    ...model('street-bus-shelters', 'stop', shelters, (b) => [b.position[0], b.position[1], 0], (b) => b.bearing),
    ...model('street-bus-signs', 'stopSign', signs, (b) => [b.position[0], b.position[1], 0], (b) => b.bearing),
    ...model('street-signals', 'signal', street.signals, (s) => [s.position[0], s.position[1], 0], (s) => s.bearing),
    // Lit lamps: a soft halo, then the bright lens. The halo doesn't write depth, so it never
    // hides the lens or a neighbour's lamp. Both keep a pixel minimum so the lights twinkle on
    // the overview, where the poles themselves are hidden.
    new ScatterplotLayer<Glow>({
      id: 'street-signal-halos',
      data: glows,
      getPosition: (g) => g.position,
      getRadius: (g) => LENS_RADIUS[g.head] * 3,
      radiusUnits: 'meters',
      radiusMinPixels: 6,
      getFillColor: (g) => [...LAMP_COLOR[g.lamp], detail ? 70 : 90],
      billboard: true,
      antialiasing: true,
      parameters: { depthWriteEnabled: false },
      updateTriggers: { getFillColor: detail },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new ScatterplotLayer<Glow>({
      id: 'street-signal-lamps',
      data: glows,
      getPosition: (g) => g.position,
      getRadius: (g) => LENS_RADIUS[g.head] * 0.9,
      radiusUnits: 'meters',
      radiusMinPixels: 2.8,
      getFillColor: (g) => [...LAMP_COLOR[g.lamp], 255],
      billboard: true,
      pickable: true,
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
  ];
}

// --------------------------------------------------------------------------------------------
// Tooltip
// --------------------------------------------------------------------------------------------

const LAMP_WORD: Record<Lamp, string> = { red: 'Red', amber: 'Amber', green: 'Green' };

/** Hover text for street furniture; null for anything else. */
export function streetTooltip(object: unknown, transit: { data: TransitData; feed: MbtaFeed } | null): string | null {
  if (!object || typeof object !== 'object') return null;
  const o = object as { streetKind?: string; signal?: StreetSignal };
  const signal = o.streetKind === 'signal' ? (object as StreetSignal) : o.signal && 'group' in o.signal ? o.signal : null;
  if (signal) {
    const { group, axis, movement } = signal;
    const lamp = lampAt(lastTime, group, axis, signal.flash, movement);
    const state = signal.flash
      ? 'Flashing amber'
      : `${LAMP_WORD[lamp ?? 'red']} for ${Math.ceil(secondsToChange(lastTime, group, axis, movement))} s more`;
    const timing = timingFor(group);
    const lines = [`Traffic signal · ${timing?.name ?? signal.road}`, state];
    if (signal.flash) {
      lines.push('Flashing beacon: no timing plan');
    } else {
      const split = splitFor(lastTime, group, axis, movement);
      if (split) {
        const who = movement ? `${signal.road} ${movement}` : signal.road;
        const lpi = split.lpi ? ` after a ${split.lpi} s walk head start` : '';
        lines.push(`${who}: green ${Math.round(split.green)} s${lpi}, amber ${split.yellow} s, all-red ${split.allRed} s`);
      }
      lines.push(timingLabel(lastTime, group));
    }
    return lines.join('\n');
  }
  if (o.streetKind === 'bus-stop') {
    const b = object as BusStop;
    const text = transit ? transitTooltip(b.stop, transit.data, transit.feed) : b.stop.name;
    return `${text}\n${b.shelter ? 'Shelter' : 'Sign only'}`;
  }
  if (o.streetKind === 'platform') {
    const p = object as Platform;
    const route: TransitRoute | undefined = transit?.data.routes.find((r) => r.id === p.track.route);
    const text = transit ? transitTooltip(p.station, transit.data, transit.feed) : p.station.name;
    return `${text}\nPlatform: Green Line ${route?.name ?? ''} toward ${route?.directions[p.track.direction] ?? ''}`;
  }
  return null;
}
