// Glass tags for the parking lots (only while the Parking toggle is on: App mounts this then, and
// it creates nothing before). Same pill and card as the transit and place tags, through the shared
// placer after the building and transit tags:
//  - pill: a "P" in the lot's level colour, its name and "82%", or "FULL",
//  - card: "Agganis Garage · 82% · Busy", spaces taken and free, filling / emptying, and the event
//    whose cars are there ("Red Sox v Yankees"). Every figure is an estimate ("Est.").
// Colour is never the only signal: the words and numbers carry the level too.
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { TagProjection } from './tags/projection';
import type { CameraState } from './map/basemap';
import type { LabelPlacer, Projector } from './layers/placement';
import { crowdLevel, crowdLevelStyle } from './layers/crowd';
import { GlassTags, esc, type GlassTagItem, type GlassTagSpec } from './tags/glassTags';
import type { LotState, ParkingLot, ParkingState } from './sim/parking';

/** Big lots (and FULL or event lots) get tags from this zoom; every lot from DETAIL_ZOOM. */
export const PARKING_TAG_ZOOM = 14.6;
const DETAIL_ZOOM = 15.6;
const BIG_LOT = 140;
const MARGIN = 40;
const ROOF_LIFT = 1;

const P_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="2.5" width="19" height="19" rx="5" fill="currentColor" opacity="0.22"/><path d="M9 17V7h4.2a3.1 3.1 0 0 1 0 6.2H9" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const TREND_TEXT = { filling: '↑ filling', emptying: '↓ emptying', steady: 'steady' } as const;

export interface ParkingTagsFrame {
  placer: LabelPlacer;
  project: Projector;
  camera: CameraState;
  state: ParkingState;
}

export interface ParkingTagsHandle {
  update(frame: ParkingTagsFrame): void;
  /** The lot under the pointer on the map (its fill), or null: expands its tag. */
  hoverLot(id: string | null): void;
}

/** "Agganis Garage · 82% · Busy" (or "· FULL"), the words every tag and row share. */
export function lotSummary(s: Pick<LotState, 'share' | 'full'>): { percent: number; word: string } {
  const percent = Math.round(s.share * 100);
  return { percent, word: s.full ? 'FULL' : crowdLevel(s.share).label };
}

function lotSpec(s: LotState): GlassTagSpec {
  const { lot } = s;
  const { percent, word } = lotSummary(s);
  const name = esc(lot.short);
  const event = s.event && s.eventCars >= 5 ? esc(s.event.name) : null;
  const html =
    `<span class="gtag-icon gtag-icon--parking">${P_ICON}</span>` +
    `<span class="gtag-text"><span class="gtag-name">${name}<span class="gtag-sep">·</span><span class="gtag-pct">${percent}%</span><span class="gtag-sep">·</span><span class="gtag-word">${word}</span><span class="gtag-est">Est.</span></span>` +
    `<span class="gtag-stats"><span><b>${s.free.toLocaleString()}</b> of ${lot.capacity.toLocaleString()} free</span><span class="gtag-sep">·</span><span class="gtag-dir">${TREND_TEXT[s.trend]}</span>` +
    (event ? `<span class="gtag-sep">·</span><span class="gtag-dir">${event}</span>` : '') +
    `</span></span>`;
  const compact = `<span class="gtag-picon gtag-icon--parking">${P_ICON}</span><span class="gtag-pname">${name}</span>` +
    (s.full ? '<span class="gtag-state">FULL</span>' : `<span class="gtag-ppct">${percent}%</span>`);
  const label = `${lot.name}: ${percent}% full, ${word}, about ${s.free} of ${lot.capacity} spaces free, ${s.trend}${event ? `, ${s.event!.name} parking` : ''}. Estimate.`;
  const style = crowdLevelStyle(s.full ? 1 : s.share);
  return { id: lot.id, key: html, html, compact, label, className: s.full ? 'is-full' : '', vars: style };
}

const anchorOf = (lot: ParkingLot): [number, number, number] => [lot.position[0], lot.position[1], lot.underBuilding || lot.kind === 'surface' ? 0 : lot.height + ROOF_LIFT];

export function ParkingTags({ ref }: { ref: Ref<ParkingTagsHandle> }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const s = useRef({
    pool: null as GlassTags | null,
    size: [0, 0] as [number, number],
    from: null as ParkingState | null,
    ordered: [] as LotState[],
    specs: new Map<string, GlassTagSpec>(),
    hovered: null as string | null,
    projection: new TagProjection<LotState>(MARGIN),
  }).current;

  useEffect(() => {
    const layer = layerRef.current!;
    s.pool = new GlassTags(layer, 'gtag--parking');
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
      hoverLot: (id) => void (s.hovered = id),
      update({ placer, project, camera, state }) {
        const pool = s.pool;
        const [width, height] = s.size;
        if (!pool || !width) return;
        if (state !== s.from) {
          // Re-ordered and re-written only when the estimate is refreshed (twice a second at most).
          s.from = state;
          // FULL and event lots first, then the fullest and biggest: if tags must be dropped, the small quiet lots go.
          s.ordered = [...state.lots].sort((a, b) => Number(b.full) - Number(a.full) || Number(b.eventCars > 0) - Number(a.eventCars > 0) || b.share * Math.sqrt(b.lot.capacity) - a.share * Math.sqrt(a.lot.capacity));
          s.specs = new Map(s.ordered.map((l) => [l.lot.id, lotSpec(l)]));
        }
        const minZoom = (l: LotState) => (l.full || l.eventCars > 0 || l.lot.capacity >= BIG_LOT ? PARKING_TAG_ZOOM : DETAIL_ZOOM);
        const anchors = s.projection.get(s.ordered, camera, width, height, project, (l) => anchorOf(l.lot), undefined, minZoom);
        const items: GlassTagItem[] = [];
        for (const [l, anchor] of anchors) items.push({ spec: s.specs.get(l.lot.id)!, anchor });
        pool.update(items, placer, { direction: -1, gap: 8, maxLift: 2, openId: s.hovered });
      },
    }),
    [s],
  );

  return <div ref={layerRef} className="gtags" />;
}
