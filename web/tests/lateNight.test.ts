import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { TonightInput } from '../src/lib/lateNight.ts';
import type { Timetable, TransitContext } from '../src/lib/transitDeparture.ts';
import type { CampusLocation, ScheduleItem } from '../src/data/types.ts';
// lateNight.ts imports without extensions: load through Vite.
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { planTonight, nightMode, lastRideHome, serviceDateFor } = await vite.ssrLoadModule('/src/lib/lateNight.ts') as typeof import('../src/lib/lateNight.ts');
const { bostonWallTime } = await vite.ssrLoadModule('/src/lib/placeHours.ts') as typeof import('../src/lib/placeHours.ts');
const { departureBasisLabel, exclusionLabel } = await vite.ssrLoadModule('/src/lib/transitDeparture.ts') as typeof import('../src/lib/transitDeparture.ts');
await vite.close();

// Wednesday 28 Oct 2026, Boston is UTC-4.
const at = (hhmm: string, day = '2026-10-28') => Date.parse(`${day}T${hhmm}:00-04:00`);
const item = (id: string, start: string, end: string, locationId: string, day = '2026-10-28'): ScheduleItem =>
  ({ id, title: id, start: new Date(at(start, day)).toISOString(), end: new Date(at(end, day)).toISOString(), locationId, source: 'calendar' });
const loc = (id: string, kind: CampusLocation['kind']): CampusLocation => ({ id, name: id.toUpperCase(), short: id, kind, capacity: 100 });
const locations = [loc('cas', 'classroom'), loc('warren', 'dorm'), loc('marciano', 'dining'), loc('gsu', 'dining'), loc('mugar', 'library'), loc('fitrec', 'gym'), loc('far', 'library')];
const walk = { 'cas>gsu': 168, 'cas>marciano': 336, 'cas>mugar': 168, 'cas>fitrec': 1260, 'cas>far': 3000, 'cas>warren': 840,
  'gsu>warren': 1008, 'mugar>warren': 1008, 'fitrec>warren': 840, 'marciano>warren': 840 };
const open = (from: number, to: number, date = '2026-10-28') => ({ date, windows: [[from * 3600, to * 3600]] as [number, number][], sourceUrl: 'https://bu.edu/hours', qualifier: null });
const hours = {
  marciano: { hours: [open(7, 21)], hoursStatus: 'published' },
  gsu: { hours: [open(7, 23)], hoursStatus: 'published' },
  mugar: { hours: [open(8, 26)], hoursStatus: 'published' }, // until 2 AM
  fitrec: { hours: [open(6, 22.5)], hoursStatus: 'published' }, // closes 10:30 PM: 15 min walk leaves 15 min
  far: { hours: [open(8, 26)], hoursStatus: 'published' },
};
const forecasts = [{ locationId: 'mugar', day: '2026-10-28', hours: Array.from({ length: 24 }, (_, hour) => ({ hour, share: 0.4 })) }];

// Reference week Mon 26 Oct – Sun 1 Nov 2026, as in transit-schedule.json; weekday 2 = Wednesday.
const dates = ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'];
const sec = (h: number, m: number) => h * 3600 + m * 60;
type Trip = Timetable['schedule']['trips'][number];
const trip = (id: string, depart: number, ride = 300, weekdays = [0, 1, 2, 3, 4]): Trip => ({ id, route: 'Green-B', direction: 0, weekdays,
  stops: [{ stop: 'p-cas', arrival: depart, departure: depart }, { stop: 'p-warren', arrival: depart + ride, departure: depart + ride }] });
const schedule = (trips: Trip[], feed = { start: '20261014', end: '20261212', version: 'test feed' }): Timetable['schedule'] => ({
  schemaVersion: 1, referenceWeekStart: '2026-10-26', dates, priorDate: '2026-10-25', feed, sourceUrl: 'https://example.test/gtfs.zip',
  stops: { 'p-cas': { position: [0, 0], mapStopId: 'S-cas' }, 'p-warren': { position: [0, 0], mapStopId: 'S-warren' } }, trips,
});
// BU Central is a 2 min walk from CAS and Mugar; Warren is 1 min from its stop.
const stops = { 'S-cas': { name: 'BU Central', walkMeters: { cas: 140, mugar: 140, gsu: 168 } }, 'S-warren': { name: 'Warren Stop', walkMeters: { warren: 84 } } };
const routes = { 'Green-B': { name: 'Green Line B', directions: ['Westbound', 'Eastbound'] as [string, string] } };
const transit: TransitContext = {
  timetables: [
    { operator: 'mbta', schedule: schedule([trip('t-2330', sec(23, 30)), trip('t-0040', sec(24, 40)), trip('t-weekend', sec(25, 30), 300, [5, 6])]) },
    { operator: 'bu-shuttle', schedule: schedule([trip('s-late', sec(25, 0))], { start: '20240830', end: '20251231', version: 'baseline' }) },
  ],
  stops, routes,
};
const base: TonightInput = { schedule: [item('Night seminar', '19:00', '21:30', 'cas')], locations, geo: { positions: {}, walkMeters: walk }, hours, forecasts,
  homeLocationId: 'warren', now: at('22:00'), transit };

test('late-night mode after 9 PM, or once classes are over; not while classes are left', () => {
  const day = [item('CAS 101', '10:10', '11:00', 'cas'), item('CDS 112', '12:30', '13:45', 'cas')];
  assert.equal(nightMode(day, at('22:00')), 'late');
  assert.equal(nightMode(day, at('02:00', '2026-10-29')), 'late');
  assert.equal(nightMode(day, at('11:05')), null);
  assert.equal(nightMode(day, at('15:00')), 'classes-done');
  assert.equal(nightMode([item('Thu', '10:00', '11:00', 'cas', '2026-10-29')], at('15:00')), 'no-classes-today');
  assert.equal(nightMode([], at('15:00')), null, 'no imported schedule: only at night');
  assert.equal(nightMode([], at('21:00')), 'late');
});

