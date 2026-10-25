// The persona appearance catalog: every hair/top/bottom/face/shoes/backpack/costume option a
// student can pick on /join, described as real 3D geometry -- primitive-shape recipes (box,
// cylinder, cone, sphere), not flat colors on a box. This is the ONE place "what a Hoodie actually
// looks like in 3D" is defined. web/ consumes this file directly via its `@map/*` Vite alias (see
// web/vite.config.ts and web/src/map-entry.ts's existing `import '@map/main'`) -- genuinely shared,
// not hand-duplicated like persona.ts/personaShared.ts's wander logic was (that duplication predates
// this alias being used this way; there's no reason to repeat it here now that it demonstrably works).
//
// Two renderers consume this catalog: map-client/src/layers/personaMeshes.ts (luma.gl, for the live
// map) and web/src/lib/personaMeshes.ts (Three.js, for the /join preview and picker thumbnails).
// Each turns a PartLayer's PrimitiveSpec[] into its own engine's geometry type and merges them --
// see buildPrimitives() in either file for the shared per-primitive math (kept in those two files,
// not here, since it's genuinely engine-specific; only the *recipe* lives here).

export type PartCategory = 'hair' | 'top' | 'bottom' | 'face' | 'shoes' | 'backpack' | 'costume';
export type RGB = [number, number, number];

export type PrimitiveSpec =
  | { kind: 'box'; size: [number, number, number]; pos: [number, number, number]; rotateDeg?: [number, number, number] }
  | { kind: 'cylinder'; radius: number; height: number; segments?: number; pos: [number, number, number]; rotateDeg?: [number, number, number] }
  | { kind: 'cone'; radiusTop: number; radiusBottom: number; height: number; segments?: number; pos: [number, number, number]; rotateDeg?: [number, number, number] }
  | { kind: 'sphere'; radius: number; thetaStart?: number; thetaLength?: number; pos: [number, number, number] };

/** One colored piece of an option -- most options are one layer; a few (hoodie's hood, a hiking
 * pack's bedroll, the jersey costume's shorts) need a second color, which means a second mesh/layer
 * at render time (no vertex colors -- see personaMeshes.ts for why). */
export interface PartLayer {
  primitives: PrimitiveSpec[];
  color: RGB;
}

export interface PartOption {
  id: string;
  category: PartCategory;
  label: string;
  layers: PartLayer[]; // empty = nothing drawn (e.g. "Bald", "No backpack")
}

// Standing ~1.5 m peg figure, legs-to-head-top. Matches the original simple peg-doll's proportions.
export const LEG_LEN = 0.55;
export const TORSO_LEN = 0.55;
export const HEAD_R = 0.15;
export const HIP_Y = LEG_LEN;
export const SHOULDER_Y = LEG_LEN + TORSO_LEN;
export const HEAD_CY = SHOULDER_Y + HEAD_R;

/** Locked base body -- always this one glossy yellow, no skin-tone picker. Visible wherever a
 * garment doesn't cover it (e.g. calves below shorts), the way the real Pegman reference is one
 * solid-colored figure with garments layered on top, not a separate "skin" underneath everything. */
export const BASE_BODY_COLOR: RGB = [255, 193, 7];
export const BASE_BODY_LAYERS: PartLayer[] = [
  { primitives: [{ kind: 'sphere', radius: HEAD_R, pos: [0, HEAD_CY, 0] }], color: BASE_BODY_COLOR },
  { primitives: [{ kind: 'box', size: [0.22, TORSO_LEN, 0.14], pos: [0, SHOULDER_Y - TORSO_LEN / 2, 0] }], color: BASE_BODY_COLOR },
  {
    primitives: [
      { kind: 'cylinder', radius: 0.055, height: LEG_LEN, segments: 8, pos: [-0.07, 0, 0] },
      { kind: 'cylinder', radius: 0.055, height: LEG_LEN, segments: 8, pos: [0.07, 0, 0] },
    ],
    color: BASE_BODY_COLOR,
  },
];

