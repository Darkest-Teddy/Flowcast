/*
 * Persona catalog built on the map's own people: the Kenney Mini Characters in map-client/public/models.
 * Every part of a persona is a choice: skin tone, hair style (taken from one of the Kenney heads), hair
 * colour, expression, clothes, accessories. One shared body (male-a: tee, shorts, sneakers) carries it all.
 *  - Colours re-point a region's UVs to another swatch of the shared Kenney colormap (same palette + shading).
 *  - Styles are add-ons parented to the character's bones (boxes, rings and discs), UV-mapped into the same
 *    colormap. Coordinates are bind-pose model space: faces +Z, feet at y=0, height ~0.7.
 *    Bones: root, torso, head, arm-left (+x), arm-right (-x), leg-left (+x), leg-right (-x).
 *
 * Ported from the design handoff's `kenneyParts.js` with types added. The geometry numbers are tuned
 * against the Kenney rigs and are kept verbatim -- do not "tidy" them.
 *
 * This module is pure data and logic: no DOM, no three.js. It lives in map-client/src so that both the
 * map (which imports it directly) and the dashboard (which imports it through the `@map/*` alias) can
 * share one catalog. The three.js assembly that consumes it lives in web/src/lib/personaRender.ts.
 */

/** A 32px cell of the shared 512² Kenney colormap, as [row, column]. */
export type Sw = [number, number];
export type Vec3 = [number, number, number];

export type BoneName = 'root' | 'torso' | 'head' | 'arm-left' | 'arm-right' | 'leg-left' | 'leg-right';

export type ColorId =
  | 'red' | 'orange' | 'yellow' | 'green' | 'sky' | 'blue' | 'purple' | 'pink'
  | 'white' | 'silver' | 'grey' | 'black' | 'tan' | 'brown' | 'peach';

export interface PaletteColor {
  id: ColorId;
  label: string;
  sw: Sw;
  hex: string;
}

export const PALETTE: readonly PaletteColor[] = [
  { id: 'red', label: 'Red', sw: [2, 9], hex: '#e76047' },
  { id: 'orange', label: 'Orange', sw: [2, 7], hex: '#ff8744' },
  { id: 'yellow', label: 'Yellow', sw: [2, 5], hex: '#ffb54a' },
  { id: 'green', label: 'Green', sw: [2, 3], hex: '#3ea77a' },
  { id: 'sky', label: 'Sky', sw: [2, 13], hex: '#9cbfed' },
  { id: 'blue', label: 'Blue', sw: [2, 11], hex: '#5f75cb' },
  { id: 'purple', label: 'Purple', sw: [2, 15], hex: '#8259d0' },
  { id: 'pink', label: 'Pink', sw: [1, 1], hex: '#cd78ec' },
  { id: 'white', label: 'White', sw: [3, 9], hex: '#ddddea' },
  { id: 'silver', label: 'Silver', sw: [3, 7], hex: '#9ea6c6' },
  { id: 'grey', label: 'Grey', sw: [3, 3], hex: '#6e738b' },
  { id: 'black', label: 'Black', sw: [3, 1], hex: '#3e3e45' },
  { id: 'tan', label: 'Tan', sw: [3, 11], hex: '#d17c57' },
  { id: 'brown', label: 'Brown', sw: [3, 13], hex: '#9a5a41' },
  { id: 'peach', label: 'Peach', sw: [3, 15], hex: '#dda07a' },
];

const P = Object.fromEntries(PALETTE.map((c) => [c.id, c.sw])) as Record<ColorId, Sw>;
const ALL: readonly ColorId[] = PALETTE.map((c) => c.id);

export const HAIR_COLORS: readonly ColorId[] = ['black', 'brown', 'tan', 'yellow', 'silver', 'white', 'pink', 'purple', 'blue', 'green', 'red', 'orange'];
export const GLASSES_COLORS: readonly ColorId[] = ['black', 'brown', 'tan', 'silver', 'white', 'red', 'pink', 'purple', 'blue', 'green'];

/** Eyes, mouth and every expression are always this black. */
export const FACE_SW: Sw = [3, 1];

export interface SkinTone {
  id: string;
  label: string;
  sw: Sw;
  hex: string;
}

export const SKINS: readonly SkinTone[] = [
  { id: 'yellow', label: 'Yellow', sw: [2, 4], hex: '#ffc044' },
  { id: 'light', label: 'Light', sw: [2, 1], hex: '#f8d7af' },
  { id: 'peach', label: 'Peach', sw: [3, 15], hex: '#dda07a' },
  { id: 'tan', label: 'Tan', sw: [3, 11], hex: '#d17c57' },
  { id: 'brown', label: 'Brown', sw: [3, 13], hex: '#9a5a41' },
];

/* ---------------------------------------------------------------------------
 * Meshes. Region keys are "bone group:swatch" (group = head/torso/arm/leg or *).
 * ------------------------------------------------------------------------- */

/** A named area of a source mesh, so the renderer can recolour or hide it. */
export type Region = 'top' | 'sleeve' | 'bottom' | 'shoes' | 'shin' | 'skin' | 'hair' | 'face' | 'crutches' | 'gone';

export interface Piece {
  model: string;
  mesh: string;
  regions: Record<string, Region>;
  /** Heads get rounded, get their eyes/mouth detected, and obey the hat clamp. */
  head?: boolean;
  /** Keep only this region and hide everything else (the crutches rig). */
  only?: Region;
}

export const BASE_MODEL = 'male-a';

const BODY: Piece = {
  model: 'male-a',
  mesh: 'body-mesh',
  regions: { '*:2.3': 'top', 'arm:2.3': 'sleeve', 'leg:2.11': 'bottom', 'leg:2.5': 'shoes', 'leg:3.13': 'shin', '*:3.13': 'skin', '*:3.12': 'skin' },
};

const CRUTCHES: Piece = {
  model: 'female-a',
  mesh: 'body-mesh',
  only: 'crutches',
  regions: { 'arm:2.11': 'crutches', 'arm:3.7': 'crutches' },
};

export interface HairStyle {
  id: string;
  label: string;
  /** The Kenney head this style is taken from; also the GLB the map falls back to. */
  model: string;
  /** The swatch this head uses for face skin, as "row.col". */
  skin: string;
  /** Swatches that are hair on this head. */
  hair: string[];
  /** Swatches to delete outright (a head's built-in glasses). */
  drop?: string[];
}

