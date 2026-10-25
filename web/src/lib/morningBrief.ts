// "Today at a glance": the first (or next) class and when to leave for it, the quietest lunch hour
// near the saved lunch time among dining open by published hours, libraries closing earlier than
// they usually do on this weekday, today's campus events, and venue events (Red Sox, Agganis,
// MGM Music Hall...) that crowd Kenmore or the B line. Pure: the Home card renders it.
//
// Honest by construction: hours are published hours only; the lunch pick ranks the model's
// projections (built from real day-to-day data, never a live count); venue crowds are estimates (a
// published box-score attendance when the event has one, else the median published attendance of
// past events of its kind at the venue, else the venue's capacity for the setup as an upper bound),
// and an event whose crowd size isn't known is left out.
import type { CalendarEvent, EventVenue } from '../../../map-client/src/data/eventCalendar';
import type { CampusEvent, CampusGeo, CampusLocation, HourlyForecast, Profile, ScheduleItem } from '../data/types';
import { getDeparturePlan } from './departure';
import { addDays, bostonLocal, bostonWallTime, closingOn, hoursSource, MINUTE, weekdayOf } from './placeHours';
import { studyOpenAt, type StudyHoursByLocation } from './studyFinder';
import type { TransitContext, TransitOption } from './transitDeparture';

/** Lunch hours considered: from an hour before the saved lunch time to two hours after it. */
export const LUNCH_RANGE: [number, number] = [-60, 120];
/** Minutes of an hour that must be free of classes (and open) for it to count as a lunch window. */
export const LUNCH_MIN_MINUTES = 30;
/** A library closing at least this much earlier than usual is called out. */
export const EARLY_CLOSING_MINUTES = 30;
/** Venue events below this many people don't move the T. */
export const CROWD_THRESHOLD = 1500;
/** Past events of the same kind at the venue needed before their median attendance stands in. */
const TYPICAL_MIN_SAMPLES = 3;

/** event-calendar.json: venues, the calendar, and earlier home games with published attendance. */
export interface VenueCalendar { venues: EventVenue[]; events: CalendarEvent[]; referenceEvents?: CalendarEvent[] }

export interface BriefClass {
  item: ScheduleItem;
  label: 'first' | 'next';
  from: string | null;
  walkMinutes: number | null;
  leaveBy: number | null;
  /** A published T/Shuttle trip when it lets you leave later or cuts a long walk. */
  transit: TransitOption | null;
}
export interface LunchWindow { locationId: string; start: number; share: number; lunchTime: string }
export interface EarlyClosing {
  locationId: string;
  /** Epoch ms of today's published closing, or null when published as closed all day. */
  closesAt: number | null;
  /** Epoch ms, on today's date, of the usual closing on this weekday. */
  usualClosesAt: number;
  sourceUrl: string | null;
}
export interface VenueCrowd {
  id: string;
  name: string;
  venue: string;
  start: number;
  end: number | null;
  timeTbd: boolean;
  /** Where the crowd shows up: Kenmore (Fenway venues) or the B line (BU West). */
  area: 'kenmore' | 'b-line';
  stations: string[];
  estimate: number;
  /** This event's box score; the median box score of past events of its kind there; or the venue's capacity (upper bound). */
  estimateBasis: 'published-attendance' | 'typical-attendance' | 'venue-capacity';
  sourceUrl: string | null;
}
export interface MorningBrief {
  day: string;
  classCount: number;
  firstClass: BriefClass | null;
  lunch: LunchWindow | null;
  earlyClosings: EarlyClosing[];
  campusEvents: CampusEvent[];
  venueEvents: VenueCrowd[];
}

export interface BriefInput {
  schedule: ScheduleItem[];
  locations: CampusLocation[];
  geo: CampusGeo;
  hours: StudyHoursByLocation;
  forecasts: HourlyForecast[];
  profile: Pick<Profile, 'lunchTime'> | null;
  homeLocationId: string | null;
  campusEvents: CampusEvent[];
  venues: VenueCalendar | null;
  now: number;
  transit?: TransitContext;
}

const valid = (s: ScheduleItem) => Number.isFinite(Date.parse(s.start)) && Date.parse(s.end) > Date.parse(s.start);
const toMinutes = (hhmm: string | undefined): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm ?? '');
  return match ? +match[1] * 60 + +match[2] : null;
};

