// The Citgo sign at night: its LED tubes, their bloom, and the light it throws on its roof and on
// Kenmore Square, switched by the clock the way the real sign is.
//
// How the real sign lights up (Boston Landmarks Commission, Citgo Sign study report, 2018, s. 2.2):
//  - Neon from 1965, LEDs since 2005 (about 218,000, matched to the neon's blue, white, orange
//    and two reds). It is lit "every night from dusk to midnight".
//  - Lit elements: a white border tube round the rounded square; 39 white horizontal lines across
//    the face; 18 concentric triangles on the trimark (left side orange, bottom medium red, right
//    dark red); the blue CITGO letters.
//  - Animation: all lit; the 39 white lines go out bottom to top, then come back top to bottom;
//    the triangles go out from the outermost in, then come back from the innermost out; then
//    everything except the blue letters flashes off and on twice, and the sequence repeats. The
//    border stays lit except during the two flashes. The report gives no timings, so the ones
//    below are our estimate.
// The geometry (public/data/citgo-lights.json) is written by scripts/make_monument_models.py in
// the sign model's own metres, so the tubes sit exactly on the model's faces.
import { IconLayer, PathLayer } from '@deck.gl/layers';
import type { Color } from '@deck.gl/core';

export interface CitgoLights {
  /** z of the front face's tubes (the back face is the front turned 180 degrees about Y). */
  face: number;
  centre: [number, number];
  trimarkCentre: [number, number];
  lettersCentre: [number, number];
  border: [number, number][];
  /** Bottom to top. */
  rows: { v: number; segments: [number, number][] }[];
  /** Outermost first; points are [u, v, dz] with dz the height in front of the face. */
  triangles: Record<'left' | 'bottom' | 'right', [number, number, number][]>[];
  letters: [number, number][][];
}

export type CitgoLight = 'dawn' | 'day' | 'dusk' | 'night';

export interface CitgoPlacement {
  position: [number, number];
  bearing: number;
  altitude: number;
}

export interface CitgoLightOptions {
  /** Shown time, seconds since local midnight (the sim clock, or the wall clock when live). */
  time: number;
  lightPreset: CitgoLight;
  zoom: number;
  /** performance.now(), for the animation and the power-on. */
  now: number;
}

// --------------------------------------------------------------------------------------------
// When it's on: dusk to midnight
// --------------------------------------------------------------------------------------------

const KENMORE: [number, number] = [-71.0962, 42.3493];
const SWITCH_ON_SUN = -1.5; // degrees: a photocell trips a few minutes after sunset

/** Sun altitude in degrees at Kenmore Square, for today's date at `seconds` past local midnight. */
export function sunAltitude(seconds: number, date = new Date()): number {
  const rad = Math.PI / 180;
  const at = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() + seconds * 1000;
  const d = at / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * rad;
  const q = 280.459 + 0.98564736 * d;
  const lambda = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad;
  const e = (23.439 - 0.00000036 * d) * rad;
  const ra = Math.atan2(Math.cos(e) * Math.sin(lambda), Math.cos(lambda));
  const dec = Math.asin(Math.sin(e) * Math.sin(lambda));
  const gmst = (18.697374558 + 24.06570982441908 * d) % 24;
  const ha = (gmst * 15 + KENMORE[0]) * rad - ra;
  const lat = KENMORE[1] * rad;
  return Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(ha)) / rad;
}

/**
 * Whether the sign is lit at `time`, and how dark it is around it (0..1, for the bloom). Lit
 * from when the sun sets to midnight; the Night preset also counts as dark, so the sign lights
 * if someone picks Night in the afternoon, but never between midnight and noon.
 */
export function citgoSchedule(time: number, lightPreset: CitgoLight) {
  const sun = sunAltitude(time);
  const evening = time >= 12 * 3600 && time < 24 * 3600;
  const dark = sun < SWITCH_ON_SUN || lightPreset === 'night';
  const twilight = lightPreset === 'night' ? 1 : Math.min(1, Math.max(0, (SWITCH_ON_SUN - sun) / 8));
  const presetDark = { day: 0.3, dawn: 0.55, dusk: 0.8, night: 1 }[lightPreset];
  return { on: evening && dark, darkness: (0.4 + 0.6 * twilight) * presetDark, sun };
}

