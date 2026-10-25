// Glass tags for getting around, in the same language as the building tags. Each is a compact
// pill until it opens (hover or focus on the pill, hover on its dot on the map, or a tap); then
// the full card expands:
//  - Green Line stations (from zoom 16.2): pill = T roundel and name. Card = branch badges and the
//    next train each way ("Inbound B 2 min · Outbound 7 min"); both pulse while a train is
//    arriving now,
//  - bus and BU shuttle stops (zoomed in, on screen, with predictions): pill = route badges in
//    route colours. Card = the stop and the next arrival per route,
//  - Bluebikes docks (zoomed in): pill = bikes, plus Empty / Full (word and colour). Card = bikes,
//    empty docks, e-bikes and "Est." for estimated counts at playback times,
//  - the vehicle under the pointer, or clicked: route, direction and what it's doing (always open).
// React renders only the layer; App's frame loop calls update(), after the building tags and
// before the other labels, so all of them share one placer.
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import type { LabelPlacer, Projector } from './layers/placement';
import { STATION_LABEL_MIN_ZOOM } from './layers/transit';
import { minutesUntil, type Arrival, type TransitData, type TransitRoute, type TransitSource, type TransitStop, type Vehicle } from './transit/mbta';
import { BU_RED, shuttleInService } from './transit/buShuttle';
import type { BikeStation, DockEstimate } from './bikes/bluebikes';
import { GlassTags, esc, readableOn, type GlassTagItem, type GlassTagSpec } from './tags/glassTags';

/** Bus and shuttle stop tags only from this zoom (street level). */
export const STOP_TAG_ZOOM = 17;
/** Bluebikes dock tags from this zoom. */
export const DOCK_TAG_ZOOM = 16;
const COMPACT_ZOOM = 16.8;
/** Arrival times change by the minute: recompute tag content at most this often. */
const CONTENT_MS = 1000;
const MARGIN = 40;