/** The brief starts open on the first view of a Boston day and collapsed after that. */
export function briefStartsOpen(seenDay: string | null, today: string): boolean {
  return seenDay !== today;
}

function briefClass(input: BriefInput, todays: ScheduleItem[]): BriefClass | null {
  const { now, locations, geo, homeLocationId, transit } = input;
  const first = todays[0];
  if (!first) return null;
  if (Date.parse(first.start) > now) {
    // Before the first class the student is at home.
    const plan = getDeparturePlan({ items: [first], locations, geo, now, homeLocationId, fromLocationId: homeLocationId ?? '', transit });
    return { item: first, label: 'first', from: plan.fromLocationId, walkMinutes: plan.walkMinutes, leaveBy: plan.leaveBy,
      transit: plan.transit?.status === 'offered' ? plan.transit.option : null };
  }
  const next = todays.find((s) => Date.parse(s.start) > now);
  if (!next) return null;
  const plan = getDeparturePlan({ items: todays, locations, geo, now, homeLocationId, transit });
  if (plan.target?.id !== next.id) return { item: next, label: 'next', from: null, walkMinutes: null, leaveBy: null, transit: null };
  return { item: next, label: 'next', from: plan.fromLocationId, walkMinutes: plan.walkMinutes, leaveBy: plan.leaveBy,
    transit: plan.transit?.status === 'offered' ? plan.transit.option : null };
}

/** The quietest projected hour near the saved lunch time at a dining place open by published hours, outside classes. */
export function bestLunchWindow({ locations, hours, forecasts, todays, lunchTime, day, now }: {
  locations: CampusLocation[]; hours: StudyHoursByLocation; forecasts: HourlyForecast[]; todays: ScheduleItem[]; lunchTime: string; day: string; now: number;
}): LunchWindow | null {
  const lunch = toMinutes(lunchTime) ?? 12 * 60;
  const firstHour = Math.floor((lunch + LUNCH_RANGE[0]) / 60), lastHour = Math.floor((lunch + LUNCH_RANGE[1]) / 60) - 1;
  let best: (LunchWindow & { distance: number }) | null = null;
  for (let hour = Math.max(0, firstHour); hour <= Math.min(23, lastHour); hour++) {
    const start = bostonWallTime(day, hour * 60);
    if (start + 60 * MINUTE <= now) continue;
    // Free minutes this hour: not in a class, and not already past.
    let free = 0;
    for (let m = 0; m < 60; m++) {
      const at = start + m * MINUTE;
      if (at >= now && !todays.some((s) => Date.parse(s.start) <= at && Date.parse(s.end) > at)) free++;
    }
    if (free < LUNCH_MIN_MINUTES) continue;
    for (const location of locations) {
      if (location.kind !== 'dining') continue;
      const source = hours[location.id];
      let open = 0;
      for (let m = 0; m < 60; m += 5) if (studyOpenAt(source, start + m * MINUTE) === true) open += 5;
      if (open < LUNCH_MIN_MINUTES) continue;
      const share = forecasts.find((f) => f.locationId === location.id && f.day === day)?.hours.find((h) => h.hour === hour)?.share;
      if (share === undefined || !Number.isFinite(share) || share < 0) continue;
      const distance = Math.abs(hour * 60 + 30 - lunch);
      if (!best || share < best.share || (share === best.share && (distance < best.distance || (distance === best.distance && location.id < best.locationId)))) {
        best = { locationId: location.id, start, share, lunchTime, distance };
      }
    }
  }
  if (!best) return null;
  const { distance: _distance, ...window } = best;
  return window;
}

/** Libraries whose published closing today is earlier than their usual closing on this weekday. */
export function earlyLibraryClosings({ locations, hours, day }: { locations: CampusLocation[]; hours: StudyHoursByLocation; day: string }): EarlyClosing[] {
  const out: EarlyClosing[] = [];
  for (const location of locations) {
    if (location.kind !== 'library') continue;
    const source = hours[location.id];
    const today = closingOn(source, day);
    if (today === null) continue;
    // The same weekday in the three weeks either side, by published hours only.
    const samples = new Map<number, number>();
    for (let week = -3; week <= 3; week++) {
      if (!week) continue;
      const other = closingOn(source, addDays(day, week * 7));
      if (typeof other === 'number') samples.set(other, (samples.get(other) ?? 0) + 1);
    }
    if (!samples.size) continue;
    const usual = [...samples].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
    if (today !== 'closed' && usual - today < EARLY_CLOSING_MINUTES * 60) continue;
    out.push({ locationId: location.id, closesAt: today === 'closed' ? null : bostonWallTime(day, today / 60),
      usualClosesAt: bostonWallTime(day, usual / 60), sourceUrl: hoursSource(source) });
  }
  return out.sort((a, b) => (a.closesAt ?? 0) - (b.closesAt ?? 0) || a.locationId.localeCompare(b.locationId));
}

