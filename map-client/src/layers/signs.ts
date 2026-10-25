// Signs on the buildings of Kenmore Square and Comm Ave: WHOOP's rooftop letters on One Kenmore
// Square, next to the Citgo sign, and the shop signs of the well-known restaurants along the street.
//
// Data: public/data/signs.json (data-pipeline/make_signs.py): each sign's centre, flush on the
// modelled facade it hangs on (0.15 m proud of the wall), the compass bearing it faces, its size
// in metres, its lettering and colours, and the restaurant's OSM details for the tooltip.
//
// Drawing: every sign's lettering is painted once into ONE canvas texture atlas (system fonts, so
// nothing to load), a day face and a lit night face per sign, the night face with its glow
// washing the wall round it. All signs are then ONE instanced quad mesh (SignLayer, a
// SimpleMeshLayer with a per-instance atlas rectangle): a single draw call, culled with its box
// when Kenmore and Comm Ave are off-screen. After dark the instances switch to their night faces
// (lit like shop signs until 2 am; WHOOP's letters all night).
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type { Color } from '@deck.gl/core';
import { boxAround, setCullBox } from './culling';
import { lowPitchDepthBias } from './buildings';
import { sunAltitude } from './citgo';

export interface SignStyle {
  /** "panel": a lit box or painted fascia (`bg` behind `fg`); "letters": channel letters on the wall. */
  frame: 'panel' | 'letters';
  bg?: string;
  fg: string;
  /** A second text colour after `split` characters (two-colour wordmarks). */
  fg2?: string;
  split?: number;
  font: 'sans' | 'serif' | 'condensed' | 'rounded' | 'script' | 'whoop';
  weight?: number;
  italic?: boolean;
  /** Extra letter spacing, as a share of the letter height. */
  spacing?: number;
}

export interface Sign {
  id: string;
  kind: 'storefront' | 'rooftop';
  name: string;
  text: string;
  osm: string | null;
  building: string;
  /** Centre of the sign's face, [lng, lat], on the wall it hangs on. */
  position: [number, number];
  /** Height of the sign's centre above the ground, metres. */
  altitude: number;
  /** Compass bearing the sign faces (the wall's outward normal). */
  bearing: number;
  width: number;
  height: number;
  style: SignStyle;
  info: { amenity?: string; cuisine?: string; address?: string; hours?: string; website?: string; subtitle?: string };
  source: Record<string, string>;
}

export interface SignData {
  signs: Sign[];
}

export async function loadSigns(url = '/data/signs.json'): Promise<SignData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  const data = (await res.json()) as SignData;
  return { signs: data.signs };
}

// --------------------------------------------------------------------------------------------
// The atlas
// --------------------------------------------------------------------------------------------

/** Texture pixels per metre of sign: shop signs are read up close, WHOOP from across the square. */
const PX_PER_M = { storefront: 60, rooftop: 26 } as const;
/** Room round each sign for its night glow, as a share of the sign's height. */
const GLOW_PAD = { storefront: 0.45, rooftop: 0.32 } as const;
const ATLAS_W = 2048;
const GUTTER = 4; // px between cells, so mipmaps never bleed one sign into the next

/** Where a sign's faces are in the atlas: [u0, v0, du, dv] for day and night, and the quad's size
 * in metres (the sign plus its glow margin). */
export interface SignCell {
  day: [number, number, number, number];
  night: [number, number, number, number];
  quad: [number, number];
}

interface Slot { x: number; y: number; w: number; h: number; pad: number; px: number }

