import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { CampusData } from '../../map-client/src/data/campusData';
import { buildCourseIndex, coursesForKeys, expandSections, searchCourses, sectionKey } from '../src/dashboard/courses';

const now = new Date('2026-10-24T16:00:00Z'); // Saturday, inside Fall 2026.
const DAY = 86400;

/** A published meeting. `startSec`/`endSec` are seconds into the reference week, as the snapshot stores them. */
function meeting(over: Partial<CampusData['locations'][string]['meetings'][number]> & { courseCode: string; section: string; weekday: number; from: number; to: number }) {
  const { weekday, from, to, ...rest } = over;
  return {
    id: `${over.courseCode}-${over.section}-${weekday}`,
    title: 'Introduction to Computer Science',
    buildingCode: 'CAS',
    roomCode: '201',
    roomCapacity: 100,
    notes: null,
    calendarRestricted: false,
    sharedKey: null,
    sourceUrl: 'https://www.bu.edu/academics/cas/courses/cas-cs-112/',
    intervals: [{ weekday, startSec: weekday * DAY + from, endSec: weekday * DAY + to }],
    ...rest,
  } as CampusData['locations'][string]['meetings'][number];
}

function campus(over: Partial<CampusData> = {}): CampusData {
  return {
    schemaVersion: 1,
    term: 'FALL 2026',
    collectedAt: '2026-10-24T16:25:43.761Z',
    referenceWeekStart: '2026-10-26',
    coverage: {} as CampusData['coverage'],
    locations: {
      cas: {
        id: 'cas', buildingCodes: ['CAS'], evidence: [], hours: [],
        meetings: [
          // CAS CS 112 A1 meets Monday and Wednesday, 12:30-13:45.
          meeting({ courseCode: 'CAS CS 112', section: 'A1', weekday: 0, from: 45000, to: 49500 }),
          meeting({ courseCode: 'CAS CS 112', section: 'A1', weekday: 2, from: 45000, to: 49500 }),
          // A second section, Tuesday only, overlapping A1's time but on another day.
          meeting({ courseCode: 'CAS CS 112', section: 'B1', weekday: 1, from: 45000, to: 49500 }),
          // A different course that clashes with A1 on Monday.
          meeting({ courseCode: 'CAS MA 123', section: 'A1', title: 'Calculus I', weekday: 0, from: 46800, to: 50400 }),
          // Restricted meetings are not published to students.
          meeting({ courseCode: 'CAS XX 999', section: 'A1', title: 'Hidden', weekday: 0, from: 45000, to: 49500, calendarRestricted: true }),
          // A professional-school prefix the semester calendar excludes.
          meeting({ courseCode: 'MED MD 121', section: 'A1', title: 'Doctoring 1', weekday: 3, from: 45000, to: 49500 }),
        ],
      },
    } as unknown as CampusData['locations'],
    academicCalendar: {
      sourceUrl: '', scopeSourceUrl: '', limitations: '',
      applicableCoursePrefixes: ['CAS', 'ENG'],
      excludedCoursePrefixes: ['MED'],
      terms: [{
        term: 'FALL 2026',
        classesStart: '2026-09-02',
        classesEnd: '2026-12-10',
        suspendedDates: ['2026-11-25', '2026-11-26'],
        substitutions: [{ date: '2026-10-27', scheduleWeekday: 0 }], // A Tuesday running Monday's timetable.
        sourceUrl: '', events: [],
      }],
    },
    ...over,
  } as CampusData;
}

test('the index keeps one entry per section and drops restricted meetings', () => {
  const index = buildCourseIndex(campus());
  assert.equal(index.term, 'FALL 2026');
  assert.ok(index.sections.has(sectionKey('CAS CS 112', 'A1')));
  assert.ok(index.sections.has(sectionKey('CAS CS 112', 'B1')));
  assert.equal(index.sections.has(sectionKey('CAS XX 999', 'A1')), false, 'calendar-restricted sections are not offered');
  // The two Monday/Wednesday meetings collapse into one section with two slots.
  const a1 = index.sections.get(sectionKey('CAS CS 112', 'A1'))!;
  assert.deepEqual(a1.slots.map((s) => s.weekday), [0, 2]);
  assert.deepEqual(a1.slots.map((s) => s.startSec), [45000, 45000], 'the weekday is peeled back out of week-seconds');
  assert.equal(a1.slots[0].locationId, 'cas');
  assert.equal(a1.calendarApplies, true);
  assert.equal(index.sections.get(sectionKey('MED MD 121', 'A1'))!.calendarApplies, false);
});

