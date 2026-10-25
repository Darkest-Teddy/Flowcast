// BU's West Campus athletic fields: New Balance Field (field hockey and lacrosse on the roof deck
// of the Langsam Garage) and Nickerson Field (soccer and lacrosse in the old Braves Field, with its
// running track and the 1915 right-field pavilion). Turf, track and line markings are flat layers
// at their real footprints; the stands, goals, scoreboards, netting and floodlight poles are
// real-scale GLBs. The floodlights come on at dusk and night.
//
// Fenway Park's light towers are part of the building models (make_building_models.py); its
// manifest entry's `floodlights` adds their lamps to the glow here, and lights its field, while
// the towers' own lit-window schedule has them on.
//
// Data: public/data/fields.json (data-pipeline/fetch_fields.py: OpenStreetMap outlines, plus
// positions measured on satellite imagery; see its `sources`). Models:
// scripts/make_field_models.py. Each field's props are ONE merged GLB in the field's own frame
// (origin at `anchor`, +Z along `bearing`), so a field costs one ScenegraphLayer.
import { PathLayer, ScatterplotLayer, SolidPolygonLayer, TextLayer, _MultiIconLayer as MultiIconLayer } from '@deck.gl/layers';
import { MaterialScenegraphLayer as ScenegraphLayer } from './material-scenegraph';
import { mergeMaterialPrimitives } from './gltf-materials';
import { load } from '@loaders.gl/core';
import { GLTFLoader } from '@loaders.gl/gltf';
import type { Color, Layer } from '@deck.gl/core';
import { lowPitchDepthBias, windowHour, type Floodlights } from './buildings';
import type { Seating } from './seatedFans';

type LngLat = [number, number];
type RGB = [number, number, number];

interface FieldSurface {
  kind: string;
  /** Outer ring, then holes. */
  polygon: LngLat[][];
  color: RGB;
}

interface FieldPaint {
  text: string;
  position: LngLat;
  /** Metres. */
  size: number;
  /** Degrees counter-clockwise from east, in the ground plane. */
  angle: number;
  color: RGB;
  outline?: RGB;
  font: string;
}

interface FieldTower {
  position: LngLat;
  /** Compass bearing the lamps face. */
  bearing: number;
  height: number;
  model: string;
  litModel: string;
  /** Where the lamp bank's light appears, and its height above the field's surface. */
  glow: LngLat;
  lampHeight: number;
}

export interface Field {
  id: string;
  name: string;
  subtitle: string;
  anchor: LngLat;
  /** Compass bearing of the long axis: the props GLB's +Z. */
  bearing: number;
  /** Metres above the map's ground of the playing surface (New Balance Field is a roof deck). */
  altitude: number;
  /** Sit on this building of building-models.json, at its top minus `roofBelowTop` (the parapet). */
  followBuilding?: { osm: string; roofBelowTop: number };
  /** OSM buildings this layer draws itself (Nickerson's grandstand): leave them out of the city layer. */
  replaces?: string[];
  props: string;
  surfaces: FieldSurface[];
  lines: LngLat[][];
  laneLines?: LngLat[][];
  lineWidth: number;
  lineColor: RGB;
  text: FieldPaint[];
  towers: FieldTower[];
  label: LngLat;
}

export interface FieldData {
  fields: Field[];
  /** Floodlit landmarks from the building models' manifest (Fenway Park). */
  floodlit: Floodlights[];
  /** Parsed GLBs, keyed by URL. */
  models: Record<string, unknown>;
  /** Fenway Park's seat rows from the building models' manifest, for seating game crowds. */
  seating: Seating | null;
}

/**
 * Fetch the fields and every model they name (a model that fails to load is skipped). A field on
 * a roof follows the height the building models actually draw that building at, so it never ends
 * up inside (or floating over) the garage.
 */
/** Turf height above a roof deck, metres. */
const DECK_LIFT = 0.05;

