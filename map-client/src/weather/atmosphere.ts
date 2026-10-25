// The weather's shapes in the world, beside the falling rain and snow (precipitation.ts): cloud
// shadows drifting over the ground on a partly cloudy day, low fog banks that wander between the
// buildings in fog (and a thin mist in heavy rain), and lightning bolts that strike with the
// screen flash in a thunderstorm. All deck.gl, so they work on Mapbox and MapLibre alike.
//
// Soft edges come from stacking a few translucent circles per shape (an outer, faint one down to
// a small, denser core), which reads as a gradient without a custom shader. Shapes have fixed
// places in a box that follows the camera, wrapped like the precipitation, and move with the wind.
import { COORDINATE_SYSTEM, type Layer } from '@deck.gl/core';
import { PathLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { CameraState, LightPreset } from '../map/basemap';
import type { ActiveWeather } from './weather';
import { lastStrike } from './lightning';

const ANCHOR: [number, number] = [-71.1054, 42.3505];
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG = 111_320 * Math.cos((ANCHOR[1] * Math.PI) / 180);

const REDUCED_MOTION = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const SHADOWS = 26;
const FOG_BANKS = 90;
const RINGS = 4; // circles per soft shape
const BOLT_MS = 260; // how long a bolt stays drawn (the flash's two flickers)

function seeded(n: number, seed: number) {
  const out = new Float32Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    out[i] = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  return out;
}
const RX = seeded(FOG_BANKS, 71);
const RY = seeded(FOG_BANKS, 83);
const RS = seeded(FOG_BANKS, 97);

const wrap = (v: number, origin: number, size: number) => origin + (((v - origin) % size) + size) % size;

// deck.gl skips the upload when it is handed the same typed array again, so alternate two.
function doubleBuffer<T extends Float32Array | Uint8Array>(make: () => T) {
  const bufs = [make(), make()];
  let i = 0;
  return () => bufs[(i ^= 1)];
}
const MAX_SOFT = FOG_BANKS * RINGS;
const softPos = doubleBuffer(() => new Float32Array(MAX_SOFT * 3));
const softRadius = doubleBuffer(() => new Float32Array(MAX_SOFT));
const softColor = doubleBuffer(() => new Uint8Array(MAX_SOFT * 4));

interface View { size: number; ox: number; oy: number; camDist: number }

/** The camera's box in metres from ANCHOR, as precipitation.ts lays it out. */
function viewBox(camera: CameraState): View {
  const lat = camera.center[1];
  const metresPerPixel = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** camera.zoom);
  const camDist = 1.5 * window.innerHeight * metresPerPixel;
  const size = camDist * 2.2;
  const bearing = (camera.bearing * Math.PI) / 180;
  const cx = (camera.center[0] - ANCHOR[0]) * M_PER_DEG_LNG + Math.sin(bearing) * size * 0.15;
  const cy = (camera.center[1] - ANCHOR[1]) * M_PER_DEG_LAT + Math.cos(bearing) * size * 0.15;
  return { size, ox: cx - size / 2, oy: cy - size / 2, camDist };
}

const common = {
  coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
  coordinateOrigin: [ANCHOR[0], ANCHOR[1], 0] as [number, number, number],
  pickable: false,
  parameters: { depthWriteEnabled: false },
};

/** One soft shape: RINGS circles from wide and faint to small and denser, written at slot `i`. */
function writeSoft(i: number, x: number, y: number, z: number, radius: number, rgb: [number, number, number], alpha: number,
  pos: Float32Array, rad: Float32Array, col: Uint8Array) {
  for (let r = 0; r < RINGS; r++) {
    const k = i * RINGS + r;
    pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
    rad[k] = radius * (1 - r * 0.22);
    col[k * 4] = rgb[0]; col[k * 4 + 1] = rgb[1]; col[k * 4 + 2] = rgb[2];
    col[k * 4 + 3] = Math.round(alpha * (0.45 + r * 0.2));
  }
}

function softLayer(id: string, count: number, pos: Float32Array, rad: Float32Array, col: Uint8Array, billboard: boolean): Layer {
  return new ScatterplotLayer({
    ...common,
    id,
    data: { length: count * RINGS, attributes: {
      getPosition: { value: pos, size: 3 },
      getRadius: { value: rad, size: 1 },
      getFillColor: { value: col, size: 4, normalized: true },
    } },
    radiusUnits: 'meters',
    billboard,
    antialiasing: true,
  });
}

/** Cloud shadows: broad, faint patches crossing the ground with the wind (daylight only). */
function cloudShadows(weather: ActiveWeather, view: View, t: number): Layer | null {
  const windTo = ((weather.wind.fromDeg + 180) * Math.PI) / 180;
  const speed = 2 + weather.wind.mph * 0.6; // m/s; clouds move faster than the surface wind
  const dx = Math.sin(windTo) * speed * t, dy = Math.cos(windTo) * speed * t;
  const span = Math.max(view.size, 2400); // shadows are big: keep their layout from shrinking at street level
  const pos = softPos(), rad = softRadius(), col = softColor();
  for (let i = 0; i < SHADOWS; i++) {
    const x = wrap(RX[i] * span * 5.1 + dx, view.ox - (span - view.size) / 2, span);
    const y = wrap(RY[i] * span * 5.1 + dy, view.oy - (span - view.size) / 2, span);
    writeSoft(i, x, y, 0.4, 140 + RS[i] * 260, [24, 32, 48], 26, pos, rad, col);
  }
  return softLayer('weather-cloud-shadows', SHADOWS, pos, rad, col, false);
}

