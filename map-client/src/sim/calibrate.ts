// Size each place's capacity to the simulated day that's loaded, so "% full" reads sensibly.
//
// Capacities in demo-day.json were tuned to the placeholder day. The source day built from real
// class schedules (sourceDay.ts) puts students in different places, e.g. far more in CAS, which
// then read 199%. Same rule as data-pipeline/make_demo_routes.py: each kind of place (classrooms,
// dining...) is sized so its busiest moment of the day is TARGET_PEAK full, split across that
// kind's buildings by their existing (real-size-weighted) capacities; no single place peaks above
// MAX_PEAK. Only `capacity` changes; trips and counts are untouched.
import type { DayData } from './playback';
import { Playback } from './playback';

const TARGET_PEAK = 0.85;
const MAX_PEAK = 1.0;
const STEP_SECONDS = 600;

export function calibrateCapacities(day: DayData): DayData {
  const playback = new Playback(day);
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
    const share = Math.max(1, l.capacity) / weightByKind.get(l.kind)!;
    const sized = Math.round(((kindPeak.get(l.kind) ?? 0) * share) / TARGET_PEAK);
    const capacity = Math.max(5, sized, Math.ceil((locationPeak.get(l.id) ?? 0) / MAX_PEAK));
    return { ...l, capacity };
  });
  return { ...day, locations };
}