/** Shelf-pack each sign's two faces (day above night) into an ATLAS_W-wide atlas. */
export function layoutAtlas(signs: Pick<Sign, 'kind' | 'width' | 'height'>[], width = ATLAS_W) {
  const slots: Slot[] = [];
  let x = 0, y = 0, shelf = 0;
  for (const s of signs) {
    const px = PX_PER_M[s.kind];
    const pad = Math.ceil(s.height * GLOW_PAD[s.kind] * px);
    let w = Math.ceil(s.width * px) + 2 * pad;
    let h = Math.ceil(s.height * px) + 2 * pad;
    let scale = px;
    if (w > width - 2 * GUTTER) {
      // Too long for a row: paint it at a lower resolution.
      const k = (width - 2 * GUTTER) / w;
      w = Math.floor(w * k);
      h = Math.floor(h * k);
      scale = px * k;
    }
    if (x + w + GUTTER > width) {
      x = 0;
      y += shelf + GUTTER;
      shelf = 0;
    }
    slots.push({ x: x + GUTTER, y: y + GUTTER, w, h, pad: (pad * scale) / px, px: scale });
    x += w + GUTTER;
    shelf = Math.max(shelf, 2 * h + GUTTER);
  }
  const height = y + shelf + 2 * GUTTER;
  const cells: SignCell[] = slots.map((sl, i) => ({
    day: [sl.x / width, sl.y / height, sl.w / width, sl.h / height],
    night: [sl.x / width, (sl.y + sl.h + GUTTER) / height, sl.w / width, sl.h / height],
    quad: [signs[i].width + (2 * sl.pad) / sl.px, signs[i].height + (2 * sl.pad) / sl.px],
  }));
  return { width, height, slots, cells };
}

const FONTS: Record<Exclude<SignStyle['font'], 'whoop'>, string> = {
  sans: '"Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Georgia, "Times New Roman", serif',
  condensed: '"Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif',
  rounded: '"Arial Rounded MT Bold", "Varela Round", "Helvetica Neue", Arial, sans-serif',
  script: '"Snell Roundhand", "Segoe Script", "Brush Script MT", cursive',
};