test('what is still open by published hours, open latest first, with walks from the last class', () => {
  const plan = planTonight(base);
  assert.equal(plan.from, 'cas');
  assert.equal(plan.fromSource, 'class');
  // Marciano closed at 9; "far" is past the walking limit; FitRec closes 15 min after you'd arrive (kept, last).
  assert.deepEqual(plan.options.map((o) => o.locationId), ['mugar', 'gsu', 'fitrec']);
  const [mugar, gsu, fitrec] = plan.options;
  assert.equal(mugar.closesAt, at('02:00', '2026-10-29'));
  assert.equal(mugar.walkMinutes, 2);
  assert.equal(mugar.crowd, 0.4);
  assert.equal(mugar.hoursSourceUrl, 'https://bu.edu/hours');
  assert.equal(mugar.walkHomeMinutes, 12);
  assert.equal(gsu.closesAt, at('23:00'));
  assert.equal(gsu.crowd, null, 'no projection: no figure');
  assert.equal(fitrec.closesAt, at('22:30'));
  // Ten minutes later FitRec no longer leaves 15 minutes after the walk.
  assert.equal(planTonight({ ...base, now: at('22:10') }).options.some((o) => o.locationId === 'fitrec'), false);
  // No hours published, no listing.
  assert.equal(planTonight({ ...base, hours: { ...hours, mugar: { hours: [], hoursStatus: 'published' } } }).options.some((o) => o.locationId === 'mugar'), false);
});

test('two hours after the last class the walk starts from home; with no home, nothing to plan', () => {
  const plan = planTonight({ ...base, now: at('23:45') });
  assert.equal(plan.fromSource, 'home');
  assert.equal(plan.rideHome?.status, 'at-home');
  assert.equal(planTonight({ ...base, homeLocationId: null, schedule: [] }).options.length, 0);
});

test('the last published T home: the latest trip still catchable, past midnight on the same service day', () => {
  const ride = planTonight(base).rideHome!;
  assert.equal(ride.status, 'ride');
  const option = ride.option!;
  assert.equal(option.trip, 't-0040');
  assert.equal(option.departure, at('00:40', '2026-10-29'));
  assert.equal(option.leaveBy, at('00:36', '2026-10-29')); // 2 min at the stop + 2 min walk
  assert.deepEqual([option.boardStop.name, option.alightStop.name, option.routeName], ['BU Central', 'Warren Stop', 'Green Line B']);
  assert.equal(option.walkFromStopMinutes, 1);
  // The 2024-25 BU Shuttle baseline doesn't cover the date: left out, and said so.
  assert.deepEqual(ride.excluded.map((e) => e.operator), ['bu-shuttle']);
  assert.match(exclusionLabel(ride.excluded[0]), /BU Shuttle timetable not used/);
  assert.match(departureBasisLabel(option), /MBTA timetable for Wed, Oct 28/);
  // Each open place carries its own last ride home.
  assert.equal(planTonight(base).options[0].rideHome.option?.trip, 't-0040');
  // At 00:30 it is still Wednesday's service; at 00:37 the last one is gone.
  assert.equal(serviceDateFor(at('00:30', '2026-10-29')), '2026-10-28');
  assert.equal(lastRideHome({ from: 'cas', home: 'warren', now: at('00:30', '2026-10-29'), transit }).option?.trip, 't-0040');
  assert.equal(lastRideHome({ from: 'cas', home: 'warren', now: at('00:37', '2026-10-29'), transit }).status, 'none-left');
  // A place whose nearby stops no trip links to home's says so, rather than "the last one left".
  const elsewhere: TransitContext = { ...transit, stops: { ...stops, 'S-gsu': { name: 'GSU Stop', walkMeters: { gsu: 84 } }, 'S-cas': { name: 'BU Central', walkMeters: { cas: 140 } } } };
  assert.equal(lastRideHome({ from: 'gsu', home: 'warren', now: at('22:00'), transit: elsewhere }).status, 'no-direct');
  // Without stops near the place, or without timetables, no ride is offered.
  assert.equal(lastRideHome({ from: 'fitrec', home: 'warren', now: at('22:00'), transit }).status, 'no-stops');
  assert.equal(lastRideHome({ from: 'cas', home: 'warren', now: at('22:00'), transit: undefined }).status, 'not-covered');
});

test('the shuttle is used when its feed covers the date, and the reference week stands in by weekday', () => {
  const shuttle: TransitContext = { ...transit, timetables: [{ operator: 'bu-shuttle', schedule: schedule([trip('s-late', sec(25, 0))]) }] };
  const ride = lastRideHome({ from: 'cas', home: 'warren', now: Date.parse('2026-11-04T22:00:00-05:00'), transit: shuttle });
  assert.equal(ride.option?.operator, 'bu-shuttle');
  assert.equal(ride.option?.departure, Date.parse('2026-11-05T01:00:00-05:00')); // EST after the change
  assert.equal(ride.option?.timetable.exactDate, false);
  assert.match(departureBasisLabel(ride.option!), /reference week/);
});

test('Boston wall-clock times across the fall-back change', () => {
  assert.equal(bostonWallTime('2026-10-28', 22 * 60), Date.parse('2026-10-29T02:00:00Z'));
  assert.equal(bostonWallTime('2026-11-01', 12 * 60), Date.parse('2026-11-01T17:00:00Z'));
  assert.equal(bostonWallTime('2026-10-28', 26 * 60), Date.parse('2026-10-29T06:00:00Z'));
});