// A quick, slightly ragged power-on (LED drivers coming up), and a short fade at midnight.
let switchedOnAt: number | null = null;
let switchedOffAt = -Infinity;
let lastLevel = 0;

function powerLevel(on: boolean, now: number): number {
  if (on && switchedOnAt === null) switchedOnAt = now;
  if (!on && switchedOnAt !== null) {
    switchedOnAt = null;
    switchedOffAt = now;
  }
  if (switchedOnAt === null) {
    lastLevel = Math.max(0, 1 - (now - switchedOffAt) / 400) * lastLevel;
    return lastLevel;
  }
  const ms = now - switchedOnAt;
  const steps: [number, number][] = [[90, 0.65], [200, 0.05], [330, 0.9], [430, 0.25]];
  const step = steps.find(([until]) => ms < until);
  lastLevel = step ? step[1] : Math.min(1, 0.6 + (0.4 * (ms - 430)) / 800);
  return lastLevel;
}

// --------------------------------------------------------------------------------------------
// The animation (timings estimated; the order is the Landmarks Commission's)
// --------------------------------------------------------------------------------------------

const CYCLE = 20; // seconds
const reducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function animationState(now: number) {
  const p = reducedMotion ? 0 : (now / 1000) % CYCLE;
  const flashOff = (p >= 17 && p < 17.4) || (p >= 17.8 && p < 18.2);
  return {
    p,
    flashOff,
    /** Row i, counted from the bottom. */
    row(i: number, n: number) {
      if (flashOff) return false;
      if (p >= 5 && p < 8) return p < 5 + (3 * i) / n; // going out, bottom to top
      if (p >= 8 && p < 11) return p >= 8 + (3 * (n - 1 - i)) / n; // back on, top to bottom
      return true;
    },
    /** Triangle k, 0 = outermost. */
    triangle(k: number, n: number) {
      if (flashOff) return false;
      if (p >= 11 && p < 14) return p < 11 + (3 * k) / n; // going out, outermost first
      if (p >= 14 && p < 17) return p >= 14 + (3 * (n - 1 - k)) / n; // back on, innermost first
      return true;
    },
    key: reducedMotion ? 'still' : `${Math.floor(p * 26)}`,
  };
}

// --------------------------------------------------------------------------------------------
// Geometry: sign metres -> map coordinates
// --------------------------------------------------------------------------------------------

type Group = 'border' | 'row' | 'left' | 'bottom' | 'right' | 'letter';

interface Tube {
  path: [number, number, number][];
  group: Group;
  /** Row number from the bottom, or triangle number from the outside. */
  index: number;
}

interface Glow {
  position: [number, number, number];
  color: Color;
  size: number;
}

// Tube colours: near-white LED, the trimark's orange / medium red / dark red, CITGO blue.
const COLOURS: Record<Group, Color> = {
  border: [255, 250, 244, 255],
  row: [236, 232, 224, 255],
  left: [240, 62, 14, 165],
  bottom: [230, 18, 22, 165],
  right: [176, 0, 14, 165],
  letter: [40, 110, 255, 255],
};
const WIDTHS: Record<Group, number> = { border: 0.28, row: 0.13, left: 0.22, bottom: 0.22, right: 0.22, letter: 0.55 };

/** The sign is drawn 25% larger than life at every zoom so it reads from the campus; the monument
 * layer scales its model by the same factor. */
export const CITGO_SCALE = 1.25;

function placer({ position, bearing, altitude }: CitgoPlacement, scale = 1) {
  const rad = Math.PI / 180;
  const fz = [Math.sin(bearing * rad), Math.cos(bearing * rad)]; // +Z: the front face's bearing
  const fx = [Math.sin((bearing - 90) * rad), Math.cos((bearing - 90) * rad)]; // +X
  const mx = 111320 * Math.cos(position[1] * rad);
  const my = 110540;
  return (x: number, y: number, z: number): [number, number, number] => {
    const east = (x * fx[0] + z * fz[0]) * scale;
    const north = (x * fx[1] + z * fz[1]) * scale;
    return [position[0] + east / mx, position[1] + north / my, altitude + y * scale];
  };
}

const geometryCache = new WeakMap<CitgoLights, Map<string, { tubes: Tube[]; at: ReturnType<typeof placer> }>>();

