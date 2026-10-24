// Name tags for BU's places, in the same glass as the building and transit tags: monuments (Free
// at Last, Rhett Bench, the Golden Greek), landmarks (the Citgo sign, the Braves Field ticket
// office), public art, the named open spaces (BU Beach, Marsh Plaza) and the playing fields.
// A compact pill (kind icon and name) until it opens on hover or focus of the pill, hover of the
// place itself on the map (invisible pick targets, placeHitLayers below), or a tap. Then the
// full card adds the subtitle: artist and year, or what the field is for and its seats.
// Placed after the building and transit tags through the shared placer.
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { SolidPolygonLayer, ScatterplotLayer } from '@deck.gl/layers';
import { WebMercatorViewport } from '@deck.gl/core';
import type { CameraState } from './map/basemap';
import type { LabelPlacer, Projector } from './layers/placement';
import { LABEL_MIN_ZOOM, labelPosition, type Monument } from './layers/monuments';
import { LABEL_ZOOM as FIELD_TAG_ZOOM, type Field } from './layers/fields';
import { GlassTags, esc, type GlassTagItem, type GlassTagSpec } from './tags/glassTags';

type PlaceKind = Monument['kind'] | 'field';

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// Lucide-style glyphs (ISC), one per kind of place.
const ICONS: Record<PlaceKind, string> = {
  // A figure on a plinth.
  monument: svg('<circle cx="12" cy="4.5" r="2"/><path d="M9.5 15l.8-6.5h3.4l.8 6.5"/><path d="M8 15h8v3H8z"/><path d="M5 22h14"/><path d="M7 18v4"/><path d="M17 18v4"/>'),
  landmark: svg('<path d="M3 22h18"/><path d="M6 18v-7"/><path d="M10 18v-7"/><path d="M14 18v-7"/><path d="M18 18v-7"/><path d="M12 2 20 7H4z"/>'),
  artwork: svg('<circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.93 0 1.65-.75 1.65-1.69 0-.44-.18-.84-.44-1.13-.29-.29-.44-.65-.44-1.13a1.64 1.64 0 0 1 1.67-1.67h2c3.05 0 5.55-2.5 5.55-5.55C21.97 6.01 17.46 2 12 2z"/>'),
  area: svg('<path d="M10 10v.2A3 3 0 0 1 8.9 16H5a3 3 0 0 1-1-5.8V10a3 3 0 0 1 6 0Z"/><path d="M7 16v6"/><path d="M13 19v3"/><path d="M12 19h8.3a1 1 0 0 0 .7-1.7L18 14h.3a1 1 0 0 0 .7-1.7L16 9h.2a1 1 0 0 0 .8-1.7L13 3l-1.4 1.5"/>'),
  field: svg('<rect x="2" y="5" width="20" height="14" rx="1.5"/><path d="M12 5v14"/><circle cx="12" cy="12" r="2.5"/><path d="M2 9.5h2.5v5H2"/><path d="M22 9.5h-2.5v5H22"/>'),
};
const KIND_LABEL: Record<PlaceKind, string> = { monument: 'Monument', landmark: 'Landmark', artwork: 'Public art', area: 'Open space', field: 'Athletics' };
// Most important first: if tags must be dropped, the minor artworks go.
const PRIORITY: PlaceKind[] = ['landmark', 'field', 'monument', 'area', 'artwork'];
const MARGIN = 40;

interface Place {
  id: string;
  kind: PlaceKind;
  name: string;
  subtitle: string | null;
  /** Where the tag stands, [lng, lat, metres]. */
  anchor: [number, number, number];
  minZoom: number;
}

export interface PlaceTagsFrame {
  placer: LabelPlacer;
  project: Projector;
  camera: CameraState;
  monuments: Monument[] | null;
  fields: Field[] | null;
}

export interface PlaceTagsHandle {
  update(frame: PlaceTagsFrame): void;
  /** The place under the pointer on the map (placeHitLayers), or null: expands its tag. */
  hoverPlace(id: string | null): void;
}

function places(monuments: Monument[] | null, fields: Field[] | null): Place[] {
  return [
    ...(monuments ?? []).map((m) => ({
      id: m.id,
      kind: m.kind,
      name: m.name,
      subtitle: m.subtitle,
      anchor: labelPosition(m),
      minZoom: LABEL_MIN_ZOOM[m.kind],
    })),
    ...(fields ?? []).map((f) => ({
      id: f.id,
      kind: 'field' as const,
      name: f.name,
      subtitle: f.subtitle,
      anchor: [f.label[0], f.label[1], f.altitude + 1] as [number, number, number],
      minZoom: FIELD_TAG_ZOOM,
    })),
  ].sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
}

function placeSpec(p: Place): GlassTagSpec {
  const name = esc(p.name);
  const html =
    `<span class="gtag-icon">${ICONS[p.kind]}</span>` +
    `<span class="gtag-text"><span class="gtag-name">${name}</span>` +
    `<span class="gtag-stats"><span class="gtag-dir">${esc(p.subtitle ?? KIND_LABEL[p.kind])}</span></span></span>`;
  const compact = `<span class="gtag-picon">${ICONS[p.kind]}</span><span class="gtag-pname">${name}</span>`;
  return { id: p.id, key: html, html, compact, label: `${p.name}. ${p.subtitle ?? KIND_LABEL[p.kind]}.`, className: `is-${p.kind}` };
}

