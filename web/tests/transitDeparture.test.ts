import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { DepartureInput } from '../src/lib/departure.ts';
import type { Timetable, TransitContext } from '../src/lib/transitDeparture.ts';
import type { CampusLocation, ScheduleItem } from '../src/data/types.ts';
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { getDeparturePlan } = await vite.ssrLoadModule('/src/lib/departure.ts') as typeof import('../src/lib/departure.ts');
const { departureBasisLabel, exclusionLabel, referenceDateFor, serviceEpoch } = await vite.ssrLoadModule('/src/lib/transitDeparture.ts') as typeof import('../src/lib/transitDeparture.ts');
const { departureAnswer } = await vite.ssrLoadModule('/src/lib/departureAnswer.ts') as typeof import('../src/lib/departureAnswer.ts');
await vite.close();

// Reference week Mon 26 Oct – Sun 1 Nov 2026 (weekday 0 = Monday), as in transit-schedule.json.
const dates = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const at = (h: number, m: number) => h * 3600 + m * 60;
type Trip = Timetable['schedule']['trips'][number];
const trip = (id: string, depart: number, arrive: number, route = 'Green-B', weekdays = [0, 1, 2, 3, 4]): Trip => ({ id, route, direction: 1, weekdays,
  stops: [{ stop: 'p-dorm', arrival: depart, departure: depart }, { stop: 'p-mid', arrival: depart + 60, departure: depart + 60 }, { stop: 'p-hall', arrival: arrive, departure: arrive }] });
const schedule = (trips: Trip[], feed = { start: '20261014', end: '20261212', version: 'test feed' }): Timetable['schedule'] => ({
  schemaVersion: 1, referenceWeekStart: '2026-10-26', dates, priorDate: '2026-10-25', feed, sourceUrl: 'https://example.test/gtfs.zip',
  stops: { 'p-dorm': { position: [0, 0], mapStopId: 'S-dorm' }, 'p-mid': { position: [0, 0], mapStopId: null }, 'p-hall': { position: [0, 0], mapStopId: 'S-hall' } },
  trips,
});
// Bundled stop walks: 140 m (2 min) from the dorm, 84 m (1 min) to the hall.
const stops = { 'S-dorm': { name: 'Dorm Station', walkMeters: { dorm: 140 } }, 'S-hall': { name: 'Hall Station', walkMeters: { hall: 84 } } };
const routes = { 'Green-B': { name: 'Green Line B', directions: ['Outbound', 'Inbound'] as [string, string] } };
// Mon 26 Oct 2026 10:00 EDT; 5 min buffer means arriving by 9:55.
const lecture: ScheduleItem = { id: 'lecture', title: 'BI 108', start: '2026-10-26T14:00:00Z', end: '2026-10-26T15:00:00Z', locationId: 'hall', source: 'calendar' };
const trips = [trip('t-940', at(9, 40), at(9, 48)), trip('t-947', at(9, 47), at(9, 53)), trip('t-950', at(9, 50), at(9, 54))];
const mbta = (list = trips): TransitContext => ({ timetables: [{ operator: 'mbta', schedule: schedule(list) }], stops, routes });
const base: DepartureInput = { items: [lecture], locations: [{ id: 'dorm' }, { id: 'hall' }, { id: 'lonely' }], homeLocationId: 'dorm',
  now: Date.parse('2026-10-26T13:00:00Z'), geo: { positions: {}, walkMeters: { 'dorm>hall': 2016 } }, transit: mbta() };
const plan = (overrides: Partial<DepartureInput> = {}) => getDeparturePlan({ ...base, ...overrides });
const iso = (ms: number) => new Date(ms).toISOString();

