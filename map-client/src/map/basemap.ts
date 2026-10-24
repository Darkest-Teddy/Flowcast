// The base 3D map. Mapbox Standard (textured, lit 3D buildings) when a token is set;
// otherwise MapLibre + OpenFreeMap, which needs no account. deck.gl draws on top of either.
import type { IControl } from 'mapbox-gl';
// Static so the styles are in place before the map is constructed (both are small; the class
// prefixes don't clash).
import 'mapbox-gl/dist/mapbox-gl.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { MapWeather } from '../weather/weather';
import { quality, type QualitySettings } from '../perf/quality';
import { paceMapRendering } from '../perf/pacer';

export type LightPreset = 'dawn' | 'day' | 'dusk' | 'night';

export interface Basemap {
  kind: 'mapbox' | 'maplibre';
  addControl(control: IControl): void;
  /** Only Mapbox Standard has time-of-day lighting; a no-op on the fallback. */
  setLightPreset(preset: LightPreset): void;
  /**
   * Draw the city's buildings ourselves, leaving out these OSM ids (buildings we render as
   * detailed models). Mapbox Standard can't hide single buildings, and its own copies (e.g.
   * Warren Towers as one 56 m block, podium included) poke through our models. Mapbox only.
   */
  excludeBuildings(osmIds: number[]): void;
  /** Remove the base map's own 3D models (trees) inside these polygons. Mapbox only. */
  clipModels(polygons: [number, number][][]): void;
  /** Live traffic needs Mapbox's traffic tiles (a token); the fallback has none. */
  supportsTraffic: boolean;
  setTrafficVisible(visible: boolean): void;
  /** Weather fog and a wet or snowy ground (Mapbox only; a no-op on the fallback). Rain and snow particles are deck.gl layers. */
  setWeather(weather: MapWeather): void;
  flyTo(center: [number, number], zoom?: number): void;
  /** Screen pixel position of a lng/lat (ground level). */
  project(lngLat: [number, number]): [number, number];
  getZoom(): number;
  /** True once every tile the current view needs has loaded (the loading screen waits on it). */
  tilesLoaded(): boolean;
  remove(): void;

  // Camera control (src/map/camera.ts). Moves made through these never count as user interaction.
  getCamera(): CameraState;
  /** Animated move; `fly: true` uses the zoom-out arc of flyTo. Skipped (jumps) under prefers-reduced-motion. */
  easeTo(move: CameraMove): void;
  jumpTo(camera: Partial<CameraState>): void;
  /** True while an animated camera move (ours or the app's flyTo) is running. */
  isEasing(): boolean;
  /** Steepest pitch the map allows. */
  maxPitch: number;
  /**
   * The user touching the map: 'press' (pointer down on the map), 'release' (pointer up),
   * 'gesture' (drag, scroll, pinch, rotate, tilt, keyboard pan). Returns an unsubscribe.
   */
  onUserInteraction(cb: (kind: UserInteraction) => void): () => void;
}

export interface CameraState {
  center: [number, number];
  zoom: number;
  pitch: number;
  bearing: number;
}

export interface CameraMove extends Partial<CameraState> {
  duration?: number;
  easing?: (t: number) => number;
  fly?: boolean;
}

export type UserInteraction = 'press' | 'release' | 'gesture';

// The camera calls shared by Mapbox and MapLibre; their typings differ only in detail.
interface CameraMap {
  getCenter(): { lng: number; lat: number };
  getZoom(): number;
  getPitch(): number;
  getBearing(): number;
  easeTo(options: object): unknown;
  flyTo(options: object): unknown;
  jumpTo(options: object): unknown;
  isEasing(): boolean;
  getCanvasContainer(): HTMLElement;
  on(type: string, listener: (e: { originalEvent?: Event }) => void): unknown;
  off(type: string, listener: (e: { originalEvent?: Event }) => void): unknown;
}

// Map events carry an originalEvent only when a handler (mouse, touch, wheel, keyboard) caused
// them; the app's own flyTo/easeTo/jumpTo calls have none.
const GESTURE_EVENTS = ['dragstart', 'rotatestart', 'pitchstart', 'zoomstart', 'movestart', 'boxzoomstart'];

