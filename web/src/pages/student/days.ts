import { dayKey } from '../../lib/format';

export interface DayGroup<T> {
  key: string;
  start: string; // ISO of the first item, for the day label
  items: T[];
}

/** Sort by start time and group into local calendar days. */
export function groupByDay<T>(items: T[], startOf: (item: T) => string): DayGroup<T>[] {
  const sorted = [...items].sort((a, b) => Date.parse(startOf(a)) - Date.parse(startOf(b)));
  const groups: DayGroup<T>[] = [];
  for (const item of sorted) {
    const key = dayKey(startOf(item));
    let group = groups[groups.length - 1];
    if (!group || group.key !== key) {
      group = { key, start: startOf(item), items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

/** True when the timestamp is today or later. */
export function isUpcoming(isoString: string, now = new Date()): boolean {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return Date.parse(isoString) >= start.getTime();
}