const HAIR: PartOption[] = [
  { id: 'hair-bald', category: 'hair', label: 'Bald', layers: [] },
  {
    id: 'hair-short',
    category: 'hair',
    label: 'Short',
    layers: [{ primitives: [{ kind: 'sphere', radius: HEAD_R * 1.1, thetaStart: 0, thetaLength: Math.PI * 0.55, pos: [0, HEAD_CY, 0] }], color: [54, 38, 28] }],
  },
  {
    id: 'hair-long',
    category: 'hair',
    label: 'Long',
    layers: [
      { primitives: [{ kind: 'sphere', radius: HEAD_R * 1.1, thetaStart: 0, thetaLength: Math.PI * 0.55, pos: [0, HEAD_CY, 0] }], color: [40, 28, 22] },
      {
        primitives: [
          { kind: 'box', size: [0.2, 0.34, 0.06], pos: [0, HEAD_CY - 0.12, -HEAD_R * 0.75] },
          { kind: 'box', size: [0.08, 0.3, 0.08], pos: [-HEAD_R * 0.95, HEAD_CY - 0.14, 0], rotateDeg: [0, 0, 8] },
          { kind: 'box', size: [0.08, 0.3, 0.08], pos: [HEAD_R * 0.95, HEAD_CY - 0.14, 0], rotateDeg: [0, 0, -8] },
        ],
        color: [40, 28, 22],
      },
    ],
  },
  {
    id: 'hair-cap',
    category: 'hair',
    label: 'Cap',
    layers: [
      {
        primitives: [
          { kind: 'cylinder', radius: HEAD_R * 1.12, height: 0.1, segments: 10, pos: [0, HEAD_CY - 0.02, 0] },
          { kind: 'box', size: [0.22, 0.02, 0.12], pos: [0, HEAD_CY - 0.07, HEAD_R * 1.05] },
        ],
        color: [196, 48, 56],
      },
    ],
  },
];

const FACE: PartOption[] = [
  { id: 'face-none', category: 'face', label: 'None', layers: [] },
  {
    id: 'face-glasses',
    category: 'face',
    label: 'Glasses',
    layers: [
      {
        primitives: [
          { kind: 'cylinder', radius: 0.035, height: 0.012, segments: 12, pos: [-0.06, HEAD_CY, HEAD_R * 0.92], rotateDeg: [90, 0, 0] },
          { kind: 'cylinder', radius: 0.035, height: 0.012, segments: 12, pos: [0.06, HEAD_CY, HEAD_R * 0.92], rotateDeg: [90, 0, 0] },
          { kind: 'box', size: [0.05, 0.012, 0.012], pos: [0, HEAD_CY, HEAD_R * 0.95] },
        ],
        color: [210, 230, 235],
      },
    ],
  },
  {
    id: 'face-sunglasses',
    category: 'face',
    label: 'Sunglasses',
    layers: [
      {
        primitives: [
          { kind: 'cylinder', radius: 0.038, height: 0.014, segments: 12, pos: [-0.06, HEAD_CY, HEAD_R * 0.92], rotateDeg: [90, 0, 0] },
          { kind: 'cylinder', radius: 0.038, height: 0.014, segments: 12, pos: [0.06, HEAD_CY, HEAD_R * 0.92], rotateDeg: [90, 0, 0] },
          { kind: 'box', size: [0.05, 0.014, 0.014], pos: [0, HEAD_CY, HEAD_R * 0.95] },
        ],
        color: [18, 18, 22],
      },
    ],
  },
];