export async function loadFields(url = '/data/fields.json', buildingsUrl = '/data/building-models.json'): Promise<FieldData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
  const { fields } = (await res.json()) as { fields: Field[] };
  const manifest = await fetch(buildingsUrl)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  const floodlit: Floodlights[] = (manifest?.campuses ?? []).flatMap((c: { buildings: { floodlights?: Floodlights }[] }) =>
    c.buildings.flatMap((b) => (b.floodlights ? [b.floodlights] : [])),
  );
  if (fields.some((f) => f.followBuilding)) {
    const buildings = new Map<string, { height: number; deck?: number }>(
      (manifest?.campuses ?? []).flatMap((c: { buildings: { osm: string; height: number; deck?: number }[] }) => c.buildings.map((b) => [b.osm, b])),
    );
    for (const f of fields) {
      const b = f.followBuilding && buildings.get(f.followBuilding.osm);
      if (!b) continue;
      // On the deck when the model says where it is (Langsam Garage: 3.5 m), a few centimetres up
      // so the turf doesn't flicker against the deck; otherwise `roofBelowTop` under the parapet
      // top. (Subtracting `roofBelowTop` from the deck as well sank the turf to 2.6 m, inside the
      // garage, so New Balance Field showed the bare roof.)
      f.altitude = b.deck !== undefined ? b.deck + DECK_LIFT : Math.max(0, b.height - f.followBuilding!.roofBelowTop);
    }
  }
  const urls = [...new Set(fields.flatMap((f) => [f.props, ...f.towers.flatMap((t) => [t.model, t.litModel])]))];
  const loaded = await Promise.all(urls.map(async (u) => [u, await load(u, GLTFLoader).then((model) => mergeMaterialPrimitives(model, { materialAttributes: true })).catch(() => null)] as const));
  const seating: Seating | null = (manifest?.campuses ?? []).flatMap((c: { buildings: { seating?: Seating }[] }) =>
    c.buildings.flatMap((b) => (b.seating ? [b.seating] : [])))[0] ?? null;
  return { fields, floodlit, models: Object.fromEntries(loaded.filter(([, m]) => m)), seating };
}

/** Numeric OSM ids of the buildings the fields layer models, for basemap.excludeBuildings(). */
export function fieldBuildingIds({ fields }: FieldData): number[] {
  return fields.flatMap((f) => f.replaces ?? []).map((ref) => Number(ref.split('/')[1]));
}

export type FieldLight = 'dawn' | 'day' | 'dusk' | 'night';

export interface FieldLayerOptions {
  zoom: number;
  /** Mapbox Standard's lightPreset: the floodlights are on at dusk and night. */
  lightPreset?: FieldLight;
  /** Sim time, seconds since Boston midnight, and auto lighting, as for the building models:
   *  Fenway's floodlights keep the hours of its towers' lit lamps. */
  clock?: number;
  auto?: boolean;
}

/** The goals, stands and poles are a few pixels across below this zoom: skip them. Turf stays. */
const DETAIL_ZOOM = 16;
/** Field name tags (PlaceTags.tsx) from this zoom. */
export const LABEL_ZOOM = 16;

// Same multipliers as the building and monument models, so concrete and aluminium sit in the
// scene at dusk and night. Emissive materials (lit lenses, the scoreboards) are not tinted.
const MODEL_TINT: Record<FieldLight, Color> = {
  day: [255, 255, 255, 255],
  dawn: [236, 220, 214, 255],
  dusk: [206, 196, 214, 255],
  night: [110, 116, 146, 255],
};
// The flat turf isn't shaded by Mapbox's lights. At dusk and night the floodlights are on, so the
// field stays bright and slightly warm; at dawn (lights off) it dims with the rest of the map.
const TURF_TINT: Record<FieldLight, [number, number, number]> = {
  day: [1, 1, 1],
  dawn: [0.78, 0.74, 0.76],
  dusk: [0.95, 0.93, 0.88],
  night: [0.9, 0.9, 0.84],
};
// Fenway's floodlights are LEDs (since 2019): a cool, slightly blue white, not sodium orange.
const LAMP: RGB = [236, 243, 255];
const GLOW = [
  { id: 'bloom', radius: 4.5, alpha: 26, minPixels: 6 },
  { id: 'halo', radius: 2.2, alpha: 80, minPixels: 3 },
  { id: 'core', radius: 0.9, alpha: 255, minPixels: 1.5 },
];
// Fenway's lit field: the floodlights multiply the turf's brightness (dst * (1 + src)) under
// the night tint, so it reads as lit grass and dirt rather than a grey wash. Near-neutral, like
// LED light on grass; the stands get less (the lamps aim at the field) but enough to see the
// seats and the crowd in them.
const FLOODLIT_FIELD: Record<FieldLight, Color> = {
  day: [0, 0, 0, 255],
  dawn: [0, 0, 0, 255],
  dusk: [104, 108, 100, 255],
  night: [222, 228, 218, 255],
};
const FLOODLIT_STANDS: Record<FieldLight, Color> = {
  day: [0, 0, 0, 255],
  dawn: [0, 0, 0, 255],
  dusk: [60, 62, 64, 255],
  night: [150, 156, 162, 255],
};
/** Light shafts from each bank to the field, in the night air's haze: faint, additive. */
const BEAM_ALPHA: Record<FieldLight, number> = { day: 0, dawn: 0, dusk: 5, night: 9 };
/** The glow over a lit ballpark seen across the city: one wide, faint disc, drawn only from a
 *  distance (SKY_MAX_ZOOM): up close it would cover the whole screen for no visible gain. */