function cameraApi(map: CameraMap, maxPitch: number) {
  return {
    getCamera: (): CameraState => {
      const c = map.getCenter();
      return { center: [c.lng, c.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    },
    easeTo: ({ fly, ...move }: CameraMove) => {
      // Both maps merge options over their defaults, so an explicit `undefined` (say, easing)
      // would wipe the default out.
      const options = Object.fromEntries(Object.entries(move).filter(([, v]) => v !== undefined));
      if (fly) map.flyTo(options);
      else map.easeTo(options);
    },
    jumpTo: (camera: Partial<CameraState>) => map.jumpTo(camera),
    isEasing: () => map.isEasing(),
    maxPitch,
    onUserInteraction: (cb: (kind: UserInteraction) => void) => {
      const el = map.getCanvasContainer();
      let pressed = false;
      // Both maps cancel an in-progress drag when the camera is moved under it (jumpTo -> stop()),
      // so a press has to pause any animation before the drag threshold is even reached.
      const press = () => {
        pressed = true;
        cb('press');
      };
      const release = () => {
        if (!pressed) return;
        pressed = false;
        cb('release');
      };
      const gesture = () => cb('gesture');
      const fromHandler = (e: { originalEvent?: Event }) => {
        if (e.originalEvent) cb('gesture');
      };
      const capture = { capture: true } as const;
      el.addEventListener('pointerdown', press, capture);
      el.addEventListener('touchstart', press, { capture: true, passive: true });
      el.addEventListener('wheel', gesture, { capture: true, passive: true });
      window.addEventListener('pointerup', release, capture);
      window.addEventListener('pointercancel', release, capture);
      window.addEventListener('touchend', release, capture);
      for (const type of GESTURE_EVENTS) map.on(type, fromHandler);
      return () => {
        el.removeEventListener('pointerdown', press, capture);
        el.removeEventListener('touchstart', press, capture);
        el.removeEventListener('wheel', gesture, capture);
        window.removeEventListener('pointerup', release, capture);
        window.removeEventListener('pointercancel', release, capture);
        window.removeEventListener('touchend', release, capture);
        for (const type of GESTURE_EVENTS) map.off(type, fromHandler);
      };
    },
  };
}

// From behind Kenmore looking west up Comm Ave: the Citgo sign's lit face up front, the whole campus
// strip along the Charles behind it, Fenway Park to the left.
// Any field can be overridden from the URL, e.g. ?lng=-71.105&lat=42.350&zoom=18&pitch=70&bearing=-60
const DEFAULT_VIEW = {
  center: [-71.1018, 42.3477] as [number, number],
  zoom: 15.6,
  pitch: 58,
  bearing: 250,
};

// Keeps the campus centred in the area the dashboard panel doesn't cover.
const VIEW_PADDING = { top: 0, bottom: 80, left: 0, right: 340 };

function viewFromUrl() {
  const q = new URLSearchParams(window.location.search);
  const num = (key: string, fallback: number) => (q.has(key) ? Number(q.get(key)) : fallback);
  return {
    center: [num('lng', DEFAULT_VIEW.center[0]), num('lat', DEFAULT_VIEW.center[1])] as [number, number],
    zoom: num('zoom', DEFAULT_VIEW.zoom),
    pitch: num('pitch', DEFAULT_VIEW.pitch),
    bearing: num('bearing', DEFAULT_VIEW.bearing),
  };
}

export const INITIAL_VIEW = viewFromUrl();

// Keep the camera (and so tile loading) to the campuses and central Boston: West Campus /
// Nickerson to downtown and the Seaport edge, the Cambridge riverbank to the Medical Campus.
const BOSTON_LIMITS = {
  maxBounds: [
    [-71.135, 42.325],
    [-71.045, 42.368],
  ] as [[number, number], [number, number]],
  minZoom: 13.5,
};

// Mapbox's live traffic tiles (refreshed every few minutes). Congestion is shown by width as
// well as colour, so it doesn't rely on colour alone (plan Section 10.3).
const TRAFFIC_LAYER = 'flowcast-traffic';
const ROAD_LABEL_MIN_ZOOM = 17.2;
const CITY_BUILDINGS = 'flowcast-city-buildings';
const CITY_AO = 0.35; // ambient occlusion at the city buildings' feet (Auto drops it from level 2)
const ROOF_SNOW = 'flowcast-roof-snow';
// Google Maps-style live traffic, kept calm: only the main roads carry a line, coloured by
// speed. Free-flowing roads are a thin, quiet green so the eye goes to slowdowns; heavier
// traffic is also thicker, so the overlay never relies on colour alone.
export const TRAFFIC_LEVELS = [
  { key: 'low', label: 'Fast', color: '#34A853', boost: 0.7 },
  { key: 'moderate', label: 'Slow', color: '#F5A623', boost: 1.1 },
  { key: 'heavy', label: 'Heavy', color: '#E5341D', boost: 1.3 },
  { key: 'severe', label: 'Stopped', color: '#8E1515', boost: 1.45 },
] as const;

const TRAFFIC_ROADS = ['motorway', 'trunk', 'primary', 'secondary'];
// Line width (px) at zoom 13 and zoom 18, by road class.
const TRAFFIC_ROAD_WIDTHS: [string[], number, number][] = [
  [['motorway', 'trunk'], 2.4, 7],
  [['primary', 'secondary'], 2.0, 5.5],
];

function addTrafficLayer(map: import('mapbox-gl').Map) {
  map.addSource('mapbox-traffic', { type: 'vector', url: 'mapbox://mapbox.mapbox-traffic-v1' });
  const byLevel = (pick: (level: (typeof TRAFFIC_LEVELS)[number]) => string | number, fallback: string | number) =>
    ['match', ['get', 'congestion'], ...TRAFFIC_LEVELS.flatMap((l) => [l.key, pick(l)]), fallback];
  const widthAt = (zoomIndex: 1 | 2) => [
    '*',
    ['match', ['get', 'class'], ...TRAFFIC_ROAD_WIDTHS.flatMap((row) => [row[0], row[zoomIndex]]), 1],
    byLevel((l) => l.boost, 1),
  ];
  map.addLayer({
    id: TRAFFIC_LAYER,
    type: 'line',
    source: 'mapbox-traffic',
    'source-layer': 'traffic',
    slot: 'middle',
    filter: [
      'all',
      ['match', ['get', 'congestion'], TRAFFIC_LEVELS.map((l) => l.key), true, false],
      ['match', ['get', 'class'], TRAFFIC_ROADS, true, false],
    ],
    // Worst congestion drawn last, so a red stretch is never covered by the green beside it.
    layout: {
      visibility: 'none', // off until the Transit tab's Traffic toggle turns it on
      'line-cap': 'round',
      'line-join': 'round',
      'line-sort-key': byLevel((l) => TRAFFIC_LEVELS.indexOf(l), 0) as never,
    },
    paint: {
      'line-color': byLevel((l) => l.color, '#888888') as never,
      'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 13, widthAt(1), 18, widthAt(2)] as never,
      // One line per road until zoomed right in; then each direction on its own side.
      'line-offset': ['interpolate', ['linear'], ['zoom'], 17, 0, 18.5, 3] as never,
      'line-opacity': ['match', ['get', 'congestion'], 'low', 0.55, 0.95] as never,
    },
  });
}

/**
 * Calmer map handling for a demo screen: a flick only glides a short way and stops fast, the
 * scroll wheel zooms gently, and double-click zoom is off (it fired when clicking buildings).
 * Both Mapbox and MapLibre share these handler APIs.
 */
function tameInteractions(map: {
  dragPan: { enable(options?: { linearity?: number; maxSpeed?: number; deceleration?: number }): void };
  scrollZoom: { setWheelZoomRate(rate: number): void; setZoomRate(rate: number): void };
  doubleClickZoom: { disable(): void };
}) {
  map.dragPan.enable({ linearity: 0.2, maxSpeed: 500, deceleration: 4500 });
  map.scrollZoom.setWheelZoomRate(1 / 900); // default 1/450
  map.scrollZoom.setZoomRate(1 / 200); // trackpad; default 1/100
  map.doubleClickZoom.disable();
}

export async function createBasemap(container: HTMLElement, lightPreset: LightPreset): Promise<Basemap> {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

  if (token) {
    const { default: mapboxgl } = await import('mapbox-gl');
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container,
      style: 'mapbox://styles/mapbox/standard',
      // Standard defaults to a globe, which flips deck.gl into GlobeView, where text labels and
      // the 3D characters silently don't draw. One campus is flat anyway.
      projection: 'mercator',
      ...INITIAL_VIEW,
      ...BOSTON_LIMITS,
      // 4x MSAA. Speed mode starts without it (it can only be chosen when the map is created).
      antialias: quality.msaa,
      // Render settings that cost nothing visible: one world (the camera is held to Boston, so
      // copies never show) and no Mapbox performance telemetry uploads.
      renderWorldCopies: false,
      performanceMetricsCollection: false,
      config: {
        // Standard's own 3D buildings are off from the start: we draw the city ourselves
        // (excludeBuildings). Switching them off after load raced Mapbox's 3D tile loading.
        basemap: { lightPreset, showPointOfInterestLabels: false, showTransitLabels: false, show3dBuildings: false, show3dFacades: false },
      },
    });
    map.setPadding(VIEW_PADDING);
    tameInteractions(map);
    paceMapRendering(map);
    skipSlotGroupMoves(map);
    await new Promise<void>((resolve) => map.once('style.load', () => resolve()));
    addTrafficLayer(map);
    // Distance haze: the tilted camera would otherwise show the whole region out to the
    // horizon. Fading out a few km away keeps the eye on campus and central Boston.
    // The haze doubles as the sky: Mapbox draws the sky from the fog colours, and the defaults are
    // flat grey. These follow the light (measure-light brightness): clear blue by day, warm at
    // the horizon at dawn and dusk, deep navy at night.
    const skyBy = (night: string, dusk: string, day: string) =>
      ['interpolate', ['linear'], ['measure-light', 'brightness'], 0.1, night, 0.25, dusk, 0.5, day] as unknown as string;
    const baseFog = {
      range: [0.8, 3.2] as [number, number],
      'horizon-blend': 0.12,
      color: skyBy('#1d2538', '#e9b48c', '#dcebf7'), // at the horizon
      'high-color': skyBy('#0c1426', '#5d6fa8', '#5aa2e6'), // the sky above it
      'space-color': skyBy('#05070f', '#2a3560', '#3d8be0'), // straight up
      'star-intensity': ['interpolate', ['linear'], ['measure-light', 'brightness'], 0.1, 0.35, 0.25, 0] as unknown as number,
    };
    const dryGround: Record<string, string> = {}; // Standard's own ground colours, as first changed
    const appliedGround: Record<string, string> = {};
    map.setFog(baseFog);
    // Street names stay out of the way: hidden until you zoom in close, then in a muted grey.
    map.setConfigProperty('basemap', 'colorRoadLabels', '#9AA0A8');
    let roadLabels: boolean | null = null;
    const updateRoadLabels = () => {
      const show = map.getZoom() >= ROAD_LABEL_MIN_ZOOM;
      if (show !== roadLabels) map.setConfigProperty('basemap', 'showRoadLabels', (roadLabels = show));
    };
    updateRoadLabels();
    map.on('zoom', updateRoadLabels);
    hideStandardFootprints(map);
    const stopQuality = applyMapboxQuality(map);
    return {
      kind: 'mapbox',
      addControl: (control) => map.addControl(control),
      setLightPreset: (preset) => map.setConfigProperty('basemap', 'lightPreset', preset),
      clipModels: (polygons) => {
        // Mapbox's clip layer hides 3D models (Standard's trees) inside the polygons: used to keep
        // trees off the Green Line trackbed down the middle of Comm Ave.
        const data = {
          type: 'FeatureCollection' as const,
          features: polygons.map((ring) => ({
            type: 'Feature' as const,
            properties: {},
            geometry: { type: 'Polygon' as const, coordinates: [ring] },
          })),
        };
        const source = map.getSource('flowcast-clip') as import('mapbox-gl').GeoJSONSource | undefined;
        if (source) {
          source.setData(data);
          return;
        }
        map.addSource('flowcast-clip', { type: 'geojson', data });
        map.addLayer({ id: 'flowcast-clip', type: 'clip', source: 'flowcast-clip', layout: { 'clip-layer-types': ['model'] } });
      },
      excludeBuildings: (osmIds) => {
        if (!map.getSource('flowcast-city')) {
          map.addSource('flowcast-city', { type: 'vector', url: 'mapbox://mapbox.mapbox-streets-v8' });
        }
        const filter = ['all', ['==', ['get', 'extrude'], 'true'], ['!', ['in', ['id'], ['literal', osmIds]]]];
        if (map.getLayer(CITY_BUILDINGS)) {
          map.setFilter(CITY_BUILDINGS, filter as never);
          return;
        }
        map.addLayer({
          id: CITY_BUILDINGS,
          type: 'fill-extrusion',
          source: 'flowcast-city',
          'source-layer': 'building',
          slot: 'middle',
          minzoom: 13,
          filter: filter as never,
          paint: {
            // Neutral stone: Standard's lights shade it, so it reads as city fabric behind BU.
            'fill-extrusion-color': '#d6d1c8',
            'fill-extrusion-height': ['get', 'height'],
            'fill-extrusion-base': ['get', 'min_height'],
            'fill-extrusion-opacity': 1,
            'fill-extrusion-ambient-occlusion-intensity': quality.settings.mapBuildingAO ? CITY_AO : 0,
            'fill-extrusion-vertical-gradient': true,
          },
        });
      },
      supportsTraffic: true,
      setTrafficVisible: (visible) => map.setLayoutProperty(TRAFFIC_LAYER, 'visibility', visible ? 'visible' : 'none'),
      setWeather: ({ fog, ground }) => {
        // Weather fog merges into the distance haze and never reaches further out than it.
        const range = (fog?.range as [number, number] | undefined) ?? baseFog.range;
        map.setFog({ ...baseFog, ...fog, range: [Math.min(range[0], baseFog.range[0]), Math.min(range[1], baseFog.range[1])] });
        // Wet or snowy ground: Standard's land and road colours, back to the style's own when dry.
        for (const [key, value] of Object.entries(ground?.colors ?? {})) {
          if (!(key in dryGround)) dryGround[key] = map.getConfigProperty('basemap', key) as string;
          if (value !== appliedGround[key]) map.setConfigProperty('basemap', key, (appliedGround[key] = value));
        }
        for (const key of Object.keys(dryGround)) {
          if (!ground?.colors[key] && appliedGround[key] !== dryGround[key]) map.setConfigProperty('basemap', key, (appliedGround[key] = dryGround[key]));
        }
        // Snow on the roofs: a thin white slab on top of every city building.
        const roofSnow = ground?.roofSnow ?? 0;
        if (!map.getLayer(ROOF_SNOW)) {
          if (!roofSnow || !map.getLayer(CITY_BUILDINGS)) return;
          map.addLayer({
            id: ROOF_SNOW,
            type: 'fill-extrusion',
            source: 'flowcast-city',
            'source-layer': 'building',
            slot: 'middle',
            minzoom: 13,
            filter: map.getFilter(CITY_BUILDINGS) as never,
            paint: {
              'fill-extrusion-color': '#f5f8fc',
              'fill-extrusion-base': ['get', 'height'],
              'fill-extrusion-height': ['+', ['get', 'height'], 0.5],
              'fill-extrusion-ambient-occlusion-intensity': 0,
            },
          });
        }
        map.setLayoutProperty(ROOF_SNOW, 'visibility', roofSnow > 0 ? 'visible' : 'none');
        map.setPaintProperty(ROOF_SNOW, 'fill-extrusion-opacity', Math.min(0.92, roofSnow));
      },
      flyTo: (center, zoom) => map.flyTo({ center, zoom: zoom ?? map.getZoom(), essential: true }),
      project: (lngLat) => {
        const p = map.project(lngLat);
        return [p.x, p.y];
      },
      getZoom: () => map.getZoom(),
      tilesLoaded: () => map.areTilesLoaded(),
      remove: () => {
        stopQuality();
        map.remove();
      },
      ...cameraApi(map as unknown as CameraMap, 80),
    };
  }

  // Pinned to MapLibre 5: v6 dropped the map.transform internals deck.gl 9.4's interleaved mode reads.
  const maplibreModule = await import('maplibre-gl');
  // v5 is a UMD bundle: depending on how Vite pre-bundles it, the API is on .default or the namespace.
  const maplibregl = (maplibreModule.default ?? maplibreModule) as typeof maplibreModule.default;
  const map = new maplibregl.Map({
    container,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    ...INITIAL_VIEW,
    ...BOSTON_LIMITS,
    maxPitch: 85, // the default 60 is too flat for the street-level view
    canvasContextAttributes: { antialias: quality.msaa },
    renderWorldCopies: false,
  });
  map.setPadding(VIEW_PADDING);
  tameInteractions(map);
  paceMapRendering(map);
  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  return {
    kind: 'maplibre',
    // MapboxOverlay implements MapLibre's IControl too; the two interfaces only differ in typings.
    addControl: (control) => map.addControl(control as unknown as maplibregl.IControl),
    setLightPreset: () => {},
    excludeBuildings: () => {},
    clipModels: () => {},
    supportsTraffic: false,
    setTrafficVisible: () => {},
    setWeather: () => {},
    flyTo: (center, zoom) => map.flyTo({ center, zoom: zoom ?? map.getZoom(), essential: true }),
    project: (lngLat) => {
      const p = map.project(lngLat);
      return [p.x, p.y];
    },
    getZoom: () => map.getZoom(),
    tilesLoaded: () => map.areTilesLoaded(),
    remove: () => map.remove(),
    ...cameraApi(map as unknown as CameraMap, 85),
  };
}

