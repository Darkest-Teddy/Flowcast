import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { roomFloor, floorFor, ordinal, parseClassQuery, findClasses, formatClassTimes, buildingLabel, floorText, isClassQuestion } = await import('../src/classSearch.ts');

const H = 3600, D = 86400;
const meeting = (id, courseCode, section, buildingCode, roomCode, intervals, extra = {}) => ({
  id, courseCode, title: extra.title ?? 'Introduction to Computer Science 2', section, buildingCode, roomCode,
  intervals: intervals.map(([weekday, start, end]) => ({ weekday, startSec: weekday * D + start, endSec: weekday * D + end })),
  roomCapacity: null, notes: null, calendarRestricted: false, sharedKey: null, sourceUrl: `https://example.test/${id}`, ...extra,
});
const tt = [[1, 17 * H, 18.25 * H], [3, 17 * H, 18.25 * H]];
const rows = [
  { locationId: 'cas', meeting: meeting('m1', 'CAS CS 112', 'A1', 'CAS', 'B18', tt) },
  { locationId: 'epic', meeting: meeting('m2', 'CAS CS 112', 'A2', 'EPC', '207', [[1, 15.5 * H, 16.75 * H], [3, 15.5 * H, 16.75 * H]]) },
  // One section, two places: a lecture room and a lab in another building.
  { locationId: 'cds', meeting: meeting('m3', 'CAS CS 112', 'B1', 'CDS', '1526', [[0, 10 * H, 11 * H]]) },
  { locationId: 'cas', meeting: meeting('m4', 'CAS CS 112', 'B1', 'CAS', '211', [[2, 10 * H, 11 * H]]) },
  { locationId: 'sci', meeting: meeting('m5', 'CAS CS 111', 'A1', 'SCI', '113', [[0, 10 * H + 600, 11 * H], [2, 10 * H + 600, 11 * H], [4, 10 * H + 600, 11 * H]], { title: 'Introduction to Computer Science 1' }) },
  { locationId: 'cas', meeting: meeting('m6', 'CAS BI 515', 'A1', 'CAS', '320', tt, { title: 'Population Genetics' }) },
  { locationId: 'cgs', meeting: meeting('m7', 'WED BI 515', 'A1', 'CGS', '521', tt, { title: 'Methods in Bilingual Education' }) },
  { locationId: 'cas', meeting: meeting('m8', 'CAS MA 123', 'A1', 'CAS', 'B12', tt, { title: 'Calculus 1' }) },
];
const directory = {
  buildings: { CAS: { name: 'College of Arts & Sciences', address: '685-725 Commonwealth Avenue' }, CDS: { name: 'Computing & Data Sciences', address: '665 Commonwealth Avenue' } },
  instructors: { m1: 'Narayanan' },
};

test('room numbers give the floor: leading digit, basement, ground, tall buildings', () => {
  assert.equal(roomFloor('211').label, '2nd floor');
  assert.deepEqual(roomFloor('211'), { level: 'floor', floor: 2, label: '2nd floor' });
  assert.equal(roomFloor('B12').label, 'Basement');
  assert.equal(roomFloor('B-12').label, 'Basement');
  assert.equal(roomFloor('b06a').label, 'Basement');
  assert.equal(roomFloor('G10').label, 'Ground floor');
  assert.equal(roomFloor('100').label, '1st floor');
  assert.equal(roomFloor('114A').label, '1st floor');
  assert.equal(roomFloor('212X4').label, '2nd floor');
  assert.equal(roomFloor('323B').label, '3rd floor');
  assert.equal(roomFloor('Room 404').label, '4th floor');
  assert.equal(roomFloor('1150', { tall: true }).label, '11th floor');
  assert.equal(roomFloor('1150').label, '1st floor');
  assert.equal(floorFor('CDS', '1526').label, '15th floor');
  assert.equal(floorFor('cas', '1526').label, '1st floor');
  for (const unclear of ['L240', 'AUD', 'KEEFR', '05', '12', '012', '12345', '']) {
    assert.equal(roomFloor(unclear).level, null, unclear);
    assert.match(roomFloor(unclear).label, /^room /);
  }
  assert.equal(roomFloor('L240').label, 'room L240');
  assert.deepEqual([1, 2, 3, 4, 11, 12, 13, 21, 22].map(ordinal), ['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd']);
});

