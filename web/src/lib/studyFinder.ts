import type { CampusGeo, CampusLocation, HourlyForecast, ScheduleItem } from '../data/types';
import type { StudyAmenity, StudySpot } from '../data/studySpots';

export interface StudyHours {
  date: string | null;
  weekday?: number;
  validFrom?: string;
  validTo?: string;
  windows: [number, number][];
  sourceUrl: string;
  qualifier: string | null;
}
export type StudyHoursByLocation = Record<string, { hours: StudyHours[]; hoursStatus?: string }>;
const clockFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
function clock(at: number) {
  const parts = clockFormatter.formatToParts(at);
  const get = (key: string) => parts.find(p => p.type === key)!.value;
  const day = `${get('year')}-${get('month')}-${get('day')}`;
  return { day, weekday: (new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7, seconds: +get('hour') * 3600 + +get('minute') * 60 + +get('second') };
}
/** Published entries for a Boston date: dated ones win, else weekly ones valid that date (weekday 0 = Monday). */
export function entriesFor(hours: StudyHours[], day: string, weekday: number) {
  const exact = hours.filter(h => h.date === day);
  return exact.length ? exact : hours.filter(h => h.date === null && h.weekday === weekday && (!h.validFrom || day >= h.validFrom) && (!h.validTo || day <= h.validTo));
}
/** Only published dates/valid weekly hours count; no carried-forward estimates. */
export function studyOpenAt(source: StudyHoursByLocation[string] | undefined, at: number): boolean | null {
  if (!source || source.hoursStatus === 'restricted') return null;
  const { day, weekday, seconds } = clock(at);
  const today = entriesFor(source.hours, day, weekday);
  const previousDay = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
  const previous = entriesFor(source.hours, previousDay, (weekday + 6) % 7);
  const contains = (h: StudyHours, sec: number) => h.windows.some(([start, end]) => sec >= start && sec < end);
  if (today.some(h => contains(h, seconds)) || previous.some(h => contains(h, seconds + 86400))) return true;
  return today.length ? false : null;
}
export function studyWalkMinutes(geo: CampusGeo, locations: CampusLocation[], from: string, to: string): number | null {
  if (![from, to].every(id => locations.some(l => l.id === id))) return null;
  if (from === to) return 0;
  const meters = geo.walkMeters[[from, to].sort().join('>')];
  return Number.isFinite(meters) && meters >= 0 ? Math.ceil(meters / 84) : null;
}
export interface StudyFinderInput {
  spots: StudySpot[];
  locations: CampusLocation[];
  geo: CampusGeo;
  hours: StudyHoursByLocation;
  forecasts: HourlyForecast[];
  schedule: ScheduleItem[];
  scheduleKnown: boolean;
  now: number;
  from: string;
  minutes: number;
  amenities: StudyAmenity[];
  openOnly: boolean;
  lateOnly: boolean;
  fitsOnly: boolean;
  maxWalk: number | null;
  sort: 'time' | 'walk' | 'crowd';
}
export function findStudySpots(input: StudyFinderInput) {
  const { now, from, geo, locations, hours } = input;
  const duration = Math.max(15, Math.min(180, Number.isFinite(input.minutes) ? input.minutes : 60));
  const schedule = input.schedule.filter(s => Number.isFinite(Date.parse(s.start)) && Date.parse(s.end) > Date.parse(s.start));
  const active = schedule.some(s => Date.parse(s.start) <= now && Date.parse(s.end) > now);
  const scheduledNext = schedule.filter(s => Date.parse(s.start) > now).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
  const results = input.spots.filter(spot => input.amenities.every(a => spot.amenities[a] === true)).map(spot => {
    const walk = studyWalkMinutes(geo, locations, from, spot.locationId);
    const arrival = now + (walk ?? 0) * 60000;
    const next = scheduledNext && (clock(Date.parse(scheduledNext.start)).day === clock(arrival).day
      || Date.parse(scheduledNext.start) <= arrival + (duration + 5) * 60000) ? scheduledNext : undefined;
    const source = hours[spot.locationId];
    const open = studyOpenAt(source, arrival);
    const local = clock(now);
    // 22:00 on today's Boston calendar date, keeping DST changes out of duration arithmetic.
    let lateAt = now + (22 * 3600 - local.seconds) * 1000;
    const lateClock = clock(lateAt);
    lateAt += (22 * 3600 - lateClock.seconds) * 1000;
    const late = studyOpenAt(source, lateAt);
    const onwardWalk = next ? studyWalkMinutes(geo, locations, spot.locationId, next.locationId) : 0;
    let usable: number | null = null;
    let reason = '';
    if (!input.scheduleKnown) reason = 'Schedule unavailable; class conflicts cannot be checked.';
    else if (active) { usable = 0; reason = 'A class is currently in progress.'; }
    else if (walk === null) reason = from ? 'No saved route from your starting building.' : 'Choose a starting building to calculate study time.';
    else if (onwardWalk === null) reason = 'No saved route to your next class.';
    else if (open === null) reason = 'Published hours do not confirm access for this arrival.';
    else {
      const deadline = Math.min(arrival + Math.min(duration, spot.maxSessionMinutes ?? duration) * 60000, next ? Date.parse(next.start) - (onwardWalk + 5) * 60000 : Infinity);
      const available = Math.max(0, Math.floor((deadline - arrival) / 60000));
      usable = 0;
      // Check each occupied minute, including its end, so a closing boundary never adds time.
      while (usable < available && studyOpenAt(source, arrival + usable * 60000) === true && studyOpenAt(source, arrival + (usable + 1) * 60000 - 1) === true) usable++;
      if (!open) reason = 'Closed at your estimated arrival.';
      else if (usable < duration) reason = 'Limited by library hours, room booking limits, or your next class.';
    }
    const arrivalClock = clock(arrival);
    const forecast = input.forecasts.find(f => f.locationId === spot.locationId && f.day === arrivalClock.day);
    const rawShare = forecast?.hours.find(h => h.hour === Math.floor(arrivalClock.seconds / 3600))?.share;
    const crowd = rawShare !== undefined && Number.isFinite(rawShare) && rawShare >= 0 ? rawShare : null;
    return { spot, walk, arrival, onwardWalk, open, late, usable, reason, crowd, next, leaveAt: usable !== null && usable > 0 ? arrival + usable * 60000 : null };
  }).filter(r => (!input.openOnly || (r.walk !== null && r.open === true)) && (!input.lateOnly || r.late === true)
    && (!input.fitsOnly || (r.usable !== null && r.usable >= duration))
    && (input.maxWalk === null || (r.walk !== null && r.walk <= input.maxWalk)));
  return results.sort((a, b) => {
    const rank = input.sort === 'time' ? (b.usable ?? -1) - (a.usable ?? -1)
      : input.sort === 'walk' ? (a.walk ?? Infinity) - (b.walk ?? Infinity)
      : (a.crowd ?? Infinity) - (b.crowd ?? Infinity);
    return (Number.isNaN(rank) ? 0 : rank) || a.spot.name.localeCompare(b.spot.name);
  });
}