/**
 * @deck.gl/mapbox re-checks its layer groups' order on every setProps (every frame here) and wants
 * each to be the style's last layer. With two slot groups (`middle`, `top`) both can't be, so one
 * was moved every frame, and each move marked the style changed: a style update, a layer re-merge
 * and change events on every frame, ~8% of the main thread. A slot group's place is set by its
 * slot, not its index, so moving it changes nothing on screen. Those moves are skipped.
 */
function skipSlotGroupMoves(map: import('mapbox-gl').Map) {
  const moveLayer = map.moveLayer.bind(map);
  map.moveLayer = ((id: string, beforeId?: string) => {
    if (id.startsWith('deck-layer-group-slot:') && beforeId === undefined && map.getLayer(id)) return map;
    return moveLayer(id, beforeId);
  }) as typeof map.moveLayer;
}

/**
 * Standard draws every building as a flat footprint (and an outline) when its 3D buildings are
 * off. Ours are all covered by the city extrusions and the BU models, so those two layers were
 * ~700 GL calls a frame of nothing visible. Standard has no switch for them; its layers live in
 * the style import ("fragment"), whose own style object takes layout changes. Internal API, so
 * it's guarded: if Mapbox changes shape the footprints simply stay.
 */
const HIDDEN_STANDARD_LAYERS = ['2d-building', '2d-building-outline'];
function hideStandardFootprints(map: import('mapbox-gl').Map) {
  const hide = () => {
    try {
      const fragment = (map as unknown as { style?: { fragments?: { id: string; style: { getLayer(id: string): unknown; getLayoutProperty(id: string, p: string): unknown; setLayoutProperty(id: string, p: string, v: unknown): void } }[] } }).style?.fragments?.find((f) => f.id === 'basemap');
      for (const id of HIDDEN_STANDARD_LAYERS) {
        if (fragment?.style.getLayer(id) && fragment.style.getLayoutProperty(id, 'visibility') !== 'none') fragment.style.setLayoutProperty(id, 'visibility', 'none');
      }
    } catch {
      // Mapbox internals changed: leave Standard's footprints as they are.
    }
  };
  hide();
  // Config changes (Auto's quality steps, light presets) can rebuild the import's layers.
  map.on('styledata', hide);
}

