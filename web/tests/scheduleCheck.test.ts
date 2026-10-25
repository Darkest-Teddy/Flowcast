import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { Timetable, TransitContext } from '../src/lib/transitDeparture.ts';
import type { CampusGeo, CampusLocation, ScheduleItem } from '../src/data/types.ts';
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { checkSchedule, summarizeScheduleCheck, campusArea, dayPhrases, firstClassDay, weekOfLabel } = await vite.ssrLoadModule('/src/lib/scheduleCheck.ts') as typeof import('../src/lib/scheduleCheck.ts');
await vite.close();

const locations: CampusLocation[] = [
  { id: 'cas', name: 'College of Arts & Sciences', short: 'CAS', kind: 'classroom', capacity: 400 },
  { id: 'cds', name: 'Center for Computing & Data Sciences', short: 'CDS', kind: 'classroom', capacity: 300 },
  { id: 'bumc-sph', name: 'School of Public Health', short: 'SPH', kind: 'classroom', capacity: 200 },
  { id: 'warren', name: 'Warren Dining', short: 'Warren', kind: 'dining', capacity: 500 },
];
// 84 m a minute: 1008 m is a 12 min walk, 3360 m is 40 min.
const geo: CampusGeo = { positions: {}, walkMeters: { 'cas>cds': 1008, 'bumc-sph>cas': 3360 } };
// Tuesday 27 Oct 2026, EDT (UTC-4).
const at = (hhmm: string, day = '2026-10-27') => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), h + 4, m)).toISOString();
};
let n = 0;
const cls = (locationId: string, start: string, end: string, day?: string, extra: Partial<ScheduleItem> = {}): ScheduleItem =>
  ({ id: `c${n++}`, title: `Class ${n}`, locationId, start: at(start, day), end: at(end, day), source: 'calendar', ...extra });
const profile = { lunchTime: '12:00', dinnerTime: '18:00' };
const run = (items: ScheduleItem[], extra: Partial<Parameters<typeof checkSchedule>[0]> = {}) =>
  checkSchedule({ items, locations, geo, profile, fromDay: '2026-10-26', ...extra });
const tuesday = (result: ReturnType<typeof checkSchedule>) => result.days.find((d) => d.day === '2026-10-27')!;

test('a walk that nearly uses up the gap is a tight transfer, said in plain times', () => {
  const day = tuesday(run([cls('cas', '10:10', '11:00'), cls('cds', '11:15', '12:05')]));
  assert.equal(day.weekday, 'Tuesday');
  assert.equal(day.transfers.length, 1);
  const t = day.transfers[0];
  assert.equal(t.kind, 'tight');
  assert.deepEqual([t.gapMinutes, t.walkMinutes, t.spareMinutes], [15, 12, 3]);
  assert.equal(t.text, 'CAS 10:10–11:00 AM then CDS 11:15 AM: 12 min walk, 3 min to spare');
  assert.equal(t.crossCampus, null);
});

test('a comfortable transfer and a same-building pair are not flagged', () => {
  const day = tuesday(run([cls('cas', '9:00', '9:50'), cls('cds', '10:30', '11:20'), cls('cds', '11:25', '12:15')]));
  assert.equal(day.transfers.length, 0);
});

test('overlapping classes are flagged', () => {
  const day = tuesday(run([cls('cas', '9:00', '10:15'), cls('cds', '10:00', '11:00')]));
  assert.equal(day.transfers[0].kind, 'overlap');
  assert.match(day.transfers[0].text, /overlap by 15 min/);
});

const dates = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const sec = (h: number, m: number) => h * 3600 + m * 60;
const transit = (depart: number, arrive: number, feed = { start: '20261014', end: '20261212', version: 'test' }): TransitContext => {
  const schedule: Timetable['schedule'] = {
    schemaVersion: 1, referenceWeekStart: '2026-10-26', dates, priorDate: '2026-10-25', feed, sourceUrl: 'https://example.test/gtfs.zip',
    stops: { 'p-a': { position: [0, 0], mapStopId: 'S-a' }, 'p-b': { position: [0, 0], mapStopId: 'S-b' } },
    trips: [{ id: 't1', route: 'CT2', direction: 0, weekdays: [0, 1, 2, 3, 4],
      stops: [{ stop: 'p-a', arrival: depart, departure: depart }, { stop: 'p-b', arrival: arrive, departure: arrive }] }],
  };
  return { timetables: [{ operator: 'mbta', schedule }], stops: { 'S-a': { name: 'Kenmore', walkMeters: { cas: 84 } }, 'S-b': { name: 'BUMC', walkMeters: { 'bumc-sph': 84 } } },
    routes: { CT2: { name: 'Route 47', directions: null } } };
};

test('a cross-campus transfer walking cannot make names the campuses and a published trip that might', () => {
  const items = [cls('cas', '10:10', '11:00'), cls('bumc-sph', '11:20', '12:10')];
  const t = tuesday(run(items, { transit: transit(sec(11, 4), sec(11, 12)) })).transfers[0];
  assert.equal(t.kind, 'short');
  assert.deepEqual(t.crossCampus, { from: 'charles-river', to: 'medical' });
  assert.equal(t.spareMinutes, -20);
  assert.match(t.text, /40 min walk in a 20 min gap, 20 min short on foot \(Charles River to Medical campus\)/);
  assert.equal(t.transit!.status, 'offered');
  assert.match(t.transit!.text, /Route 47 trip may make it: leave by 11:01 AM, board at Kenmore 11:04 AM, at class 11:13 AM/);
});

