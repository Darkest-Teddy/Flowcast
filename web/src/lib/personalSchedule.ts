import type { PersonalSchedule } from '@map/personalSchedule';
import type { ScheduleItem } from '../data/types';

export function buildPersonalSchedule(schedule: ScheduleItem[], at = new Date()): PersonalSchedule {
  const start = at.getTime() - 86_400_000;
  const end = at.getTime() + 14 * 86_400_000;
  const items = schedule.filter(item => {
    const from = Date.parse(item.start), to = Date.parse(item.end);
    return Number.isFinite(from) && Number.isFinite(to) && to > from && from < end && to > start;
  }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return {
    asOf: at.toISOString(), windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(),
    truncated: items.length > 100,
    items: items.slice(0, 100).map(item => ({
      title: item.title.slice(0, 160), start: new Date(item.start).toISOString(), end: new Date(item.end).toISOString(),
      locationId: item.locationId.slice(0, 160), locationText: (item.locationText ?? '').slice(0, 200),
    })),
  };
}