/**
 * The Performance setting (perf/quality.ts) on Mapbox: shadows, Standard's 3D objects (trees and
 * the like), footpaths and the city buildings' ambient occlusion. Each is left as the style has it until a level first turns it off.
 * (The pixel-ratio cap and MSAA are applied once, before the map exists.)
 */
function applyMapboxQuality(map: import('mapbox-gl').Map): () => void {
  const detail: Partial<Record<'show3dObjects' | 'showPedestrianRoads', boolean>> = {};
  let shadows: boolean | null = null;
  return quality.onChange((q: QualitySettings) => {
    const want = { show3dObjects: q.map3dObjects, showPedestrianRoads: q.mapPedestrianRoads };
    for (const [key, value] of Object.entries(want) as [keyof typeof want, boolean][]) {
      if (detail[key] === undefined && value) continue; // untouched until first turned off
      if (detail[key] !== value) map.setConfigProperty('basemap', key, (detail[key] = value));
    }
    // Shadows draw every building and tree a second time (into the shadow map) and made Mapbox
    // rebuild ~130 vertex arrays a frame. Standard has no switch for them, so the style's own
    // lights are re-set with the directional light's cast-shadows flag changed; its colours and
    // intensities are expressions on the light preset, so they keep following Dawn/Day/Dusk/Night.
    if (map.getLayer(CITY_BUILDINGS)) {
      const ao = q.mapBuildingAO ? CITY_AO : 0;
      if (map.getPaintProperty(CITY_BUILDINGS, 'fill-extrusion-ambient-occlusion-intensity') !== ao) map.setPaintProperty(CITY_BUILDINGS, 'fill-extrusion-ambient-occlusion-intensity', ao);
    }
    if ((shadows === null && q.mapShadows) || shadows === q.mapShadows) return;
    const lights = map.getLights();
    const sun = lights?.find((l) => l.type === 'directional');
    if (!lights || !sun) return;
    sun.properties = { ...sun.properties, 'cast-shadows': q.mapShadows };
    map.setLights(lights);
    shadows = q.mapShadows;
  });
}
