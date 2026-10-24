// Rain and snow as world-space particles in deck.gl: thin streaks and soft flakes falling through
// 3D space over the visible campus, hidden behind buildings like everything else interleaved
// with the map, plus small splash rings on the ground in rain. Works on Mapbox and MapLibre.
//
// Particles live in a box that follows the camera and scales with its distance, so screen
// density stays steady from the wide shot to street level. Each particle has a fixed place in
// the world (wrapped into the box), so panning doesn't drag the rain along. Per frame this only
// fills a few typed arrays: about 0.5 ms a frame for ~10,000 streaks.
import { COORDINATE_SYSTEM, type Layer } from '@deck.gl/core';
import { LineLayer, ScatterplotLayer } from '@deck.gl/layers';
import type { CameraState, LightPreset } from '../map/basemap';

export interface Precipitation {
  kind: 'rain' | 'snow';
  strength: number; // 0 (drizzle, flurries) to 1 (downpour, heavy snow)
  windToDeg: number; // compass bearing the wind blows toward
  windMph: number;
}

// Positions are metre offsets from a fixed point at BU, so numbers stay small on every campus.
const ANCHOR: [number, number] = [-71.1054, 42.3505];
const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LNG = 111_320 * Math.cos((ANCHOR[1] * Math.PI) / 180);

// Counts at a 1600x900 view and full strength; scaled with the screen area and the strength.
const MAX_STREAKS = 15000;
const MAX_RIPPLES = 600;
const MAX_FLAKES = 8000;
const POOL = Math.round(Math.max(MAX_STREAKS, MAX_FLAKES) * 2); // big screens

// Share of the normal particle count (the Performance setting lowers it on slow machines).
let particleScale = 1;
export function setParticleScale(scale: number) {
  particleScale = Math.max(0, Math.min(1, scale));
}

const REDUCED_MOTION = typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Per-particle random numbers, fixed for the session (seeded, so the pattern is stable).
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
const RX = seeded(POOL, 11);
const RY = seeded(POOL, 23);
const RZ = seeded(POOL, 37);
const RJ = seeded(POOL, 51);

// deck.gl skips the upload when it is handed the same typed array again, so alternate two.
function doubleBuffer(size: number) {
  const bufs = [new Float32Array(size), new Float32Array(size)];
  let i = 0;
  return () => bufs[(i ^= 1)];
}
const streakSrc = doubleBuffer(POOL * 3);
const streakDst = doubleBuffer(POOL * 3);
const flakePos = doubleBuffer(POOL * 3);
const flakeSize = doubleBuffer(POOL);
const ripplePos = doubleBuffer(MAX_RIPPLES * 4 * 3);
const rippleRadius = doubleBuffer(MAX_RIPPLES * 4);
const rippleColorBufs = [new Uint8Array(MAX_RIPPLES * 4 * 4), new Uint8Array(MAX_RIPPLES * 4 * 4)];
let rippleColorIndex = 0;

// What is falling, since when, and (after it stops) when it stopped: rain and snow fade in and
// out over 1.5 s, so a change of weather (an hour boundary in playback) cross-fades.
let current: { last: Precipitation; since: number; endedAt: number | null } | null = null;
const FADE_MS = 1500;

const fract = (v: number) => v - Math.floor(v);
const wrap = (v: number, origin: number, size: number) => origin + (((v - origin) % size) + size) % size;