const TOP: PartOption[] = [
  {
    id: 'top-tshirt',
    category: 'top',
    label: 'T-shirt',
    layers: [
      {
        primitives: [
          { kind: 'box', size: [0.26, TORSO_LEN + 0.02, 0.17], pos: [0, SHOULDER_Y - (TORSO_LEN + 0.02) / 2, 0] },
          { kind: 'cylinder', radius: 0.045, height: 0.1, segments: 8, pos: [-0.16, SHOULDER_Y - 0.08, 0], rotateDeg: [0, 0, 90] },
          { kind: 'cylinder', radius: 0.045, height: 0.1, segments: 8, pos: [0.16, SHOULDER_Y - 0.08, 0], rotateDeg: [0, 0, 90] },
        ],
        color: [58, 110, 165],
      },
    ],
  },
  {
    id: 'top-hoodie',
    category: 'top',
    label: 'Hoodie',
    layers: [
      {
        primitives: [
          { kind: 'box', size: [0.28, TORSO_LEN + 0.04, 0.19], pos: [0, SHOULDER_Y - (TORSO_LEN + 0.04) / 2, 0] },
          { kind: 'cylinder', radius: 0.05, height: 0.16, segments: 8, pos: [-0.17, SHOULDER_Y - 0.1, 0], rotateDeg: [0, 0, 90] },
          { kind: 'cylinder', radius: 0.05, height: 0.16, segments: 8, pos: [0.17, SHOULDER_Y - 0.1, 0], rotateDeg: [0, 0, 90] },
        ],
        color: [112, 112, 122],
      },
      { primitives: [{ kind: 'sphere', radius: HEAD_R * 1.25, thetaStart: Math.PI * 0.35, thetaLength: Math.PI * 0.4, pos: [0, SHOULDER_Y + 0.03, -0.02] }], color: [90, 90, 100] },
    ],
  },
  {
    id: 'top-jersey',
    category: 'top',
    label: 'Jersey',
    layers: [
      {
        primitives: [
          { kind: 'box', size: [0.26, TORSO_LEN + 0.02, 0.17], pos: [0, SHOULDER_Y - (TORSO_LEN + 0.02) / 2, 0] },
          { kind: 'cylinder', radius: 0.045, height: 0.08, segments: 8, pos: [-0.16, SHOULDER_Y - 0.06, 0], rotateDeg: [0, 0, 90] },
          { kind: 'cylinder', radius: 0.045, height: 0.08, segments: 8, pos: [0.16, SHOULDER_Y - 0.06, 0], rotateDeg: [0, 0, 90] },
          { kind: 'cone', radiusTop: 0, radiusBottom: 0.045, height: 0.06, segments: 4, pos: [0, SHOULDER_Y - 0.02, 0.086], rotateDeg: [180, 0, 0] },
        ],
        color: [42, 140, 82],
      },
      { primitives: [{ kind: 'box', size: [0.26, 0.05, 0.005], pos: [0, SHOULDER_Y - TORSO_LEN * 0.45, 0.086] }], color: [240, 240, 240] },
    ],
  },
  {
    id: 'top-tank',
    category: 'top',
    label: 'Tank top',
    layers: [{ primitives: [{ kind: 'box', size: [0.2, TORSO_LEN, 0.15], pos: [0, SHOULDER_Y - TORSO_LEN / 2, 0] }], color: [226, 112, 42] }],
  },
];

const BOTTOM: PartOption[] = [
  {
    id: 'bottom-shorts',
    category: 'bottom',
    label: 'Shorts',
    layers: [
      {
        primitives: [
          { kind: 'cylinder', radius: 0.07, height: LEG_LEN * 0.42, segments: 8, pos: [-0.07, HIP_Y - LEG_LEN * 0.42, 0] },
          { kind: 'cylinder', radius: 0.07, height: LEG_LEN * 0.42, segments: 8, pos: [0.07, HIP_Y - LEG_LEN * 0.42, 0] },
        ],
        color: [32, 64, 112],
      },
    ],
  },
  {
    id: 'bottom-jeans',
    category: 'bottom',
    label: 'Jeans',
    layers: [
      {
        primitives: [
          { kind: 'cylinder', radius: 0.065, height: LEG_LEN * 0.92, segments: 8, pos: [-0.07, HIP_Y - LEG_LEN * 0.92, 0] },
          { kind: 'cylinder', radius: 0.065, height: LEG_LEN * 0.92, segments: 8, pos: [0.07, HIP_Y - LEG_LEN * 0.92, 0] },
        ],
        color: [64, 94, 142],
      },
    ],
  },
  {
    id: 'bottom-track',
    category: 'bottom',
    label: 'Track pants',
    layers: [
      {
        primitives: [
          { kind: 'cylinder', radius: 0.072, height: LEG_LEN * 0.92, segments: 8, pos: [-0.07, HIP_Y - LEG_LEN * 0.92, 0] },
          { kind: 'cylinder', radius: 0.072, height: LEG_LEN * 0.92, segments: 8, pos: [0.07, HIP_Y - LEG_LEN * 0.92, 0] },
        ],
        color: [48, 52, 58],
      },
    ],
  },
  {
    id: 'bottom-skirt',
    category: 'bottom',
    label: 'Skirt',
    layers: [{ primitives: [{ kind: 'cone', radiusTop: 0.09, radiusBottom: 0.17, height: LEG_LEN * 0.48, segments: 10, pos: [0, HIP_Y - LEG_LEN * 0.48, 0] }], color: [206, 58, 122] }],
  },
];

