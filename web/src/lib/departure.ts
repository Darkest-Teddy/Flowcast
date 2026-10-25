import type { CampusGeo, CampusLocation, ScheduleItem } from '../data/types';

export const BOSTON_TIME_ZONE = 'America/New_York';
export function bostonDay(value: string | number | Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: BOSTON_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}
export function bostonTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: BOSTON_TIME_ZONE, hour: 'numeric', minute: '2-digit' }).format(new Date(value));
}
export function bostonDateTime(value: string | number | Date): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: BOSTON_TIME_ZONE, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(new Date(value));
}
export function bostonDayLabel(value: string | number | Date, now: number): string {
  return bostonDay(value) === bostonDay(now) ? 'Today · Boston time' : new Intl.DateTimeFormat('en-US', { timeZone: BOSTON_TIME_ZONE, weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

export interface DepartureInput {
  items: ScheduleItem[];
  locations: Pick<CampusLocation, 'id'>[];
  geo: CampusGeo;
  now: number;
  homeLocationId: string | null;
  /** Omit for the schedule/home default; an empty string explicitly requests no origin. */
  fromLocationId?: string;
  bufferMinutes?: number;
}

export function getDeparturePlan({ items, locations, geo, now, homeLocationId, fromLocationId, bufferMinutes = 5 }: DepartureInput) {
  const buffer = Number.isFinite(bufferMinutes) ? Math.max(0, bufferMinutes) : 5;
  const sorted = items.filter((item) => Number.isFinite(Date.parse(item.start)) && Date.parse(item.end) > Date.parse(item.start))
    .slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  const active = sorted.filter((item) => Date.parse(item.start) <= now && Date.parse(item.end) > now);
  const current = active[0] ?? null;
  const next = sorted.find((item) => Date.parse(item.start) > now) ?? null;
  const target = next ?? current;
  const known = (id: string | null | undefined): id is string => !!id && locations.some((location) => location.id === id);
  const walk = (from: string, to: string): number | null => {
    if (!known(from) || !known(to)) return null;
    if (from === to) return 0;
    const meters = geo.walkMeters[[from, to].sort().join('>')];
    return Number.isFinite(meters) && meters >= 0 ? Math.ceil(meters / (1.4 * 60)) : null;
  };
  const sameDay = target ? sorted.filter((item) => item.id !== target.id && bostonDay(item.start) === bostonDay(target.start) && Date.parse(item.start) <= Date.parse(target.start)) : [];
  const previous = sameDay.reduce<ScheduleItem | null>((latest, item) => !latest || Date.parse(item.end) > Date.parse(latest.end) ? item : latest, null);
  const originClass = target && bostonDay(target.start) === bostonDay(now)
    ? active.find((item) => item.id !== target.id) ?? sameDay.filter((item) => Date.parse(item.start) <= now).at(-1) : undefined;
  let originSource: 'selected' | 'schedule' | 'home' | 'unknown' = 'unknown';
  let from: string | null = null;
  if (fromLocationId !== undefined) {
    from = known(fromLocationId) ? fromLocationId : null;
    originSource = from ? 'selected' : 'unknown';
  } else if (active.length > 1 && target && bostonDay(target.start) === bostonDay(now)) {
    originSource = 'unknown';
  } else if (originClass) {
    from = known(originClass.locationId) ? originClass.locationId : null;
    originSource = from ? 'schedule' : 'unknown';
  } else if (known(homeLocationId)) {
    from = homeLocationId;
    originSource = 'home';
  }
  const walkMinutes = target && from ? walk(from, target.locationId) : null;
  const routeStatus = !target ? 'no-class' : !from ? 'choose-origin' : !known(target.locationId) ? 'unmapped-destination' : walkMinutes === null ? 'no-route' : 'ready';
  const arrivalTarget = target ? Date.parse(target.start) - buffer * 60_000 : null;
  const leaveBy = routeStatus === 'ready' && arrivalTarget !== null && walkMinutes !== null ? arrivalTarget - walkMinutes * 60_000 : null;
  const lateMinutes = leaveBy === null ? null : Math.max(0, Math.ceil((now - leaveBy) / 60_000));
  const transferWalkMinutes = previous && target ? walk(previous.locationId, target.locationId) : null;
  const overlap = !!(previous && target && Date.parse(previous.end) > Date.parse(target.start));
  const connectionShortfallMinutes = previous && arrivalTarget !== null && transferWalkMinutes !== null
    ? Math.max(0, Math.ceil((Date.parse(previous.end) + transferWalkMinutes * 60_000 - arrivalTarget) / 60_000)) : null;
  return { current, next, target, previous, fromLocationId: from, originSource, bufferMinutes: buffer, routeStatus,
    walkMinutes, arrivalTarget, leaveBy, lateMinutes, overlap, connectionShortfallMinutes, transferWalkMinutes,
    ambiguousCurrent: active.length > 1 };
}
