import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { CampusLocation, ScheduleItem } from '../src/data/types.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null },
  resolve: { alias: { '@theme': fileURLToPath(new URL('../../theme', import.meta.url)), '@map': fileURLToPath(new URL('../../map-client/src', import.meta.url)) } } });
const { findClassRows, classAnswerText, classRowDetail } = await vite.ssrLoadModule('/src/lib/classFinder.ts');
const { searchClasses, answerQuestion } = await vite.ssrLoadModule('/src/pages/student/campusSearch.ts');
await vite.close();

const H = 3600, D = 86400;
const meeting = (id: string, courseCode: string, section: string, buildingCode: string, roomCode: string, days: number[], start: number, end: number, title = 'Introduction to Computer Science 2') => ({
  id, courseCode, title, section, buildingCode, roomCode,
  intervals: days.map((d) => ({ weekday: d, startSec: d * D + start, endSec: d * D + end })),
  roomCapacity: null, notes: null, calendarRestricted: false, sharedKey: null, sourceUrl: `https://example.test/${id}`,
});
const classes = {
  meetings: [
    { locationId: 'cas', meeting: meeting('m1', 'CAS CS 112', 'A1', 'CAS', 'B18', [1, 3], 17 * H, 18.25 * H) },
    { locationId: 'cds', meeting: meeting('m2', 'CAS CS 112', 'B1', 'CDS', '1526', [0], 10 * H, 11 * H) },
    { locationId: 'cas', meeting: meeting('m3', 'CAS CS 112', 'B1', 'CAS', '211', [2], 10 * H, 11 * H) },
    { locationId: 'cas', meeting: meeting('m4', 'CAS CS 111', 'A1', 'CAS', '313', [0, 2, 4], 9 * H, 10 * H, 'Introduction to Computer Science 1') },
  ],
  directory: {
    buildings: { CAS: { name: 'College of Arts & Sciences', address: '685-725 Commonwealth Avenue' }, CDS: { name: 'Computing & Data Sciences', address: '665 Commonwealth Avenue' } },
    instructors: { m1: 'Narayanan' },
  },
};
const locations: CampusLocation[] = [
  { id: 'warren', name: 'Warren Towers', short: 'Warren', kind: 'dorm', capacity: 1800 },
  { id: 'cas', name: 'College of Arts and Sciences', short: 'CAS', kind: 'classroom', capacity: 900 },
  { id: 'cds', name: 'Computing & Data Sciences', short: 'CDS', kind: 'classroom', capacity: 600 },
];
const geo = { positions: { cas: [-71.1056, 42.3503] as [number, number], cds: [-71.1029, 42.35] as [number, number] }, walkMeters: { 'cas>warren': 504, 'cds>warren': 168 } };
const ctx = { locations, geo, schedule: [] as ScheduleItem[], homeLocationId: 'warren' };
const now = new Date('2026-10-26T14:00:00Z');

test('class rows give building, floor, times, instructor and the walk from home', () => {
  const found = findClassRows('cs112 a1', classes, ctx, now);
  assert.equal(found.rows.length, 1);
  const [row] = found.rows;
  assert.equal(row.building, 'CAS · College of Arts & Sciences, 685-725 Commonwealth Avenue');
  assert.equal(row.floor, 'Basement (room B18)');
  assert.equal(row.times, 'Tue, Thu 5:00–6:15 PM');
  assert.equal(row.instructor, 'Narayanan');
  assert.equal(row.walk.minutes, 6);
  assert.equal(found.from.locationId, 'warren');
  assert.match(classRowDetail(row, found.from), /Basement \(room B18\) · Tue, Thu 5:00–6:15 PM · Instructor: Narayanan · 6 min walk from Warren/);
  assert.match(classAnswerText(found, 'cs112 a1'), /^CAS CS 112 A1 meets in CAS · College of Arts & Sciences, 685-725 Commonwealth Avenue, Basement \(room B18\): Tue, Thu 5:00–6:15 PM\. It’s a 6-minute walk from Warren\.$/);
});

test('a section in two buildings gives a row per building with its own floor', () => {
  const found = findClassRows('CS 112 B1', classes, ctx, now);
  assert.deepEqual(found.rows.map((r: { floor: string }) => r.floor), ['15th floor (room 1526)', '2nd floor (room 211)']);
  assert.match(classAnswerText(found, 'CS 112 B1'), /meets in 2 buildings/);
});

test('an unknown section is ignored and said so; title searches ask which course', () => {
  const found = findClassRows('CS 112 Z9', classes, ctx, now);
  assert.equal(found.rows.length, 3);
  assert.match(classAnswerText(found, 'CS 112 Z9'), /Section Z9 isn’t in the published schedule/);
  const intro = findClassRows('intro to CS', classes, ctx, now);
  assert.deepEqual(intro.courses.map((c: { courseCode: string }) => c.courseCode), ['CAS CS 111', 'CAS CS 112']);
  assert.match(classAnswerText(intro, 'intro to CS'), /matches 2 courses.*Which one/);
  assert.match(classAnswerText(findClassRows('zzz 999', classes, ctx, now), 'zzz 999'), /no published class meeting/);
});

test('Home search lists class results with the building map location; Ask answers with building and floor', () => {
  const data = { locations, schedule: [], events: [], clubs: [], hourly: [], places: [], geo, homeLocationId: 'warren', classes };
  const search = searchClasses('CS 112', data, now);
  assert.equal(search.results[0].kind, 'Class');
  assert.equal(search.results[0].locationId, 'cas');
  assert.match(search.results[0].detail, /Basement \(room B18\)/);
  assert.equal(searchClasses('CS 112', { ...data, classes: null }, now), null);
  const answer = answerQuestion('Where does CS 112 A1 meet?', data, now);
  assert.match(answer.text, /CAS · College of Arts & Sciences, 685-725 Commonwealth Avenue, Basement/);
  assert.deepEqual(answer.focus, ['cas']);
  assert.match(answer.note, /room number/);
  // A walking question still goes to the walking answer.
  assert.doesNotMatch(answerQuestion('How far is CS 112 from Warren?', data, now).text, /Basement/);
});
