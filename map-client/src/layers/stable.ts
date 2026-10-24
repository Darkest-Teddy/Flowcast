// Keep per-frame layer data referentially stable.
//
// deck.gl treats a new `data` array as all-new data and regenerates every attribute; for a
// ScenegraphLayer that means re-binding ~7 vertex attributes on every primitive of the model
// (16 for a bus) every frame. Moving things (walkers, vehicles) only need their positions
// refreshed each frame, which updateTriggers can do on their own when the array is the same.

const slots = new Map<string, { ids: string; list: unknown[] }>();

/**
 * Returns last frame's array for `slot` when `items` has the same ids in the same order (its
 * contents replaced in place with `items`), so only accessors whose updateTriggers changed are
 * re-run. Otherwise returns `items` itself, which deck.gl sees as new data.
 */
export function stableList<T>(slot: string, items: T[], idOf: (item: T) => string): T[] {
  let ids = '';
  for (const item of items) ids += `${idOf(item)}|`;
  const previous = slots.get(slot);
  if (previous && previous.ids === ids) {
    const list = previous.list as T[];
    for (let i = 0; i < items.length; i++) list[i] = items[i];
    return list;
  }
  slots.set(slot, { ids, list: items });
  return items;
}

/** A cheap update trigger that changes whenever any item's heading does. */
export function headingsKey<T>(items: T[], bearingOf: (item: T) => number): string {
  let key = '';
  for (const item of items) key += `${bearingOf(item)},`;
  return key;
}
