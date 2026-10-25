import type { CampusGeo, CampusLocation } from '../data/types';
import { studyWalkMinutes } from './studyFinder';

/** One published class meeting in a room, with its reference-week intervals (seconds from Monday 00:00). */
export interface ClassMeeting {
  locationId: string;
  roomCode: string;
  seats: number | null;
  intervals: { startSec: number; endSec: number }[];
}

export interface FreeClassroom {
  locationId: string;
  building: string;
  room: string;
  seats: number | null;
  /** Seconds since midnight when the next published class in the room starts, or null when none starts later that day. */
  freeUntil: number | null;
  /** Minutes until that class, or until the building's last class of the day ends. */
  freeMinutes: number;
  walk: number | null;
}

export interface FreeClassroomInput {
  meetings: ClassMeeting[];
  locations: CampusLocation[];
  geo: CampusGeo;
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** Seconds since midnight, Boston time. */
  seconds: number;
  from: string;
  minMinutes: number;
  maxWalk: number | null;
  query: string;
  sort: 'walk' | 'free' | 'seats';
}

const DAY = 86400;

/**
 * Rooms with no published class at the given time, like the Ask server's free_rooms tool: only rooms
 * that host a published class sometime in the week are known, and exams, events, office hours and
 * building access are not in the data, so a free room may still be in use or locked.
 *
 * A room counts only while its building is teaching that day, from its first published class start
 * to its last class end: outside that window (nights, weekends) the building is likely locked.
 * nextStart is the earliest teaching start later today (seconds since midnight) when no building is teaching yet.
 */
export function findFreeClassrooms(input: FreeClassroomInput): { rooms: FreeClassroom[]; busy: number; classesToday: boolean; nextStart: number | null } {
  const t = input.weekday * DAY + input.seconds;
  const dayEnd = (input.weekday + 1) * DAY;
  const names = new Map(input.locations.map(l => [l.id, l.name]));
  const dayStart = input.weekday * DAY;
  const rooms = new Map<string, { locationId: string; room: string; seats: number | null; busy: boolean; nextStart: number }>();
  const teaching = new Map<string, { first: number; last: number }>();
  for (const m of input.meetings) {
    if (!names.has(m.locationId)) continue;
    const key = `${m.locationId}|${m.roomCode}`;
    const room = rooms.get(key) ?? { locationId: m.locationId, room: m.roomCode, seats: null, busy: false, nextStart: Infinity };
    if (m.seats !== null) room.seats = Math.max(room.seats ?? 0, m.seats);
    for (const iv of m.intervals) {
      if (iv.startSec < dayEnd && iv.endSec > dayStart) {
        const w = teaching.get(m.locationId) ?? { first: Infinity, last: -Infinity };
        teaching.set(m.locationId, { first: Math.min(w.first, iv.startSec), last: Math.max(w.last, Math.min(iv.endSec, dayEnd)) });
      }
      if (iv.startSec <= t && t < iv.endSec) room.busy = true;
      else if (iv.startSec > t && iv.startSec < dayEnd) room.nextStart = Math.min(room.nextStart, iv.startSec);
    }
    rooms.set(key, room);
  }
  // Every word must match, so "kenmore 101" finds Kenmore Classroom Building 101.
  const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
  const inUse = (r: { locationId: string }) => {
    const w = teaching.get(r.locationId);
    return !!w && w.first <= t && t < w.last;
  };
  const all = [...rooms.values()].filter(inUse);
  const free = all.filter(r => !r.busy).map((r): FreeClassroom => {
    const until = Number.isFinite(r.nextStart) ? r.nextStart : teaching.get(r.locationId)!.last;
    return {
      locationId: r.locationId,
      building: names.get(r.locationId)!,
      room: r.room,
      seats: r.seats,
      freeUntil: Number.isFinite(r.nextStart) ? r.nextStart - dayStart : null,
      freeMinutes: Math.floor((until - t) / 60),
      walk: input.from ? studyWalkMinutes(input.geo, input.locations, input.from, r.locationId) : null,
    };
  }).filter(r => r.freeMinutes >= input.minMinutes
    && (input.maxWalk === null || (r.walk !== null && r.walk <= input.maxWalk))
    && words.every(w => `${r.building} ${r.room}`.toLowerCase().includes(w)));
  free.sort((a, b) => {
    const rank = input.sort === 'walk' ? (a.walk ?? Infinity) - (b.walk ?? Infinity)
      : input.sort === 'free' ? b.freeMinutes - a.freeMinutes
      : (b.seats ?? -1) - (a.seats ?? -1);
    return (Number.isNaN(rank) ? 0 : rank) || b.freeMinutes - a.freeMinutes || a.building.localeCompare(b.building) || a.room.localeCompare(b.room, undefined, { numeric: true });
  });
  const later = [...teaching.values()].map(w => w.first).filter(first => first > t);
  return {
    rooms: free,
    busy: all.filter(r => r.busy).length,
    classesToday: teaching.size > 0,
    nextStart: all.length === 0 && later.length ? Math.min(...later) - dayStart : null,
  };
}
