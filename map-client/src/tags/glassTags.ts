// A pool of glass HTML tags over the map, the same look as the building tags: cards on a stem,
// moved every frame with a transform, placed through the shared screen-space placer so no two
// labels overlap. Content is HTML rewritten only when its key changes; widths are measured then,
// in one batch (all writes, then all reads).
import type { LabelPlacer } from '../layers/placement';

export interface GlassTagSpec {
  id: string;
  /** Changes whenever the content does; the card is rewritten only then. */
  key: string;
  html: string;
  /** State classes on the tag, e.g. "is-arriving". */
  className?: string;
  /** CSS custom properties on the tag (accent colours). */
  vars?: Record<string, string>;
}

export interface GlassTagItem {
  spec: GlassTagSpec;
  /** Screen px of the thing the tag points at. */
  anchor: [number, number];
}

export interface GlassPlaceOptions {
  /** -1: card above the anchor (stem down to it); 1: card below (stem up to it). */
  direction: -1 | 1;
  /** Shortest stem, px. */
  gap: number;
  maxLift?: number;
}

interface Tag {
  id: string;
  root: HTMLDivElement;
  card: HTMLDivElement;
  key: string;
  className: string;
  width: number;
  height: number;
  lift: number;
  stem: number;
  shown: boolean;
}

/** px kept clear between neighbouring tags. */
const SPACING = 6;

export class GlassTags {
  private readonly tags = new Map<string, Tag>();
  private last = 0;

  /** `kind` is a class on every tag of this pool (e.g. "gtag--station"). */
  constructor(
    private readonly layer: HTMLElement,
    private readonly kind: string,
  ) {}

  /**
   * Shows these items (most important first) and hides every other tag of this pool. With a
   * placer, tags that can't find room are hidden; without one, every item is shown.
   */
  update(items: GlassTagItem[], placer: LabelPlacer | null, { direction, gap, maxLift = 1 }: GlassPlaceOptions) {
    const now = performance.now();
    const dt = this.last ? Math.min(now - this.last, 100) / 1000 : 0;
    this.last = now;

    const changed: Tag[] = [];
    for (const { spec } of items) {
      let tag = this.tags.get(spec.id);
      if (!tag) {
        tag = this.create(spec.id, direction);
        this.tags.set(spec.id, tag);
      }
      if (this.write(tag, spec)) changed.push(tag);
    }
    for (const tag of changed) {
      tag.width = tag.card.offsetWidth;
      tag.height = tag.card.offsetHeight;
    }

    let rowHeight = 0;
    for (const { spec } of items) rowHeight = Math.max(rowHeight, this.tags.get(spec.id)!.height);
    rowHeight += SPACING;
    const lifts: Map<GlassTagItem, number> = placer
      ? placer.place(items, {
          point: (it) => it.anchor,
          width: (it) => this.tags.get(it.spec.id)!.width + SPACING,
          height: rowHeight,
          direction,
          gap,
          maxLift,
        })
      : new Map(items.map((it) => [it, 0]));

    const dpr = window.devicePixelRatio || 1;
    const snap = (v: number) => Math.round(v * dpr) / dpr; // whole device pixels: crisp text
    const placed = new Set<string>();
    for (const [item, lift] of lifts) {
      const tag = this.tags.get(item.spec.id)!;
      placed.add(tag.id);
      tag.lift = tag.shown ? tag.lift + (lift - tag.lift) * Math.min(1, dt * 10) : lift;
      if (Math.abs(tag.lift - lift) < 0.01) tag.lift = lift;
      const stem = Math.round(gap + tag.lift * rowHeight);
      if (stem !== tag.stem) {
        tag.stem = stem;
        tag.root.style.setProperty('--stem', `${stem}px`);
      }
      tag.root.style.transform = `translate3d(${snap(item.anchor[0])}px, ${snap(item.anchor[1])}px, 0)`;
      if (!tag.shown) {
        tag.shown = true;
        tag.root.classList.remove('is-hidden');
      }
    }
    for (const tag of this.tags.values()) {
      if (tag.shown && !placed.has(tag.id)) {
        tag.shown = false;
        tag.root.classList.add('is-hidden');
      }
    }
  }

  hideAll() {
    for (const tag of this.tags.values()) {
      if (!tag.shown) continue;
      tag.shown = false;
      tag.root.classList.add('is-hidden');
    }
  }

  destroy() {
    for (const tag of this.tags.values()) tag.root.remove();
    this.tags.clear();
  }

  private create(id: string, direction: -1 | 1): Tag {
    const root = document.createElement('div');
    root.className = `gtag ${this.kind} ${direction < 0 ? 'is-above' : 'is-below'} is-hidden`;
    root.innerHTML = '<span class="gtag-stem"></span><div class="gtag-card"></div>';
    this.layer.appendChild(root);
    return {
      id,
      root,
      card: root.querySelector('.gtag-card') as HTMLDivElement,
      key: '',
      className: '',
      width: 120,
      height: 40,
      lift: 0,
      stem: -1,
      shown: false,
    };
  }

  private write(tag: Tag, spec: GlassTagSpec): boolean {
    if (spec.key === tag.key) return false;
    tag.key = spec.key;
    tag.card.innerHTML = spec.html;
    const className = spec.className ?? '';
    if (className !== tag.className) {
      for (const c of tag.className.split(' ').filter(Boolean)) tag.root.classList.remove(c);
      for (const c of className.split(' ').filter(Boolean)) tag.root.classList.add(c);
      tag.className = className;
    }
    for (const [k, v] of Object.entries(spec.vars ?? {})) tag.root.style.setProperty(k, v);
    return true;
  }
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapes text for the tags' HTML. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c]);

/** Black or white text, whichever reads better on a hex colour (BU's lime Comm Ave line needs black). */
export function readableOn(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.18 ? '#111' : '#fff';
}