/** Hair styles are the Kenney heads themselves: their face skin, hair swatches, and bits to drop (built-in glasses). */
export const HAIR_STYLES: readonly HairStyle[] = [
  { id: 'hair-short', label: 'Short', model: 'male-a', skin: '3.13', hair: ['3.1'], drop: ['3.7', '3.9'] },
  { id: 'hair-crop', label: 'Crop', model: 'male-f', skin: '3.11', hair: ['3.1'] },
  { id: 'hair-quiff', label: 'Quiff', model: 'male-d', skin: '3.15', hair: ['3.11'] },
  { id: 'hair-part', label: 'Side part', model: 'male-e', skin: '3.15', hair: ['3.13'], drop: ['3.7', '3.9'] },
  { id: 'hair-beard', label: 'Beard', model: 'male-b', skin: '3.15', hair: ['3.11', '3.13'] },
  { id: 'hair-bun', label: 'Top bun', model: 'female-a', skin: '3.13', hair: ['3.1'] },
  { id: 'hair-buns', label: 'Space buns', model: 'female-b', skin: '3.15', hair: ['3.11'] },
  { id: 'hair-long', label: 'Long', model: 'female-e', skin: '3.15', hair: ['3.1'] },
  { id: 'hair-bob', label: 'Bob', model: 'female-f', skin: '3.15', hair: ['3.13', '3.11'] },
  { id: 'hair-bald', label: 'Bald', model: 'male-d', skin: '3.15', hair: [], drop: ['3.11'] },
];

export const MODELS: readonly string[] = [...new Set([BASE_MODEL, CRUTCHES.model, ...HAIR_STYLES.map((h) => h.model)])];

function headPiece(style: HairStyle): Piece {
  const regions: Record<string, Region> = { ['*:' + style.skin]: 'skin' };
  for (const s of style.hair) regions['*:' + s] = 'hair';
  for (const s of style.drop || []) regions['*:' + s] = 'gone';
  return { model: style.model, mesh: 'head-mesh', regions, head: true };
}

/* ---------------------------------------------------------------------------
 * Add-on geometry.
 * ------------------------------------------------------------------------- */

interface PartBase {
  bone: BoneName;
  c: Vec3;
  sw: Sw;
  rotX?: number;
  rotY?: number;
  rotZ?: number;
}

/** A box, authored as min/max bounds in bind-pose model space. The default kind. */
export interface BoxPart extends PartBase {
  kind?: undefined;
  s: Vec3;
}
/** Ring facing +Z (torus), optionally squashed and tilted. */
export interface RingPart extends PartBase {
  kind: 'ring';
  r: number;
  tube: number;
  scale: [number, number];
}
/** Disc facing +Z. */
export interface DiscPart extends PartBase {
  kind: 'disc';
  r: number;
  depth: number;
  scale: [number, number];
}
export interface BallPart extends PartBase {
  kind: 'ball';
  r: number;
  scale3?: Vec3;
}
export interface ConePart extends PartBase {
  kind: 'cone';
  r: number;
  h: number;
  seg: number;
  scale3: Vec3;
}
export interface CylPart extends PartBase {
  kind: 'cyl';
  r: number;
  rTop: number;
  h: number;
  seg: number;
  scale3: Vec3;
}

export type Part = BoxPart | RingPart | DiscPart | BallPart | ConePart | CylPart;

const box = (bone: BoneName, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, sw: Sw, rotZ = 0): BoxPart => ({
  bone,
  c: [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2],
  s: [x1 - x0, y1 - y0, z1 - z0],
  sw,
  rotZ,
});
const ring = (bone: BoneName, c: Vec3, r: number, tube: number, sw: Sw, scale: [number, number] = [1, 1], rotZ = 0): RingPart => ({ bone, kind: 'ring', c, r, tube, sw, scale, rotZ });
const disc = (bone: BoneName, c: Vec3, r: number, depth: number, sw: Sw, scale: [number, number] = [1, 1], rotZ = 0): DiscPart => ({ bone, kind: 'disc', c, r, depth, sw, scale, rotZ });

const both = <T>(fn: (s: number) => T): T[] => [fn(1), fn(-1)];
const LR = (s: number, a: number, b: number): [number, number] => (s > 0 ? [a, b] : [-b, -a]);
const arm = (s: number): BoneName => (s > 0 ? 'arm-left' : 'arm-right');
const leg = (s: number): BoneName => (s > 0 ? 'leg-left' : 'leg-right');
const W = P.white;
const K = P.black;

// Tops hug the body: torso spans x ±0.126, z -0.138..0.080. The Kenney tee sleeve is a chunky block, so it is
// always hidden and every top draws its own slim sleeve around the forearm (cross-section y 0.232-0.343,
// z -0.062..0.038). Below the elbow the forearm angles forward toward the hand (~25°), so the lower sleeve turns too.
const SHELL = (sw: Sw, k = 0) => box('torso', -0.131 - k, 0.131 + k, 0.2, 0.348 + k * 0.5, -0.143 - k, 0.085 + k, sw);
const HEM = (sw: Sw) => box('torso', -0.137, 0.137, 0.198, 0.222, -0.149, 0.091, sw);
// Kenney arm: a shoulder block (x 0.10-0.21, hidden) then one forearm box that runs from (x 0.21, z -0.012)
// forward at ~28° to the hand end (x 0.356, z 0.062), cross-section 0.11 square (y 0.232-0.343).
const AY: [number, number] = [0.226, 0.349];
const AYM = (AY[0] + AY[1]) / 2;
const UPPER = (s: number, sw: Sw, k = 0) => box(arm(s), ...LR(s, 0.1, 0.222), AY[0] - k, AY[1] + k, -0.074 - k, 0.05 + k, sw);
const ALONG = (s: number, t0: number, t1: number, sw: Sw, k = 0): BoxPart => {
  const tm = (t0 + t1) / 2;
  return {
    bone: arm(s),
    c: [s * (0.21 + 0.88 * tm), AYM, -0.012 + 0.476 * tm],
    s: [t1 - t0, AY[1] - AY[0] + 2 * k, 0.124 + 2 * k],
    sw,
    rotZ: 0,
    rotY: -s * 0.496,
  };
};
const SHORT_SLEEVES = (sw: Sw, k = 0.002): Part[] => both((s) => [UPPER(s, sw, k), ALONG(s, -0.01, 0.068, sw, k)]).flat();
const LONG_SLEEVES = (sw: Sw, cuff: Sw = sw, k = 0): Part[] => both((s) => [UPPER(s, sw, k), ALONG(s, -0.01, 0.108, sw, k), ALONG(s, 0.1, 0.12, cuff, k + 0.005)]).flat();