const SKY_GLOW = [{ id: 'sky', radius: 150, alpha: 14 }];
const SKY_MAX_ZOOM = 16.5;
const BRIGHTEN = {
  depthWriteEnabled: false,
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'dst',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'zero',
  blendAlphaDstFactor: 'one',
} as const;
/** Height of the lit-field layer over Fenway's turf: above the chalk and bases (0.64 m). */
const FLOODLIT_Z = 0.75;
// Light adds to what's behind it.
const ADDITIVE = {
  depthWriteEnabled: false,
  blend: true,
  blendColorOperation: 'add',
  blendColorSrcFactor: 'src-alpha',
  blendColorDstFactor: 'one',
  blendAlphaOperation: 'add',
  blendAlphaSrcFactor: 'one',
  blendAlphaDstFactor: 'one-minus-src-alpha',
} as const;

const lit = (light: FieldLight) => light === 'dusk' || light === 'night';
function metresApart(a: LngLat, b: LngLat): number {
  const k = 111_320;
  return Math.hypot((a[0] - b[0]) * k * Math.cos((a[1] * Math.PI) / 180), (a[1] - b[1]) * k);
}
function centroid(ring: LngLat[]): LngLat {
  let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return [x / ring.length, y / ring.length];
}
const at = (p: LngLat, z: number): [number, number, number] => [p[0], p[1], z];

interface Surface3D {
  polygon: [number, number, number][][];
  color: RGB;
}
/** A light shaft: the lamp bank, and the stretch of field it lands on. */
interface Beam {
  polygon: [number, number, number][][];
}
interface Line3D {
  path: [number, number, number][];
  width: number;
}
interface Paint3D extends FieldPaint {
  z: number;
}
interface TowerInstance {
  tower: FieldTower;
  altitude: number;
}
interface FieldGeometry {
  field: Field;
  surfaces: Surface3D[];
  lines: Line3D[];
  paint: Paint3D[];
}
/** A lamp bank's glow: where, and how big against a field floodlight's. */
interface Glow {
  position: [number, number, number];
  scale: number;
}
// Flat geometry with each field's altitude baked in, built once per FieldData. `floodlit`: the
// fields the floodlit landmarks light; `glow`: the fields' lamps alone, and with the landmarks'
// (while their towers are lit too).
const cache = new WeakMap<
  FieldData,
  { fields: FieldGeometry[]; towers: TowerInstance[]; floodlit: Surface3D[]; stands: Surface3D[]; beams: Beam[]; sky: Glow[]; glow: { fields: Glow[]; all: Glow[] } }
>();