test('picks the latest published trip that still arrives before the buffered class start, with both walks', () => {
  const result = plan();
  assert.equal(result.walkMinutes, 24);
  assert.equal(iso(result.leaveBy!), '2026-10-26T13:31:00.000Z');
  const transit = result.transit!;
  assert.equal(transit.status, 'offered');
  assert.equal(transit.reason, 'leave-later');
  const option = transit.option!;
  // 9:50 arrives 9:54, +30 s alighting +1 min walk = 9:55:30, after the 9:55 target: not chosen.
  assert.equal(option.trip, 't-947');
  assert.equal(option.routeName, 'Green Line B');
  assert.equal(option.toward, 'Inbound');
  assert.deepEqual([option.boardStop.name, option.alightStop.name], ['Dorm Station', 'Hall Station']);
  assert.deepEqual([option.walkToStopMinutes, option.rideMinutes, option.walkFromStopMinutes], [2, 6, 1]);
  assert.equal(iso(option.departure), '2026-10-26T13:47:00.000Z');
  // Leave by = departure − 2 min at the stop − 2 min walk.
  assert.equal(iso(option.leaveBy), '2026-10-26T13:43:00.000Z');
  assert.equal(iso(option.atClass), '2026-10-26T13:54:30.000Z');
  assert.equal(option.marginMinutes, 5);
  assert.equal(transit.versusWalkMinutes, 12);
  assert.ok(option.atClass <= result.arrivalTarget!);
});

test('a trip already missed is skipped for the next one that fits', () => {
  const option = plan({ now: Date.parse('2026-10-26T13:43:01Z') }).transit!.option;
  assert.equal(option, null);
  assert.equal(plan({ now: Date.parse('2026-10-26T13:43:01Z') }).transit!.status, 'no-trip');
  assert.equal(plan({ now: Date.parse('2026-10-26T13:43:00Z') }).transit!.option!.trip, 't-947');
});

test('falls back to walking when transit is not better, but cuts a long walk when it walks less', () => {
  const short = plan({ geo: { positions: {}, walkMeters: { 'dorm>hall': 336 } } });
  assert.equal(short.walkMinutes, 4);
  assert.equal(short.transit!.status, 'walking-better');
  assert.equal(short.transit!.reason, null);
  assert.equal(iso(short.leaveBy!), '2026-10-26T13:51:00.000Z');
  // Only an early trip: leaving at 9:16 by train is earlier than walking at 9:31, but a 24 min walk becomes 3 min on foot.
  const early = plan({ transit: mbta([trip('t-920', at(9, 20), at(9, 28))]) }).transit!;
  assert.equal(early.status, 'offered');
  assert.equal(early.reason, 'less-walking');
  assert.equal(early.versusWalkMinutes, -15);
  // A 19 min walk is not long: the same earlier trip is not offered.
  assert.equal(plan({ geo: { positions: {}, walkMeters: { 'dorm>hall': 1596 } }, transit: mbta([trip('t-920', at(9, 20), at(9, 28))]) }).transit!.status, 'walking-better');
});

test('offers transit when there is no walking route (another campus)', () => {
  const result = plan({ geo: { positions: {}, walkMeters: {} } });
  assert.equal(result.routeStatus, 'no-route');
  assert.equal(result.leaveBy, null);
  assert.equal(result.transit!.status, 'offered');
  assert.equal(result.transit!.reason, 'no-walk-route');
  assert.equal(result.transit!.versusWalkMinutes, null);
});

test('no-service times: night classes, weekends without trips, and places with no stop route', () => {
  assert.equal(plan({ items: [{ ...lecture, start: '2026-10-26T07:30:00Z', end: '2026-10-26T08:30:00Z' }], now: Date.parse('2026-10-26T05:00:00Z') }).transit!.status, 'no-trip');
  // Saturday 31 Oct: these trips run Monday–Friday only.
  assert.equal(plan({ items: [{ ...lecture, start: '2026-10-31T14:00:00Z', end: '2026-10-31T15:00:00Z' }] }).transit!.status, 'no-trip');
  assert.equal(plan({ items: [{ ...lecture, locationId: 'lonely' }], geo: { positions: {}, walkMeters: {} } }).transit!.status, 'no-stops');
  // A trip that reaches the stop before the dorm stop (wrong direction) is never ridden backwards.
  const backwards: Trip = { ...trip('t-back', at(9, 40), at(9, 48)), stops: [...trip('x', at(9, 40), at(9, 48)).stops].reverse() };
  assert.equal(plan({ transit: mbta([backwards]) }).transit!.status, 'no-trip');
  // Without timetables the plan stays walking only.
  assert.equal(plan({ transit: undefined }).transit, null);
});