test('a trip leaving before the earlier class ends is not offered; an uncovered date says so', () => {
  const items = [cls('cas', '10:10', '11:00'), cls('bumc-sph', '11:20', '12:10')];
  assert.equal(tuesday(run(items, { transit: transit(sec(10, 55), sec(11, 5)) })).transfers[0].transit!.status, 'no-trip');
  const old = tuesday(run(items, { transit: transit(sec(11, 4), sec(11, 12), { start: '20250101', end: '20250201', version: 'old' }) })).transfers[0];
  assert.equal(old.transit!.status, 'not-covered');
  assert.equal(old.transit!.text, 'No saved T or shuttle timetable covers this date.');
  // Without timetables it is still flagged, with no transit claim.
  assert.equal(tuesday(run(items)).transfers[0].transit, null);
});

test('without a saved route, a short gap between mapped buildings is flagged as unknown', () => {
  const day = tuesday(run([cls('cas', '10:10', '11:00'), cls('cds', '11:10', '12:00')], { geo: null }));
  assert.equal(day.transfers[0].kind, 'no-route');
  assert.equal(tuesday(run([cls('cas', '10:10', '11:00'), cls('cds', '11:40', '12:30')], { geo: null })).transfers.length, 0);
});

test('a day with classes through the lunch window has no meal break; walks count against the gap', () => {
  const items = [cls('cas', '10:30', '11:45'), cls('cds', '12:15', '13:30'), cls('cds', '13:35', '14:00')];
  const day = tuesday(run(items));
  // Window 10:45 AM–1:30 PM; the 30 min gap loses 12 min to the walk, leaving 18 < 20.
  assert.equal(day.meals.length, 1);
  assert.equal(day.meals[0].meal, 'lunch');
  assert.equal(day.meals[0].longestFreeMinutes, 18);
  assert.equal(day.meals[0].text, 'No 20 min lunch break between 10:45 AM and 1:30 PM (saved lunch 12:00 PM; longest free stretch 18 min)');
  // The same gap in one building leaves 30 minutes: a meal fits.
  assert.equal(tuesday(run([cls('cds', '10:30', '11:45'), cls('cds', '12:15', '13:30')])).meals.length, 0);
});

test('a cleared meal time is not checked; no profile uses stated defaults', () => {
  const items = [cls('cas', '10:30', '14:00'), cls('cas', '16:30', '19:30')];
  assert.deepEqual(tuesday(run(items, { profile: { lunchTime: '', dinnerTime: '18:00' } })).meals.map((m) => m.meal), ['dinner']);
  const defaults = tuesday(run(items, { profile: null })).meals;
  assert.deepEqual(defaults.map((m) => [m.meal, m.defaulted]), [['lunch', true], ['dinner', true]]);
  assert.match(defaults[0].text, /assumed lunch 12:00 PM/);
});

test('long days and rushed transitions come from first-to-last class and the fatigue model', () => {
  const items = [cls('cas', '9:00', '9:50'), cls('cds', '10:00', '10:50'), cls('cas', '11:00', '11:50'), cls('cas', '16:00', '18:15')];
  const day = tuesday(run(items));
  assert.equal(day.spanMinutes, 9 * 60 + 15);
  assert.equal(day.long, true);
  assert.equal(day.rushes, 2);
  assert.ok(dayPhrases(day).includes('9 h 15 min day'));
  assert.ok(!('score' in day));
});

test('unaccepted suggestions and other weeks are ignored', () => {
  const result = run([cls('cas', '10:10', '11:00'), cls('cds', '11:15', '12:05', undefined, { source: 'suggested' }), cls('cas', '9:00', '18:00', '2026-11-03')]);
  assert.equal(result.issueCount, 0);
  assert.equal(result.days.length, 7);
});

test('the one-line summary groups findings by weekday', () => {
  const items = [cls('cas', '10:10', '11:00'), cls('cds', '11:15', '12:05'), cls('cas', '12:20', '13:00'),
    cls('cas', '10:10', '11:00', '2026-10-29'), cls('cds', '11:15', '12:05', '2026-10-29'), cls('cas', '12:20', '13:00', '2026-10-29')];
  const result = run(items, { profile: { lunchTime: '', dinnerTime: '' } });
  assert.equal(summarizeScheduleCheck(result), '2 tight transfers on Tuesday and Thursday');
  assert.equal(summarizeScheduleCheck(run([cls('cas', '10:00', '11:00')])), 'No tight transfers, missed meal breaks or long days found.');
  assert.equal(summarizeScheduleCheck(run([])), 'No classes to check this week.');
});

test('campus areas come from building ids', () => {
  assert.deepEqual(['cas', 'bumc-sph', 'fenway-classroom'].map(campusArea), ['charles-river', 'medical', 'fenway']);
});

test('the checked week starts at the first class from today on', () => {
  const items = [cls('cas', '10:00', '11:00', '2026-10-20'), cls('cas', '10:00', '11:00', '2026-11-03')];
  assert.equal(firstClassDay(items, Date.parse('2026-10-25T16:00:00Z')), '2026-11-03');
  assert.equal(firstClassDay([], Date.parse('2026-10-25T16:00:00Z')), '2026-10-25');
  assert.equal(weekOfLabel('2026-11-03'), 'Nov 3');
});
