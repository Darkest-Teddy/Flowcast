import type { Stay } from './playback';

export interface OccupancyIndex {
  countsAt(time: number): Map<string, number>;
}

function through(sorted: readonly number[], time: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Snapshot nonoverlapping stays; return null when per-agent first-match semantics need a scan. */
export function createOccupancyIndex(stays: readonly Stay[]): OccupancyIndex | null {
  const agents = new Map<string, { start: number; end: number }[]>();
  const locations = new Map<string, { starts: number[]; ends: number[] }>();
  for (const stay of stays) {
    if (!Number.isFinite(stay.start) || !Number.isFinite(stay.end) || stay.end < stay.start) return null;
    const intervals = agents.get(stay.agent) ?? [];
    intervals.push({ start: stay.start, end: stay.end });
    agents.set(stay.agent, intervals);
    if (stay.location === 'off-campus' || stay.start === stay.end) continue;
    const events = locations.get(stay.location) ?? { starts: [], ends: [] };
    events.starts.push(stay.start); events.ends.push(stay.end);
    locations.set(stay.location, events);
  }
  for (const intervals of agents.values()) {
    intervals.sort((a, b) => a.start - b.start);
    let end = -Infinity;
    for (const interval of intervals) {
      if (interval.start === interval.end) continue;
      if (interval.start < end) return null;
      end = interval.end;
    }
  }
  for (const events of locations.values()) {
    events.starts.sort((a, b) => a - b); events.ends.sort((a, b) => a - b);
  }
  return {
    countsAt(time) {
      const counts = new Map<string, number>();
      if (!Number.isFinite(time)) return counts;
      for (const [location, events] of locations) {
        const count = through(events.starts, time) - through(events.ends, time);
        if (count) counts.set(location, count);
      }
      return counts;
    },
  };
}
