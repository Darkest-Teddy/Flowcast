// Legacy demo sizing only. Published and explicitly modeled capacity references are immutable.
import type { DayData } from './playback';
import { Playback } from './playback';

const TARGET_PEAK = 0.85;
const MAX_PEAK = 1.0;
const STEP_SECONDS = 600;

export function calibrateCapacities(day: DayData): DayData {
  const playback = new Playback(day);
  if (day.locations.every(location => location.referenceCapacity !== undefined)) return day;
  const locationPeak = new Map<string, number>();
  const kindPeak = new Map<string, number>();
  for (let t = 6 * 3600; t < 24 * 3600; t += STEP_SECONDS) {
    const perKind = new Map<string, number>();
    for (const { location, count } of playback.occupancyAt(t)) {
      locationPeak.set(location.id, Math.max(locationPeak.get(location.id) ?? 0, count));
      perKind.set(location.kind, (perKind.get(location.kind) ?? 0) + count);
    }
    for (const [kind, n] of perKind) kindPeak.set(kind, Math.max(kindPeak.get(kind) ?? 0, n));
  }

  const weightByKind = new Map<string, number>();
  for (const l of day.locations) weightByKind.set(l.kind, (weightByKind.get(l.kind) ?? 0) + Math.max(1, l.capacity));

  const locations = day.locations.map((l) => {
    if (l.referenceCapacity !== undefined) return l;
    const share = Math.max(1, l.capacity) / weightByKind.get(l.kind)!;
    const sized = Math.round(((kindPeak.get(l.kind) ?? 0) * share) / TARGET_PEAK);
    const capacity = Math.max(5, sized, Math.ceil((locationPeak.get(l.id) ?? 0) / MAX_PEAK));
    return { ...l, capacity };
  });
  return { ...day, locations };
}