function tubesFor(lights: CitgoLights, sign: CitgoPlacement, scale: number) {
  const key = `${sign.position}|${sign.bearing}|${sign.altitude}|${scale}`;
  const cached = geometryCache.get(lights)?.get(key);
  if (cached) return cached;
  const at = placer(sign, scale);
  const tubes: Tube[] = [];
  for (const side of [1, -1]) {
    // The back face is the front turned 180 degrees about Y.
    const p = (u: number, v: number, dz = 0) => at(side * u, v, side * (lights.face + dz));
    tubes.push({ path: lights.border.map(([u, v]) => p(u, v)), group: 'border', index: 0 });
    lights.rows.forEach((row, i) => {
      for (const [u0, u1] of row.segments) tubes.push({ path: [p(u0, row.v), p(u1, row.v)], group: 'row', index: i });
    });
    lights.triangles.forEach((tri, k) => {
      for (const g of ['left', 'bottom', 'right'] as const) {
        tubes.push({ path: tri[g].map(([u, v, dz]) => p(u, v, dz + 0.05)), group: g, index: k });
      }
    });
    for (const letter of lights.letters) tubes.push({ path: letter.map(([u, v]) => p(u, v, 0.02)), group: 'letter', index: 0 });
  }
  const entry = { tubes, at };
  if (!geometryCache.has(lights)) geometryCache.set(lights, new Map());
  geometryCache.get(lights)!.set(key, entry);
  return entry;
}