/** A colour pushed towards white: lettering lit from inside. */
function lighten(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v + (255 - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** The lettering, fitted into w x h px centred on (cx, cy), in one or two colours. */
function drawText(g: CanvasRenderingContext2D, s: Sign, cx: number, cy: number, w: number, h: number, fg: string, fg2: string | undefined) {
  const st = s.style;
  const size = h * (st.font === 'script' ? 0.78 : st.frame === 'letters' ? 0.82 : 0.6);
  g.font = `${st.italic ? 'italic ' : ''}${st.weight ?? 700} ${Math.round(size)}px ${FONTS[st.font as keyof typeof FONTS]}`;
  const spacing = (st.spacing ?? 0) * size;
  const chars = [...s.text];
  const widths = chars.map((c) => g.measureText(c).width);
  const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
  const k = Math.min(1, w / total);
  g.save();
  g.translate(cx, cy);
  g.scale(k, 1); // squeeze, never stretch, to fit the sign
  g.textBaseline = 'middle';
  g.textAlign = 'left';
  let x = -total / 2;
  chars.forEach((c, i) => {
    g.fillStyle = fg2 && st.split !== undefined && i >= st.split ? fg2 : fg;
    g.fillText(c, x, size * 0.04);
    x += widths[i] + spacing;
  });
  g.restore();
}

// WHOOP's wordmark as strokes, in letter heights (y up from the baseline): a light geometric sans
// with a W whose middle apex stops short, round Os and an open P, as on the building.
const WHOOP_GLYPHS: { w: number; paths: [number, number][][]; circle?: [number, number, number] }[] = [
  { w: 1.18, paths: [[[0, 1], [0.3, 0], [0.59, 0.74], [0.88, 0], [1.18, 1]]] },
  { w: 0.78, paths: [[[0, 0], [0, 1]], [[0.78, 0], [0.78, 1]], [[0, 0.52], [0.78, 0.52]]] },
  { w: 1.0, paths: [], circle: [0.5, 0.5, 0.5] },
  { w: 1.0, paths: [], circle: [0.5, 0.5, 0.5] },
  { w: 0.66, paths: [[[0, 0], [0, 1], [0.38, 1]], [[0, 0.44], [0.38, 0.44]]] },
];
const WHOOP_GAP = 0.3;

function drawWhoop(g: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, colour: string, depth: string | null) {
  const total = WHOOP_GLYPHS.reduce((a, l) => a + l.w, 0) + WHOOP_GAP * (WHOOP_GLYPHS.length - 1);
  const stroke = 0.1; // letter heights
  const unit = Math.min(h / (1 + stroke), w / (total + stroke));
  const x0 = cx - (total * unit) / 2;
  const base = cy + unit / 2;
  const P = (x: number, y: number): [number, number] => [x0 + x * unit, base - y * unit];
  const pass = (colour: string, dx: number, dy: number) => {
    g.strokeStyle = colour;
    g.lineWidth = stroke * unit;
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
    let x = 0;
    for (const l of WHOOP_GLYPHS) {
      const half = stroke / 2;
      for (const path of l.paths) {
        g.beginPath();
        path.forEach(([px, py], i) => {
          // Keep strokes inside the cap height.
          const [sx, sy] = P(x + px, Math.min(1 - half, Math.max(half, py)));
          if (i) g.lineTo(sx + dx, sy + dy);
          else g.moveTo(sx + dx, sy + dy);
        });
        g.stroke();
      }
      if (l === WHOOP_GLYPHS[4]) {
        // P's bowl, from the top bar round to the middle one
        const top = 1 - half, mid = 0.44;
        const [bx, by] = P(x + 0.38, (top + mid) / 2);
        g.beginPath();
        g.arc(bx + dx, by + dy, ((top - mid) / 2) * unit, -Math.PI / 2, Math.PI / 2);
        g.stroke();
      }
      if (l.circle) {
        const [ccx, ccy] = P(x + l.circle[0], l.circle[1]);
        g.beginPath();
        g.arc(ccx + dx, ccy + dy, (l.circle[2] - half) * unit, 0, Math.PI * 2);
        g.stroke();
      }
      x += l.w + WHOOP_GAP;
    }
  };
  if (depth) pass(depth, unit * 0.025, unit * 0.03); // the letters' returns, seen a little from below
  pass(colour, 0, 0);
}

function paintSign(g: CanvasRenderingContext2D, s: Sign, sl: Slot, night: boolean) {
  const st = s.style;
  const y0 = sl.y + (night ? sl.h + GUTTER : 0);
  const x = sl.x + sl.pad, y = y0 + sl.pad;
  const w = sl.w - 2 * sl.pad, h = sl.h - 2 * sl.pad;
  g.save();
  g.beginPath();
  g.rect(sl.x, y0, sl.w, sl.h);
  g.clip();
  const lit = st.frame === 'letters' ? lighten(st.fg, st.font === 'whoop' ? 1 : 0.35) : lighten(st.fg, 0.25);
  if (st.frame === 'panel') {
    const r = h * 0.08;
    if (night) {
      // Light washing the wall round the box, then the lit face.
      g.shadowColor = lighten(st.bg ?? '#000000', 0.55);
      g.shadowBlur = sl.pad * 0.9;
      g.globalAlpha = 0.5;
      g.fillStyle = lighten(st.bg ?? '#000000', 0.4);
      roundRect(g, x, y, w, h, r);
      g.fill();
      g.globalAlpha = 1;
      g.shadowBlur = 0;
      g.fillStyle = lighten(st.bg ?? '#000000', 0.12);
    } else {
      g.fillStyle = st.bg ?? '#000000';
    }
    roundRect(g, x, y, w, h, r);
    g.fill();
    // A thin trim round the box.
    g.lineWidth = Math.max(1, h * 0.035);
    g.strokeStyle = night ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)';
    roundRect(g, x + g.lineWidth / 2, y + g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth, r);
    g.stroke();
    if (night) {
      g.shadowColor = lit;
      g.shadowBlur = h * 0.12;
    }
    drawText(g, s, x + w / 2, y + h / 2, w * 0.88, h, night ? lit : st.fg, st.fg2 && (night ? lighten(st.fg2, 0.25) : st.fg2));
  } else if (st.font === 'whoop') {
    if (night) {
      g.shadowColor = 'rgba(225,238,255,0.95)';
      g.shadowBlur = sl.pad * 0.7;
      drawWhoop(g, x + w / 2, y + h / 2, w, h, 'rgba(235,244,255,0.6)', null);
      g.shadowBlur = h * 0.05;
      drawWhoop(g, x + w / 2, y + h / 2, w, h, '#ffffff', null);
    } else {
      drawWhoop(g, x + w / 2, y + h / 2, w, h, st.fg, '#8d949b');
    }
  } else {
    // Channel letters on the wall: a dark return under each letter by day, a glow by night.
    if (night) {
      g.shadowColor = lit;
      g.shadowBlur = sl.pad * 0.8;
      g.globalAlpha = 0.65;
      drawText(g, s, x + w / 2, y + h / 2, w, h, lit, st.fg2 && lighten(st.fg2, 0.35));
      g.globalAlpha = 1;
      g.shadowBlur = h * 0.08;
      drawText(g, s, x + w / 2, y + h / 2, w, h, lit, st.fg2 && lighten(st.fg2, 0.35));
    } else {
      drawText(g, s, x + w / 2 + h * 0.03, y + h / 2 + h * 0.04, w, h, 'rgba(20,20,20,0.55)', 'rgba(20,20,20,0.55)');
      drawText(g, s, x + w / 2, y + h / 2, w, h, st.fg, st.fg2);
    }
  }
  g.restore();
}

interface Atlas {
  canvas: HTMLCanvasElement;
  cells: SignCell[];
  index: Map<Sign, number>;
}
const atlasCache = new WeakMap<SignData, Atlas>();

function atlasFor(data: SignData): Atlas {
  let atlas = atlasCache.get(data);
  if (atlas) return atlas;
  const { width, height, slots, cells } = layoutAtlas(data.signs);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  data.signs.forEach((s, i) => {
    paintSign(g, s, slots[i], false);
    paintSign(g, s, slots[i], true);
  });
  atlas = { canvas, cells, index: new Map(data.signs.map((s, i) => [s, i])) };
  atlasCache.set(data, atlas);
  // One box round every sign, so the layer skips its draw when none can be on screen.
  setCullBox('kenmore-signs', boxAround(data.signs.map((s) => s.position), 12, 45));
  return atlas;
}

// --------------------------------------------------------------------------------------------
// Placement
// --------------------------------------------------------------------------------------------

/**
 * Column-major 4x4 matrix turning the unit quad (x across, z up, facing +y) into a sign of
 * `w` x `h` metres facing `bearing`: x runs along the wall to the viewer's right, z up.
 */
export function signMatrix(bearing: number, w: number, h: number): number[] {
  const r = (bearing * Math.PI) / 180;
  const n = [Math.sin(r), Math.cos(r)]; // outward: east, north
  const e = [-n[1], n[0]]; // the viewer's right as they face the sign
  return [e[0] * w, e[1] * w, 0, 0, n[0], n[1], 0, 0, 0, 0, h, 0, 0, 0, 0, 1];
}

// The quad, centred, its texture right way up from the front.
const QUAD = {
  positions: new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]),
  normals: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
  texCoords: new Float32Array([0, 1, 1, 1, 1, 0, 0, 0]),
  indices: new Uint16Array([0, 1, 2, 0, 2, 3]),
};
const MESH = {
  attributes: {
    positions: { size: 3, value: QUAD.positions },
    normals: { size: 3, value: QUAD.normals },
    texCoords: { size: 2, value: QUAD.texCoords },
  },
  indices: { size: 1, value: QUAD.indices },
};