export interface Garment {
  id: string;
  label: string;
  parts: (c: Sw) => Part[];
  /** A layered top: the body's tee is recoloured to a contrasting inner shade. */
  inner?: boolean;
  /** A layered top that still wants short sleeves underneath (the vest). */
  innerSleeves?: boolean;
  /** Long bottoms hide the body's shorts and shins entirely. */
  long?: boolean;
  /** Hats flatten hair above this height so it does not poke through. */
  clamp?: number;
  /** Expressions that draw their own face hide the head's built-in one. */
  replace?: boolean;
}

export const TOPS: readonly Garment[] = [
  { id: 'top-original', label: 'T-shirt', parts: (c) => SHORT_SLEEVES(c) },
  {
    id: 'top-hoodie', label: 'Hoodie',
    parts: (c) => [SHELL(c), HEM(c), ...LONG_SLEEVES(c, c, 0.003), box('torso', -0.11, 0.11, 0.3, 0.4, -0.215, -0.13, c), box('torso', -0.08, 0.08, 0.215, 0.265, 0.084, 0.092, c), ...both((s) => box('torso', ...LR(s, 0.028, 0.038), 0.28, 0.34, 0.084, 0.094, W))],
  },
  {
    id: 'top-jacket', label: 'Jacket', inner: true,
    parts: (c) => [
      box('torso', -0.135, 0.135, 0.198, 0.35, -0.147, -0.01, c),
      ...both((s) => box('torso', ...LR(s, 0.112, 0.135), 0.198, 0.35, -0.147, 0.089, c)),
      ...both((s) => box('torso', ...LR(s, 0.042, 0.135), 0.198, 0.35, 0.074, 0.091, c)),
      ...both((s) => box('torso', ...LR(s, 0.05, 0.13), 0.326, 0.362, 0.06, 0.1, c, s * 0.25)),
      ...LONG_SLEEVES(c, K, 0.004),
    ],
  },
  {
    id: 'top-puffer', label: 'Puffer vest', inner: true, innerSleeves: true,
    parts: (c) => [SHELL(c, 0.006), ...[0.235, 0.29].map((y) => box('torso', -0.143, 0.143, y, y + 0.026, -0.155, 0.097, c)), box('torso', -0.09, 0.09, 0.34, 0.375, -0.12, 0.07, c), box('torso', -0.005, 0.005, 0.2, 0.352, 0.09, 0.096, P.silver)],
  },
  {
    id: 'top-jersey', label: 'Jersey',
    parts: (c) => [SHELL(c, 0.003), ...SHORT_SLEEVES(c, 0.002), ...both((s) => ALONG(s, 0.032, 0.048, W, 0.005)), box('torso', -0.045, 0.045, 0.22, 0.3, 0.088, 0.094, W), box('torso', -0.055, 0.055, 0.33, 0.352, -0.05, 0.092, W)],
  },
  {
    id: 'top-sweater', label: 'Sweater',
    parts: (c) => [SHELL(c, 0.003), HEM(c), ...LONG_SLEEVES(c, c, 0.003), box('torso', -0.085, 0.085, 0.34, 0.37, -0.1, 0.065, c), ...[0.24, 0.3].map((y) => box('torso', -0.135, 0.135, y, y + 0.012, -0.147, 0.089, W))],
  },
];

// Long bottoms replace the body's shorts and shins entirely (both hidden), so nothing yellow peeks through.
// A seat joins the legs under the belt; each leg is its own tube with a small gap at the inseam.
const SEAT = (c: Sw) => box('root', -0.143, 0.143, 0.148, 0.2, -0.124, 0.07, c);
const PANT_LEG = (s: number, c: Sw, y0 = 0.068, k = 0) => box(leg(s), ...LR(s, 0.024 - k * 0.3, 0.143 + k), y0, 0.178, -0.107 - k, 0.052 + k, c);
const PANTS = (c: Sw, y0?: number, k?: number): Part[] => [SEAT(c), ...both((s) => PANT_LEG(s, c, y0, k))];
const FLY = (c: Sw) => box('root', -0.004, 0.004, 0.152, 0.198, 0.07, 0.074, K);

export const BOTTOMS: readonly Garment[] = [
  { id: 'bottom-original', label: 'Shorts', parts: () => [] },
  { id: 'bottom-pants', label: 'Long pants', long: true, parts: (c) => [...PANTS(c), FLY(c)] },
  {
    id: 'bottom-cargo', label: 'Cargo pants', long: true,
    // Baggier legs, big bellows pockets on the outer thighs with flaps, knee patches, cinched ankles.
    parts: (c) => [
      SEAT(c), FLY(c), ...both((s) => PANT_LEG(s, c, 0.084, 0.008)),
      ...both((s) => box(leg(s), ...LR(s, 0.026, 0.147), 0.064, 0.088, -0.11, 0.055, c)),
      ...both((s) => box(leg(s), ...LR(s, 0.149, 0.176), 0.098, 0.162, -0.078, 0.03, c)),
      ...both((s) => box(leg(s), ...LR(s, 0.148, 0.178), 0.15, 0.17, -0.082, 0.034, K)),
      ...both((s) => box(leg(s), ...LR(s, 0.04, 0.128), 0.098, 0.134, 0.058, 0.066, K)),
      box('root', -0.15, 0.15, 0.186, 0.2, -0.13, 0.076, K),
      ...both((s) => box('root', ...LR(s, 0.03, 0.05), 0.172, 0.2, 0.074, 0.079, P.silver)),
    ],
  },
  { id: 'bottom-joggers', label: 'Joggers', long: true, parts: (c) => [...PANTS(c, 0.085), ...both((s) => box(leg(s), ...LR(s, 0.026, 0.141), 0.064, 0.088, -0.105, 0.05, K)), ...both((s) => box(leg(s), ...LR(s, 0.142, 0.147), 0.09, 0.178, -0.035, -0.015, W)), box('root', -0.012, 0.012, 0.17, 0.198, 0.07, 0.075, W)] },
  { id: 'bottom-flares', label: 'Flares', long: true, parts: (c) => [...PANTS(c, 0.11), ...both((s) => box(leg(s), ...LR(s, 0.016, 0.151), 0.05, 0.115, -0.115, 0.06, c))] },
  { id: 'bottom-skirt', label: 'Skirt', parts: (c) => [box('root', -0.165, 0.165, 0.11, 0.215, -0.175, 0.12, c), box('root', -0.17, 0.17, 0.11, 0.124, -0.18, 0.125, c)] },
  {
    id: 'bottom-overalls', label: 'Overalls', long: true,
    parts: (c) => [...PANTS(c), box('torso', -0.09, 0.09, 0.21, 0.31, 0.078, 0.092, c), ...both((s) => box('torso', ...LR(s, 0.055, 0.085), 0.3, 0.352, -0.146, 0.092, c)), ...both((s) => box('torso', ...LR(s, 0.06, 0.08), 0.292, 0.308, 0.092, 0.098, P.yellow))],
  },
];

