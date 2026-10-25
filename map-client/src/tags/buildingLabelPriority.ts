interface BuildingLabel {
  id: string;
  share: number;
  event?: unknown;
}

/** Reserve the limited overview space for interaction targets, events, then busy buildings. */
export function buildingLabelPriority<T extends BuildingLabel>(items: T[], options: {
  zoom: number;
  width: number;
  height: number;
  selectedId: string | null;
  hoveredId: string | null;
  focusedId: string | null;
  all: boolean;
}): T[] {
  const priority = (item: T) => item.id === options.focusedId ? 3 : item.id === options.selectedId ? 2 : item.id === options.hoveredId ? 1 : 0;
  const active = (item: T) => priority(item) > 0;
  const ordered = [...items].sort((a, b) => priority(b) - priority(a)
    || Number(Boolean(b.event)) - Number(Boolean(a.event)) || b.share - a.share);
  if (options.all) return ordered;
  const zoomLimit = options.zoom < 15 ? 4 : options.zoom < 16.5 ? 8 : 16;
  const areaLimit = Math.max(3, Math.floor(options.width * options.height / 70_000));
  return ordered.slice(0, Math.max(ordered.filter(active).length, Math.min(zoomLimit, areaLimit)));
}
