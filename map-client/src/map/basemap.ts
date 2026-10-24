// The base 3D map. Mapbox Standard (textured, lit 3D buildings) when a token is set;
// otherwise MapLibre + OpenFreeMap, which needs no account. deck.gl draws on top of either.
import type { IControl } from 'mapbox-gl';

export type LightPreset = 'dawn' | 'day' | 'dusk' | 'night';

export interface Basemap {
  kind: 'mapbox' | 'maplibre';
  addControl(control: IControl): void;
  /** Only Mapbox Standard has time-of-day lighting; a no-op on the fallback. */
  setLightPreset(preset: LightPreset): void;
  flyTo(center: [number, number], zoom?: number): void;
  /** Screen pixel position of a lng/lat (ground level). */
  project(lngLat: [number, number]): [number, number];
  remove(): void;
}

// From over the Charles looking south, so the whole Comm Ave strip (Kenmore to West Campus) fits.
// Any field can be overridden from the URL, e.g. ?lng=-71.105&lat=42.350&zoom=18&pitch=70&bearing=-60
const DEFAULT_VIEW = {
  center: [-71.1098, 42.3497] as [number, number],
  zoom: 15.6,
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

export async function createBasemap(container: HTMLElement, lightPreset: LightPreset): Promise<Basemap> {
  const token = import.meta.env.VITE_MAPBOX_TOKEN as string | undefined;

  if (token) {
    const { default: mapboxgl } = await import('mapbox-gl');
    await import('mapbox-gl/dist/mapbox-gl.css');
    mapboxgl.accessToken = token;
    const map = new mapboxgl.Map({
      container,
      style: 'mapbox://styles/mapbox/standard',
      ...INITIAL_VIEW,
      antialias: true,
      config: {
        basemap: { lightPreset, showPointOfInterestLabels: false, showTransitLabels: false },
      },
    });
    map.setPadding(VIEW_PADDING);
    await new Promise<void>((resolve) => map.once('style.load', () => resolve()));
    return {
      kind: 'mapbox',
      addControl: (control) => map.addControl(control),
      setLightPreset: (preset) => map.setConfigProperty('basemap', 'lightPreset', preset),
      flyTo: (center, zoom) => map.flyTo({ center, zoom: zoom ?? map.getZoom(), essential: true }),
      project: (lngLat) => {
        const p = map.project(lngLat);
        return [p.x, p.y];
      },
      remove: () => map.remove(),
    };
  }

  // Pinned to MapLibre 5: v6 dropped the map.transform internals deck.gl 9.4's interleaved mode reads.
  const maplibreModule = await import('maplibre-gl');
  // v5 is a UMD bundle: depending on how Vite pre-bundles it, the API is on .default or the namespace.
  const maplibregl = (maplibreModule.default ?? maplibreModule) as typeof maplibreModule.default;
  await import('maplibre-gl/dist/maplibre-gl.css');
  const map = new maplibregl.Map({
    container,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    ...INITIAL_VIEW,
    canvasContextAttributes: { antialias: true },
  });
  map.setPadding(VIEW_PADDING);
  await new Promise<void>((resolve) => map.once('load', () => resolve()));
  return {
    kind: 'maplibre',
    // MapboxOverlay implements MapLibre's IControl too; the two interfaces only differ in typings.
    addControl: (control) => map.addControl(control as unknown as maplibregl.IControl),
    setLightPreset: () => {},
    flyTo: (center, zoom) => map.flyTo({ center, zoom: zoom ?? map.getZoom(), essential: true }),
    project: (lngLat) => {
      const p = map.project(lngLat);
      return [p.x, p.y];
    },
    remove: () => map.remove(),
  };
}