const KENMORE = ['Kenmore', 'Fenway'];
const B_LINE = ['Babcock Street', 'Amory Street', 'Boston University Central', 'Boston University East', 'Blandford Street', 'Saint Paul Street'];

/** Today's venue events big enough to crowd Kenmore or the B line, with their estimated crowd. */
export function venueCrowdsToday(calendar: VenueCalendar | null, day: string): VenueCrowd[] {
  if (!calendar) return [];
  const venues = new Map(calendar.venues.map((v) => [v.id, v]));
  const attendance = (e: CalendarEvent) => typeof e.attendance === 'number' && e.attendance > 0 ? e.attendance : null;
  // Published box-score attendance of past events, by venue and kind.
  const past = new Map<string, number[]>();
  for (const e of [...calendar.events, ...(calendar.referenceEvents ?? [])]) {
    const value = attendance(e);
    if (value === null) continue;
    const key = `${e.venueId}|${e.kind}`;
    past.set(key, [...(past.get(key) ?? []), value]);
  }
  const typical = (e: CalendarEvent) => {
    const values = (past.get(`${e.venueId}|${e.kind}`) ?? []).slice().sort((a, b) => a - b);
    return values.length >= TYPICAL_MIN_SAMPLES ? values[Math.floor(values.length / 2)] : null;
  };
  const out: VenueCrowd[] = [];
  for (const event of calendar.events) {
    const start = Date.parse(event.start);
    const venue = venues.get(event.venueId);
    if (!venue || !Number.isFinite(start) || bostonLocal(start).day !== day) continue;
    const stations = venue.nearestStations ?? [];
    const area = stations.some((s) => KENMORE.includes(s)) ? 'kenmore' : stations.some((s) => B_LINE.includes(s)) ? 'b-line' : null;
    if (!area) continue;
    // A null setup is a small room in the venue (e.g. the Student Theater at Agganis), not the bowl.
    const capacity = event.setup ? venue.capacities[event.setup] : null;
    if (!event.setup) continue;
    const published = attendance(event), usual = published === null ? typical(event) : null;
    const estimate = published ?? usual ?? (typeof capacity === 'number' && capacity > 0 ? capacity : null);
    if (estimate === null || estimate < CROWD_THRESHOLD) continue;
    const end = event.end ? Date.parse(event.end) : NaN;
    out.push({ id: event.id, name: event.name, venue: venue.name, start, end: Number.isFinite(end) ? end : null, timeTbd: !!event.timeTbd,
      area, stations, estimate, estimateBasis: published !== null ? 'published-attendance' : usual !== null ? 'typical-attendance' : 'venue-capacity', sourceUrl: event.sourceUrl || null });
  }
  return out.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function composeBrief(input: BriefInput): MorningBrief {
  const { now } = input;
  const day = bostonLocal(now).day;
  const todays = input.schedule.filter((s) => valid(s) && bostonLocal(Date.parse(s.start)).day === day)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  const campusEvents = input.campusEvents
    .filter((e) => Number.isFinite(Date.parse(e.start)) && bostonLocal(Date.parse(e.start)).day === day && Date.parse(e.end ?? e.start) >= now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start) || a.id.localeCompare(b.id));
  return {
    day,
    classCount: todays.length,
    firstClass: briefClass(input, todays),
    lunch: bestLunchWindow({ locations: input.locations, hours: input.hours, forecasts: input.forecasts, todays, lunchTime: input.profile?.lunchTime ?? '12:00', day, now }),
    earlyClosings: earlyLibraryClosings({ locations: input.locations, hours: input.hours, day }),
    campusEvents,
    venueEvents: venueCrowdsToday(input.venues, day),
  };
}

/** "Saturday" for a Boston date, for "usually closes 2 AM on Saturdays". */
export const weekdayName = (day: string) => ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][weekdayOf(day)];
