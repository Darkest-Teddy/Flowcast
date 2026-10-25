// Ask the map: which library is least crowded, how far apart two places or classes are, where a
// course meets next, and when a place gets busy. Pure: the panel passes in the simulation's
// occupancy, the bundled walking routes and the published class meetings.
//
// Crowding is the simulation's modeled count over the place's stated capacity, not a measurement.
// Walks follow the bundled OSM pedestrian routes at the model's 1.4 m/s; a pair with no route gets
// the straight line stretched by a stated detour factor, marked as an estimate.
//
// The map holds no one's personal schedule (it is also the shared display), so "my next class"
// is answered with a pointer to the course form or the student's own home page.

import type { CampusLocation, LocationKind, Occupancy, WalkRoute } from './sim/playback';
import { dateForWeekday, openingHoursForDate, type CampusData, type OpeningHours, type SourceMeeting } from './data/campusData';
import { effectiveMeetingIntervals } from './data/academicCalendar';

export const ASK_ASSUMPTIONS = {
  /** m/s, the same default the simulated students walk at (sim/sourceDay.ts). */
  walkSpeedMps: 1.4,
  /** Street distance over straight-line distance when no bundled route exists. */
  detourFactor: 1.3,
} as const;

const WEEK = 7 * 86400;

export interface Walk {
  meters: number;
  minutes: number;
  path: [number, number][];
  basis: 'route' | 'estimate';
}

export interface PlaceRef {
  locationId: string;
  label: string; // "Mugar Library", or "CAS CS 132 (CDS 364)" for a class
}

export interface CourseMeeting {
  locationId: string;
  courseCode: string;
  title: string;
  section: string;
  roomCode: string;
  /** Seconds from Monday 00:00 of the reference week. */
  startSec: number;
  endSec: number;
}

export interface RankedPlace {
  location: CampusLocation;
  count: number;
  /** Count over capacity, or null when this place's capacity can't be compared (see `comparable`). */
  share: number | null;
  /** False when the simulation doesn't model activity here on the shown day (the tags say "Not modeled"). */
  modeled: boolean;
  walk: Walk | null;
  /**
   * Published opening state at the ranked time (see openAt): null when hours aren't published,
   * undefined when the context carries no campus data.
   */
  open?: boolean | null;
}

export type MapInsight =
  | { kind: 'leastCrowded'; placeKind: LocationKind; time: number; ranked: RankedPlace[]; from: PlaceRef | null }
  | { kind: 'distance'; from: PlaceRef; to: PlaceRef; walk: Walk }
  | { kind: 'course'; courseCode: string; title: string; next: CourseMeeting; buildings: { locationId: string; sections: string[] }[] }
  | { kind: 'busy'; location: CampusLocation; modeled: boolean; now: number | null; quiet: { time: number; share: number } | null; busy: { time: number; share: number } | null; time: number; openNow?: OpenState; afterMidnight?: boolean }
  | { kind: 'personal' }
  | { kind: 'needTwoPlaces' }
  | { kind: 'noCourse'; code: string }
  | { kind: 'unknown' };

export interface AskContext {
  locations: CampusLocation[];
  walkRoutes: Record<string, WalkRoute>;
  /**
   * Published meetings by map location id. `meeting.intervals` are used as given, so pass the
   * intervals that apply in the simulated reference week (effectiveMeetingIntervals in
   * data/academicCalendar.ts, which applies validFrom/validTo and the academic calendar) to
   * match the simulation: build this list with askMeetings below, as the map and the Ask server do.
   */
  meetings: { locationId: string; meeting: SourceMeeting }[];
  occupancyAt: (time: number) => Occupancy[];
  /** Shown simulation time, seconds since midnight, and weekday (0 = Monday). */
  time: number;
  weekday: number;
  /** Campus in view; rankings stay on it. */
  campus: string;
  /**
   * The campus bundle, for published opening hours (openAt). Without it rankings and outlooks
   * ignore hours, as before.
   */
  data?: CampusData;
}

// ---------------------------------------------------------------- opening hours

export interface OpenState {
  /** True inside a published window, false when published hours exclude the time, null when unknown. */
  open: boolean | null;
  reason?: string;
  hoursText?: string;
  qualifier?: string | null;
  /** Reference-week date of the weekday asked about. */
  date: string;
  /** Open only through the previous date's window running past midnight. */
  fromPreviousDay?: boolean;
}