function geometry(data: FieldData) {
  let g = cache.get(data);
  if (g) return g;
  g = { fields: [], towers: [], floodlit: [], stands: [], beams: [], sky: [], glow: { fields: [], all: [] } };
  for (const f of data.fields) {
    // A few cm proud of the ground (or roof deck) so nothing z-fights; lines and paint on top.
    const lift = f.followBuilding ? 0.1 : 0.05;
    const zTurf = f.altitude + lift;
    const zLine = f.altitude + lift + 0.05;
    g.fields.push({
      field: f,
      surfaces: f.surfaces.map((s) => ({ polygon: s.polygon.map((ring) => ring.map((p) => at(p, zTurf))), color: s.color })),
      lines: [...f.lines, ...(f.laneLines ?? [])].map((l) => ({ path: l.map((p) => at(p, zLine)), width: f.lineWidth })),
      paint: f.text.map((t) => ({ ...t, z: zLine })),
    });
    for (const t of f.towers) g.towers.push({ tower: t, altitude: f.altitude });
  }
  g.glow.fields = g.towers.map(({ tower: t, altitude }) => ({ position: at(t.glow, altitude + t.lampHeight), scale: t.height > 25 ? 1.3 : 1 }));
  g.floodlit = data.floodlit.map((light) => ({ polygon: [light.field.map((p) => at(p, FLOODLIT_Z))], color: [0, 0, 0] as RGB }));
  // The stands: the bowl's slope, a step's height (0.45 m) above it so every tread and the fans on
  // it are under the overlay, one quad per stretch of field edge (the Green Monster's are empty).
  for (const light of data.floodlit) {
    const b = light.bowl;
    if (!b) continue;
    for (let k = 0; k + 1 < b.front.length; k++) {
      const quad = [at(b.front[k], b.low + 0.45), at(b.front[k + 1], b.low + 0.45), at(b.back[k + 1], b.high + 0.45), at(b.back[k], b.high + 0.45)];
      if (metresApart(b.front[k], b.back[k]) < 1 && metresApart(b.front[k + 1], b.back[k + 1]) < 1) continue;
      g.stands.push({ polygon: [quad], color: [0, 0, 0] });
    }
    // Shafts: each bank to a 30 m stretch of field around the middle of the diamond, facing it.
    const centre = centroid(light.field);
    for (const [lng, lat, z] of light.lamps) {
      const dx = (centre[0] - lng) * Math.cos((lat * Math.PI) / 180), dy = centre[1] - lat;
      const len = Math.hypot(dx, dy) || 1;
      const side: LngLat = [(-dy / len) * 0.00018 / Math.cos((lat * Math.PI) / 180), (dx / len) * 0.00018];
      g.beams.push({ polygon: [[[lng, lat, z - 0.5], [centre[0] + side[0], centre[1] + side[1], 1], [centre[0] - side[0], centre[1] - side[1], 1]]] });
    }
    g.sky.push({ position: [centre[0], centre[1], 30], scale: 1 });
  }
  // Fenway's banks (some 8 x 4 m) at the fields' size: the bloom about covers a bank, so a bank
  // seen from behind doesn't sit in a wide grey disc.
  g.glow.all = [...g.glow.fields, ...data.floodlit.flatMap((light) => light.lamps.map(([lng, lat, z]): Glow => ({ position: [lng, lat, z], scale: 1 })))];
  cache.set(data, g);
  return g;
}

// Seen almost straight down, Mapbox's depth drifts from deck.gl's in interleaved mode and
// Standard's flat 2D building footprints paint over whatever stands inside them: the garage roof
// under New Balance Field, the grandstand's own footprint. buildings.ts pulls its models forward
// by lowPitchDepthBias(pitch) for this; everything of ours inside a footprint gets the same pull,
// so it still sits on (not under) the roof. Above 30 degrees of pitch the offset is zero.
type Drawable = Layer & { getModels(): { parameters: object; setParameters(p: object): void }[] };

function pullForward(layer: Layer, models: { parameters: object; setParameters(p: object): void }[]) {
  const pitch = (layer.context.viewport as unknown as { pitch?: number }).pitch ?? 60;
  const units = lowPitchDepthBias(pitch);
  // luma.gl: gl.polygonOffset(factor = depthBias, units = depthBiasSlopeScale)
  for (const m of models) m.setParameters({ ...m.parameters, depthBias: units ? -1 : 0, depthBiasSlopeScale: -units });
}

class FootprintPolygonLayer extends SolidPolygonLayer<Surface3D> {
  static layerName = 'FootprintPolygonLayer';
  draw(opts: Parameters<SolidPolygonLayer<Surface3D>['draw']>[0]) {
    pullForward(this, (this as unknown as Drawable).getModels());
    super.draw(opts);
  }
}

class FootprintPathLayer extends PathLayer<Line3D> {
  static layerName = 'FootprintPathLayer';
  draw(opts: Parameters<PathLayer<Line3D>['draw']>[0]) {
    pullForward(this, (this as unknown as Drawable).getModels());
    super.draw(opts);
  }
}

class FootprintIconLayer extends MultiIconLayer<Paint3D> {
  static layerName = 'FootprintIconLayer';
  draw(opts: Parameters<MultiIconLayer<Paint3D>['draw']>[0]) {
    pullForward(this, (this as unknown as Drawable).getModels());
    super.draw(opts);
  }
}

type SceneNode = { model?: { parameters: object; setParameters(p: object): void } };

class FieldModelLayer<D> extends ScenegraphLayer<D> {
  static layerName = 'FieldModelLayer';
  draw(opts: Parameters<ScenegraphLayer<D>['draw']>[0]) {
    const models: NonNullable<SceneNode['model']>[] = [];
    const scenegraph = (this.state as { scenegraph?: { traverse(cb: (node: SceneNode) => void): void } }).scenegraph;
    scenegraph?.traverse((node) => node.model && models.push(node.model));
    pullForward(this, models);
    super.draw(opts);
  }
}