const svg = (paths: string, fill = 'none') =>
  `<svg viewBox="0 0 24 24" fill="${fill}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
// The MBTA "T": a black T on a white roundel.
const T_ROUNDEL =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10.5" fill="#fff" stroke="#111" stroke-width="2"/><path d="M6.5 7.2h11v2.9h-4v8.1h-3v-8.1h-4z" fill="#111"/></svg>';
const BUS_ICON = svg('<path d="M8 6v6"/><path d="M15 6v6"/><path d="M2 12h19.6"/><path d="M18 18h3s.5-1.7.8-2.8c.1-.4.2-.8.2-1.2 0-.4-.1-.8-.2-1.2l-1.4-5C20.1 6.8 19.1 6 18 6H4a2 2 0 0 0-2 2v10h3"/><circle cx="7" cy="18" r="2"/><path d="M9 18h5"/><circle cx="16" cy="18" r="2"/>');
const BIKE_ICON = svg('<circle cx="18.5" cy="17.5" r="3.5"/><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="15" cy="5" r="1"/><path d="M12 17.5V14l-3-3 4-3 2 3h2"/>');
const BOLT = svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>', 'currentColor');
const PULSE = '<span class="gtag-pulse" aria-hidden="true"></span>';

export interface TransitTagsFrame {
  placer: LabelPlacer;
  /** Ground lng/lat to screen px. */
  project: Projector;
  zoom: number;
  /**
   * MBTA + BU shuttle data and the source drawn on the map (live feed or schedule), or null when
   * hidden. `time` (sim seconds) and `weekday` (0 = Sunday) give the BU shuttles' service hours.
   */
  transit: { data: TransitData; source: TransitSource; now: number; time: number; weekday: number;
    /** Modeled BU students aboard a vehicle, or null when the vehicle has no published trip. */
    aboard?: (vehicleId: string) => number | null;
    /** Modeled BU students waiting at each stop for a published departure. */
    waiting?: Map<string, number> } | null;
  /** Bluebikes docks and their counts at the shown time, or null when hidden. */
  bikes: { stations: BikeStation[]; dockStatus: Map<string, DockEstimate> } | null;
}

export type TagMarker = { kind: 'stop' | 'dock'; id: string } | null;

export interface TransitTagsHandle {
  update(frame: TransitTagsFrame): void;
  /** The stop or dock dot under the pointer on the map (deck.gl picking): expands its tag. */
  hoverMarker(marker: TagMarker): void;
  /** Whether this stop or dock has a tag on screen (then it needs no tooltip). */
  hasTag(marker: NonNullable<TagMarker>): boolean;
  /** The vehicle under the pointer (null: none). */
  hoverVehicle(id: string | null): void;
  /** Click: pins a vehicle's tag (clicking it again, or anything else, unpins). */
  pinVehicle(id: string | null): void;
}

const shortStopName = (name: string) =>
  name
    .replace(/Massachusetts Ave/g, 'Mass Ave')
    .replace(/Commonwealth Ave/g, 'Comm Ave')
    .replace(/ Street\b/g, ' St')
    .replace(/^BU Shuttle · /, '');

const routeBadge = (route: TransitRoute) => {
  const shuttle = route.kind === 'shuttle';
  const bg = shuttle ? BU_RED : route.color;
  const fg = shuttle ? '#fff' : route.textColor || readableOn(route.color);
  return `<span class="gtag-route" style="background:${bg};color:${fg}">${esc(shuttle ? 'BU' : route.name)}</span>`;
};
const branchBadge = (letter: string) => `<span class="gtag-branch">${esc(letter)}</span>`;
const routeLabel = (route: TransitRoute) => (route.kind === 'shuttle' ? 'BU Shuttle' : route.kind === 'subway' ? `Green Line ${route.name}` : `Bus ${route.name}`);

const waitingStat = (count: number | undefined) =>
  count ? `<span class="gtag-sep">·</span><span class="gtag-arr"><b>${count}</b>&nbsp;BU waiting</span>` : '';
const waitingLabel = (count: number | undefined) => (count ? ` ${count} BU riders waiting (modeled students and staff).` : '');

function stationSpec(s: TransitStop, routes: Map<string, TransitRoute>, source: TransitSource, waiting?: number): GlassTagSpec {
  // Trains only: Kenmore is also a stop for the 57 and other buses.
  const next: Partial<Record<0 | 1, Arrival>> = {};
  for (const a of source.nextArrivals(s.id)) {
    if (routes.get(a.route)?.kind === 'subway' && (!next[a.direction] || a.time < next[a.direction]!.time)) next[a.direction] = a;
  }
  const branches = s.routes.map((r) => routes.get(r)).filter((r): r is TransitRoute => r?.kind === 'subway');
  const parts = ([1, 0] as const).flatMap((dir) => {
    const a = next[dir];
    if (!a) return [];
    const route = routes.get(a.route)!;
    // Name the branch where more than one stops here (Kenmore: B, C, D).
    return [{ dir: route.directions[dir], branch: branches.length > 1 ? route.name : '', when: minutesUntil(a.time) }];
  });
  const arriving = parts.some((p) => p.when === 'Now');
  const stats = parts.length
    ? parts
        .map((p) => `<span class="gtag-arr"><span class="gtag-dir">${esc(p.dir)}</span>${p.branch ? branchBadge(p.branch) : ''}<b>${p.when}</b></span>`)
        .join('<span class="gtag-sep">·</span>')
    : '<span class="gtag-dir">No predictions</span>';
  const name = esc(s.short);
  const crowd = waitingStat(waiting);
  const html =
    `<span class="gtag-icon gtag-icon--t">${T_ROUNDEL}</span>` +
    `<span class="gtag-text"><span class="gtag-name">${name}${branches.map((b) => branchBadge(b.name)).join('')}${arriving ? PULSE : ''}</span>` +
    `<span class="gtag-stats">${stats}${crowd}</span></span>`;
  const compact = `<span class="gtag-picon">${T_ROUNDEL}</span><span class="gtag-pname">${name}</span>${arriving ? PULSE : ''}`;
  const label = `${s.short} station. ${parts.length ? parts.map((p) => `${p.dir}${p.branch ? ` ${p.branch}` : ''}: ${p.when}`).join(', ') : 'No predictions'}.${waitingLabel(waiting)}`;
  return { id: s.id, key: html + compact, html, compact, label, className: arriving ? 'is-arriving' : '' };
}

/** Soonest bus or shuttle per route at a stop; null when nothing is predicted. */
function stopSpec(s: TransitStop, routes: Map<string, TransitRoute>, source: TransitSource, waiting?: number): GlassTagSpec | null {
  const soonest = new Map<string, Arrival>();
  for (const a of source.nextArrivals(s.id)) {
    const kind = routes.get(a.route)?.kind;
    if (kind !== 'bus' && kind !== 'shuttle') continue;
    if (!soonest.has(a.route) || a.time < soonest.get(a.route)!.time) soonest.set(a.route, a);
  }
  if (!soonest.size) return null;
  const all = [...soonest.values()].sort((a, b) => a.time - b.time);
  // Every BU shuttle line wears the same "BU" badge, so they share one: "BU 22 · 23 min".
  const shuttles = all.filter((a) => routes.get(a.route)?.kind === 'shuttle');
  const entries: { route: TransitRoute; times: number[] }[] = all
    .filter((a) => routes.get(a.route)?.kind !== 'shuttle')
    .map((a) => ({ route: routes.get(a.route)!, times: [a.time] }));
  if (shuttles.length) entries.push({ route: routes.get(shuttles[0].route)!, times: shuttles.slice(0, 2).map((a) => a.time) });
  entries.sort((a, b) => a.times[0] - b.times[0]);
  const when = (times: number[]) =>
    times.length > 1 ? `${minutesUntil(times[0]).replace(' min', '')} · ${minutesUntil(times[1])}` : minutesUntil(times[0]);
  const list = entries.slice(0, 4);
  const arriving = list.some((e) => minutesUntil(e.times[0]) === 'Now');
  const shuttleOnly = list.every((e) => e.route.kind === 'shuttle');
  const name = shortStopName(s.short);
  const html =
    `<span class="gtag-icon ${shuttleOnly ? 'gtag-icon--bu' : 'gtag-icon--bus'}">${BUS_ICON}</span>` +
    `<span class="gtag-text"><span class="gtag-name gtag-name--stop">${esc(name)}</span>` +
    `<span class="gtag-stats">${list.map((e) => `<span class="gtag-arr">${routeBadge(e.route)}<b>${when(e.times)}</b></span>`).join('')}${waitingStat(waiting)}</span></span>`;
  const compact = list.map((e) => routeBadge(e.route)).join('') + (arriving ? PULSE : '');
  const label = `Stop ${name}. ${list.map((e) => `${routeLabel(e.route)}: ${when(e.times)}`).join(', ')}.${waitingLabel(waiting)}`;
  return { id: s.id, key: html + compact, html, compact, label, className: arriving ? 'is-arriving' : '' };
}

function dockSpec(s: BikeStation, e: DockEstimate): GlassTagSpec {
  const state = e.bikes === 0 ? 'empty' : e.docks === 0 ? 'full' : 'ok';
  const word = state === 'empty' ? '<span class="gtag-state">Empty</span>' : state === 'full' ? '<span class="gtag-state">Full</span>' : '';
  const est = e.estimated ? '<span class="gtag-est" title="Estimated from the typical day">Est.</span>' : '';
  const html =
    `<span class="gtag-icon gtag-icon--bike">${BIKE_ICON}</span>` +
    `<span class="gtag-text"><span class="gtag-name">${esc(s.short)}${word}</span>` +
    `<span class="gtag-stats">${est}` +
    `<span class="gtag-arr"><b>${e.bikes}</b>&nbsp;bike${e.bikes === 1 ? '' : 's'}</span><span class="gtag-sep">·</span>` +
    `<span class="gtag-arr"><b>${e.docks}</b>&nbsp;dock${e.docks === 1 ? '' : 's'}</span>` +
    `${e.ebikes ? `<span class="gtag-sep">·</span><span class="gtag-arr gtag-ebike">${BOLT}<b>${e.ebikes}</b>&nbsp;e-bike${e.ebikes === 1 ? '' : 's'}</span>` : ''}` +
    `</span></span>`;
  const compact = `<span class="gtag-picon gtag-icon--bike">${BIKE_ICON}</span><b>${e.bikes}</b>${word}`;
  const label = `${s.name} Bluebikes: ${e.bikes} bikes, ${e.docks} empty docks, ${e.ebikes === null ? 'e-bike count unknown' : `${e.ebikes} e-bikes`}${e.estimated ? ' (estimated)' : ''}${state === 'ok' ? '' : `, ${state}`}.`;
  return { id: s.id, key: html + compact, html, compact, label, className: `is-${state}` };
}

const STATUS: Record<string, string> = { STOPPED_AT: 'Stopped', INCOMING_AT: 'Arriving', IN_TRANSIT_TO: 'Moving' };

function vehicleSpec(v: Vehicle, routes: Map<string, TransitRoute>, aboard: number | null): GlassTagSpec {
  const route = routes.get(v.route);
  const title = !route ? v.route : route.kind === 'subway' ? 'Green Line' : route.kind === 'shuttle' ? 'BU Shuttle' : `Bus ${route.name}`;
  const badge = route ? (route.kind === 'subway' ? branchBadge(route.name) : routeBadge(route)) : '';
  const where = route?.kind === 'shuttle' ? route.longName : (route?.directions[v.direction] ?? '');
  const status = STATUS[v.status] ?? v.status;
  const html =
    `<span class="gtag-text"><span class="gtag-name">${badge}${esc(title)}</span>` +
    `<span class="gtag-stats"><span class="gtag-dir">${esc(where)}</span><span class="gtag-sep">·</span><b>${esc(status)}</b>` +
    `${aboard === null ? '' : `<span class="gtag-sep">·</span><span class="gtag-arr" title="Modeled BU students and staff on this published trip; other riders are not modeled"><b>${aboard}</b>&nbsp;BU aboard</span>`}</span></span>`;
  return { id: v.id, key: html, html, compact: '', label: `${title}, ${where}, ${status}${aboard === null ? '' : `, ${aboard} modeled BU riders aboard`}` };
}

export function TransitTags({ ref }: { ref: Ref<TransitTagsHandle> }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const s = useRef({
    pools: null as null | { stations: GlassTags; stops: GlassTags; docks: GlassTags; vehicle: GlassTags },
    size: [0, 0] as [number, number],
    compact: null as boolean | null,
    contentAt: 0,
    specs: new Map<string, GlassTagSpec | null>(),
    marker: null as TagMarker,
    hovered: null as string | null,
    pinned: null as string | null,
  }).current;

  useEffect(() => {
    const layer = layerRef.current!;
    s.pools = {
      stations: new GlassTags(layer, 'gtag--station'),
      stops: new GlassTags(layer, 'gtag--stop'),
      docks: new GlassTags(layer, 'gtag--dock'),
      vehicle: new GlassTags(layer, 'gtag--vehicle'),
    };
    const measure = () => (s.size = [layer.clientWidth, layer.clientHeight]);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => {
      observer.disconnect();
      for (const pool of Object.values(s.pools!)) pool.destroy();
      s.pools = null;
    };
  }, [s]);

  useImperativeHandle(
    ref,
    () => ({
      hoverMarker: (marker) => void (s.marker = marker),
      hasTag: ({ kind, id }) => !!s.pools && (kind === 'dock' ? s.pools.docks.has(id) : s.pools.stations.has(id) || s.pools.stops.has(id)),
      hoverVehicle: (id) => void (s.hovered = id),
      pinVehicle: (id) => void (s.pinned = id && id !== s.pinned ? id : null),
      update({ placer, project, zoom, transit, bikes }) {
        const pools = s.pools;
        const layer = layerRef.current;
        const [width, height] = s.size;
        if (!pools || !layer || !width) return;
        const compact = zoom < COMPACT_ZOOM;
        if (compact !== s.compact) {
          s.compact = compact;
          layer.classList.toggle('is-compact', compact);
          s.contentAt = 0; // re-measure every tag
          s.specs.clear();
        }
        const now = performance.now();
        const fresh = now - s.contentAt > CONTENT_MS;
        if (fresh) s.contentAt = now;
        const spec = <T,>(id: string, make: () => T) => {
          if (fresh || !s.specs.has(id)) s.specs.set(id, make() as GlassTagSpec | null);
          return s.specs.get(id) as T;
        };
        const onScreen = (p: [number, number]) => p[0] > -MARGIN && p[0] < width + MARGIN && p[1] > -MARGIN && p[1] < height + MARGIN;
        const openStop = s.marker?.kind === 'stop' ? s.marker.id : null;

        if (transit) {
          const { data, source } = transit;
          // BU shuttle lines only during their service hours, as on the map.
          const routes = new Map(
            data.routes.filter((r) => r.kind !== 'shuttle' || (source.inService?.(r.id) ?? shuttleInService(r, transit.time, transit.weekday))).map((r) => [r.id, r]),
          );
          const stationItems: GlassTagItem[] = [];
          const stopItems: GlassTagItem[] = [];
          for (const stop of data.stops) {
            if (zoom < (stop.kind === 'station' ? STATION_LABEL_MIN_ZOOM : STOP_TAG_ZOOM)) continue;
            const anchor = project(stop.position);
            if (!onScreen(anchor)) continue;
            if (stop.kind === 'station') {
              stationItems.push({ spec: spec(stop.id, () => stationSpec(stop, routes, source, transit.waiting?.get(stop.id))), anchor });
            } else {
              const stopTag = spec<GlassTagSpec | null>(stop.id, () => stopSpec(stop, routes, source, transit.waiting?.get(stop.id)));
              if (stopTag) stopItems.push({ spec: stopTag, anchor });
            }
          }
          // Stations hang below their dot, then the street-level stops.
          pools.stations.update(stationItems, placer, { direction: 1, gap: 14, maxLift: 1, openId: openStop });
          pools.stops.update(stopItems, placer, { direction: 1, gap: 10, maxLift: 1, openId: openStop });

          const focus = s.pinned ?? s.hovered;
          const vehicle = focus ? source.positionsAt(transit.now).find((v) => v.id === focus) : undefined;
          if (vehicle) {
            const [x, y] = project(vehicle.position);
            // Above the vehicle, clear of its model; never dropped by the placer.
            pools.vehicle.update([{ spec: vehicleSpec(vehicle, routes, transit.aboard?.(vehicle.id) ?? null), anchor: [x, y - 10] }], null, { direction: -1, gap: 26, alwaysOpen: true });
          } else {
            if (s.pinned) s.pinned = null; // it left the feed
            pools.vehicle.hideAll();
          }
        } else {
          pools.stations.hideAll();
          pools.stops.hideAll();
          pools.vehicle.hideAll();
        }

        if (bikes && zoom >= DOCK_TAG_ZOOM) {
          const items: GlassTagItem[] = [];
          for (const station of bikes.stations) {
            const e = bikes.dockStatus.get(station.id);
            if (!e) continue;
            const anchor = project(station.position);
            if (onScreen(anchor)) items.push({ spec: spec(`dock:${station.id}`, () => dockSpec(station, e)), anchor });
          }
          pools.docks.update(items, placer, { direction: 1, gap: 10, maxLift: 1, openId: s.marker?.kind === 'dock' ? s.marker.id : null });
        } else {
          pools.docks.hideAll();
        }
      },
    }),
    [s],
  );

  return <div ref={layerRef} className="gtags" />;
}