test('course codes normalise with or without spaces and school, and read a section', () => {
  for (const q of ['CS 112', 'cs112', 'CAS CS 112', 'cas cs112', 'where does CS 112 meet?']) {
    assert.equal(findClasses(q, rows).results[0].courseCode, 'CAS CS 112', q);
  }
  assert.deepEqual(parseClassQuery('CS 112 A1'), { code: 'cs112', section: 'A1', words: [] });
  assert.deepEqual(parseClassQuery('cs112 section b1'), { code: 'cs112', section: 'B1', words: [] });
  const a1 = findClasses('CS 112 A1', rows, directory);
  assert.equal(a1.sectionMatched, true);
  assert.deepEqual(a1.results[0].sections.map((s) => s.section), ['A1']);
  assert.equal(a1.results[0].sections[0].instructor, 'Narayanan');
  // A word after the code that isn't a section of the course is ignored, not an empty result.
  const word = findClasses('CS 112 in CAS', rows);
  assert.equal(word.sectionMatched, false);
  assert.equal(word.results[0].sections.length, 3);
  assert.equal(findClasses('CS 112 Z9', rows).results[0].sections.length, 3);
});

test('a code shared by two schools returns both courses; the school picks one', () => {
  assert.deepEqual(findClasses('BI 515', rows).results.map((c) => c.courseCode).sort(), ['CAS BI 515', 'WED BI 515']);
  assert.deepEqual(findClasses('WED BI 515', rows).results.map((c) => c.courseCode), ['WED BI 515']);
});

test('title words find courses: "intro to CS", "calc"', () => {
  assert.deepEqual(findClasses('intro to CS', rows).results.map((c) => c.courseCode), ['CAS CS 111', 'CAS CS 112']);
  assert.deepEqual(findClasses('calc', rows).results.map((c) => c.courseCode), ['CAS MA 123']);
  assert.deepEqual(findClasses('population genetics', rows).results.map((c) => c.courseCode), ['CAS BI 515']);
  assert.equal(findClasses('zz', rows).results.length, 0);
  assert.equal(findClasses('underwater basket weaving', rows).results.length, 0);
});

test('a section meeting in two buildings keeps both places with their own floors', () => {
  const b1 = findClasses('CS 112 B1', rows, directory).results[0].sections[0];
  assert.deepEqual(b1.places.map((p) => [p.buildingCode, p.floor.label]), [['CDS', '15th floor'], ['CAS', '2nd floor']]);
  assert.equal(formatClassTimes(b1.places[0].times), 'Mon 10:00–11:00 AM');
});

test('wording: times, building label and floor text', () => {
  const a1 = findClasses('CS 112 A1', rows, directory).results[0].sections[0].places[0];
  assert.equal(formatClassTimes(a1.times), 'Tue, Thu 5:00–6:15 PM');
  assert.equal(formatClassTimes([{ weekday: 0, startSec: 11.25 * H, endSec: 12.5 * H }]), 'Mon 11:15 AM–12:30 PM');
  assert.equal(formatClassTimes([]), 'times not published');
  assert.equal(buildingLabel('CAS', directory), 'CAS · College of Arts & Sciences, 685-725 Commonwealth Avenue');
  assert.equal(buildingLabel('EPC', directory, 'Engineering Product Innovation Center'), 'EPC · Engineering Product Innovation Center');
  assert.equal(floorText(a1), 'Basement (room B18)');
  assert.equal(floorText({ roomCode: 'L240', floor: roomFloor('L240') }), 'room L240');
});

test('class questions are told apart from walking questions', () => {
  assert.equal(isClassQuestion('Where does CS 112 meet?'), true);
  assert.equal(isClassQuestion('what floor is cas cs 112 on'), true);
  assert.equal(isClassQuestion('How far is CS 132 from DS 340?'), false);
  assert.equal(isClassQuestion('where is my next class'), false);
});
