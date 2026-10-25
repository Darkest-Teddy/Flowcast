// Event slot and room finder for club officers and event planners: which room with enough seats,
// and which evening of the reference week, avoids published classes, listed events in that room,
// big venue events nearby (games, concerts) and peak modeled crowding nearby, with parking close by.
// Used by the Ask tool event_slots (tools.ts) and GET /api/dashboard/event-slots (the web's "Plan
// an event").
//
// What each input is: room seats and class times are the published class schedule; listed events
// are Terrier Central events the event-impact build placed in a room; venue events are published
// schedules (event-calendar.json); crowding is the event-impact build's modeled hourly head count
// over stated capacity; parking is lot capacity (published, OpenStreetMap tag or estimate), never
// how full a lot is. A room with no class may still be in use or locked, and nothing is booked.

import { comparable } from '../../map-client/src/insights';
import { hourlyCounts, weekFrom, type WeekDay } from '../../map-client/src/bestTimes';
import { formatClock, type CampusLocation } from '../../map-client/src/sim/playback';
import type { SourceMeeting } from '../../map-client/src/data/campusData';
import type { EventImpact, ParkingLot, VenueCalendar } from './chatData';

/** Straight-line metres between places within this of a room's building count as "nearby" for crowding. */
export const CROWD_RADIUS_M = 300;
/** A venue event this close to the building conflicts with a slot. */
export const VENUE_RADIUS_M = 1000;
/** Venue crowds arrive and leave around the event: this much before its start and after its end. */
export const VENUE_BUFFER_SEC = 3600;
/** A venue event with no published end is taken to last this long. */
export const VENUE_DEFAULT_SEC = 3 * 3600;
/** Parking lots within this many metres (straight line) of the building. */
export const PARKING_RADIUS_M = 800;
const STEP_SEC = 1800;
const KINDS_FOR_CROWD = new Set(['classroom', 'library', 'dining', 'gym']);

export interface SlotSources {
  locations: CampusLocation[];
  meetings: { locationId: string; meeting: SourceMeeting }[];
  referenceWeekStart: string;
  impact: EventImpact | null;
  venues: VenueCalendar | null;
  parking: ParkingLot[];
  /** Walking minutes between two places (saved routes, or a straight-line estimate), or null when unknown. */
  walkMinutes?: (fromId: string, toId: string) => number | null;
}

export interface SlotQuery {
  headcount: number;
  /** Reference-week weekdays (0 = Monday), or null for every day. */
  days: number[] | null;
  /** Window the event must fit in, seconds since midnight. */
  fromSec: number;
  toSec: number;
  durationMin: number;
  /** Campus id, or null for every campus. */
  campus: string | null;
  limit: number;
  /** At most this many slots on one day (default 2), so the list spans several evenings. */
  maxPerDay?: number;
  /** Places the attendees come from (dorms, class buildings): rooms are then ranked by their average walk. */
  near?: string[];
}

export interface Slot extends WeekDay {
  start: string;
  end: string;
  startSec: number;
  endSec: number;
  locationId: string;
  building: string;
  campus: string;
  room: string;
  seats: number;
  /** Highest modeled crowding (mean over the slot) among comparable places nearby; null when none is modeled. */
  nearbyCrowd: { percent: number; place: string } | null;
  /** Parking lots within PARKING_RADIUS_M: summed stated spaces (capacity, not availability). */
  parking: { spaces: number; lots: number; nearest: { name: string; metres: number } | null };
  /** Venue events the same day near the building that don't overlap the slot. */
  venueEventsSameDay: string[];
  /** Walking minutes from the attendees' places (query.near): average and longest; null without near. */
  walk: { average: number; longest: number; from: string } | null;
}

export interface SlotResult {
  headcount: number;
  days: WeekDay[];
  window: { from: string; to: string };
  durationMin: number;
  campus: string | null;
  slots: Slot[];
  counts: {
    /** Rooms with published classes on the campus. */
    rooms: number;
    /** Rooms whose published seats reach the headcount. */
    roomsWithSeats: number;
    /** Room × start-time combinations checked. */
    checked: number;
    withClass: number;
    withListedEvent: number;
    nearVenueEvent: number;
    /** Free of all three. */
    free: number;
  };
  /** Venue events that ruled slots out, for saying why an evening is missing. */
  venueConflicts: { name: string; venue: string; date: string; start: string }[];
  /** Largest published room on the campus, when no room reaches the headcount. */
  largestRoom: { building: string; room: string; seats: number } | null;
  /** The attendees' places that were understood (query.near), by name. */
  near: string[];
}

export const SLOT_CAVEAT = 'Free means no published class and no listed event in the room at that time. Other uses (exams, office hours, private bookings) and building access are unknown, so a room may still be in use or locked. Nothing is booked or held: reserve it through BU’s room booking.';
export const SLOT_METHOD = 'Seats and class times are the published class schedule; venue events are published schedules; nearby crowding is model-derived (event-impact build: hourly simulated head count over stated capacity, reference week); parking is stated lot capacity, not how full a lot is. Ranked by lowest nearby modeled crowding (in 5-point steps), then more parking spaces nearby, then the smallest room that fits, then earliest; one room per building and a few slots per day. When the places attendees come from are given, rooms with the shortest average walk from them come first (in 2-minute steps), then the smallest room that fits; walks use saved walking routes, or a straight-line estimate where none is saved.';

