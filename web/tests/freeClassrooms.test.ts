import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { ClassMeeting, FreeClassroomInput } from '../src/lib/freeClassrooms.ts';
// freeClassrooms.ts imports the study finder without an extension: load through Vite, as departure.test.ts does.
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { findFreeClassrooms } = await vite.ssrLoadModule('/src/lib/freeClassrooms.ts') as typeof import('../src/lib/freeClassrooms.ts');
await vite.close();
import type { CampusLocation } from '../src/data/types.ts';

const DAY = 86400;
const at = (weekday: number, h: number, m = 0) => weekday * DAY + h * 3600 + m * 60;
const loc = (id: string, name: string) => ({ id, name, kind: 'classroom' }) as CampusLocation;
const locations = [loc('cas', 'College of Arts & Sciences'), loc('kcb', 'Kenmore Classroom Building')];
const geo = { positions: {}, walkMeters: { 'cas>kcb': 840 } };
const meetings: ClassMeeting[] = [
  // CAS 114: Tuesday 9:00–10:15 and 14:00–15:15.
  { locationId: 'cas', roomCode: '114', seats: 40, intervals: [{ startSec: at(1, 9), endSec: at(1, 10, 15) }, { startSec: at(1, 14), endSec: at(1, 15, 15) }] },
  // CAS 222: Tuesday 10:00–12:00 (busy at 11:00).
  { locationId: 'cas', roomCode: '222', seats: 25, intervals: [{ startSec: at(1, 10), endSec: at(1, 12) }] },
  // KCB 101: only on Monday, so free for the rest of KCB's Tuesday teaching (until 17:00).
  { locationId: 'kcb', roomCode: '101', seats: 120, intervals: [{ startSec: at(0, 9), endSec: at(0, 10) }] },
  // KCB 205: Tuesday 8:00–17:00, which sets KCB's teaching hours that day.
  { locationId: 'kcb', roomCode: '205', seats: 30, intervals: [{ startSec: at(1, 8), endSec: at(1, 17) }] },
  // A room in a building the dashboard doesn't know is left out.
  { locationId: 'unknown', roomCode: '1', seats: 10, intervals: [{ startSec: at(1, 8), endSec: at(1, 9) }] },
];
const input = (over: Partial<FreeClassroomInput> = {}): FreeClassroomInput => ({
  meetings, locations, geo, weekday: 1, seconds: 11 * 3600, from: '', minMinutes: 0, maxWalk: null, query: '', sort: 'free', ...over,
});

test('free rooms have no class now, with the next class as the end of the free time', () => {
  const { rooms, busy, classesToday, nextStart } = findFreeClassrooms(input());
  assert.equal(classesToday, true);
  assert.equal(nextStart, null);
  assert.equal(busy, 2);
  assert.deepEqual(rooms.map(r => `${r.locationId} ${r.room}`), ['kcb 101', 'cas 114']);
  const cas = rooms.find(r => r.room === '114')!;
  assert.equal(cas.freeUntil, 14 * 3600);
  assert.equal(cas.freeMinutes, 180);
  const kcb = rooms.find(r => r.room === '101')!;
  assert.equal(kcb.freeUntil, null);
  assert.equal(kcb.freeMinutes, 6 * 60); // until KCB's last class of the day ends
});

test('rooms count only while their building is teaching that day', () => {
  // 7:00: no building has started; KCB starts at 8:00.
  const early = findFreeClassrooms(input({ seconds: 7 * 3600 }));
  assert.deepEqual(early.rooms, []);
  assert.equal(early.busy, 0);
  assert.equal(early.nextStart, 8 * 3600);
  // 16:00: CAS finished at 15:15, KCB still teaching.
  assert.deepEqual(findFreeClassrooms(input({ seconds: 16 * 3600 })).rooms.map(r => r.locationId), ['kcb']);
  // 18:00: classes are over everywhere.
  const late = findFreeClassrooms(input({ seconds: 18 * 3600 }));
  assert.deepEqual(late.rooms, []);
  assert.equal(late.nextStart, null);
  assert.equal(late.classesToday, true);
});

test('a class ending exactly now leaves the room free; one starting now makes it busy', () => {
  const ending = findFreeClassrooms(input({ seconds: 12 * 3600 })).rooms.map(r => r.room);
  assert.ok(ending.includes('222'));
  const starting = findFreeClassrooms(input({ seconds: 14 * 3600 })).rooms.map(r => r.room);
  assert.ok(!starting.includes('114'));
});

test('minimum free time, building or room search, walking limit and sorting', () => {
  assert.deepEqual(findFreeClassrooms(input({ minMinutes: 240 })).rooms.map(r => r.room), ['101']);
  assert.deepEqual(findFreeClassrooms(input({ query: 'arts' })).rooms.map(r => r.room), ['114']);
  assert.deepEqual(findFreeClassrooms(input({ query: 'KENMORE 101' })).rooms.map(r => r.room), ['101']);
  const near = findFreeClassrooms(input({ from: 'cas', maxWalk: 5 })).rooms;
  assert.deepEqual(near.map(r => [r.room, r.walk]), [['114', 0]]);
  assert.deepEqual(findFreeClassrooms(input({ from: 'cas', sort: 'walk' })).rooms.map(r => r.walk), [0, 10]);
  assert.deepEqual(findFreeClassrooms(input({ sort: 'seats' })).rooms.map(r => r.seats), [120, 40]);
});

test('a day without classes says so', () => {
  const sunday = findFreeClassrooms(input({ weekday: 6, seconds: 12 * 3600 }));
  assert.equal(sunday.classesToday, false);
});

test('the published bundle has classrooms free and busy at a weekday midday', () => {
  const data = JSON.parse(readFileSync(new URL('../../map-client/public/data/campus-data.json', import.meta.url), 'utf8'));
  const real: ClassMeeting[] = Object.entries(data.locations as Record<string, { meetings: { roomCode: string; roomCapacity: number | null; intervals: { startSec: number; endSec: number }[] }[] }>)
    .flatMap(([locationId, l]) => l.meetings.map(m => ({ locationId, roomCode: m.roomCode, seats: m.roomCapacity, intervals: m.intervals })));
  const names = Object.keys(data.locations).map(id => loc(id, id));
  const { rooms, busy, classesToday } = findFreeClassrooms(input({ meetings: real, locations: names, geo: { positions: {}, walkMeters: {} }, weekday: 2, seconds: 11 * 3600 }));
  assert.equal(classesToday, true);
  assert.ok(rooms.length > 0 && busy > 0);
  assert.ok(rooms.every(r => r.freeMinutes >= 0));
});
