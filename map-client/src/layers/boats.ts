// Little sailboats on the Charles: dinghies from scripts/make_boat_models.py, sailing the
// courses planned in sim/boats.ts, plus a faint fading wake behind each one.
//
// Orientation (see street.ts for the derivation): with getOrientation [pitch, yaw, 90] a Y-up,
// +Z-forward model stands upright with its bow at compass bearing 180 - yaw, and `pitch` then
// rotates it about its own fore-and-aft axis, which is exactly heel (positive pitch lifts the
// starboard side, leaning the mast to port). The models are drawn with the sails out to port;
// getScale x = -1 mirrors them for the other tack.
import { ScenegraphLayer } from '@deck.gl/mesh-layers';
import { TripsLayer } from '@deck.gl/geo-layers';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import type { Color } from '@deck.gl/core';
import { BOAT_VARIANTS, DEFAULT_WIND_FROM, Fleet, type BoatState, type RiverData } from '../sim/boats';
import { boxAround, setCullBox } from './culling';
import { stableList } from './stable';

const COLOURS = ['sailboat', 'sailboat-navy', 'sailboat-green'] as const;
const TRIMS = ['close', 'run'] as const;
const modelUrl = (variant: number, trim: (typeof TRIMS)[number]) => `/models/${COLOURS[variant]}${trim === 'run' ? '-run' : ''}.glb`;

export interface Boats {
  fleet: Fleet;
  models: Record<string, unknown>; // `${variant}-${trim}` -> parsed glTF
}

/** The river polygon and every boat model; rejects if any is missing (the map runs without boats). */
export async function loadBoats(url = '/data/river.json'): Promise<Boats> {
  const river = await fetch(url).then((r) => {
    if (!r.ok) throw new Error(`Failed to load ${url}: ${r.status}`);
    return r.json() as Promise<RiverData>;
  });
  const entries = await Promise.all(
    Array.from({ length: BOAT_VARIANTS }, (_, v) => TRIMS.map(async (trim) => [`${v}-${trim}`, await load(modelUrl(v, trim), GLTFLoader)] as const)).flat(),
  );
  return { fleet: new Fleet(river), models: Object.fromEntries(entries) };
}

/** True size up close; grows only a little as the camera pulls back (a 4 m dinghy should stay
 *  small next to the buildings and the BU Bridge, just not vanish). */
export function boatScale(zoom: number) {
  return Math.min(2.5, Math.max(1, 2 ** (17.2 - zoom)));
}

// deck.gl lights models more brightly than Mapbox's dusk and night presets (as in buildings.ts).
const LIGHT_TINT: Record<string, Color> = {
  dawn: [235, 222, 220, 255],
  day: [255, 255, 255, 255],
  dusk: [214, 204, 220, 255],
  night: [130, 138, 165, 255],
};

export interface BoatLayerOptions {
  boats: Boats;
  time: number; // seconds since midnight (the app's simulation clock)
  zoom: number;
  /** Direction the wind blows from (compass degrees); defaults to a westerly. */
  windFromDegrees?: number;
  /** Playback speed: the bobbing is damped when fast-forwarding, where it would only flicker. */
  speed?: number;
  lightPreset?: string;
}

export function boatLayers({ boats, time, zoom, windFromDegrees = DEFAULT_WIND_FROM, speed = 1, lightPreset = 'day' }: BoatLayerOptions) {
  const states = boats.fleet.at(time, windFromDegrees);
  if (!states.length) return [];
  const sizeScale = boatScale(zoom);
  const calm = Math.min(1, 4 / Math.max(1, speed)); // full bob at 1-4x, fading above
  const tint = LIGHT_TINT[lightPreset] ?? LIGHT_TINT.day;

  const layers: (ScenegraphLayer<BoatState> | TripsLayer<BoatState>)[] = [
    new TripsLayer<BoatState>({
      id: 'boat-wakes',
      data: states,
      getPath: (d) => d.wake,
      getTimestamps: (d) => d.wakeTimes,
      currentTime: 0,
      trailLength: 9,
      fadeTrail: true,
      getColor: [255, 255, 255],
      opacity: 0.4,
      getWidth: 0.9 * Math.min(sizeScale, 3),
      widthMinPixels: 1,
      capRounded: true,
      jointRounded: true,
      updateTriggers: { getPath: time, getTimestamps: time },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
  ];

  for (let variant = 0; variant < BOAT_VARIANTS; variant++) {
    for (const trim of TRIMS) {
      const key = `${variant}-${trim}`;
      // Same boats as last frame: same array, so their colours aren't re-uploaded every frame
      // (position, attitude and scale still are: they bob). Empty and off-screen layers skip their draws.
      const data = stableList(`boats-${key}`, states.filter((b) => b.variant === variant && b.trim === trim), (b) => b.id);
      setCullBox(`boats-${key}`, boxAround(data.map((b) => b.position), 10 * sizeScale, 12 * sizeScale, -2));
      layers.push(
        new ScenegraphLayer<BoatState>({
          id: `boats-${key}`,
          data,
          visible: data.length > 0,
          scenegraph: boats.models[key] as never,
          _lighting: 'pbr',
          sizeScale,
          sizeMinPixels: 1.5,
          getPosition: (d) => [d.position[0], d.position[1], d.position[2] * calm],
          getOrientation: (d) => [d.heel, 180 - d.heading, 90 + d.rock * calm],
          getScale: (d) => [d.side * d.grow, d.grow, d.grow],
          getColor: tint,
          updateTriggers: { getPosition: [time, calm], getOrientation: [time, calm], getScale: time, getColor: lightPreset },
          pickable: true,
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
      );
    }
  }
  return layers;
}

export function boatTooltip(object: unknown): string | null {
  return object && typeof object === 'object' && 'sailboat' in object ? 'Sailboat · Charles River' : null;
}
