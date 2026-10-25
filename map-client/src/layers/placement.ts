// Screen-space label placement shared by every label layer, so building labels and station
// labels don't overlap each other either. Not CollisionFilterExtension: like HeatmapLayer, it
// renders nothing in deck.gl's interleaved mode.

export type Projector = (lngLat: [number, number]) => [number, number];

export interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface PlaceOptions<T> {
  /** Ground anchor, projected with the placer's projector... */
  position?: (d: T) => [number, number];
  /** ...or an anchor already in screen px (building tags anchor at the roof, not the ground). */
  point?: (d: T) => [number, number];
  /** Rough label width in px. */
  width: (d: T) => number;
  height: number;
  /** -1 stacks labels upward from their anchor (above buildings), 1 downward (below stops). */
  direction: -1 | 1;
  /** Extra px between the anchor and the label. */
  gap?: number;
  maxLift?: number;
}

/** A fresh placer per frame; call place() in priority order (most important layer first). */
export function createPlacer(project: Projector) {
  const placed: Box[] = [];
  return {
    /**
     * Mark a rectangle as already taken, before any label is placed.
     *
     * Used for the chrome: the brand, tabs, clock, legend and panel are drawn in
     * HTML over the same pixels, so a label that lands under one of them is
     * unreadable. Seeding them here makes labels lift or drop out around the
     * chrome, which is the same rule they already follow for each other. The
     * clock in particular has no backdrop of its own, so nothing else would stop
     * a building tag from sitting on top of it.
     */
    block(box: Box) {
      placed.push(box);
    },

    /**
     * Each item sits at its anchor, or is shifted up to maxLift label-heights to clear what's
     * already placed; if it still overlaps, it's left out. Returns item -> lift (in labels).
     * Items should already be sorted most-important first.
     */
    place<T>(items: T[], { position, point, width, height, direction, gap = 0, maxLift = 2 }: PlaceOptions<T>): Map<T, number> {
      const lifts = new Map<T, number>();
      for (const item of items) {
        const [x, y] = point ? point(item) : project(position!(item));
        const half = width(item) / 2;
        for (let lift = 0; lift <= maxLift; lift++) {
          const near = y + direction * (gap + lift * height);
          const far = near + direction * height;
          const box = { x0: x - half, x1: x + half, y0: Math.min(near, far), y1: Math.max(near, far) };
          if (!placed.some((p) => box.x0 < p.x1 && p.x0 < box.x1 && box.y0 < p.y1 && p.y0 < box.y1)) {
            placed.push(box);
            lifts.set(item, lift);
            break;
          }
        }
      }
      return lifts;
    },
  };
}

export type LabelPlacer = ReturnType<typeof createPlacer>;

/** Approximate px width of a multi-line label at a given font size (bold UI font). */
export function labelWidth(text: string, fontSize: number, padding = 16): number {
  const longest = Math.max(...text.split('\n').map((line) => line.length));
  return longest * fontSize * 0.6 + padding;
}
