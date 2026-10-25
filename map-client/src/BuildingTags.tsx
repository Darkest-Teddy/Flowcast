// Glassy HTML tags floating over each tracked building, on a stem that stands on the roof. By
// default a small pill: the level's people icon, the short name and the % (never colour alone).
// Hovering the pill, its roof dot or the building itself, focusing it, tapping it, or selecting
// the building expands it into the full card: kind icon, name, "87% · Packed" and a fill bar.
// HTML rather than a deck.gl TextLayer for real typography, hover/focus states and keyboard access.
//
// React renders only the empty layer. The App's frame loop calls update() every frame, which
// creates tags once, rewrites their text only when it changes, and moves them with a transform,
// so nothing here re-renders per frame. Placement goes through the shared label placer first
// (building tags, then station labels), exactly as the old TextLayer did.
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { displayName } from './tags/names';
import { countInterval } from './sim/uncertainty';
import { TagProjection } from './tags/projection';
import type { CameraState } from './map/basemap';
import type { LabelPlacer, Projector } from './layers/placement';
import { crowdLevel, crowdLevelStyle, ringTop, type CrowdLevelInfo, type RoofHeights } from './layers/crowd';
import type { BuildingFootprint, BuildingOccupancy, CampusLocation, LocationKind } from './sim/playback';
import { occupancyShare } from './sim/playback';