// Shoes hug each foot (the body's foot spans x 0.017-0.149, z -0.103..0.103 per side), leaving a clear gap
// between the two feet. Shafts sit on the ankle, narrower than the foot.
const SOLE = (s: number, sw: Sw, h = 0.02) => box(leg(s), ...LR(s, 0.021, 0.145), 0, h, -0.107, 0.11, sw);
const FOOT = (s: number, sw: Sw, y1 = 0.084) => box(leg(s), ...LR(s, 0.023, 0.143), 0.018, y1, -0.105, 0.106, sw);
const SHAFT = (s: number, sw: Sw, y1: number) => box(leg(s), ...LR(s, 0.03, 0.136), 0.07, y1, -0.104, 0.048, sw);

export const SHOES: readonly Garment[] = [
  { id: 'shoes-original', label: 'Sneakers', parts: () => [] },
  {
    id: 'shoes-hightops', label: 'High-tops',
    parts: (c) => both((s) => [SOLE(s, W), FOOT(s, c), SHAFT(s, c, 0.112), box(leg(s), ...LR(s, 0.04, 0.126), 0.02, 0.05, 0.1, 0.11, W), box(leg(s), ...LR(s, 0.134, 0.139), 0.07, 0.1, -0.04, -0.01, W)]).flat(),
  },
  {
    id: 'shoes-boots', label: 'Boots',
    parts: (c) => both((s) => [SOLE(s, P.brown, 0.024), FOOT(s, c), SHAFT(s, c, 0.122), box(leg(s), ...LR(s, 0.028, 0.138), 0.112, 0.126, -0.106, 0.05, P.brown), ...[0.06, 0.085].map((y) => box(leg(s), ...LR(s, 0.05, 0.116), y, y + 0.008, 0.106, 0.109, K))]).flat(),
  },
  {
    id: 'shoes-rain', label: 'Rain boots',
    parts: (c) => both((s) => [SOLE(s, K, 0.018), FOOT(s, c), SHAFT(s, c, 0.135), box(leg(s), ...LR(s, 0.028, 0.138), 0.125, 0.138, -0.106, 0.05, c)]).flat(),
  },
];

export const HATS: readonly Garment[] = [
  { id: 'hat-none', label: 'None', parts: () => [] },
  { id: 'hat-cap', label: 'Cap', clamp: 0.695, parts: (c) => [box('head', -0.236, 0.236, 0.6, 0.705, -0.172, 0.168, c), box('head', -0.18, 0.18, 0.598, 0.62, 0.15, 0.29, c), box('head', -0.02, 0.02, 0.705, 0.72, -0.02, 0.02, c)] },
  { id: 'hat-beanie', label: 'Beanie', clamp: 0.71, parts: (c) => [box('head', -0.24, 0.24, 0.585, 0.72, -0.176, 0.172, c), box('head', -0.248, 0.248, 0.575, 0.625, -0.184, 0.18, c), box('head', -0.05, 0.05, 0.72, 0.78, -0.05, 0.05, W)] },
  { id: 'hat-bucket', label: 'Bucket hat', clamp: 0.73, parts: (c) => [box('head', -0.215, 0.215, 0.62, 0.745, -0.185, 0.18, c), box('head', -0.3, 0.3, 0.6, 0.625, -0.27, 0.265, c)] },
  { id: 'hat-headphones', label: 'Headphones', parts: (c) => [box('head', -0.25, 0.25, 0.69, 0.718, -0.03, 0.03, c), ...both((s) => box('head', ...LR(s, 0.236, 0.256), 0.52, 0.7, -0.028, 0.028, c)), ...both((s) => box('head', ...LR(s, 0.228, 0.278), 0.43, 0.56, -0.065, 0.065, K))] },
  { id: 'hat-headband', label: 'Headband', parts: (c) => [box('head', -0.236, 0.236, 0.6, 0.642, -0.172, 0.166, c)] },
];

// ── Expressions. Every face shares one layout: eyes centred at x ±0.078, y 0.487, mouth at y 0.418, all
// drawn flat on the face plane (z 0.16). A new expression hides the 'face' region and draws its own, in black.
const FZ: [number, number] = [0.1595, 0.1655];
const fb = (x0: number, x1: number, y0: number, y1: number, rotZ = 0) => box('head', x0, x1, y0, y1, FZ[0], FZ[1], FACE_SW, rotZ);
const EX = 0.078;
const EY = 0.487;
const eyes = (w: number, h: number, y = EY) => both((s) => fb(s * EX - w / 2, s * EX + w / 2, y - h / 2, y + h / 2));
const caret = (cx: number, cy: number, w = 0.06) => [fb(cx - w / 2, cx + 0.004, cy - 0.008, cy + 0.008, 0.55), fb(cx - 0.004, cx + w / 2, cy - 0.008, cy + 0.008, -0.55)];
const smile = (w = 0.1, y = 0.41) => [fb(-w / 2 + 0.014, w / 2 - 0.014, y - 0.009, y + 0.009), fb(-w / 2, -w / 2 + 0.018, y - 0.002, y + 0.03), fb(w / 2 - 0.018, w / 2, y - 0.002, y + 0.03)];