test('labels the exact timetable date, a weekday-aligned reference date, and dates outside the feed', () => {
  const exact = plan().transit!.option!;
  assert.equal(exact.departureBasis, 'timetable');
  assert.equal(exact.timetable.exactDate, true);
  assert.equal(departureBasisLabel(exact), 'MBTA timetable for Mon, Oct 26');
  // Monday 2 Nov is inside the feed but not the collected week: Monday 26 Oct's service, said plainly.
  const nextWeek = plan({ items: [{ ...lecture, start: '2026-11-02T15:00:00Z', end: '2026-11-02T16:00:00Z' }], now: Date.parse('2026-11-02T14:00:00Z') }).transit!.option!;
  assert.equal(nextWeek.timetable.referenceDate, '2026-10-26');
  assert.equal(nextWeek.timetable.exactDate, false);
  assert.equal(iso(nextWeek.departure), '2026-11-02T14:47:00.000Z'); // 9:47 EST after the clocks change
  assert.match(departureBasisLabel(nextWeek), /Mon, Oct 26 of the reference week of Oct 26 applied by weekday, not date-specific service/);
  const outside = plan({ items: [{ ...lecture, start: '2027-01-04T15:00:00Z', end: '2027-01-04T16:00:00Z' }], now: Date.parse('2027-01-04T14:00:00Z') }).transit!;
  assert.equal(outside.status, 'not-covered');
  assert.equal(outside.option, null);
  assert.equal(exclusionLabel(outside.excluded[0]), 'MBTA timetable not used: its feed covers Oct 14, 2026–Dec 12, 2026.');
});

test('a timetable whose feed does not cover the date is never used, even with a faster trip (BU Shuttle 2024-25 baseline)', () => {
  const shuttle = schedule([trip('bu-952', at(9, 52), at(9, 53), 'BU-1', [0, 1, 2, 3, 4, 5, 6])], { start: '20240830', end: '20251231', version: 'BU 2024-25' });
  const context: TransitContext = { ...mbta(), timetables: [...mbta().timetables, { operator: 'bu-shuttle', schedule: shuttle }] };
  const transit = plan({ transit: context }).transit!;
  assert.equal(transit.option!.operator, 'mbta');
  assert.deepEqual(transit.excluded.map((row) => row.operator), ['bu-shuttle']);
  assert.match(exclusionLabel(transit.excluded[0]), /BU Shuttle timetable not used: its feed covers Aug 30, 2024–Dec 31, 2025/);
  // The same file with current coverage would be ridden: BU Shuttle names itself.
  const current = { ...shuttle, feed: { start: '20261014', end: '20261212', version: 'BU current' } };
  const shuttleOption = plan({ transit: { ...context, timetables: [{ operator: 'bu-shuttle', schedule: current }] } }).transit!.option!;
  assert.equal(shuttleOption.routeName, 'BU Shuttle');
  assert.match(departureBasisLabel(shuttleOption), /^BU Shuttle timetable for Mon, Oct 26$/);
});