/** Whether shop signs are lit: after sunset (or a dark preset) until 2 am. WHOOP's stay on all night. */
export function signsLit(time: number, lightPreset: SignLight, kind: Sign['kind']): boolean {
  const t = ((time % 86400) + 86400) % 86400;
  const dark = lightPreset === 'night' || lightPreset === 'dusk' || sunAltitude(t) < -1.5;
  if (!dark) return false;
  return kind === 'rooftop' || !(t >= 2 * 3600 && t < 12 * 3600);
}

export type SignLight = 'dawn' | 'day' | 'dusk' | 'night';

// Unlit faces sit in the scene like the building models (buildings.ts multipliers).
const LIGHT_TINT: Record<SignLight, Color> = {
  day: [255, 255, 255, 255],
  dawn: [236, 220, 214, 255],
  dusk: [206, 196, 214, 255],
  night: [120, 128, 158, 255],
};
const LIT: Color = [255, 255, 255, 255];

// --------------------------------------------------------------------------------------------
// The layer
// --------------------------------------------------------------------------------------------

type SignLayerProps = { getUvRect: (d: Sign) => [number, number, number, number] };

/** SimpleMeshLayer with a per-instance atlas rectangle; unlit (the faces carry their own light),
 * transparent texels dropped, and pulled towards the camera like the other facade overlays. */