export const EXPRESSIONS: readonly Garment[] = [
  { id: 'face-own', label: 'Smile', parts: () => [] },
  { id: 'face-happy', label: 'Happy', replace: true, parts: () => [...caret(EX, EY), ...caret(-EX, EY), ...smile(0.11)] },
  { id: 'face-grin', label: 'Grin', replace: true, parts: () => [...eyes(0.05, 0.05), fb(-0.06, 0.06, 0.392, 0.44)] },
  { id: 'face-wink', label: 'Wink', replace: true, parts: () => [fb(-EX - 0.025, -EX + 0.025, EY - 0.025, EY + 0.025), ...caret(EX, EY), ...smile(0.1)] },
  { id: 'face-surprised', label: 'Surprised', replace: true, parts: () => [...eyes(0.046, 0.066), fb(-0.022, 0.022, 0.39, 0.438)] },
  { id: 'face-sleepy', label: 'Sleepy', replace: true, parts: () => [...eyes(0.064, 0.013, EY - 0.008), fb(-0.022, 0.022, 0.408, 0.42)] },
  { id: 'face-cool', label: 'Cool', replace: true, parts: () => [...eyes(0.06, 0.026, EY - 0.006), ...both((s) => fb(s * EX - 0.036, s * EX + 0.036, EY + 0.014, EY + 0.026)), fb(-0.01, 0.06, 0.402, 0.418, 0.18)] },
  { id: 'face-freckles', label: 'Freckles', parts: () => both((s) => [[0.114, 0.446], [0.136, 0.452], [0.126, 0.432], [0.148, 0.438]].map(([x, y]) => fb(s * x - 0.006, s * x + 0.006, y - 0.006, y + 0.006))).flat() },
];

// ── Glasses: round rims (rings) in front of the eyes, a bridge, and arms back to the ears.
const GZ = 0.176;
const GR = 0.05;
function glasses({ sx = 1, sy = 1, tilt = 0, r = GR, tube = 0.0085 }: { sx?: number; sy?: number; tilt?: number; r?: number; tube?: number }, frame: Sw, lens?: Sw): Part[] {
  const hw = r * sx;
  return [
    ...both((s) => ring('head', [s * EX, EY, GZ], r, tube, frame, [sx, sy], s * tilt)),
    ...(lens ? both((s) => disc('head', [s * EX, EY, GZ - 0.002], r * 0.94, 0.004, lens, [sx, sy], s * tilt)) : []),
    box('head', -(EX - hw) - 0.004, EX - hw + 0.004, EY + 0.004, EY + 0.016, GZ - 0.005, GZ + 0.005, frame),
    ...both((s) => box('head', ...LR(s, EX + hw - 0.004, 0.184), EY + r * sy * 0.35 - 0.006, EY + r * sy * 0.35 + 0.006, GZ - 0.005, GZ + 0.005, frame)),
    ...both((s) => box('head', ...LR(s, 0.176, 0.186), EY + r * sy * 0.35 - 0.006, EY + r * sy * 0.35 + 0.006, -0.02, GZ, frame)),
  ];
}

export const GLASSES: readonly Garment[] = [
  { id: 'glasses-none', label: 'None', parts: () => [] },
  { id: 'glasses-round', label: 'Round', parts: (c) => glasses({}, c) },
  { id: 'glasses-oval', label: 'Oval', parts: (c) => glasses({ sx: 1.22, sy: 0.78 }, c) },
  { id: 'glasses-cat', label: 'Cat-eye', parts: (c) => glasses({ sx: 1.2, sy: 0.8, tilt: 0.32 }, c) },
  { id: 'glasses-aviator', label: 'Aviators', parts: (c) => glasses({ sx: 1.06, sy: 0.96, tilt: -0.18, r: 0.054 }, c, P.grey) },
  { id: 'glasses-shades', label: 'Shades', parts: (c) => glasses({ r: 0.054, tube: 0.011 }, c, K) },
  { id: 'glasses-tinted', label: 'Tinted', parts: (c) => glasses({ r: 0.054 }, c, P.yellow) },
];

const STRAPS = (sw: Sw): Part[] => both((s) => [box('torso', ...LR(s, 0.058, 0.09), 0.215, 0.35, 0.095, 0.108, sw), box('torso', ...LR(s, 0.058, 0.09), 0.345, 0.364, -0.16, 0.108, sw)]).flat();

export const BAGS: readonly Garment[] = [
  { id: 'bag-none', label: 'None', parts: () => [] },
  { id: 'bag-backpack', label: 'Backpack', parts: (c) => [box('torso', -0.112, 0.112, 0.2, 0.355, -0.24, -0.148, c), box('torso', -0.08, 0.08, 0.215, 0.285, -0.258, -0.235, c), box('torso', -0.114, 0.114, 0.33, 0.345, -0.244, -0.146, K), ...STRAPS(K)] },
  { id: 'bag-hiking', label: 'Hiking pack', parts: (c) => [box('torso', -0.122, 0.122, 0.185, 0.43, -0.27, -0.15, c), box('torso', -0.126, 0.126, 0.4, 0.44, -0.274, -0.146, K), box('torso', -0.16, 0.16, 0.44, 0.5, -0.255, -0.175, P.purple), box('torso', -0.09, 0.09, 0.22, 0.3, -0.29, -0.268, c), ...STRAPS(K), box('torso', -0.16, 0.16, 0.2, 0.225, -0.17, 0.112, K)] },
  { id: 'bag-messenger', label: 'Messenger', parts: (c) => [box('torso', -0.04, 0.17, 0.17, 0.28, -0.22, -0.152, c), box('torso', -0.042, 0.172, 0.23, 0.282, -0.225, -0.15, c), box('torso', -0.02, 0.02, 0.17, 0.43, 0.096, 0.108, K, -0.75), box('torso', -0.02, 0.02, 0.17, 0.43, -0.164, -0.152, K, 0.75)] },
];

// Hand items ride the right arm, relative to the right hand's centre in bind pose. In the holding pose the
// arm points forward, so local +y stays up, local +dz points across toward the body, local -dx points ahead.
// Shafts run through the fist (dz ~0); held objects sit just ahead of it.
const H: Vec3 = [-0.313, 0.2875, 0.036];
const CREAM: Sw = [2, 1];
const at = (dx: number, dy: number, dz: number): Vec3 => [H[0] + dx, H[1] + dy, H[2] + dz];
const hand = (dx0: number, dx1: number, dy0: number, dy1: number, dz0: number, dz1: number, sw: Sw, rotZ = 0, rotX = 0): BoxPart => ({
  ...box('arm-right', H[0] + dx0, H[0] + dx1, H[1] + dy0, H[1] + dy1, H[2] + dz0, H[2] + dz1, sw, rotZ),
  rotX,
});
const hBall = (dx: number, dy: number, dz: number, r: number, sw: Sw, scale: Vec3 = [1, 1, 1], rot: { rotX?: number; rotZ?: number } = {}): BallPart => ({ bone: 'arm-right', kind: 'ball', c: at(dx, dy, dz), r, sw, scale3: scale, ...rot });
const hCone = (dx: number, dy: number, dz: number, r: number, h: number, sw: Sw, o: { seg?: number; scale?: Vec3; rotX?: number; rotZ?: number } = {}): ConePart => ({ bone: 'arm-right', kind: 'cone', c: at(dx, dy, dz), r, h, sw, seg: o.seg || 8, scale3: o.scale || [1, 1, 1], rotX: o.rotX || 0, rotZ: o.rotZ || 0 });
const hCyl = (dx: number, dy: number, dz: number, r: number, h: number, sw: Sw, o: { rTop?: number; seg?: number; scale?: Vec3; rotX?: number; rotZ?: number } = {}): CylPart => ({ bone: 'arm-right', kind: 'cyl', c: at(dx, dy, dz), r, rTop: o.rTop ?? r, h, sw, seg: o.seg || 10, scale3: o.scale || [1, 1, 1], rotX: o.rotX || 0, rotZ: o.rotZ || 0 });
const shaft = (len: number, sw: Sw, rotX = 0, y0 = -0.06, w = 0.014) => hand(-w / 2, w / 2, y0, y0 + len, -w / 2, w / 2, sw, 0, rotX);