const SHOES: PartOption[] = [
  {
    id: 'shoes-sneakers',
    category: 'shoes',
    label: 'Sneakers',
    layers: [
      {
        primitives: [
          { kind: 'box', size: [0.09, 0.06, 0.15], pos: [-0.07, 0.03, 0.015] },
          { kind: 'box', size: [0.09, 0.06, 0.15], pos: [0.07, 0.03, 0.015] },
        ],
        color: [238, 238, 240],
      },
      {
        primitives: [
          { kind: 'box', size: [0.09, 0.02, 0.15], pos: [-0.07, 0.01, 0.015] },
          { kind: 'box', size: [0.09, 0.02, 0.15], pos: [0.07, 0.01, 0.015] },
        ],
        color: [20, 180, 160],
      },
    ],
  },
  {
    id: 'shoes-boots',
    category: 'shoes',
    label: 'Hiking boots',
    layers: [
      {
        primitives: [
          { kind: 'box', size: [0.095, 0.16, 0.15], pos: [-0.07, 0.08, 0.015] },
          { kind: 'box', size: [0.095, 0.16, 0.15], pos: [0.07, 0.08, 0.015] },
        ],
        color: [176, 138, 92],
      },
      {
        primitives: [
          { kind: 'box', size: [0.1, 0.03, 0.16], pos: [-0.07, 0.015, 0.02] },
          { kind: 'box', size: [0.1, 0.03, 0.16], pos: [0.07, 0.015, 0.02] },
        ],
        color: [60, 42, 30],
      },
    ],
  },
  {
    id: 'shoes-sandals',
    category: 'shoes',
    label: 'Sandals',
    layers: [
      {
        primitives: [
          { kind: 'box', size: [0.09, 0.016, 0.16], pos: [-0.07, 0.008, 0.02] },
          { kind: 'box', size: [0.09, 0.016, 0.16], pos: [0.07, 0.008, 0.02] },
          { kind: 'box', size: [0.09, 0.012, 0.02], pos: [-0.07, 0.03, 0.06], rotateDeg: [20, 0, 0] },
          { kind: 'box', size: [0.09, 0.012, 0.02], pos: [0.07, 0.03, 0.06], rotateDeg: [20, 0, 0] },
        ],
        color: [150, 110, 70],
      },
    ],
  },
];

const BACKPACK: PartOption[] = [
  { id: 'backpack-none', category: 'backpack', label: 'None', layers: [] },
  {
    id: 'backpack-daypack',
    category: 'backpack',
    label: 'Daypack',
    layers: [
      { primitives: [{ kind: 'box', size: [0.16, 0.22, 0.09], pos: [0, SHOULDER_Y - TORSO_LEN * 0.42, -0.12] }], color: [24, 140, 130] },
      {
        primitives: [
          { kind: 'box', size: [0.03, 0.2, 0.02], pos: [-0.08, SHOULDER_Y - TORSO_LEN * 0.35, -0.06] },
          { kind: 'box', size: [0.03, 0.2, 0.02], pos: [0.08, SHOULDER_Y - TORSO_LEN * 0.35, -0.06] },
        ],
        color: [16, 100, 92],
      },
    ],
  },
  {
    id: 'backpack-hiking',
    category: 'backpack',
    label: 'Hiking pack',
    layers: [
      { primitives: [{ kind: 'box', size: [0.2, 0.32, 0.13], pos: [0, SHOULDER_Y - TORSO_LEN * 0.48, -0.14] }], color: [190, 54, 54] },
      { primitives: [{ kind: 'cylinder', radius: 0.07, height: 0.2, segments: 10, pos: [0, SHOULDER_Y - TORSO_LEN * 0.18, -0.14], rotateDeg: [0, 0, 90] }], color: [122, 64, 168] },
      {
        primitives: [
          { kind: 'box', size: [0.03, 0.22, 0.02], pos: [-0.09, SHOULDER_Y - TORSO_LEN * 0.4, -0.06] },
          { kind: 'box', size: [0.03, 0.22, 0.02], pos: [0.09, SHOULDER_Y - TORSO_LEN * 0.4, -0.06] },
        ],
        color: [140, 36, 36],
      },
    ],
  },
];