export function PlaceTags({ ref }: { ref: Ref<PlaceTagsHandle> }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const s = useRef({
    pool: null as GlassTags | null,
    size: [0, 0] as [number, number],
    from: [null, null] as [Monument[] | null, Field[] | null],
    places: [] as Place[],
    specs: new Map<string, GlassTagSpec>(),
    hovered: null as string | null,
  }).current;

  useEffect(() => {
    const layer = layerRef.current!;
    s.pool = new GlassTags(layer, 'gtag--place');
    const measure = () => (s.size = [layer.clientWidth, layer.clientHeight]);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => {
      observer.disconnect();
      s.pool?.destroy();
      s.pool = null;
    };
  }, [s]);

  useImperativeHandle(
    ref,
    () => ({
      hoverPlace: (id) => void (s.hovered = id),
      update({ placer, project, camera, monuments, fields }) {
        const pool = s.pool;
        const [width, height] = s.size;
        if (!pool || !width) return;
        if (monuments !== s.from[0] || fields !== s.from[1]) {
          s.from = [monuments, fields];
          s.places = places(monuments, fields);
          s.specs = new Map(s.places.map((p) => [p.id, placeSpec(p)]));
        }
        // The map's projection gives the ground point (with the view padding); an unpadded
        // viewport of the same camera gives the offset up to the tag's height (as BuildingTags).
        const viewport = new WebMercatorViewport({
          width,
          height,
          longitude: camera.center[0],
          latitude: camera.center[1],
          zoom: camera.zoom,
          pitch: camera.pitch,
          bearing: camera.bearing,
        });
        const items: GlassTagItem[] = [];
        for (const p of s.places) {
          if (camera.zoom < p.minZoom) continue;
          const [lng, lat, z] = p.anchor;
          const [gx, gy] = project([lng, lat]);
          const [ax, ay] = viewport.project([lng, lat, 0]);
          const [rx, ry] = viewport.project([lng, lat, z]);
          const anchor: [number, number] = [gx + rx - ax, gy + ry - ay];
          if (anchor[0] < -MARGIN || anchor[0] > width + MARGIN || anchor[1] < -MARGIN || anchor[1] > height + MARGIN) continue;
          items.push({ spec: s.specs.get(p.id)!, anchor });
        }
        pool.update(items, placer, { direction: -1, gap: 10, maxLift: 2, openId: s.hovered });
      },
    }),
    [s],
  );

  return <div ref={layerRef} className="gtags" />;
}

/** What a hit target carries, so App's onHover can tell a place from anything else. */
export interface PlaceHit {
  placeTag: string;
}

/**
 * Invisible pick targets, so hovering a monument, an artwork, an open space or a field on the map
 * opens its tag (the models themselves aren't pickable). Only where the tags show.
 */
export function placeHitLayers(monuments: Monument[] | null, fields: Field[] | null, zoom: number) {
  const points = (monuments ?? []).filter((m) => !m.polygon && zoom >= LABEL_MIN_ZOOM[m.kind]);
  const areas: (PlaceHit & { outline: [number, number, number][] })[] = [
    ...(monuments ?? [])
      .filter((m) => m.polygon && zoom >= LABEL_MIN_ZOOM[m.kind])
      .map((m) => ({ placeTag: m.id, outline: m.polygon!.map(([x, y]) => [x, y, 0.2] as [number, number, number]) })),
    ...(zoom >= FIELD_TAG_ZOOM ? (fields ?? []) : [])
      .filter((f) => f.surfaces[0]?.polygon[0])
      .map((f) => ({ placeTag: f.id, outline: f.surfaces[0].polygon[0].map(([x, y]) => [x, y, f.altitude + 0.2] as [number, number, number]) })),
  ];
  return [
    new SolidPolygonLayer<PlaceHit & { outline: [number, number, number][] }>({
      id: 'place-hit-areas',
      data: areas,
      getPolygon: (d) => d.outline,
      getFillColor: [0, 0, 0, 0],
      pickable: true,
      parameters: { depthWriteEnabled: false },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
    new ScatterplotLayer<Monument>({
      id: 'place-hit-points',
      data: points,
      getPosition: (m) => [m.position[0], m.position[1], (m.altitude ?? 0) + (m.height ?? 2) / 2],
      getRadius: (m) => Math.max(3, (m.height ?? 2) / 2),
      radiusUnits: 'meters',
      radiusMinPixels: 9,
      billboard: true,
      getFillColor: [0, 0, 0, 0],
      pickable: true,
      parameters: { depthWriteEnabled: false },
      // @ts-expect-error `slot` is read by @deck.gl/mapbox to place the layer in Mapbox Standard.
      slot: 'middle',
    }),
  ];
}

/** The place id under the pointer, from a deck.gl picked object; null for anything else. */
export function placeUnder(object: unknown): string | null {
  if (!object || typeof object !== 'object') return null;
  if ('placeTag' in object) return (object as PlaceHit).placeTag;
  // The point targets carry the monument itself.
  if ('source' in object && 'kind' in object && 'bearing' in object && 'model' in object) return (object as Monument).id;
  return null;
}