const inWindow = (windows: [number, number][], t: number) => windows.some(([s, e]) => s <= t && t < e);
const hoursText = (entries: OpeningHours[]) => entries.map((e) => e.text).join(' / ');
const qualifierOf = (entries: OpeningHours[]) => entries.find((e) => e.qualifier)?.qualifier ?? null;

/**
 * Whether a place is open at `timeSec` on a reference-week weekday (0 = Monday), from published
 * hours only. A window can run past midnight (Mugar 07:00–26:00), so the previous date's windows
 * cover the small hours. False only when hours are published for that date and none contains the
 * time (an exact-date closure counts) or when access is restricted; null when hours aren't
 * published for the date or the place has no published hours (classrooms, dorms).
 */
export function openAt(locationId: string, weekday: number, timeSec: number, data: CampusData): OpenState {
  const date = dateForWeekday(data, weekday);
  const source = data.locations[locationId];
  if (source?.hoursStatus === 'restricted') return { open: false, reason: source.hoursReason ?? 'Access is restricted.', date };
  if (!source || source.hoursStatus !== 'published') return { open: null, reason: 'Opening hours are not published for this place.', date };
  const prevWeekday = (weekday + 6) % 7;
  const previous = openingHoursForDate(source.hours, dateForWeekday(data, weekday - 1), prevWeekday)
    .filter((e) => e.windows.some(([, end]) => end > 86400));
  if (previous.some((e) => inWindow(e.windows, timeSec + 86400))) {
    return { open: true, hoursText: hoursText(previous), qualifier: qualifierOf(previous), date, fromPreviousDay: true };
  }
  const today = openingHoursForDate(source.hours, date, weekday);
  if (!today.length) return { open: null, reason: `Opening hours are not published for ${date}.`, date };
  const open = today.some((e) => inWindow(e.windows, timeSec));
  return { open, hoursText: hoursText(today), qualifier: qualifierOf(today), date };
}

/**
 * Published meetings by map location, with each meeting's intervals replaced by the ones that apply
 * in the simulated reference week (validFrom/validTo and the academic calendar), the same intervals
 * the simulation schedules. A meeting with none is left out.
 */
export function askMeetings(data: CampusData): { locationId: string; meeting: SourceMeeting }[] {
  return Object.entries(data.locations).flatMap(([locationId, l]) =>
    l.meetings.flatMap((meeting) => {
      const intervals = effectiveMeetingIntervals(meeting, data);
      return intervals.length ? [{ locationId, meeting: { ...meeting, intervals } }] : [];
    }),
  );
}

// ---------------------------------------------------------------- walking