/** The deck.gl layers for this frame's rain or snow; empty when it's dry. */
export function precipitationLayers(next: Precipitation | null | undefined, camera: CameraState, nowMs: number, light: LightPreset): Layer[] {
  let fadeIn: number;
  if (next) {
    if (!current || current.endedAt != null || current.last.kind !== next.kind) current = { last: next, since: nowMs, endedAt: null };
    current.last = next;
    fadeIn = Math.min(1, (nowMs - current.since) / FADE_MS);
  } else {
    if (!current) return [];
    current.endedAt ??= nowMs;
    fadeIn = 1 - (nowMs - current.endedAt) / FADE_MS;
    if (fadeIn <= 0) {
      current = null;
      return [];
    }
  }
  const p = current.last;
  const t = REDUCED_MOTION ? 0 : nowMs / 1000;

  // Camera distance from the screen centre (Mapbox and MapLibre both use a ~36.9° vertical field
  // of view, so it's 1.5 screen heights in ground metres).
  const lat = camera.center[1];
  const metresPerPixel = (40_075_016.686 * Math.cos((lat * Math.PI) / 180)) / (512 * 2 ** camera.zoom);
  const camDist = 1.5 * window.innerHeight * metresPerPixel;
  const altitude = camDist * Math.cos((camera.pitch * Math.PI) / 180);

  // The box: a little ahead of the screen centre (a tilted view sees further forward than back).
  const size = camDist * 1.9;
  const height = Math.min(camDist * 0.32, altitude * 0.85);
  const bearing = (camera.bearing * Math.PI) / 180;
  const cx = (camera.center[0] - ANCHOR[0]) * M_PER_DEG_LNG + Math.sin(bearing) * size * 0.18;
  const cy = (camera.center[1] - ANCHOR[1]) * M_PER_DEG_LAT + Math.cos(bearing) * size * 0.18;
  const ox = cx - size / 2;
  const oy = cy - size / 2;

  const area = Math.min(2.2, Math.max(0.5, (window.innerWidth * window.innerHeight) / (1600 * 900)));
  const windRad = (p.windToDeg * Math.PI) / 180;
  const wx = Math.sin(windRad);
  const wy = Math.cos(windRad);
  const dark = light === 'dusk' || light === 'night';
  const common = {
    coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS,
    coordinateOrigin: [ANCHOR[0], ANCHOR[1], 0] as [number, number, number],
    pickable: false,
    // Translucent: test against buildings, but don't hide each other or the labels.
    parameters: { depthWriteEnabled: false },
  };

  if (p.kind === 'rain') {
    const n = Math.min(POOL, Math.round(MAX_STREAKS * (0.3 + 0.7 * p.strength) * area * particleScale));
    const slant = Math.min(0.5, 0.03 + p.windMph * 0.03); // tan of the angle from vertical
    const fallSeconds = 0.75;
    const src = streakSrc();
    const dst = streakDst();
    for (let i = 0; i < n; i++) {
      const j = RJ[i];
      const f = fract(RZ[i] + (t / fallSeconds) * (0.8 + 0.4 * j)); // 0 at the top, 1 at the ground
      const z = height * (1 - f);
      const drift = slant * height * f;
      const x = wrap(RX[i] * size * 7.3 + wx * drift, ox, size);
      const y = wrap(RY[i] * size * 7.3 + wy * drift, oy, size);
      const len = height * 0.045 * (0.6 + 0.8 * j);
      const k = i * 3;
      src[k] = x;
      src[k + 1] = y;
      src[k + 2] = z;
      dst[k] = x - wx * slant * len;
      dst[k + 1] = y - wy * slant * len;
      dst[k + 2] = z + len;
    }
    const alpha = Math.round((dark ? 105 : 165) * (0.75 + 0.25 * p.strength) * fadeIn);
    const layers: Layer[] = [
      new LineLayer({
        ...common,
        id: 'weather-rain',
        data: { length: n, attributes: { getSourcePosition: { value: src, size: 3 }, getTargetPosition: { value: dst, size: 3 } } },
        getColor: dark ? [160, 176, 206, alpha] : [196, 208, 226, alpha], // mid-tone: reads on pale ground and dark roofs
        getWidth: 1,
        widthUnits: 'pixels',
      }),
    ];
    if (!REDUCED_MOTION) layers.push(ripples(p, t, size, ox, oy, camDist, area, dark, fadeIn, common));
    return layers;
  }

  // Snow: slow, swaying, a touch of wind.
  const n = Math.min(POOL, Math.round(MAX_FLAKES * (0.35 + 0.65 * p.strength) * area * particleScale));
  const slant = Math.min(0.9, 0.05 + p.windMph * 0.06);
  const fallSeconds = 11;
  const pos = flakePos();
  const radius = flakeSize();
  const sway = height * 0.025;
  const flake = camDist * 0.0012;
  for (let i = 0; i < n; i++) {
    const j = RJ[i];
    const f = fract(RZ[i] + (t / fallSeconds) * (0.7 + 0.6 * j));
    const phase = RX[i] * 40;
    const swing = Math.sin(t * (0.6 + 0.9 * j) + phase) * sway;
    const drift = slant * height * f;
    const k = i * 3;
    pos[k] = wrap(RX[i] * size * 7.3 + wx * drift + swing * wy, ox, size);
    pos[k + 1] = wrap(RY[i] * size * 7.3 + wy * drift - swing * wx, oy, size);
    pos[k + 2] = height * (1 - f);
    radius[i] = flake * (0.55 + 0.9 * j * j);
  }
  return [
    new ScatterplotLayer({
      ...common,
      id: 'weather-snow',
      data: { length: n, attributes: { getPosition: { value: pos, size: 3 }, getRadius: { value: radius, size: 1 } } },
      getFillColor: dark ? [226, 232, 246, Math.round(215 * fadeIn)] : [255, 255, 255, Math.round(235 * fadeIn)],
      radiusUnits: 'meters',
      radiusMinPixels: 0.8,
      radiusMaxPixels: 3.2,
      billboard: true,
      antialiasing: true,
    }),
  ];
}

/** Splash rings: each spot on the ground rings out, fades and comes back somewhere else. */
function ripples(
  p: Precipitation,
  t: number,
  size: number,
  ox: number,
  oy: number,
  camDist: number,
  area: number,
  dark: boolean,
  fadeIn: number,
  common: object,
): Layer {
  const n = Math.min(MAX_RIPPLES * 4, Math.round(MAX_RIPPLES * (0.3 + 0.7 * p.strength) * area * particleScale));
  const pos = ripplePos();
  const radius = rippleRadius();
  const color = rippleColorBufs[(rippleColorIndex ^= 1)];
  const period = 0.7;
  const maxRadius = camDist * 0.005;
  const [r, g, b] = dark ? [190, 205, 230] : [250, 252, 255];
  for (let i = 0; i < n; i++) {
    const cycle = RZ[i] + t / (period * (0.8 + 0.4 * RJ[i]));
    const age = fract(cycle);
    const round = Math.floor(cycle); // a new spot each time round
    const k = i * 3;
    pos[k] = wrap((RX[i] + round * 0.618) * size * 7.3, ox, size);
    pos[k + 1] = wrap((RY[i] + round * 0.382) * size * 7.3, oy, size);
    pos[k + 2] = 0.3;
    radius[i] = maxRadius * (0.15 + 0.85 * age);
    const c = i * 4;
    color[c] = r;
    color[c + 1] = g;
    color[c + 2] = b;
    color[c + 3] = Math.round(210 * (1 - age) ** 1.5 * fadeIn);
  }
  return new ScatterplotLayer({
    ...common,
    id: 'weather-ripples',
    data: {
      length: n,
      attributes: {
        getPosition: { value: pos, size: 3 },
        getRadius: { value: radius, size: 1 },
        getLineColor: { value: color, size: 4, normalized: true },
      },
    },
    filled: false,
    stroked: true,
    getLineWidth: 1.2,
    lineWidthUnits: 'pixels',
    radiusUnits: 'meters',
    radiusMaxPixels: 14,
  });
}