export const metresBetween = (a: [number, number], b: [number, number]) => {
  const ky = 111_320, kx = ky * Math.cos((a[1] * Math.PI) / 180);
  return Math.round(Math.hypot((b[0] - a[0]) * kx, (b[1] - a[1]) * ky));
};

const bostonParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
/** An ISO instant as a Boston date and seconds since that date's midnight. */
function boston(iso: string): { date: string; sec: number } {
  const parts = bostonParts.formatToParts(new Date(iso));
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, sec: Number(part('hour')) * 3600 + Number(part('minute')) * 60 };
}

export function findEventSlots(q: SlotQuery, src: SlotSources): SlotResult {
  const byId = new Map(src.locations.map((l) => [l.id, l]));
  const campusOf = (l: CampusLocation) => l.campus ?? 'charles-river';
  const days = weekFrom(src.referenceWeekStart).filter((d) => !q.days || q.days.includes(d.weekday));
  const duration = q.durationMin * 60;

  // Rooms with published classes: seats (the largest published figure) and their class intervals.
  const rooms = new Map<string, { loc: CampusLocation; room: string; seats: number | null; intervals: { startSec: number; endSec: number }[] }>();
  for (const { locationId, meeting } of src.meetings) {
    const loc = byId.get(locationId);
    if (!loc || (q.campus && campusOf(loc) !== q.campus)) continue;
    const key = `${locationId}|${meeting.roomCode}`;
    const r = rooms.get(key) ?? { loc, room: meeting.roomCode, seats: null, intervals: [] };
    if (meeting.roomCapacity !== null) r.seats = Math.max(r.seats ?? 0, meeting.roomCapacity);
    r.intervals.push(...meeting.intervals);
    rooms.set(key, r);
  }
  const fitting = [...rooms.values()].filter((r): r is typeof r & { seats: number } => r.seats !== null && r.seats >= q.headcount);
  const largest = [...rooms.values()].reduce<{ building: string; room: string; seats: number } | null>(
    (best, r) => (r.seats !== null && (!best || r.seats > best.seats) ? { building: r.loc.name, room: r.room, seats: r.seats } : best), null);

  // Venue events by Boston date, with their busy window (buffered) and position.
  const venueById = new Map((src.venues?.venues ?? []).map((v) => [v.id, v]));
  const venueEvents = (src.venues?.events ?? []).flatMap((e) => {
    const venue = venueById.get(e.venueId);
    if (!venue?.position) return [];
    const start = boston(e.start);
    const end = e.end ? boston(e.end) : null;
    const endSec = end && end.date === start.date ? end.sec : end ? 86400 : start.sec + VENUE_DEFAULT_SEC;
    return [{ name: e.name, venue: venue.name, position: venue.position, date: start.date, startSec: start.sec, from: start.sec - VENUE_BUFFER_SEC, to: endSec + VENUE_BUFFER_SEC }];
  });

  // Per building: comparable places nearby for crowding, parking lots nearby, venues nearby.
  const buildings = new Map<string, { nearby: { id: string; name: string; capacity: number }[]; parking: Slot['parking']; venues: typeof venueEvents }>();
  const impactPlaces = (src.impact?.places ?? []).map((p) => byId.get(p.id)).filter((l): l is CampusLocation => !!l && KINDS_FOR_CROWD.has(l.kind) && comparable(l, true));
  for (const r of fitting) {
    if (buildings.has(r.loc.id)) continue;
    const at = r.loc.position;
    const lots = src.parking.map((l) => ({ l, m: metresBetween(at, l.position) })).filter((x) => x.m <= PARKING_RADIUS_M).sort((a, b) => a.m - b.m);
    buildings.set(r.loc.id, {
      nearby: impactPlaces.filter((p) => metresBetween(at, p.position) <= CROWD_RADIUS_M).map((p) => ({ id: p.id, name: p.name, capacity: p.capacity })),
      parking: { spaces: lots.reduce((s, x) => s + (x.l.capacity ?? 0), 0), lots: lots.length, nearest: lots[0] ? { name: lots[0].l.name, metres: lots[0].m } : null },
      venues: venueEvents.filter((e) => metresBetween(at, e.position) <= VENUE_RADIUS_M),
    });
  }

  // Convenience: average and longest walk from the attendees' places to each building.
  const near = [...new Set(q.near ?? [])].map((id) => byId.get(id)).filter((l): l is CampusLocation => !!l).slice(0, 12);
  const walks = new Map<string, Slot['walk']>();
  if (near.length && src.walkMinutes) {
    for (const r of fitting) {
      if (walks.has(r.loc.id)) continue;
      const minutes = near.map((n) => src.walkMinutes!(n.id, r.loc.id)).filter((m): m is number => m !== null);
      const longest = minutes.length ? Math.max(...minutes) : null;
      walks.set(r.loc.id, longest === null ? null : {
        average: Math.round(minutes.reduce((a, b) => a + b, 0) / minutes.length), longest,
        from: near[minutes.indexOf(longest)]?.name ?? '',
      });
    }
  }

  const counts = { rooms: rooms.size, roomsWithSeats: fitting.length, checked: 0, withClass: 0, withListedEvent: 0, nearVenueEvent: 0, free: 0 };
  const conflicts = new Map<string, SlotResult['venueConflicts'][number]>();
  const starts: number[] = [];
  for (let s = q.fromSec; s + duration <= q.toSec; s += STEP_SEC) starts.push(s);
  const candidates: (Slot & { crowdShare: number })[] = [];

  for (const day of days) {
    const gatherings = src.impact?.dates[day.date]?.gatherings ?? [];
    for (const r of fitting) {
      const b = buildings.get(r.loc.id)!;
      for (const s0 of starts) {
        const s1 = s0 + duration;
        counts.checked++;
        const t0 = day.weekday * 86400 + s0, t1 = day.weekday * 86400 + s1;
        if (r.intervals.some((iv) => iv.startSec < t1 && iv.endSec > t0)) { counts.withClass++; continue; }
        if (gatherings.some((g) => g.locationId === r.loc.id && g.roomCode === r.room && g.startSec < s1 && g.endSec > s0)) { counts.withListedEvent++; continue; }
        const clash = b.venues.filter((e) => e.date === day.date && e.from < s1 && e.to > s0);
        if (clash.length) {
          counts.nearVenueEvent++;
          for (const e of clash) conflicts.set(`${e.date}|${e.name}|${e.startSec}`, { name: e.name, venue: e.venue, date: e.date, start: formatClock(e.startSec) });
          continue;
        }
        counts.free++;
        // Crowding: each nearby place's modeled share, averaged over the slot's hours by overlap.
        let worst: { share: number; place: string } | null = null;
        for (const p of b.nearby) {
          const { counts: hourly } = hourlyCounts(src.impact!, p.id, day);
          if (!hourly) continue;
          let total = 0;
          for (let h = Math.floor(s0 / 3600); h * 3600 < s1; h++) {
            const overlap = Math.min(s1, (h + 1) * 3600) - Math.max(s0, h * 3600);
            total += (hourly[h] ?? 0) * overlap;
          }
          const share = total / duration / p.capacity;
          if (!worst || share > worst.share) worst = { share, place: p.name };
        }
        candidates.push({
          ...day, start: formatClock(s0), end: formatClock(s1), startSec: s0, endSec: s1,
          locationId: r.loc.id, building: r.loc.name, campus: campusOf(r.loc), room: r.room, seats: r.seats,
          nearbyCrowd: worst ? { percent: Math.round(worst.share * 100), place: worst.place } : null,
          crowdShare: worst?.share ?? 0,
          parking: b.parking,
          venueEventsSameDay: [...new Set(b.venues.filter((e) => e.date === day.date).map((e) => e.name))].slice(0, 2),
          walk: walks.get(r.loc.id) ?? null,
        });
      }
    }
  }

  const step = (share: number) => Math.round(share * 20);
  const walkStep = (c: Slot) => (c.walk ? Math.round(c.walk.average / 2) : Infinity);
  const byWalk = walks.size > 0;
  candidates.sort((a, b) => (byWalk ? (walkStep(a) - walkStep(b) || a.seats - b.seats) : 0)
    || step(a.crowdShare) - step(b.crowdShare) || b.parking.spaces - a.parking.spaces
    || a.seats - b.seats || a.date.localeCompare(b.date) || a.startSec - b.startSec || a.building.localeCompare(b.building) || a.room.localeCompare(b.room));
  // Variety: one start per room per day, one room per building per day, a few slots per day.
  const perRoomDay = new Set<string>();
  const perBuildingDay = new Set<string>();
  const perDay = new Map<string, number>();
  const maxPerDay = q.maxPerDay ?? 2;
  const slots: Slot[] = [];
  for (const c of candidates) {
    if (slots.length >= q.limit) break;
    const rk = `${c.locationId}|${c.room}|${c.date}`, bk = `${c.locationId}|${c.date}`;
    if (perRoomDay.has(rk) || perBuildingDay.has(bk) || (perDay.get(c.date) ?? 0) >= maxPerDay) continue;
    perRoomDay.add(rk);
    perBuildingDay.add(bk);
    perDay.set(c.date, (perDay.get(c.date) ?? 0) + 1);
    const { crowdShare: _, ...slot } = c;
    slots.push(slot);
  }
  return {
    headcount: q.headcount, days, window: { from: formatClock(q.fromSec), to: formatClock(q.toSec) }, durationMin: q.durationMin, campus: q.campus,
    slots, counts, venueConflicts: [...conflicts.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6),
    largestRoom: fitting.length ? null : largest,
    near: near.map((n) => n.name),
  };
}