const COSTUME: PartOption[] = [
  { id: 'costume-none', category: 'costume', label: 'None', layers: [] },
  {
    id: 'costume-ghost',
    category: 'costume',
    label: 'Ghost',
    layers: [
      { primitives: [{ kind: 'cone', radiusTop: 0.12, radiusBottom: 0.32, height: 1.25, segments: 12, pos: [0, 0, 0] }], color: [245, 245, 248] },
      {
        primitives: [
          { kind: 'sphere', radius: 0.03, pos: [-0.08, 1.0, 0.27] },
          { kind: 'sphere', radius: 0.03, pos: [0.08, 1.0, 0.27] },
        ],
        color: [30, 30, 36],
      },
    ],
  },
  {
    id: 'costume-jersey-kit',
    category: 'costume',
    label: 'Sports kit',
    layers: [
      { primitives: [{ kind: 'sphere', radius: HEAD_R, pos: [0, HEAD_CY, 0] }], color: BASE_BODY_COLOR },
      {
        primitives: [
          { kind: 'box', size: [0.27, TORSO_LEN + 0.02, 0.18], pos: [0, SHOULDER_Y - (TORSO_LEN + 0.02) / 2, 0] },
          { kind: 'cylinder', radius: 0.045, height: 0.08, segments: 8, pos: [-0.16, SHOULDER_Y - 0.06, 0], rotateDeg: [0, 0, 90] },
          { kind: 'cylinder', radius: 0.045, height: 0.08, segments: 8, pos: [0.16, SHOULDER_Y - 0.06, 0], rotateDeg: [0, 0, 90] },
        ],
        color: [222, 110, 32],
      },
      {
        primitives: [
          { kind: 'cylinder', radius: 0.07, height: LEG_LEN * 0.9, segments: 8, pos: [-0.07, 0, 0] },
          { kind: 'cylinder', radius: 0.07, height: LEG_LEN * 0.9, segments: 8, pos: [0.07, 0, 0] },
        ],
        color: BASE_BODY_COLOR,
      },
      { primitives: [{ kind: 'cylinder', radius: HEAD_R * 1.08, height: 0.09, segments: 10, pos: [0, HEAD_CY - 0.02, 0] }], color: [240, 240, 240] },
    ],
  },
];

export const PART_CATALOG: Record<PartCategory, PartOption[]> = {
  hair: HAIR,
  face: FACE,
  top: TOP,
  bottom: BOTTOM,
  shoes: SHOES,
  backpack: BACKPACK,
  costume: COSTUME,
};

/** Order categories are shown in the /join tab bar. */
export const CATEGORY_ORDER: PartCategory[] = ['hair', 'top', 'bottom', 'face', 'shoes', 'backpack', 'costume'];
export const CATEGORY_LABEL: Record<PartCategory, string> = {
  hair: 'Hair', top: 'Top', bottom: 'Bottom', face: 'Face', shoes: 'Shoes', backpack: 'Backpack', costume: 'Costume',
};

export function findOption(category: PartCategory, id: string): PartOption | undefined {
  return PART_CATALOG[category].find((o) => o.id === id);
}

/** A persona's appearance: one choice per category, plus an optional costume override. */
export interface PersonaAppearance {
  hair: string;
  top: string;
  bottom: string;
  face: string;
  shoes: string;
  backpack: string;
  costume: string; // 'costume-none' when not wearing one
}

export const DEFAULT_APPEARANCE: PersonaAppearance = {
  hair: 'hair-short', top: 'top-tshirt', bottom: 'bottom-shorts', face: 'face-none', shoes: 'shoes-sneakers', backpack: 'backpack-none', costume: 'costume-none',
};

/** The layers actually drawn for an appearance: base body + each category's selection, or just the
 * costume's own layers (with its own base-body replacement) when one is chosen. */
export function resolveLayers(appearance: PersonaAppearance): { category: PartCategory; optionId: string; layerIndex: number; layer: PartLayer }[] {
  const out: { category: PartCategory; optionId: string; layerIndex: number; layer: PartLayer }[] = [];
  if (appearance.costume && appearance.costume !== 'costume-none') {
    const opt = findOption('costume', appearance.costume);
    opt?.layers.forEach((layer, layerIndex) => out.push({ category: 'costume', optionId: opt.id, layerIndex, layer }));
    return out;
  }
  BASE_BODY_LAYERS.forEach((layer, layerIndex) => out.push({ category: 'hair' as PartCategory, optionId: '__base__', layerIndex: 100 + layerIndex, layer }));
  (['hair', 'top', 'bottom', 'face', 'shoes', 'backpack'] as PartCategory[]).forEach((category) => {
    const id = appearance[category];
    const opt = findOption(category, id);
    opt?.layers.forEach((layer, layerIndex) => out.push({ category, optionId: opt.id, layerIndex, layer }));
  });
  return out;
}