const svg = (paths: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

// Lucide-style glyphs (ISC), one per kind of place.
const ICONS: Record<LocationKind, string> = {
  'off-campus': '',
  outdoor: '',
  dorm: svg('<path d="M2 4v16"/><path d="M2 8h18a2 2 0 0 1 2 2v10"/><path d="M2 17h20"/><path d="M6 8v9"/>'),
  classroom: svg('<path d="M22 10v6"/><path d="M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/>'),
  dining: svg('<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3zm0 0v7"/>'),
  library: svg('<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'),
  gym: svg('<path d="M6.5 6.5l11 11"/><path d="M21 21l-1-1"/><path d="M3 3l1 1"/><path d="M18 22l4-4"/><path d="M2 6l4-4"/><path d="M3 10l7-7"/><path d="M14 21l7-7"/>'),
};

// The crowd levels' marks: one, two or three people. The same paths as HudIcons person1/person2/
// person3 (hud/Chrome.tsx); theme/crowd.ts says which level takes which.
const PERSON_ICONS: Record<CrowdLevelInfo['icon'], string> = {
  person1: svg('<circle cx="12" cy="8" r="3.6"/><path d="M5 20a7 7 0 0 1 14 0"/>'),
  person2: svg('<circle cx="9" cy="8" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M16 6.2a3 3 0 0 1 0 5.6M17.5 19a5.4 5.4 0 0 0-2-4.2"/>'),
  person3: svg('<circle cx="12" cy="7.5" r="2.8"/><path d="M7 19.5a5 5 0 0 1 10 0"/><circle cx="5" cy="9.5" r="2.1"/><path d="M1.5 18.5a4 4 0 0 1 4.5-4"/><circle cx="19" cy="9.5" r="2.1"/><path d="M22.5 18.5a4 4 0 0 0-4.5-4"/>'),
};

const KIND_LABEL: Record<LocationKind, string> ={ dorm: 'Residence', classroom: 'Academic', dining: 'Dining', library: 'Library', gym: 'Athletics', outdoor: 'Outdoors', 'off-campus': 'Off map' };

/** px from the roof to the bottom of the card (the stem). */
const STEM = 16;
/** px kept clear between neighbouring tags. */
const SPACING = 6;
/** Tags whose roof is this far off screen are dropped before placement. */
const MARGIN = 60;
/** Below this zoom the tags tighten up so more of them fit on the overview. */
const COMPACT_ZOOM = 16;

export interface BuildingTagsFrame {
  buildings: BuildingOccupancy[];
  footprints: BuildingFootprint[];
  locations: CampusLocation[];
  selectedId: string | null;
  /** Shared with the station labels; building tags are placed first. */
  placer: LabelPlacer;
  /** Ground lng/lat to screen px (the map's own projection, padding included). */
  project: Projector;
  camera: CameraState;
  /** Detailed-model heights, so tags stand on the model's roof rather than the footprint's. */
  roofHeights?: RoofHeights;
}

export interface BuildingTagsHandle {
  update(frame: BuildingTagsFrame): void;
  /** The building under the pointer on the map (deck.gl picking), or null: expands its tag. */
  hoverBuilding(id: string | null): void;
}

interface Tag {
  id: string;
  root: HTMLDivElement;
  /** The compact pill: the focusable button, and what the placer makes room for. */
  pill: HTMLButtonElement;
  /** The pill's level mark: the people icon, or a plain dot where there is no level. */
  pdot: HTMLElement;
  pdotIcon: string;
  pname: HTMLElement;
  ppct: HTMLElement;
  /** A venue event's crowd (visitors included), beside the student figure, never in it. */
  pevent: HTMLElement;
  event: HTMLElement;
  card: HTMLElement;
  icon: HTMLElement;
  short: HTMLElement;
  pct: HTMLElement;
  word: HTMLElement;
  fill: HTMLElement;
  key: string;
  kind: LocationKind | null;
  width: number;
  /** Smoothed lift (in tag heights), so a tag slides rather than jumps when it moves up. */
  lift: number;
  stem: number;
  shown: boolean;
  selected: boolean;
  open: boolean;
}

function createTag(id: string, layer: HTMLElement, onClick: () => void): Tag {
  const root = document.createElement('div');
  root.className = 'btag is-hidden';
  root.innerHTML =
    '<span class="btag-dot"></span><span class="btag-stem"></span>' +
    '<button type="button" class="btag-pill" aria-expanded="false"><span class="btag-pdot"></span>' +
    '<span class="btag-pname"></span><span class="btag-ppct"></span><span class="btag-pevent" hidden></span></button>' +
    '<span class="btag-card" aria-hidden="true">' +
    '<span class="btag-icon"></span>' +
    '<span class="btag-text"><span class="btag-name"><span class="btag-short"></span><span class="btag-pulse"></span></span>' +
    '<span class="btag-stats"><span class="btag-pct"></span><span class="btag-word"></span></span>' +
    '<span class="btag-event" hidden></span></span>' +
    '<span class="btag-bar"><span class="btag-fill"></span></span>' +
    '</span>';
  const q = (s: string) => root.querySelector(s) as HTMLElement;
  const pill = q('.btag-pill') as HTMLButtonElement;
  const card = q('.btag-card');
  // A click or tap on either selects the building, which also keeps its card open.
  pill.addEventListener('click', onClick);
  card.addEventListener('click', onClick);
  layer.appendChild(root);
  return {
    id,
    root,
    pill,
    pdot: q('.btag-pdot'),
    pdotIcon: '',
    pname: q('.btag-pname'),
    ppct: q('.btag-ppct'),
    pevent: q('.btag-pevent'),
    event: q('.btag-event'),
    card,
    icon: q('.btag-icon'),
    short: q('.btag-short'),
    pct: q('.btag-pct'),
    word: q('.btag-word'),
    fill: q('.btag-fill'),
    key: '',
    kind: null,
    width: 120,
    lift: 0,
    stem: -1,
    shown: false,
    selected: false,
    open: false,
  };
}

export function BuildingTags({ ref, onSelect }: { ref: Ref<BuildingTagsHandle>; onSelect: (id: string | null) => void }) {
  const layerRef = useRef<HTMLDivElement>(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;
  const s = useRef({
    tags: new Map<string, Tag>(),
    size: [0, 0] as [number, number],
    tagHeight: 0,
    compact: null as boolean | null,
    last: 0,
    selectedId: null as string | null,
    hoveredId: null as string | null,
    heightsFrom: null as BuildingFootprint[] | null,
    heights: new Map<string, number>(),
    roofsFrom: undefined as RoofHeights | undefined,
    kindsFrom: null as CampusLocation[] | null,
    kinds: new Map<string, LocationKind>(),
    canBeEmpty: new Set<string>(),
    projection: new TagProjection<BuildingOccupancy>(MARGIN),
  }).current;

  useEffect(() => {
    const layer = layerRef.current!;
    const measure = () => (s.size = [layer.clientWidth, layer.clientHeight]);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(layer);
    return () => {
      observer.disconnect();
      for (const tag of s.tags.values()) tag.root.remove();
      s.tags.clear();
    };
  }, [s]);

  useImperativeHandle(
    ref,
    () => ({
      hoverBuilding: (id) => void (s.hoveredId = id),
      update({ buildings, footprints, locations, selectedId, placer, project, camera, roofHeights }) {
        const layer = layerRef.current;
        const [width, height] = s.size;
        if (!layer || !width) return;
        const now = performance.now();
        const dt = s.last ? Math.min(now - s.last, 100) / 1000 : 0;
        s.last = now;
        s.selectedId = selectedId;

        if (footprints !== s.heightsFrom || roofHeights !== s.roofsFrom) {
          s.heightsFrom = footprints;
          s.roofsFrom = roofHeights;
          s.heights = new Map();
          for (const f of footprints) s.heights.set(f.id, Math.max(s.heights.get(f.id) ?? 0, ringTop(f, footprints, roofHeights)));
        }
        if (locations !== s.kindsFrom) {
          s.kindsFrom = locations;
          // Keyed by both the source name and the tag's display name (tags/names.ts).
          s.kinds = new Map(locations.flatMap((l) => [[l.name, l.kind], [displayName(l.name), l.kind]] as [string, LocationKind][]));
          // Purpose-only places (the crew boathouse): nobody there outside sessions is a real zero.
          s.canBeEmpty = new Set(locations.filter((l) => l.estimatedProfile?.purpose === 'rowing').flatMap((l) => [l.name, displayName(l.name)]));
        }
        const compact = camera.zoom < COMPACT_ZOOM;
        if (compact !== s.compact) {
          s.compact = compact;
          layer.classList.toggle('is-compact', compact);
          for (const tag of s.tags.values()) tag.width = tag.pill.offsetWidth;
          s.tagHeight = 0;
        }

        // Roof anchors. The map's own projection puts the ground point on screen (with the view
        // padding); an unpadded viewport of the same camera gives the roof's offset above it
        // (padding only shifts the whole picture).
        const anchors = s.projection.get(buildings, camera, width, height, project,
          b => [b.position[0], b.position[1], b.roof ?? s.heights.get(b.id) ?? 0], s.heights);

        // Selected first, then venues with an event under way, then busiest: if tags must be
        // dropped, the quiet ones go (the side panel still lists every building).
        const order = [...anchors.keys()].sort(
          (a, b) => Number(b.id === selectedId) - Number(a.id === selectedId) || Number(Boolean(b.event)) - Number(Boolean(a.event)) || b.share - a.share,
        );
        const changed: Tag[] = [];
        for (const b of order) {
          let tag = s.tags.get(b.id);
          if (!tag) {
            const id = b.id;
            tag = createTag(id, layer, () => onSelectRef.current(s.selectedId === id ? null : id));
            s.tags.set(id, tag);
          }
          if (writeContent(tag, b, s.kinds.get(b.name) ?? null, s.canBeEmpty.has(b.name))) changed.push(tag);
        }
        // All writes first, then all reads: one layout pass, however many tags changed.
        for (const tag of changed) tag.width = tag.pill.offsetWidth;
        if (!s.tagHeight) {
          const any = s.tags.values().next().value;
          s.tagHeight = any ? any.pill.offsetHeight : 0;
        }
        const tagHeight = s.tagHeight + SPACING;
        const lifts = placer.place(order, {
          point: (b) => anchors.get(b)!,
          width: (b) => s.tags.get(b.id)!.width + SPACING,
          height: tagHeight,
          direction: -1,
          gap: STEM,
        });

        const dpr = window.devicePixelRatio || 1;
        const snap = (v: number) => Math.round(v * dpr) / dpr; // whole device pixels: crisp text
        const placed = new Set<string>();
        for (const [b, lift] of lifts) {
          const tag = s.tags.get(b.id)!;
          placed.add(b.id);
          const [x, y] = anchors.get(b)!;
          tag.lift = tag.shown ? tag.lift + (lift - tag.lift) * Math.min(1, dt * 10) : lift;
          if (Math.abs(tag.lift - lift) < 0.01) tag.lift = lift;
          const stem = Math.round(STEM + tag.lift * tagHeight);
          if (stem !== tag.stem) {
            tag.stem = stem;
            tag.root.style.setProperty('--stem', `${stem}px`);
          }
          tag.root.style.transform = `translate3d(${snap(x)}px, ${snap(y)}px, 0)`;
          const selected = b.id === selectedId;
          if (selected !== tag.selected) {
            tag.selected = selected;
            tag.root.classList.toggle('is-selected', selected);
            tag.pill.setAttribute('aria-pressed', String(selected));
          }
          // Hover and focus on the tag itself open it in CSS; the map's hover and the selection here.
          const open = selected || b.id === s.hoveredId;
          if (open !== tag.open) {
            tag.open = open;
            tag.root.classList.toggle('is-open', open);
            tag.pill.setAttribute('aria-expanded', String(open));
          }
          if (!tag.shown) {
            tag.shown = true;
            tag.root.classList.remove('is-hidden');
            tag.pill.tabIndex = 0;
          }
        }
        for (const tag of s.tags.values()) {
          if (tag.shown && !placed.has(tag.id)) {
            tag.shown = false;
            tag.root.classList.add('is-hidden');
            tag.pill.tabIndex = -1;
          }
        }
      },
    }),
    [s],
  );

  return <div ref={layerRef} className="btags" />;
}

interface ActivityDisplayInput {
  count: number;
  capacity: number;
  share: number;
  modeled?: boolean;
  capacityBasis?: string;
  kind?: LocationKind | null;
  /** The place really can be empty (a team-only boathouse between sessions): show a plain 0. */
  allowZero?: boolean;
}

/** Labels refer to the modeled space and its denominator, not every use of its building. */
/** Below these, a place shows "<N%" / "<N students" instead of a figure that rounds to zero. */
const NEAR_ZERO_PERCENT = 5;
const NEAR_ZERO_STUDENTS = 3;

export function activityDisplay({ count, capacity, modeled, capacityBasis, kind, allowZero = false }: ActivityDisplayInput) {
  const share = occupancyShare(count, capacity);
  const hasPercentage = modeled !== false && capacity > 0 && Number.isFinite(share)
    && capacityBasis !== 'residential_beds_plus_classroom_seats'
    && capacityBasis !== 'estimated_student_capacity';
  const percent = hasPercentage ? Math.round(share * 100) : 0;
  const seats = capacityBasis?.includes('classroom_seats') || (!capacityBasis && kind === 'classroom');
  const level = crowdLevel(share);
  // Plain percentages, except near zero: no building is ever truly empty (staff, visitors, people
  // the model doesn't simulate; sim/uncertainty.ts), so a near-empty place reads "<3%" rather than
  // "0%". The level and colour still follow the simulated figure.
  const band = countInterval(count, capacity);
  const unit = seats ? ' seats' : '';
  const nearZeroPct = Math.max(2, Math.min(NEAR_ZERO_PERCENT, Math.ceil((band.high / capacity) * 100)));
  const primary = modeled === false ? 'Not modeled'
    : hasPercentage
      ? percent < NEAR_ZERO_PERCENT && !(allowZero && count === 0) ? `<${nearZeroPct}%${unit}` : `${percent}%${unit}`
      : count < NEAR_ZERO_STUDENTS && !(allowZero && count === 0) ? `<${NEAR_ZERO_STUDENTS} students` : `${count.toLocaleString()} ${count === 1 ? 'student' : 'students'}`;
  const secondary = hasPercentage ? level.label : '';
  return {
    primary,
    secondary,
    percent,
    hasPercentage,
    level: hasPercentage ? level.key : 'unmodeled',
    /** One, two or three people for the level; empty where there is no level to show. */
    icon: hasPercentage ? PERSON_ICONS[level.icon] : '',
    // Not modeled: slate on the tags, plain secondary ink and a neutral bar on the panels.
    style: hasPercentage ? crowdLevelStyle(share) : { '--lv': '148, 163, 184', '--lv-text': '#cbd5e1', '--lv-ink': 'var(--map-ink-secondary)', '--lv-fill': 'var(--color-off)' },
    description: hasPercentage ? `${primary} of ${seats ? 'classroom seats' : 'capacity'}, ${secondary}` : primary,
  };
}

/** Rewrites a tag's text when it has changed; returns whether it did. */
function writeContent(tag: Tag, b: BuildingOccupancy, kind: LocationKind | null, allowZero = false): boolean {
  const display = b.eventOnly
    ? { primary: '', secondary: '', percent: 0, hasPercentage: false, level: 'event', icon: '', style:{ '--lv': '167, 139, 250', '--lv-text': '#ddd6fe', '--lv-ink': 'var(--map-ink-secondary)', '--lv-fill': 'var(--color-off)' }, description: '' }
    : activityDisplay({ ...b, kind, allowZero });
  const eventText = b.event?.text ?? '';
  const key = `${b.name}|${b.short}|${display.primary}|${display.level}|${kind}|${eventText}`;
  if (key === tag.key) return false;
  tag.key = key;
  if (tag.kind !== kind) {
    tag.kind = kind;
    tag.icon.innerHTML = kind ? ICONS[kind] : '';
    tag.icon.title = kind ? KIND_LABEL[kind] : '';
  }
  if (tag.pdotIcon !== display.icon) {
    tag.pdotIcon = display.icon;
    tag.pdot.innerHTML = display.icon;
    tag.pdot.classList.toggle('is-icon', Boolean(display.icon));
  }
  tag.short.textContent = b.short;
  tag.pname.textContent = b.short;
  tag.pct.textContent = display.primary;
  tag.ppct.textContent = display.primary;
  tag.ppct.hidden = !display.primary;
  tag.pct.hidden = !display.primary;
  tag.word.textContent = display.secondary;
  tag.word.hidden = !display.secondary;
  tag.pevent.textContent = eventText;
  tag.pevent.hidden = !eventText;
  tag.event.textContent = eventText;
  tag.event.hidden = !eventText;
  tag.fill.style.width = `${Math.min(100, display.percent)}%`;
  tag.fill.parentElement!.hidden = !display.hasPercentage;
  tag.root.dataset.level = display.level;
  tag.root.classList.toggle('has-event', Boolean(eventText));
  for (const [k, v] of Object.entries(display.style)) tag.root.style.setProperty(k, v);
  const students = display.description ? `${display.description}${kind ? ` (${KIND_LABEL[kind]})` : ''}` : '';
  tag.pill.setAttribute('aria-label', `${b.name}: ${[students, b.event?.description].filter(Boolean).join('; ')}`);
  return true;
}