export const HANDS: readonly Garment[] = [
  { id: 'hand-none', label: 'None', parts: () => [] },
  { id: 'hand-crutches', label: 'Crutches', parts: () => [] },
  { id: 'hand-coffee', label: 'Coffee', parts: () => [hand(-0.04, 0.04, -0.06, 0.05, 0.075, 0.155, W), hand(-0.042, 0.042, -0.01, 0.025, 0.073, 0.157, P.brown), hand(-0.044, 0.044, 0.05, 0.07, 0.071, 0.159, K)] },
  { id: 'hand-phone', label: 'Phone', parts: () => [hand(-0.035, 0.035, -0.08, 0.06, 0.07, 0.085, K), hand(-0.028, 0.028, -0.07, 0.05, 0.085, 0.088, P.sky)] },
  { id: 'hand-books', label: 'Books', parts: () => [hand(-0.03, 0.03, -0.09, 0.07, 0.075, 0.185, P.red), hand(-0.026, 0.026, -0.085, 0.065, 0.185, 0.2, W), hand(-0.03, 0.03, -0.09, 0.07, 0.2, 0.25, P.blue)] },
  { id: 'hand-skateboard', label: 'Skateboard', parts: () => [hand(-0.03, -0.012, -0.24, 0.24, 0.06, 0.16, P.orange), ...[-0.18, 0.18].map((y) => hand(-0.05, -0.03, y - 0.03, y + 0.03, 0.07, 0.15, P.silver))] },
  {
    id: 'hand-umbrella', label: 'Umbrella',
    parts: () => [shaft(0.58, K, 0.22), hand(-0.012, 0.012, -0.1, -0.05, -0.012, 0.03, K), hCone(0, 0.5, 0.11, 0.33, 0.14, P.red, { rotX: 0.22 }), hBall(0, 0.58, 0.13, 0.018, K)],
  },
  { id: 'hand-water', label: 'Water bottle', parts: () => [hCyl(-0.03, 0.12, 0, 0.034, 0.16, P.sky), hCyl(-0.03, 0.215, 0, 0.022, 0.03, K), hCyl(-0.03, 0.1, 0, 0.0355, 0.03, P.blue)] },
  { id: 'hand-flashlight', label: 'Flashlight', parts: () => [hCyl(-0.04, 0, 0.03, 0.022, 0.15, K, { rotZ: Math.PI / 2 }), hCyl(-0.125, 0, 0.03, 0.032, 0.03, K, { rotZ: Math.PI / 2 }), hCyl(-0.142, 0, 0.03, 0.026, 0.006, P.yellow, { rotZ: Math.PI / 2 })] },
  { id: 'hand-megaphone', label: 'Megaphone', parts: () => [hand(-0.016, 0.016, -0.06, 0.02, -0.016, 0.016, K), hCyl(-0.09, 0.04, 0.03, 0.03, 0.15, W, { rTop: 0.075, rotZ: Math.PI / 2 }), hCyl(-0.17, 0.04, 0.03, 0.077, 0.014, P.red, { rotZ: Math.PI / 2 })] },
  { id: 'hand-flag', label: 'Team flag', parts: () => [shaft(0.5, P.brown, 0, -0.08, 0.012), hand(0.0, 0.006, 0.26, 0.42, 0.006, 0.2, P.red), hand(0.0, 0.007, 0.32, 0.36, 0.04, 0.16, W), hBall(0, 0.43, 0, 0.016, P.yellow)] },
  { id: 'hand-icecream', label: 'Ice cream', parts: () => [hCone(-0.03, 0.09, 0, 0.04, 0.12, P.tan, { rotX: Math.PI }), hBall(-0.03, 0.165, 0, 0.046, P.pink), hBall(-0.03, 0.225, 0, 0.04, P.brown), hBall(-0.03, 0.27, 0, 0.013, P.red)] },
  { id: 'hand-boba', label: 'Bubble tea', parts: () => [hCyl(-0.03, 0.12, 0, 0.042, 0.15, P.tan, { rTop: 0.048 }), hCyl(-0.03, 0.2, 0, 0.05, 0.012, P.sky), hand(-0.036, -0.024, 0.19, 0.3, -0.006, 0.006, P.pink, 0.15), ...([[-0.02, -0.024], [0.02, -0.02], [0, 0.026], [0.024, 0.018], [-0.024, 0.02]] as const).map(([x, z]) => hBall(-0.03 + x, 0.065, z, 0.012, K))] },
  { id: 'hand-pizza', label: 'Pizza slice', parts: () => [hCone(-0.03, 0.15, 0, 0.1, 0.2, P.yellow, { seg: 3, scale: [0.3, 1, 1] }), hand(-0.04, -0.02, 0.04, 0.07, -0.085, 0.085, P.tan), ...([[0.09, -0.03], [0.11, 0.035], [0.18, 0.0]] as const).map(([y, z]) => hCyl(-0.042, y, z, 0.017, 0.006, P.red, { rotZ: Math.PI / 2 }))] },
  { id: 'hand-balloon', label: 'Balloon', parts: () => [shaft(0.52, W, 0, -0.04, 0.005), hCone(0, 0.48, 0, 0.014, 0.025, P.red), hBall(0, 0.58, 0, 0.1, P.red, [1, 1.18, 1]), hBall(-0.035, 0.62, 0.06, 0.018, W)] },
  {
    id: 'hand-chicken', label: 'Rubber chicken',
    parts: () => [hand(-0.008, 0.008, -0.07, 0.03, -0.02, -0.004, P.orange), hand(-0.008, 0.008, -0.07, 0.03, 0.004, 0.02, P.orange), hBall(0, -0.15, 0, 0.055, W, [0.8, 1.6, 0.8]), hBall(0, -0.26, 0.012, 0.035, W), hCone(-0.035, -0.27, 0.01, 0.012, 0.035, P.orange, { rotZ: Math.PI / 2 }), hand(-0.008, 0.008, -0.31, -0.28, -0.004, 0.024, P.red), ...[-0.012, 0.012].map((z) => hBall(-0.02, -0.25, 0.012 + z * 2, 0.006, K))],
  },
  {
    id: 'hand-fish', label: 'Fish',
    // Held by the tail, hanging head-down. Flat sides face ahead (local ±x) so the profile reads from the front.
    parts: () => [
      hand(-0.0095, 0.0095, -0.0675, 0.0000, -0.0810, -0.0081, P.blue, 0.0, -0.5), hand(-0.0095, 0.0095, -0.0675, 0.0000, 0.0081, 0.0810, P.blue, 0.0, 0.5),
      hand(-0.0162, 0.0162, -0.1148, -0.0540, -0.0243, 0.0243, P.blue),
      hBall(0.0000, -0.2430, 0.0000, 0.0837, P.blue, [0.36, 1.65, 1]),
      hBall(0.0000, -0.2565, 0.0405, 0.0675, P.sky, [0.4, 1.45, 0.55]),
      hand(-0.0081, 0.0081, -0.2835, -0.1755, -0.1148, -0.0607, P.blue, 0, 0.25),
      ...[-1, 1].map((sx) => hBall(sx * 0.0162, -0.3307, 0.0162, 0.0203, W)),
      ...[-1, 1].map((sx) => hBall(sx * 0.0270, -0.3348, 0.0216, 0.0108, K)),
      hand(-0.0135, 0.0135, -0.3847, -0.3699, -0.0162, 0.0162, K),
    ],
  },
  {
    id: 'hand-baguette', label: 'Baguette',
    // A long golden loaf leaning out from the fist, three cream score marks facing ahead, paper wrap at the grip.
    parts: () => [
      hBall(0, 0.09, 0, 0.044, P.tan, [1, 5.4, 1], { rotX: -0.42 }),
      hand(-0.0450, -0.0350, 0.0366, 0.0886, -0.0038, 0.0282, CREAM, 0, 0.280),
      hand(-0.0450, -0.0350, 0.1188, 0.1708, -0.0405, -0.0085, CREAM, 0, 0.280),
      hand(-0.0450, -0.0350, 0.2010, 0.2530, -0.0772, -0.0452, CREAM, 0, 0.280),
      hCyl(0.0000, -0.0287, 0.0530, 0.05, 0.13, W, { rotX: -0.42, seg: 8 }),
      hCyl(0.0000, 0.0297, 0.0269, 0.052, 0.014, P.red, { rotX: -0.42, seg: 8 }),
    ],
  },
  { id: 'hand-frisbee', label: 'Frisbee', parts: () => [hCyl(-0.065, 0.05, 0, 0.11, 0.016, P.green, { rotZ: Math.PI / 2 }), hCyl(-0.075, 0.05, 0, 0.065, 0.005, W, { rotZ: Math.PI / 2 })] },
];

