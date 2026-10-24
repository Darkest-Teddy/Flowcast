import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const { effectiveMeetingIntervals } = await import('../src/data/academicCalendar.ts');
const { campusOfferingWeights } = await import('../src/sim/population.ts');
const calendar = JSON.parse(readFileSync(new URL('../../data-pipeline/output/academic_calendar.json', import.meta.url))).calendar;
const interval = weekday => ({ weekday, startSec: weekday * 86400 + 32400, endSec: weekday * 86400 + 36000 });
const meeting = (extra = {}) => ({ courseCode: 'CAS MA 123', section: 'A1', calendarRestricted: false, roomCapacity: 30,
  intervals: [interval(0), { weekday: 1, startSec: 86400 + 39600, endSec: 86400 + 43200 }], ...extra });
const data = (extra = {}) => ({ term: 'FALL 2026', referenceWeekStart: '2026-10-12', academicCalendar: calendar, ...extra });

test('published October exception suspends Monday and uses its schedule on Tuesday', () => {
  assert.deepEqual(effectiveMeetingIntervals(meeting(), data()), [interval(1)]);
  assert.deepEqual(effectiveMeetingIntervals(meeting({ validTo: '2026-10-12' }), data()), []);
  assert.deepEqual(effectiveMeetingIntervals(meeting({ validFrom: '2026-10-13' }), data()), [interval(1)]);
});

test('recesses, term bounds, and exam periods do not run ordinary classes', () => {
  const daily = meeting({ intervals: Array.from({ length: 7 }, (_, weekday) => interval(weekday)) });
  assert.deepEqual(effectiveMeetingIntervals(daily, data({ referenceWeekStart: '2026-11-23' })).map(i => i.weekday), [0, 1]);
  assert.deepEqual(effectiveMeetingIntervals(daily, data({ referenceWeekStart: '2026-12-14' })), []);
  assert.deepEqual(effectiveMeetingIntervals(daily, data({ referenceWeekStart: '2026-08-24' })), []);
  assert.deepEqual(effectiveMeetingIntervals(daily, data({ term: 'SPRING 2027', referenceWeekStart: '2027-03-08' })), []);
});

test('school-specific and unknown calendars retain source schedules', () => {
  for (const courseCode of ['LAW JD 101', 'MED MD 121', 'GMS AN 700', 'SDM RS 100', 'SPH PH 700', 'SSW HB 720', 'OTHER 123']) {
    const row = meeting({ courseCode });
    assert.deepEqual(effectiveMeetingIntervals(row, data()), row.intervals);
  }
  const row = meeting();
  assert.deepEqual(effectiveMeetingIntervals(row, data({ term: 'FALL 2025' })), row.intervals);
});

test('campus weights count actual calendar meetings instead of holiday timetable rows', () => {
  const base = { campuses: [{ id: 'charles-river' }], locations: [{ id: 'cas', campus: 'charles-river' }] };
  const source = data({ locations: { cas: { id: 'cas', meetings: [meeting({ intervals: [interval(1)] })] } } });
  assert.deepEqual(campusOfferingWeights(base, source), { 'charles-river': { undergraduate: 0, graduate: 0 } });
  source.locations.cas.meetings = [meeting({ intervals: [interval(0)] })];
  assert.deepEqual(campusOfferingWeights(base, source), { 'charles-river': { undergraduate: 30, graduate: 0 } });
});