export function haversineMeters([lng1, lat1]: [number, number], [lng2, lat2]: [number, number]): number {
  const rad = Math.PI / 180;
  const h = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

export function walkBetween(from: CampusLocation, to: CampusLocation, routes: Record<string, WalkRoute>, a = ASK_ASSUMPTIONS): Walk {
  const minutes = (m: number) => (m === 0 ? 0 : Math.max(1, Math.round(m / a.walkSpeedMps / 60)));
  if (from.id === to.id) return { meters: 0, minutes: 0, path: [from.position], basis: 'route' };
  const forward = routes[`${from.id}>${to.id}`];
  const back = routes[`${to.id}>${from.id}`];
  const route = forward ?? back;
  if (route) {
    const meters = Math.round(route.cumulative[route.cumulative.length - 1]);
    return { meters, minutes: minutes(meters), path: forward ? route.path : [...route.path].reverse(), basis: 'route' };
  }
  const meters = Math.round(haversineMeters(from.position, to.position) * a.detourFactor);
  return { meters, minutes: minutes(meters), path: [from.position, to.position], basis: 'estimate' };
}

// ---------------------------------------------------------------- crowding

/** Places whose percentage the map shows; the same rule as the building tags (BuildingTags.activityDisplay). */
export function comparable(location: CampusLocation, modeled: boolean | undefined): boolean {
  return modeled !== false && location.activityModeled !== false && location.capacity > 0
    && location.capacityBasis !== 'residential_beds_plus_classroom_seats'
    && location.capacityBasis !== 'estimated_student_capacity';
}

/**
 * Ranking tier: 0 open with a comparable percentage, 1 open with a headcount only, 2 hours not
 * published, 3 closed, 4 not modeled. Without campus data every modeled place counts as open.
 */
/** Kinds the simulation visits only during published hours (sim/sourceDay.ts venueWindows). */
const VISIT_KINDS = new Set<LocationKind>(['dining', 'library', 'gym']);

export function rankTier(r: RankedPlace): number {
  if (!r.modeled) return 4;
  if (r.open === false) return 3;
  if (r.open === null) return 2;
  return r.share !== null ? 0 : 1;
}

export function rankByCrowd(ctx: AskContext, placeKind: LocationKind | null, time: number, from: CampusLocation | null): RankedPlace[] {
  const occupancy = ctx.occupancyAt(time).filter((o) => (placeKind === null ? o.location.kind !== 'off-campus' : o.location.kind === placeKind) && (o.location.campus ?? 'charles-river') === ctx.campus);
  const data = ctx.data;
  return occupancy
    .map((o): RankedPlace => {
      const open = data ? openAt(o.location.id, ctx.weekday, time, data).open : undefined;
      // The simulation only sends visitors to venues with published hours, so an empty venue
      // whose hours aren't published says nothing about how busy it is: no percent for it.
      const unsampled = open === null && o.count === 0 && VISIT_KINDS.has(o.location.kind);
      return {
        location: o.location,
        count: o.count,
        share: comparable(o.location, o.modeled) && !unsampled ? o.count / o.location.capacity : null,
        modeled: o.modeled !== false && o.location.activityModeled !== false,
        walk: from ? walkBetween(from, o.location, ctx.walkRoutes) : null,
        ...(data ? { open } : {}),
      };
    })
    // Open places with percentages first, then open headcounts, places with unpublished hours
    // (percentages before headcounts), closed places, and last the ones the simulation doesn't model.
    .sort((x, y) => rankTier(x) - rankTier(y) || Number(x.share === null) - Number(y.share === null)
      || (x.share ?? 0) - (y.share ?? 0) || x.count - y.count || (x.walk?.meters ?? 0) - (y.walk?.meters ?? 0));
}

/**
 * Quietest and busiest whole hour from `time` to midnight on the shown day. With campus data the
 * shown time itself is a candidate, hours when the place is closed are skipped, and hours open
 * only through the previous day's window past midnight are skipped and flagged (`afterMidnight`):
 * simulated stays end at midnight, so those hours read empty though the place is open.
 */
export function busyOutlook(ctx: AskContext, location: CampusLocation, time: number) {
  const current = ctx.occupancyAt(time).find((x) => x.location.id === location.id);
  const modeled = current?.modeled !== false && location.activityModeled !== false;
  const shareAt = (t: number) => {
    const o = ctx.occupancyAt(t).find((x) => x.location.id === location.id);
    return o && comparable(o.location, o.modeled) ? o.count / location.capacity : null;
  };
  const data = ctx.data;
  const openNow = data ? openAt(location.id, ctx.weekday, time, data) : undefined;
  const now = shareAt(time);
  let quiet: { time: number; share: number } | null = null;
  let busy: { time: number; share: number } | null = null;
  let afterMidnight = Boolean(openNow?.open && openNow.fromPreviousDay);
  const candidates: number[] = data ? [time] : [];
  for (let t = Math.ceil(time / 3600) * 3600; t < 86400; t += 3600) if (t !== time || !data) candidates.push(t);
  for (const t of candidates) {
    if (data) {
      const state = t === time ? openNow! : openAt(location.id, ctx.weekday, t, data);
      if (state.open === false) continue;
      if (state.open && state.fromPreviousDay) { afterMidnight = true; continue; }
    }
    const share = shareAt(t);
    if (share === null) continue;
    if (!quiet || share < quiet.share) quiet = { time: t, share };
    if (!busy || share > busy.share) busy = { time: t, share };
  }
  return data ? { modeled, now, quiet, busy, openNow, afterMidnight } : { modeled, now, quiet, busy };
}

// ---------------------------------------------------------------- courses

/** School prefixes in the published schedule (campus-data.json). */
const SCHOOLS = new Set(['cas', 'cds', 'cfa', 'cgs', 'com', 'eng', 'gms', 'hub', 'khc', 'law', 'med', 'met', 'qst', 'sar', 'sha', 'sph', 'ssw', 'sth', 'wed']);

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** "CAS CS 132", "cs132", "DS 340" in a question, in order. Returns compact codes ("cascs132" or "cs132"). */
export function courseMentions(query: string): { at: number; len: number; code: string }[] {
  const q = query.toLowerCase();
  const out: { at: number; len: number; code: string }[] = [];
  const re = /\b(?:([a-z]{3})\s*)?([a-z]{2})\s*(\d{3})\b/g;
  for (let m = re.exec(q); m; m = re.exec(q)) {
    // "and ds 340": a three-letter word is a prefix only when it's a BU school code.
    const school = m[1] && SCHOOLS.has(m[1]) ? m[1] : '';
    const at = school || !m[1] ? m.index : m.index + m[0].indexOf(m[2], m[1].length);
    out.push({ at, len: m.index + m[0].length - at, code: `${school}${m[2]}${m[3]}` });
  }
  return out;
}

/** Every published meeting of a course, matched with or without the school prefix. */
export function meetingsFor(code: string, ctx: AskContext): CourseMeeting[] {
  const out: CourseMeeting[] = [];
  for (const { locationId, meeting } of ctx.meetings) {
    if (meeting.calendarRestricted) continue;
    const full = compact(meeting.courseCode);
    if (full !== code && !(code.length < full.length && full.endsWith(code) && full.length - code.length === 3)) continue;
    for (const iv of meeting.intervals) {
      out.push({ locationId, courseCode: meeting.courseCode, title: meeting.title, section: meeting.section, roomCode: meeting.roomCode, startSec: iv.startSec, endSec: iv.endSec });
    }
  }
  return out;
}

/**
 * Meetings matching a code, grouped by full course code, the course with the most sections first.
 * A code without a school prefix can name several courses ("BI 515": CAS BI 515 and WED BI 515),
 * whose sections must not be mixed.
 */
export function coursesFor(code: string, ctx: AskContext): { courseCode: string; meetings: CourseMeeting[] }[] {
  const groups = new Map<string, CourseMeeting[]>();
  for (const m of meetingsFor(code, ctx)) groups.set(m.courseCode, [...(groups.get(m.courseCode) ?? []), m]);
  const sections = (ms: CourseMeeting[]) => new Set(ms.map((m) => m.section)).size;
  return [...groups]
    .map(([courseCode, meetings]) => ({ courseCode, meetings }))
    .sort((x, y) => sections(y.meetings) - sections(x.meetings) || y.meetings.length - x.meetings.length || x.courseCode.localeCompare(y.courseCode));
}

/** The meeting that starts soonest at or after the shown time, wrapping into next week. */
export function nextMeeting(meetings: CourseMeeting[], weekday: number, time: number): CourseMeeting | null {
  const now = weekday * 86400 + time;
  let best: CourseMeeting | null = null;
  let bestWait = Infinity;
  for (const m of meetings) {
    const wait = (((m.startSec - now) % WEEK) + WEEK) % WEEK;
    if (wait < bestWait) { best = m; bestWait = wait; }
  }
  return best;
}

// ---------------------------------------------------------------- places and times

const words = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/** Map places named in the question, in order; the longer name wins where names overlap. */
export function placeMentions(query: string, locations: CampusLocation[]): { at: number; len: number; location: CampusLocation }[] {
  const q = words(query);
  const hits: { at: number; len: number; location: CampusLocation }[] = [];
  for (const l of locations) {
    const needles = new Set([l.name, l.short, l.id, l.name.replace(/\s*\(.*\)$/, '')].map(words));
    for (const n of needles) {
      if (n.trim().length < 3) continue;
      for (let at = q.indexOf(n); at !== -1; at = q.indexOf(n, at + 1)) hits.push({ at, len: n.length, location: l });
    }
  }
  hits.sort((x, y) => x.at - y.at || y.len - x.len);
  const picked: typeof hits = [];
  for (const h of hits) {
    const last = picked[picked.length - 1];
    if (last && h.at < last.at + last.len - 1) { if (h.len > last.len) picked[picked.length - 1] = h; continue; }
    picked.push(h);
  }
  return picked;
}

/** "at 3pm", "3:30 pm", "noon", "tonight": seconds since midnight. Null when no time is named. */
export function parseTime(query: string): number | null {
  const q = query.toLowerCase();
  const m = q.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/);
  if (m) return ((Number(m[1]) % 12) + (m[3] === 'pm' ? 12 : 0)) * 3600 + Number(m[2] ?? 0) * 60;
  const m24 = q.match(/\bat (\d{1,2}):(\d{2})\b/);
  if (m24) return Number(m24[1]) * 3600 + Number(m24[2]) * 60;
  if (/\bnoon\b/.test(q)) return 12 * 3600;
  if (/\btonight\b|\bthis evening\b/.test(q)) return 20 * 3600;
  if (/\bthis afternoon\b/.test(q)) return 14 * 3600;
  if (/\bthis morning\b/.test(q)) return 9 * 3600;
  return null;
}