/* ---------------------------------------------------------------------------
 * The appearance model.
 * ------------------------------------------------------------------------- */

/** Fields naming a style option. */
export type StyleField = 'skin' | 'hair' | 'expression' | 'top' | 'bottom' | 'shoes' | 'hat' | 'glasses' | 'bag' | 'hand';
/** Fields naming a palette colour. */
export type ColorField = 'hairColor' | 'topColor' | 'bottomColor' | 'shoesColor' | 'hatColor' | 'glassesColor' | 'bagColor';

export type Appearance = Record<StyleField, string> & Record<ColorField, ColorId>;

/** Which framing a category's thumbnails use. Mirrors CAMERAS in personaRender.ts. */
export type CameraId = 'full' | 'stage' | 'person' | 'hair' | 'hat' | 'face' | 'expression' | 'top' | 'bottom' | 'shoes' | 'bag' | 'hand';

export interface Category {
  id: string;
  label: string;
  options: readonly { id: string; label: string }[];
  field: StyleField;
  color?: ColorField;
  colors?: readonly ColorId[];
  cam: CameraId;
}

export const CATEGORIES: readonly Category[] = [
  { id: 'skin', label: 'Skin', options: SKINS, field: 'skin', cam: 'person' },
  { id: 'hair', label: 'Hair', options: HAIR_STYLES, field: 'hair', color: 'hairColor', colors: HAIR_COLORS, cam: 'hair' },
  { id: 'expression', label: 'Face', options: EXPRESSIONS, field: 'expression', cam: 'expression' },
  { id: 'top', label: 'Top', options: TOPS, field: 'top', color: 'topColor', colors: ALL, cam: 'top' },
  { id: 'bottom', label: 'Bottom', options: BOTTOMS, field: 'bottom', color: 'bottomColor', colors: ALL, cam: 'bottom' },
  { id: 'shoes', label: 'Shoes', options: SHOES, field: 'shoes', color: 'shoesColor', colors: ALL, cam: 'shoes' },
  { id: 'hat', label: 'Hat', options: HATS, field: 'hat', color: 'hatColor', colors: ALL, cam: 'hat' },
  { id: 'glasses', label: 'Glasses', options: GLASSES, field: 'glasses', color: 'glassesColor', colors: GLASSES_COLORS, cam: 'face' },
  { id: 'bag', label: 'Bag', options: BAGS, field: 'bag', color: 'bagColor', colors: ALL, cam: 'bag' },
  { id: 'hand', label: 'Holding', options: HANDS, field: 'hand', cam: 'hand' },
];

export const DEFAULT_APPEARANCE: Appearance = {
  skin: 'yellow', hair: 'hair-short', hairColor: 'black', expression: 'face-own',
  top: 'top-original', topColor: 'green', bottom: 'bottom-original', bottomColor: 'blue', shoes: 'shoes-original', shoesColor: 'yellow',
  hat: 'hat-none', hatColor: 'blue', glasses: 'glasses-none', glassesColor: 'black', bag: 'bag-none', bagColor: 'green', hand: 'hand-none',
};