/** Fog banks: pale, slowly drifting billows a few storeys up, so buildings stand in and out of them. */
function fogBanks(weather: ActiveWeather, view: View, t: number, light: LightPreset, density: number): Layer {
  const windTo = ((weather.wind.fromDeg + 180) * Math.PI) / 180;
  const drift = 0.6 + weather.wind.mph * 0.15;
  const dark = light === 'dusk' || light === 'night';
  const rgb: [number, number, number] = dark ? [120, 130, 150] : [232, 236, 242];
  const count = Math.round(FOG_BANKS * density);
  const pos = softPos(), rad = softRadius(), col = softColor();
  for (let i = 0; i < count; i++) {
    const own = 0.7 + 0.6 * RS[i]; // each bank at its own pace, so they slide past each other
    const x = wrap(RX[i] * view.size * 6.7 + Math.sin(windTo) * drift * own * t, view.ox, view.size);
    const y = wrap(RY[i] * view.size * 6.7 + Math.cos(windTo) * drift * own * t, view.oy, view.size);
    const swell = 0.85 + 0.15 * Math.sin(t * 0.07 + i);
    const radius = Math.max(18, view.camDist * (0.05 + 0.07 * RS[i])) * swell;
    writeSoft(i, x, y, 4 + RS[(i + 7) % FOG_BANKS] * 26, radius, rgb, (dark ? 34 : 42) * density, pos, rad, col);
  }
  return softLayer('weather-fog-banks', count, pos, rad, col, true);
}

/** A forked bolt from the cloud base to the ground somewhere ahead of the camera, for BOLT_MS after a strike. */
function bolt(view: View, nowPerf: number): Layer[] {
  const { at, seed } = lastStrike();
  const age = nowPerf - at;
  if (!(age >= 0 && age < BOLT_MS)) return [];
  const rand = seeded(64, 1000 + seed);
  const gx = view.ox + view.size * (0.2 + 0.6 * rand[0]);
  const gy = view.oy + view.size * (0.35 + 0.5 * rand[1]);
  const top = Math.max(250, view.camDist * 0.6);
  const main: [number, number, number][] = [];
  const steps = 14;
  let x = gx + (rand[2] - 0.5) * top * 0.4, y = gy + (rand[3] - 0.5) * top * 0.4;
  for (let s = 0; s <= steps; s++) {
    const f = s / steps;
    main.push([x, y, top * (1 - f)]);
    // Zigzag toward the ground point, less as it nears it.
    x += (gx - x) / (steps - s + 1) + (rand[4 + s] - 0.5) * top * 0.07 * (1 - f);
    y += (gy - y) / (steps - s + 1) + (rand[20 + s] - 0.5) * top * 0.07 * (1 - f);
  }
  main[steps] = [gx, gy, 0];
  const forks: [number, number, number][][] = [];
  for (let b = 0; b < 2; b++) {
    const from = 3 + Math.floor(rand[40 + b] * 6);
    const [fx, fy, fz] = main[from];
    const fork: [number, number, number][] = [[fx, fy, fz]];
    let px = fx, py = fy, pz = fz;
    for (let s = 0; s < 4; s++) {
      px += (rand[44 + b * 5 + s] - 0.5) * top * 0.18; py += (rand[54 + b * 4 + s] - 0.5) * top * 0.18; pz -= top * 0.07;
      fork.push([px, py, Math.max(0, pz)]);
    }
    forks.push(fork);
  }
  // Bright at the strike, a dimmer re-strike with the second flicker.
  const strength = age < 70 ? 1 : age < 120 ? 0.25 : age < 190 ? 0.8 : 0.3;
  const glowAlpha = Math.round(70 * strength), coreAlpha = Math.round(255 * strength);
  const paths = [{ path: main, main: true }, ...forks.map((path) => ({ path, main: false }))];
  return [
    new PathLayer({
      ...common,
      id: 'weather-bolt-glow',
      data: paths,
      getPath: (d: { path: [number, number, number][] }) => d.path,
      getColor: [170, 190, 255, glowAlpha],
      getWidth: (d: { main: boolean }) => (d.main ? 12 : 6),
      widthUnits: 'pixels',
      jointRounded: true,
      capRounded: true,
    }),
    new PathLayer({
      ...common,
      id: 'weather-bolt',
      data: paths,
      getPath: (d: { path: [number, number, number][] }) => d.path,
      getColor: [248, 250, 255, coreAlpha],
      getWidth: (d: { main: boolean }) => (d.main ? 2.6 : 1.4),
      widthUnits: 'pixels',
      jointRounded: true,
    }),
    // Where it lands, the ground lights up for a moment.
    new ScatterplotLayer({
      ...common,
      id: 'weather-bolt-ground',
      data: [0],
      getPosition: () => [gx, gy, 0.5],
      getRadius: Math.max(40, view.camDist * 0.06),
      getFillColor: [200, 215, 255, Math.round(60 * strength)],
      radiusUnits: 'meters',
    }),
  ];
}

/** The deck.gl layers for this frame's cloud shadows, fog banks and lightning; empty in clear weather. */
export function atmosphereLayers(weather: ActiveWeather | null, camera: CameraState, nowMs: number, light: LightPreset): Layer[] {
  if (!weather) return [];
  const t = REDUCED_MOTION ? 0 : nowMs / 1000;
  const view = viewBox(camera);
  const layers: Layer[] = [];
  const { condition } = weather;
  if (condition === 'partly-cloudy' && (light === 'day' || light === 'dawn')) {
    const shadows = cloudShadows(weather, view, t);
    if (shadows) layers.push(shadows);
  }
  if (condition === 'fog') layers.push(fogBanks(weather, view, t, light, 1));
  else if (condition === 'heavy-rain' || condition === 'thunderstorm') layers.push(fogBanks(weather, view, t, light, 0.35));
  if (condition === 'thunderstorm' && !REDUCED_MOTION) layers.push(...bolt(view, performance.now()));
  return layers;
}