const KIND_WORDS: [RegExp, LocationKind][] = [
  [/\b(librar(y|ies)|study|studying)\b/, 'library'],
  [/\b(dining|food|eat|eating|lunch|dinner|breakfast|meal)\b/, 'dining'],
  [/\b(gyms?|workout|work out|lift|fitness)\b/, 'gym'],
  [/\b(dorms?|residence halls?)\b/, 'dorm'],
  [/\b(classrooms?|academic buildings?)\b/, 'classroom'],
];

// ---------------------------------------------------------------- the question

export function ask(query: string, ctx: AskContext): MapInsight {
  const q = ` ${query.toLowerCase()} `;
  const time = parseTime(query) ?? ctx.time;

  if (/\bmy (next )?(class|classes|schedule|lecture)\b/.test(q)) return { kind: 'personal' };

  // Mentions of places and courses, in reading order. A course resolves to its next meeting's building.
  const courses = courseMentions(query);
  const places = placeMentions(query, ctx.locations).filter((p) => !courses.some((c) => p.at < c.at + c.len && c.at < p.at + p.len));
  const byId = new Map(ctx.locations.map((l) => [l.id, l]));
  const refs: { at: number; ref: PlaceRef; location: CampusLocation }[] = places.map((p) => ({ at: p.at, ref: { locationId: p.location.id, label: p.location.short }, location: p.location }));
  for (const c of courses) {
    // An unprefixed code that names several courses resolves to the most common one.
    const next = nextMeeting(coursesFor(c.code, ctx)[0]?.meetings ?? [], ctx.weekday, ctx.time);
    if (!next) return { kind: 'noCourse', code: query.slice(c.at, c.at + c.len).trim().toUpperCase() };
    const location = byId.get(next.locationId);
    if (location) refs.push({ at: c.at, ref: { locationId: location.id, label: `${next.courseCode} (${location.short} ${next.roomCode})` }, location });
  }
  refs.sort((x, y) => x.at - y.at);

  const asksDistance = /\bhow far\b|\bdistance\b|\bhow long\b.*\bwalk\b|\bwalk(ing)?\b.*\b(to|from|between)\b|\bfar apart\b|\bminutes? (from|to|between)\b|\bget (from|to)\b/.test(q);
  if (asksDistance) {
    if (refs.length < 2) return { kind: 'needTwoPlaces' };
    const [a, b] = refs;
    return { kind: 'distance', from: a.ref, to: b.ref, walk: walkBetween(a.location, b.location, ctx.walkRoutes) };
  }

  const placeKind = KIND_WORDS.find(([re]) => re.test(q))?.[1];
  const asksQuietest = /\b(least|less) (crowded|busy|full|packed)\b|\bquiet(est|er)?\b|\bemptiest\b|\bfewest people\b|\bnot (crowded|busy)\b|\bfree(st)? (seats?|space)\b|\bbest\b|\bwhere (can|should) i\b/.test(q);

  if (courses.length && /\bwhere\b|\bwhen\b|\bnext\b|\bmeet/.test(q) || (courses.length && !places.length && !placeKind)) {
    const code = courses[0].code;
    const all = coursesFor(code, ctx)[0].meetings;
    const next = nextMeeting(all, ctx.weekday, ctx.time)!;
    const grouped = new Map<string, Set<string>>();
    for (const m of all) grouped.set(m.locationId, (grouped.get(m.locationId) ?? new Set()).add(m.section));
    const buildings = [...grouped].map(([locationId, s]) => ({ locationId, sections: [...s].sort() })).sort((x, y) => y.sections.length - x.sections.length);
    return { kind: 'course', courseCode: next.courseCode, title: next.title, next, buildings };
  }

  // "When is Mugar Library quiet" names a library, so it asks about that one, not all of them.
  if (placeKind && (asksQuietest || !refs.length) && !refs.some((r) => r.location.kind === placeKind)) {
    // "quietest library near CAS": walks from the named place.
    const from = refs[0] ?? null;
    return { kind: 'leastCrowded', placeKind, time, ranked: rankByCrowd(ctx, placeKind, time, from?.location ?? null), from: from?.ref ?? null };
  }

  if (refs.length) {
    const location = refs[0].location;
    return { kind: 'busy', location, time, ...busyOutlook(ctx, location, time) };
  }
  return { kind: 'unknown' };
}