class SignLayer extends SimpleMeshLayer<Sign, SignLayerProps> {
  static layerName = 'SignLayer';
  static defaultProps = {
    ...SimpleMeshLayer.defaultProps,
    getUvRect: { type: 'accessor', value: [0, 0, 1, 1] },
  } as typeof SimpleMeshLayer.defaultProps;

  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      inject: {
        ...shaders.inject,
        'vs:#decl': 'in vec4 instanceUvRects;',
        'vs:#main-end': 'vTexCoord = instanceUvRects.xy + texCoords * instanceUvRects.zw;',
        'fs:#main-end': [
          'if (texture(sampler, vTexCoord).a < 0.03) discard;',
          // Tint unlit faces into the scene's light (never the picking colours).
          'if (picking.isActive < 0.5) fragColor.rgb *= vColor.rgb;',
        ].join('\n'),
      },
    };
  }

  initializeState() {
    super.initializeState();
    this.getAttributeManager()!.addInstanced({
      instanceUvRects: { size: 4, accessor: 'getUvRect', defaultValue: [0, 0, 1, 1] },
    });
  }

  draw(opts: Parameters<SimpleMeshLayer<Sign, SignLayerProps>['draw']>[0]) {
    // Beat the detailed building models' own pull at low pitch (buildings.ts), plus the usual
    // overlay margin (crowd.ts GLOW_PARAMETERS).
    const pitch = (this.context.viewport as unknown as { pitch?: number }).pitch ?? 60;
    const units = 1600 + lowPitchDepthBias(pitch);
    const model = (this.state as { model?: { parameters: Record<string, unknown>; setParameters(p: Record<string, unknown>): void } }).model;
    model?.setParameters({ ...model.parameters, depthBias: -1, depthBiasSlopeScale: -units });
    super.draw(opts);
  }
}

export interface SignLayerOptions {
  zoom: number;
  lightPreset: SignLight;
  /** Shown time, seconds since local midnight. */
  time: number;
}

/** Shown from zoom 16 (fading in from 15.5). */
export const SIGN_MIN_ZOOM = 15.5;

/** Shop signs a little larger from afar so they still read (like the Citgo sign); WHOOP real size. */
export function signScale(kind: Sign['kind'], zoom: number): number {
  if (kind === 'rooftop') return 1;
  return Math.round(Math.min(1.5, Math.max(1, 1 + (19 - zoom) * 0.22)) * 20) / 20;
}

export function signLayers(data: SignData, { zoom, lightPreset, time }: SignLayerOptions) {
  const { canvas, cells, index } = atlasFor(data);
  const litShops = signsLit(time, lightPreset, 'storefront');
  const litRoof = signsLit(time, lightPreset, 'rooftop');
  const lit = (s: Sign) => (s.kind === 'rooftop' ? litRoof : litShops);
  const scaleKey = signScale('storefront', zoom);
  const fade = Math.min(1, Math.max(0, (zoom - SIGN_MIN_ZOOM) / 0.6));
  return [
    new SignLayer({
      id: 'kenmore-signs',
      data: data.signs,
      mesh: MESH as never,
      texture: canvas as never,
      material: { unlit: true } as never,
      visible: fade > 0,
      opacity: fade,
      getPosition: (s) => [s.position[0], s.position[1], s.altitude],
      getTransformMatrix: (s) => {
        const [w, h] = cells[index.get(s)!].quad;
        const k = signScale(s.kind, zoom);
        return signMatrix(s.bearing, w * k, h * k);
      },
      getUvRect: (s) => (lit(s) ? cells[index.get(s)!].night : cells[index.get(s)!].day),
      getColor: (s) => (lit(s) ? LIT : LIGHT_TINT[lightPreset]),
      pickable: true,
      parameters: { depthWriteEnabled: false, cullMode: 'back' },
      updateTriggers: {
        getTransformMatrix: scaleKey,
        getUvRect: `${litShops}|${litRoof}`,
        getColor: `${litShops}|${litRoof}|${lightPreset}`,
      },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
  ];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Tooltip for a sign under the pointer: the restaurant's name, what it is, address and hours. */
export function signTooltip(object: unknown): string | null {
  if (!object || typeof object !== 'object' || !('style' in object) || !('text' in object) || !('building' in object)) return null;
  const s = object as Sign;
  const { amenity, cuisine, address, hours, subtitle } = s.info;
  const what = [amenity, cuisine && cap(cuisine)].filter(Boolean).join(' · ');
  return [s.name, subtitle ?? what, address, hours && `Hours: ${hours}`].filter(Boolean).join('\n');
}