/** Ready-made looks (sample row + a starting point for Randomize). */
export const PRESETS: readonly Appearance[] = ([
  { hair: 'hair-bun', hairColor: 'black', top: 'top-hoodie', topColor: 'green', bottom: 'bottom-joggers', bottomColor: 'black', shoes: 'shoes-hightops', shoesColor: 'red', hat: 'hat-headphones', hatColor: 'white', hand: 'hand-crutches' },
  { hair: 'hair-buns', hairColor: 'tan', expression: 'face-happy', top: 'top-jacket', topColor: 'blue', bottom: 'bottom-skirt', bottomColor: 'black', shoes: 'shoes-boots', shoesColor: 'tan', glasses: 'glasses-cat', glassesColor: 'pink' },
  { hair: 'hair-bob', hairColor: 'brown', expression: 'face-freckles', top: 'top-puffer', topColor: 'red', bottom: 'bottom-cargo', bottomColor: 'tan', shoes: 'shoes-boots', shoesColor: 'brown', bag: 'bag-hiking', bagColor: 'orange', hat: 'hat-bucket', hatColor: 'tan' },
  { hair: 'hair-quiff', hairColor: 'black', expression: 'face-cool', top: 'top-jersey', topColor: 'orange', bottom: 'bottom-pants', bottomColor: 'blue', shoes: 'shoes-hightops', shoesColor: 'white', glasses: 'glasses-shades', hand: 'hand-skateboard' },
  { hair: 'hair-beard', hairColor: 'brown', expression: 'face-wink', top: 'top-sweater', topColor: 'purple', bottom: 'bottom-overalls', bottomColor: 'blue', shoes: 'shoes-rain', shoesColor: 'yellow', bag: 'bag-messenger', bagColor: 'brown', hand: 'hand-coffee', glasses: 'glasses-round', glassesColor: 'brown' },
] as Partial<Appearance>[]).map((p) => ({ ...DEFAULT_APPEARANCE, ...p }));

/** A stable cache key for one look, so a renderer can skip rebuilding an unchanged character. */
export function appearanceKey(a: Appearance): string {
  return [a.skin, a.hair, a.hairColor, a.expression, a.top, a.topColor, a.bottom, a.bottomColor, a.shoes, a.shoesColor, a.hat, a.hatColor, a.glasses, a.glassesColor, a.bag, a.bagColor, a.hand].join('|');
}

const find = <T extends { id: string }>(list: readonly T[], id: string): T => list.find((o) => o.id === id) || list[0];

export interface Resolved {
  pieces: Piece[];
  recolor: Partial<Record<Region, Sw>>;
  hide: Region[];
  clamp: number | null;
  parts: Part[];
  anim: 'idle' | 'holding-right';
}

/** Everything the renderer needs: meshes to assemble, region recolours, hidden regions, hair clamp, add-on parts. */
export function resolve(a: Appearance): Resolved {
  const style = find(HAIR_STYLES, a.hair);
  const top = find(TOPS, a.top);
  const bottom = find(BOTTOMS, a.bottom);
  const shoes = find(SHOES, a.shoes);
  const hat = find(HATS, a.hat);
  const expr = find(EXPRESSIONS, a.expression);
  const gl = find(GLASSES, a.glasses);
  const bag = find(BAGS, a.bag);
  const hand = find(HANDS, a.hand);
  const innerTop: ColorId = top.inner ? (a.topColor === 'white' ? 'black' : 'white') : a.topColor;
  const pieces: Piece[] = [BODY, headPiece(style)];
  if (hand.id === 'hand-crutches') pieces.push(CRUTCHES);
  const hide: Region[] = ['sleeve'];
  if (expr.replace) hide.push('face');
  if (bottom.long) hide.push('bottom', 'shin');
  return {
    pieces,
    recolor: { shin: find(SKINS, a.skin).sw, skin: find(SKINS, a.skin).sw, hair: P[a.hairColor], face: FACE_SW, top: P[innerTop], bottom: P[a.bottomColor], shoes: P[a.shoesColor] },
    hide,
    clamp: hat.clamp || null,
    parts: [
      ...(top.innerSleeves ? SHORT_SLEEVES(P[innerTop]) : []),
      ...top.parts(P[a.topColor]),
      ...bottom.parts(P[a.bottomColor]),
      ...shoes.parts(P[a.shoesColor]),
      ...expr.parts(FACE_SW),
      ...hat.parts(P[a.hatColor]),
      ...gl.parts(P[a.glassesColor]),
      ...bag.parts(P[a.bagColor]),
      ...hand.parts(FACE_SW),
    ],
    anim: hand.id === 'hand-none' || hand.id === 'hand-crutches' ? 'idle' : 'holding-right',
  };
}

/** A plain-English rundown of a look: "black short hair, green t-shirt, blue shorts, …". */
export function describe(a: Appearance): string {
  const col = (id: ColorId) => PALETTE.find((c) => c.id === id)?.label.toLowerCase();
  const bits: string[] = [];
  bits.push(`${col(a.hairColor)} ${find(HAIR_STYLES, a.hair).label.toLowerCase()}${a.hair === 'hair-bald' ? '' : ' hair'}`);
  const x = find(EXPRESSIONS, a.expression);
  if (x.id !== 'face-own') bits.push(x.label.toLowerCase());
  bits.push(`${col(a.topColor)} ${find(TOPS, a.top).label.toLowerCase()}`);
  bits.push(`${col(a.bottomColor)} ${find(BOTTOMS, a.bottom).label.toLowerCase()}`);
  bits.push(`${col(a.shoesColor)} ${find(SHOES, a.shoes).label.toLowerCase()}`);
  const h = find(HATS, a.hat);
  if (h.id !== 'hat-none') bits.push(h.label.toLowerCase());
  const g = find(GLASSES, a.glasses);
  if (g.id !== 'glasses-none') bits.push(g.label.toLowerCase() + ' glasses');
  const b = find(BAGS, a.bag);
  if (b.id !== 'bag-none') bits.push(b.label.toLowerCase());
  const n = find(HANDS, a.hand);
  if (n.id !== 'hand-none') bits.push(n.id === 'hand-crutches' ? 'crutches' : 'holding ' + n.label.toLowerCase());
  return bits.join(', ');
}

/**
 * The stock Kenney GLB that best matches a look.
 *
 * The map draws the simulated crowd from the 12 shipped `character-*.glb` files. A joined persona's
 * hair style *is* one of those heads (HAIR_STYLES[].model), so the closest stock body is the one whose
 * head the student picked. Used by the map layer, which draws real GLBs rather than assembling geometry.
 */
export function stockModelFor(a: Appearance): string {
  return find(HAIR_STYLES, a.hair).model;
}