// A soft round sprite for bloom and light pools, drawn once.
let glowAtlas: string | null = null;
function glowTexture(): string {
  if (glowAtlas) return glowAtlas;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const g = canvas.getContext('2d')!;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  // A Gaussian falloff, so no sprite shows an edge.
  for (let i = 0; i <= 16; i++) grad.addColorStop(i / 16, `rgba(255,255,255,${Math.exp(-((i / 16) ** 2) * 5.5).toFixed(3)})`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glowAtlas = canvas.toDataURL();
  return glowAtlas;
}
const GLOW_MAPPING = { glow: { x: 0, y: 0, width: 128, height: 128, mask: true } };

// Light adds to the scene, never writes depth, and is still hidden by buildings in front of it.
const ADDITIVE = {
  depthWriteEnabled: false,
  depthCompare: 'less-equal',
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'zero',
  blendAlphaDstFactor: 'one',
} as const;
// Pools of light on surfaces must also beat the detailed building models' depth pull (buildings.ts).
const ADDITIVE_ON_SURFACE = { ...ADDITIVE, depthBias: -1, depthBiasSlopeScale: -1600 } as const;

const scaleAlpha = (c: Color, a: number): Color => [c[0], c[1], c[2], Math.round(Math.min(255, Math.max(0, a)))];

export function citgoLightLayers(lights: CitgoLights, sign: CitgoPlacement, { time, lightPreset, now }: CitgoLightOptions) {
  const schedule = citgoSchedule(time, lightPreset);
  const power = powerLevel(schedule.on, now);
  if (power <= 0.01) return [];
  const scale = CITGO_SCALE;
  const { tubes, at } = tubesFor(lights, sign, scale);
  const anim = animationState(now);
  const rows = lights.rows.length;
  const tris = lights.triangles.length;
  const lit = (t: Tube) =>
    t.group === 'letter' ? true
    : t.group === 'border' ? !anim.flashOff
    : t.group === 'row' ? anim.row(t.index, rows)
    : anim.triangle(t.index, tris);
  // The lit trimark and letters carry the sign; the bloom is just a soft, steady halo.
  const dark = schedule.darkness;
  const key = `${anim.key}|${power.toFixed(2)}|${dark.toFixed(2)}|${scale}`;

  // Bloom: how much of each colour is lit right now, so the halos breathe with the animation.
  const share = (group: Group[]) => {
    const all = tubes.filter((t) => group.includes(t.group));
    return all.length ? all.filter(lit).length / all.length : 0;
  };
  const redShare = share(['left', 'bottom', 'right']);
  const whiteShare = share(['row', 'border']);
  const glows: Glow[] = [];
  for (const side of [1, -1]) {
    const out = (u: number, v: number, dz: number) => at(side * u, v, side * (lights.face + dz));
    const [tu, tv] = lights.trimarkCentre;
    const [lu, lv] = lights.lettersCentre;
    // Soft and steady (a little brighter with more tubes lit), sized to the sign, never a pulsing dot.
    glows.push({ position: out(tu, tv, 2.5), color: scaleAlpha([255, 40, 28, 255], (45 + 25 * redShare) * dark), size: 26 * scale });
    glows.push({ position: out(lu, lv, 2.0), color: scaleAlpha([60, 130, 255, 255], 55 * dark), size: 18 * scale });
    glows.push({ position: out(lights.centre[0], lights.centre[1], 3.5), color: scaleAlpha([255, 196, 180, 255], (10 + 10 * whiteShare) * dark), size: 40 * scale });
  }
  // Light falling on the truss under the sign.
  glows.push({ position: at(0, lights.centre[1] - 13, 0), color: scaleAlpha([255, 120, 90, 255], 60 * dark), size: 16 });

  // Pools of light: on the 660 Beacon roof under the sign, and out on Kenmore Square in front
  // of each face (the sign is 23 m up, so the pool is wide and faint).
  const roof = sign.altitude + 0.15;
  const pools = [
    { position: [at(0, 0, 0)[0], at(0, 0, 0)[1], roof] as [number, number, number], color: scaleAlpha([255, 90, 70, 255], 110 * dark * (0.5 + 0.5 * redShare)), size: 30 },
    ...[1, -1].map((side) => {
      const p = at(0, 0, side * 38);
      return { position: [p[0], p[1], 0.3] as [number, number, number], color: scaleAlpha([255, 80, 70, 255], 34 * dark), size: 80 };
    }),
  ];

  return [
    new IconLayer<{ position: [number, number, number]; color: Color; size: number }>({
      id: 'citgo-spill',
      data: pools,
      iconAtlas: glowTexture(),
      iconMapping: GLOW_MAPPING,
      getIcon: () => 'glow',
      getPosition: (d) => d.position,
      getSize: (d) => d.size,
      getColor: (d) => d.color,
      sizeUnits: 'meters',
      billboard: false, // lies flat on the roof / street
      opacity: power,
      parameters: ADDITIVE_ON_SURFACE,
      updateTriggers: { getColor: key },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // Wide, faint copies of the lit tubes: the glow that bleeds round each one.
    new PathLayer<Tube>({
      id: 'citgo-tube-bloom',
      data: tubes,
      getPath: (t) => t.path,
      getColor: (t) => (lit(t) ? scaleAlpha(COLOURS[t.group], (t.group === 'row' ? 14 : t.group === 'letter' ? 70 : t.group === 'border' ? 50 : 22) * dark) : [0, 0, 0, 0]),
      getWidth: (t) => WIDTHS[t.group] * scale * (t.group === 'letter' ? 3 : t.group === 'row' ? 3.5 : 4.5),
      widthUnits: 'meters',
      widthMinPixels: 2,
      billboard: true,
      capRounded: true,
      jointRounded: true,
      opacity: power,
      parameters: ADDITIVE,
      updateTriggers: { getColor: key },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // The tubes themselves.
    new PathLayer<Tube>({
      id: 'citgo-tubes',
      data: tubes,
      getPath: (t) => t.path,
      getColor: (t) => (!lit(t) ? [0, 0, 0, 0] : COLOURS[t.group]),
      getWidth: (t) => WIDTHS[t.group] * scale,
      widthUnits: 'meters',
      widthMinPixels: 1,
      billboard: true,
      capRounded: true,
      jointRounded: true,
      opacity: power,
      parameters: ADDITIVE,
      updateTriggers: { getColor: key },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // Bloom sprites round the trimark, the letters and the whole face; they keep the sign
    // readable as a glowing landmark from the campus overview.
    new IconLayer<Glow>({
      id: 'citgo-bloom',
      data: glows,
      iconAtlas: glowTexture(),
      iconMapping: GLOW_MAPPING,
      getIcon: () => 'glow',
      getPosition: (d) => d.position,
      getSize: (d) => d.size,
      getColor: (d) => d.color,
      sizeUnits: 'meters',
      sizeMinPixels: 0,
      billboard: true,
      opacity: power,
      parameters: ADDITIVE,
      updateTriggers: { getColor: key, getSize: scale },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
  ];
}