// Per-frame rebuilds must hand deck.gl the same arrays while nothing changed: a new `data` array
// makes it regenerate and re-upload every attribute (for every primitive of every model).
interface FieldCache {
  single: Map<Field, Field[]>;
  towers: Map<boolean, Map<string, TowerInstance[]>>;
}
const fieldCache = new WeakMap<FieldData, FieldCache>();
const NO_GLOW: Glow[] = [];
const NO_SURFACES: Surface3D[] = [];
const NO_BEAMS: Beam[] = [];

export function fieldLayers(data: FieldData, { zoom, lightPreset = 'dusk', clock, auto = false }: FieldLayerOptions) {
  let cache = fieldCache.get(data);
  if (!cache) fieldCache.set(data, (cache = { single: new Map(data.fields.map((f) => [f, [f]])), towers: new Map() }));
  const { fields, models } = data;
  const g = geometry(data);
  const on = lit(lightPreset);
  // Fenway's towers: lit on their schedule, read at the same hour as the lit-window mesh.
  const hour = windowHour(clock, lightPreset, auto);
  const floodlit = on && data.floodlit.some((light) => hour >= light.on && hour < light.off);
  const detail = zoom >= DETAIL_ZOOM;
  const tint = MODEL_TINT[lightPreset];
  const [tr, tg, tb] = TURF_TINT[lightPreset];
  const shade = (c: RGB): Color => [c[0] * tr, c[1] * tg, c[2] * tb, 255];

  let towerModels = cache.towers.get(on);
  if (!towerModels) {
    towerModels = new Map<string, TowerInstance[]>();
    for (const t of g.towers) {
      const url = on ? t.tower.litModel : t.tower.model;
      if (models[url]) towerModels.set(url, [...(towerModels.get(url) ?? []), t]);
    }
    cache.towers.set(on, towerModels);
  }

  return [
    ...g.fields.flatMap(({ field: f, surfaces, lines, paint }) => {
      // Only a field on a roof sits inside a building footprint (see pullForward).
      const roof = !!f.followBuilding;
      const Surfaces = roof ? FootprintPolygonLayer : SolidPolygonLayer<Surface3D>;
      const Lines = roof ? FootprintPathLayer : PathLayer<Line3D>;
      return [
        new Surfaces({
          id: `field-surfaces-${f.id}`,
          data: surfaces,
          getPolygon: (s) => s.polygon,
          getFillColor: (s) => shade(s.color),
          filled: true,
          pickable: false,
          updateTriggers: { getFillColor: lightPreset },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
        new Lines({
          id: `field-lines-${f.id}`,
          data: lines,
          getPath: (l) => l.path,
          getWidth: (l) => l.width,
          widthUnits: 'meters',
          widthMinPixels: 0.6,
          getColor: shade(f.lineColor),
          capRounded: false,
          jointRounded: true,
          billboard: false,
          pickable: false,
          updateTriggers: { getColor: lightPreset },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
        // Painted lettering lying on the turf: "BOSTON" on New Balance Field, "BU" at midfield.
        new TextLayer<Paint3D>({
          id: `field-paint-${f.id}`,
          data: paint,
          getPosition: (p) => at(p.position, p.z),
          getText: (p) => p.text,
          getSize: (p) => p.size,
          sizeUnits: 'meters',
          getAngle: (p) => p.angle,
          getColor: (p) => shade(p.color),
          fontFamily: paint[0]?.font ?? 'sans-serif',
          fontWeight: paint[0]?.outline ? 800 : 400,
          characterSet: 'auto',
          billboard: false,
          getTextAnchor: 'middle',
          getAlignmentBaseline: 'center',
          // An SDF atlas, so the outline (BU's white keyline) can be drawn.
          fontSettings: { sdf: true, fontSize: 96, buffer: 10 },
          outlineWidth: paint[0]?.outline ? 2 : 0,
          outlineColor: shade(paint[0]?.outline ?? [0, 0, 0]),
          pickable: false,
          ...(roof ? { _subLayerProps: { characters: { type: FootprintIconLayer } } } : {}),
          updateTriggers: { getColor: lightPreset, outlineColor: lightPreset },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
      ];
    }),
    ...fields
      .filter((f) => models[f.props])
      .map(
        (f) =>
          new FieldModelLayer<Field>({
            id: `field-props-${f.id}`,
            data: cache.single.get(f) ?? [f],
            scenegraph: models[f.props] as never,
            sizeScale: 1, // real size: these are metres
            _lighting: 'pbr',
            getPosition: (d) => at(d.anchor, d.altitude),
            // Model +Z is the field's long axis: the 90° roll stands it up, 180 - bearing turns it.
            getOrientation: (d) => [0, 180 - d.bearing, 90],
            getColor: () => tint,
            visible: detail,
            pickable: false,
            updateTriggers: { getColor: lightPreset },
            // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
            slot: 'middle',
          }),
      ),
    ...[...towerModels].map(
      ([url, towers]) =>
        new FieldModelLayer<TowerInstance>({
          id: `field-lights-${url.split('/').pop()}`,
          data: towers,
          scenegraph: models[url] as never,
          sizeScale: 1,
          _lighting: 'pbr',
          getPosition: (t) => at(t.tower.position, t.altitude),
          getOrientation: (t) => [0, 180 - t.tower.bearing, 90],
          getColor: () => tint,
          visible: detail,
          pickable: false,
          updateTriggers: { getColor: lightPreset },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
    ),
    // Fenway's field under its floodlights: one layer for all floodlit landmarks (Fenway is the
    // only one), lit while any of them is.
    new FootprintPolygonLayer({
      id: 'field-floodlit',
      data: floodlit ? g.floodlit : NO_SURFACES,
      getPolygon: (s) => s.polygon,
      getFillColor: FLOODLIT_FIELD[lightPreset],
      filled: true,
      material: false,
      parameters: BRIGHTEN,
      pickable: false,
      updateTriggers: { getFillColor: lightPreset },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // The stands under the floodlights: the seats and the crowd in them, lit less than the field.
    new FootprintPolygonLayer({
      id: 'field-floodlit-stands',
      data: floodlit ? g.stands : NO_SURFACES,
      getPolygon: (s) => s.polygon,
      getFillColor: FLOODLIT_STANDS[lightPreset],
      filled: true,
      material: false,
      parameters: BRIGHTEN,
      pickable: false,
      updateTriggers: { getFillColor: lightPreset },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    // Light shafts from the banks through the night air to the field, and the dome of light over
    // the park (seen from across the city). Both additive and faint; neither writes depth.
    new SolidPolygonLayer<Beam>({
      id: 'field-floodlight-beams',
      data: floodlit && detail ? g.beams : NO_BEAMS,
      getPolygon: (b) => b.polygon,
      getFillColor: [...LAMP, BEAM_ALPHA[lightPreset]],
      filled: true,
      material: false,
      parameters: ADDITIVE,
      pickable: false,
      updateTriggers: { getFillColor: lightPreset },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    ...SKY_GLOW.map(({ id, radius, alpha }) => new ScatterplotLayer<Glow>({
      id: `field-${id}`,
      data: floodlit && zoom < SKY_MAX_ZOOM ? g.sky : NO_GLOW,
      getPosition: (l) => l.position,
      getRadius: radius,
      radiusUnits: 'meters',
      getFillColor: [...LAMP, alpha * (lightPreset === 'night' ? 1 : 0.6)],
      billboard: true,
      antialiasing: true,
      parameters: ADDITIVE,
      pickable: false,
      updateTriggers: { getFillColor: lightPreset },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    })),
    // Floodlight glow: three additive discs per lamp bank (a wide faint bloom, a halo, a hot core),
    // so it reads as light rather than a grey disc. None writes depth, so they never cut into
    // each other; they keep a pixel minimum so the lit fields still sparkle on the overview,
    // where the poles themselves are hidden.
    ...GLOW.map(
      ({ id, radius, alpha, minPixels }) =>
        new ScatterplotLayer<Glow>({
          id: `field-light-${id}`,
          data: !on ? NO_GLOW : floodlit ? g.glow.all : g.glow.fields,
          getPosition: (l) => l.position,
          getRadius: (l) => radius * l.scale,
          radiusUnits: 'meters',
          radiusMinPixels: minPixels,
          getFillColor: [...LAMP, alpha * (lightPreset === 'night' ? 1 : 0.75)],
          billboard: true,
          antialiasing: true,
          parameters: ADDITIVE,
          pickable: false,
          updateTriggers: { getFillColor: lightPreset },
          // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
          slot: 'middle',
        }),
    ),
  ];
}