test('search matches course code and title, and groups sections under their course', () => {
  const index = buildCourseIndex(campus());
  const byCode = searchCourses(index, 'cas cs 112');
  assert.deepEqual(byCode.courses.map((c) => c.courseCode), ['CAS CS 112']);
  assert.deepEqual(byCode.courses[0].sections.map((s) => s.section), ['A1', 'B1']);
  assert.equal(byCode.total, 2, 'total counts sections, not courses');

  const byTitle = searchCourses(index, 'calculus');
  assert.deepEqual(byTitle.courses.map((c) => c.courseCode), ['CAS MA 123']);

  assert.equal(searchCourses(index, 'no such course').courses.length, 0);
  assert.ok(searchCourses(index, '').courses.length >= 3, 'an empty query opens the catalog');
  // Public sections carry no internal validity fields.
  assert.equal('validFrom' in byCode.courses[0].sections[0].slots[0], false);
});

test('lookup by key returns just those sections and skips ones no longer published', () => {
  const index = buildCourseIndex(campus());
  const found = coursesForKeys(index, [sectionKey('CAS MA 123', 'A1'), 'CAS CS 112|GONE', sectionKey('CAS MA 123', 'A1')]);
  assert.deepEqual(found.courses.map((c) => c.courseCode), ['CAS MA 123']);
  assert.equal(found.courses[0].sections.length, 1, 'a repeated key is returned once');
  assert.equal(found.total, 1, 'a withdrawn section is skipped rather than throwing');
  assert.deepEqual(coursesForKeys(index, []).courses, []);
});

test('a chosen section expands onto its published weekdays inside the term', () => {
  const index = buildCourseIndex(campus());
  const { items } = expandSections(index, [sectionKey('CAS CS 112', 'A1')], now);
  assert.ok(items.length > 0);
  const days = items.map((item) => item.start.slice(0, 10));

  // Monday 2026-10-26 and Wednesday 2026-10-28 are ordinary class days.
  assert.ok(days.includes('2026-10-26'));
  assert.ok(days.includes('2026-10-28'));
  // Thanksgiving recess is suspended.
  assert.equal(days.includes('2026-11-25'), false);
  // Classes end 2026-12-10, so nothing is generated after it even though the window runs 120 days.
  assert.equal(days.some((d) => d > '2026-12-10'), false);

  const first = items.find((item) => item.start.startsWith('2026-10-26'))!;
  assert.equal(first.title, 'CAS CS 112 A1');
  assert.equal(first.note, 'Introduction to Computer Science');
  assert.equal(first.locationId, 'cas');
  assert.equal(first.locationText, 'CAS 201');
  assert.equal(first.source, 'course');
  // 12:30 Boston on an EDT date is 16:30 UTC.
  assert.equal(first.start, '2026-10-26T16:30:00.000Z');
  assert.equal(first.end, '2026-10-26T17:45:00.000Z');
});

test('a substitute day runs the substituted weekday, not its own', () => {
  const index = buildCourseIndex(campus());
  // 2026-10-27 is a Tuesday the registrar runs on Monday's timetable.
  const monday = expandSections(index, [sectionKey('CAS CS 112', 'A1')], now).items
    .filter((item) => item.start.startsWith('2026-10-27'));
  assert.equal(monday.length, 1, 'the Monday-only section meets on the substitute Tuesday');

  const tuesday = expandSections(index, [sectionKey('CAS CS 112', 'B1')], now).items
    .filter((item) => item.start.startsWith('2026-10-27'));
  assert.equal(tuesday.length, 0, 'the Tuesday section does not meet that day');
});

test('clocks stay on Boston wall time across the end of daylight saving', () => {
  const index = buildCourseIndex(campus());
  const items = expandSections(index, [sectionKey('CAS CS 112', 'A1')], now).items;
  const beforeChange = items.find((item) => item.start.startsWith('2026-10-26'))!; // EDT
  const afterChange = items.find((item) => item.start.startsWith('2026-11-02'))!; // EST
  assert.equal(beforeChange.start, '2026-10-26T16:30:00.000Z');
  assert.equal(afterChange.start, '2026-11-02T17:30:00.000Z', 'same 12:30 local, one hour later in UTC');
});

test('a prefix the semester calendar excludes keeps its weekly pattern through recess', () => {
  const index = buildCourseIndex(campus());
  const days = expandSections(index, [sectionKey('MED MD 121', 'A1')], now).items.map((i) => i.start.slice(0, 10));
  assert.ok(days.includes('2026-11-26'), 'Thanksgiving does not suspend the medical school timetable');
  assert.ok(days.some((d) => d > '2026-12-10'), 'nor does the CAS last day of classes end it');
});

test('item ids are unique and an unknown section is rejected', () => {
  const index = buildCourseIndex(campus());
  const { items } = expandSections(index, [sectionKey('CAS CS 112', 'A1'), sectionKey('CAS MA 123', 'A1')], now);
  assert.equal(new Set(items.map((i) => i.id)).size, items.length);
  assert.throws(() => expandSections(index, ['CAS CS 112|ZZ'], now), /No published section matches/);
  // Repeating a key must not double the meetings.
  const once = expandSections(index, [sectionKey('CAS CS 112', 'A1')], now).items.length;
  const twice = expandSections(index, [sectionKey('CAS CS 112', 'A1'), sectionKey('CAS CS 112', 'A1')], now).items.length;
  assert.equal(twice, once);
});
