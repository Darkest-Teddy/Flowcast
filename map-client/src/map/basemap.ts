// The base 3D map. Mapbox Standard (textured, lit 3D buildings) when a token is set;
// otherwise MapLibre + OpenFreeMap, which needs no account. deck.gl draws on top of either.
import type { IControl } from 'mapbox-gl';
// Static so the styles are in place before the map is constructed (both are small; the class
// prefixes don't clash).
import 'mapbox-gl/dist/mapbox-gl.css';
import 'maplibre-gl/dist/maplibre-gl.css';

export type LightPreset = 'dawn' | 'day' | 'dusk' | 'night';

export interface Basemap {
  kind: 'mapbox' | 'maplibre';
  addControl(control: IControl): void;
  /** Only Mapbox Standard has time-of-day lighting; a no-op on the fallback. */
  setLightPreset(preset: LightPreset): void;
  /** Live traffic needs Mapbox's traffic tiles (a token); the fallback has none. */
  supportsTraffic: boolean;
  setTrafficVisible(visible: boolean): void;
  flyTo(center: [number, number], zoom?: number): void;
  /** Screen pixel position of a lng/lat (ground level). */
  project(lngLat: [number, number]): [number, number];
  getZoom(): number;
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

// From over the Charles looking south, so the whole Comm Ave strip (Kenmore to West Campus) fits.
// Any field can be overridden from the URL, e.g. ?lng=-71.105&lat=42.350&zoom=18&pitch=70&bearing=-60
const DEFAULT_VIEW = {
  center: [-71.1106, 42.3498] as [number, number],
  zoom: 15.5,
  pitch: 58,
  bearing: 192,
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

// Mapbox's live traffic tiles (refreshed every few minutes). Congestion is shown by width as
// well as colour, so it doesn't rely on colour alone (plan Section 10.3).
const TRAFFIC_LAYER = 'flowcast-traffic';
export const TRAFFIC_LEVELS = [
  { key: 'low', label: 'Moving', color: '#2e9d5b', width: 1.5 },
  { key: 'moderate', label: 'Slow', color: '#f2b705', width: 2.5 },
  { key: 'heavy', label: 'Heavy', color: '#e8590c', width: 3.5 },
  { key: 'severe', label: 'Stopped', color: '#b0122b', width: 4.5 },
] as const;

function addTrafficLayer(map: import('mapbox-gl').Map) {
  map.addSource('mapbox-traffic', { type: 'vector', url: 'mapbox://mapbox.mapbox-traffic-v1' });
  const byLevel = (pick: (level: (typeof TRAFFIC_LEVELS)[number]) => string | number, fallback: string | number) =>
    ['match', ['get', 'congestion'], ...TRAFFIC_LEVELS.flatMap((l) => [l.key, pick(l)]), fallback];
  map.addLayer({
    id: TRAFFIC_LAYER,
    type: 'line',
    source: 'mapbox-traffic',
    'source-layer': 'traffic',
    slot: 'middle',
    // Free-flowing traffic only on main roads; any congestion everywhere. Otherwise every side
    // street is outlined green and the map turns to noise.
    filter: [
      'any',
      ['!=', ['get', 'congestion'], 'low'],
      ['match', ['get', 'class'], ['motorway', 'trunk', 'primary', 'secondary'], true, false],
    ],
    layout: { 'line-cap': 'round', 'line-join': 'round' },
    paint: {
      'line-color': byLevel((l) => l.color, '#888888') as never,
      // Grows with zoom; heavier traffic is always drawn thicker.
      'line-width': ['interpolate', ['linear'], ['zoom'], 13, byLevel((l) => l.width * 0.6, 1), 18, byLevel((l) => l.width * 2.5, 3)] as never,
      // Each direction is its own feature; nudge them apart so both show.
      'line-offset': ['interpolate', ['linear'], ['zoom'], 13, 1, 18, 5] as never,
      'line-opacity': 0.9,
    },
  });
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
      antialias: true,
      config: {
        basemap: { lightPreset, showPointOfInterestLabels: false, showTransitLabels: false },
      },
    });
    map.setPadding(VIEW_PADDING);
    await new Promise<void>((resolve) => map.once('style.load', () => resolve()));
    addTrafficLayer(map);
    return {
      kind: 'mapbox',
      addControl: (control) => map.addControl(control),
      setLightPreset: (preset) => map.setConfigProperty('basemap', 'lightPreset', preset),
      supportsTraffic: true,
      setTrafficVisible: (visible) => map.setLayoutProperty(TRAFFIC_LAYER, 'visibility', visible ? 'visible' : 'none'),
      flyTo: (center, zoom) => map.flyTo({ center, zoom: zoom ?? map.getZoom(), essential: true }),
      project: (lngLat) => {
        const p = map.project(lngLat);
        return [p.x, p.y];
      },
      getZoom: () => map.getZoom(),
      remove: () => map.remove(),
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
    maxPitch: 85, // the default 60 is too flat for the street-level view
    canvasContextAttributes: { antialias: true },
  });
  map.setPadding(VIEW_PADDING);
  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  return {
    kind: 'maplibre',
    // MapboxOverlay implements MapLibre's IControl too; the two interfaces only differ in typings.
    addControl: (control) => map.addControl(control as unknown as maplibregl.IControl),
    setLightPreset: () => {},
    supportsTraffic: false,
    setTrafficVisible: () => {},
    flyTo: (center, zoom) => map.flyTo({ center, zoom: zoom ?? map.getZoom(), essential: true }),
    project: (lngLat) => {
      const p = map.project(lngLat);
      return [p.x, p.y];
    },
    getZoom: () => map.getZoom(),
    remove: () => map.remove(),
    ...cameraApi(map as unknown as CameraMap, 85),
  };
}
