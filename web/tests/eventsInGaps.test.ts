import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { CampusEvent, CampusLocation, ScheduleItem } from '../src/data/types.ts';
// eventsInGaps.ts imports without extensions: load through Vite.
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { freeWindows, eventsInGaps } = await vite.ssrLoadModule('/src/lib/eventsInGaps.ts') as typeof import('../src/lib/eventsInGaps.ts');
await vite.close();

// Wednesday 28 Oct 2026, Boston is UTC-4. Classes in CAS 10:10-11:00 and CDS 12:30-13:45.
const at = (hhmm: string, day = '2026-10-28') => Date.parse(`${day}T${hhmm}:00-04:00`);
const item = (id: string, start: string, end: string, locationId: string, day = '2026-10-28'): ScheduleItem =>
  ({ id, title: id, start: new Date(at(start, day)).toISOString(), end: new Date(at(end, day)).toISOString(), locationId, source: 'calendar' });
const loc = (id: string, kind: CampusLocation['kind']): CampusLocation => ({ id, name: id.toUpperCase(), short: id, kind, capacity: 100 });
const locations = [loc('cas', 'classroom'), loc('cds', 'classroom'), loc('warren', 'dorm'), loc('gsu', 'dining'), loc('fitrec', 'gym'), loc('mugar', 'library'), loc('marciano', 'dining')];
const walk = { 'cas>gsu': 168, 'cds>gsu': 336, 'cas>fitrec': 1260, 'cds>fitrec': 1680, 'mugar>warren': 1008, 'cds>marciano': 420, 'cas>warren': 840, 'gsu>warren': 1008 };
const geo = { positions: {}, walkMeters: walk };
const schedule = [item('CAS 101', '10:10', '11:00', 'cas'), item('CDS 112', '12:30', '13:45', 'cds')];
const event = (id: string, start: string, locationId: string | null, opts: { end?: string; day?: string; clubId?: string } = {}): CampusEvent => ({
  id, title: id, locationId, venue: locationId, start: new Date(at(start, opts.day)).toISOString(), end: opts.end ? new Date(at(opts.end, opts.day)).toISOString() : null,
  organizer: null, clubId: opts.clubId ?? null, source: 'club-ics', mapStatus: 'simulated' });

test('free windows around the imported classes, from now through the week', () => {
  const windows = freeWindows({ schedule, now: at('09:00'), homeLocationId: 'warren' });
  const today = windows.filter((w) => w.day === '2026-10-28');
  assert.deepEqual(today.map((w) => [w.start, w.end, w.from, w.next?.id ?? null]), [
    [at('09:00'), at('10:10'), 'warren', 'CAS 101'],
    [at('11:00'), at('12:30'), 'cas', 'CDS 112'],
    [at('13:45'), at('23:00'), 'cds', null],
  ]);
  // Days without classes are free 8 AM to 11 PM, from home.
  assert.equal(windows.length, 3 + 6);
  const thursday = windows.find((w) => w.day === '2026-10-29')!;
  assert.deepEqual([thursday.start, thursday.end, thursday.from], [at('08:00', '2026-10-29'), at('23:00', '2026-10-29'), 'warren']);
  // During a class the window starts when it ends.
  assert.equal(freeWindows({ schedule, now: at('10:30'), homeLocationId: 'warren' })[0].start, at('11:00'));
});

test('events that start in a free window, are in walking range, and leave time before the next class; followed clubs first', () => {
  const now = at('09:00');
  const events = [
    event('Club lunch', '11:30', 'gsu', { end: '12:30', clubId: 'followed' }), // 2 min from CAS, 4 min to CDS: stay until 12:21
    event('Too far to stay', '12:00', 'fitrec', { end: '13:00' }), // 15 min there, 20 min to CDS: must leave 12:05
    event('During class', '10:30', 'gsu'),
    event('Unmapped', '15:00', null),
    event('After class', '14:00', 'marciano'),
    event('Thursday talk', '18:00', 'mugar', { day: '2026-10-29' }),
    event('No route', '15:00', 'mugar'),
    event('Already started', '08:30', 'gsu'),
    event('Next week', '18:00', 'mugar', { day: '2026-11-05' }),
  ];
  const fits = eventsInGaps({ events, windows: freeWindows({ schedule, now, homeLocationId: 'warren' }), followedClubIds: ['followed'], geo, locations, now });
  assert.deepEqual(fits.map((f) => f.event.id), ['Club lunch', 'After class', 'Thursday talk']);
  const [lunch, after] = fits;
  assert.equal(lunch.followed, true);
  assert.deepEqual([lunch.walkThere, lunch.walkBack, lunch.leaveBy, lunch.minutesThere], [2, 4, at('12:21'), 51]);
  assert.equal(lunch.window.next?.id, 'CDS 112');
  assert.deepEqual([after.walkThere, after.walkBack, after.leaveBy, after.minutesThere], [5, null, null, 60]);
  // A start too soon to walk to doesn't fit: at 11:01 from CAS, GSU at 11:02 is 2 min away.
  const soon = eventsInGaps({ events: [event('Soon', '11:01', 'gsu')], windows: freeWindows({ schedule, now, homeLocationId: 'warren' }), followedClubIds: [], geo, locations, now });
  assert.equal(soon.length, 0);
  // No home and no class before: nowhere to walk from.
  assert.equal(eventsInGaps({ events: [event('Morning', '09:30', 'gsu')], windows: freeWindows({ schedule, now, homeLocationId: null }), followedClubIds: [], geo, locations, now }).length, 0);
});