test('a fresh matching prediction makes the departure live; a stale one stays a timetable time', () => {
  const now = Date.parse('2026-10-26T13:30:00Z');
  const prediction = { trip: 't-947', route: 'Green-B', direction: 1 as const, stop: 'S-dorm', time: Date.parse('2026-10-26T13:46:00Z') };
  const live = plan({ now, transit: { ...mbta(), live: [{ ...prediction, observedAt: now - 30_000 }] } }).transit!.option!;
  assert.equal(live.departureBasis, 'live');
  assert.equal(iso(live.leaveBy), '2026-10-26T13:42:00.000Z');
  assert.equal(iso(live.atClass), '2026-10-26T13:53:30.000Z');
  assert.equal(departureBasisLabel(live), 'Live MBTA prediction; ride time from the timetable');
  const stale = plan({ now, transit: { ...mbta(), live: [{ ...prediction, observedAt: now - 91_000 }] } }).transit!.option!;
  assert.equal(stale.departureBasis, 'timetable');
  assert.equal(stale.liveStale, true);
  assert.equal(iso(stale.leaveBy), '2026-10-26T13:43:00.000Z');
  assert.match(departureBasisLabel(stale), /live prediction too old to use/);
  // A prediction for another trip id never relabels this one.
  assert.equal(plan({ now, transit: { ...mbta(), live: [{ ...prediction, trip: 'other', observedAt: now }] } }).transit!.option!.departureBasis, 'timetable');
  // A future observation time is not fresh (liveFreshness.ts).
  assert.equal(plan({ now, transit: { ...mbta(), live: [{ ...prediction, observedAt: now + 5_000 }] } }).transit!.option!.departureBasis, 'timetable');
});

test('GTFS service times keep the Boston wall clock on DST days; reference dates align by weekday', () => {
  assert.equal(iso(serviceEpoch('2026-10-26', at(8, 0))), '2026-10-26T12:00:00.000Z');
  assert.equal(iso(serviceEpoch('2026-11-01', at(8, 0))), '2026-11-01T13:00:00.000Z');
  const data = schedule([]);
  assert.deepEqual(referenceDateFor(data, '2026-10-25'), { referenceDate: '2026-11-01', exactDate: false });
  assert.deepEqual(referenceDateFor(data, '2026-10-28'), { referenceDate: '2026-10-28', exactDate: true });
  assert.equal(referenceDateFor(data, '2026-10-13'), null);
  assert.equal(referenceDateFor(data, 'not a date'), null);
});

test('leave-by answer gives both ways there with their basis', () => {
  const locations: CampusLocation[] = [
    { id: 'dorm', name: 'Dorm', short: 'Dorm', kind: 'dorm', capacity: 100 },
    { id: 'hall', name: 'Hall', short: 'Hall', kind: 'classroom', capacity: 100 },
  ];
  const answer = departureAnswer([lecture], locations, base.geo, 'dorm', base.now, mbta());
  assert.match(answer.text, /leave by Oct 26, 9:31 AM EDT: 24 min walking/);
  assert.match(answer.text, /Or by Green Line B: leave by Oct 26, 9:43 AM EDT, walk 2 min to Dorm Station, take the 9:47 AM departure Inbound to Hall Station, then walk 1 min, arriving 9:54 AM, 5 min before class \(MBTA timetable for Mon, Oct 26\)/);
  assert.deepEqual(answer.rows.map((row) => row.id), ['walk', 'transit']);
  assert.match(answer.rows[1].detail, /timetable$/);
  // Walking better: one sentence, no transit, no rows.
  const walking = departureAnswer([lecture], locations, { positions: {}, walkMeters: { 'dorm>hall': 336 } }, 'dorm', base.now, mbta());
  assert.doesNotMatch(walking.text, /Green Line/);
  assert.deepEqual(walking.rows, []);
  // No walking route: transit is the answer, said as the only way.
  const away = departureAnswer([lecture], locations, { positions: {}, walkMeters: {} }, 'dorm', base.now, mbta());
  assert.match(away.text, /By Green Line B: leave by/);
  const none = departureAnswer([lecture], locations, { positions: {}, walkMeters: {} }, 'dorm', base.now, mbta([]));
  assert.match(none.text, /No saved walking route or published trip/);
});
