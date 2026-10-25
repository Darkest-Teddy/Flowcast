import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { BriefInput, VenueCalendar } from '../src/lib/morningBrief.ts';
import type { CampusEvent, CampusLocation, ScheduleItem } from '../src/data/types.ts';
// morningBrief.ts imports without extensions: load through Vite.
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { composeBrief, briefStartsOpen, weekdayName } = await vite.ssrLoadModule('/src/lib/morningBrief.ts') as typeof import('../src/lib/morningBrief.ts');
await vite.close();

// Wednesday 28 Oct 2026, Boston is UTC-4.
const at = (hhmm: string, day = '2026-10-28') => Date.parse(`${day}T${hhmm}:00-04:00`);
const item = (id: string, start: string, end: string, locationId: string, day = '2026-10-28'): ScheduleItem =>
  ({ id, title: id, start: new Date(at(start, day)).toISOString(), end: new Date(at(end, day)).toISOString(), locationId, source: 'calendar' });
const loc = (id: string, kind: CampusLocation['kind']): CampusLocation => ({ id, name: id.toUpperCase(), short: id, kind, capacity: 100 });
const locations = [loc('cas', 'classroom'), loc('cds', 'classroom'), loc('warren', 'dorm'), loc('marciano', 'dining'), loc('gsu', 'dining'), loc('mugar', 'library'), loc('sel', 'library')];
const walk = { 'cas>warren': 840, 'cas>cds': 420, 'cds>warren': 1260 };
const dated = (date: string, from: number, to: number | null) => ({ date, windows: (to === null ? [] : [[from * 3600, to * 3600]]) as [number, number][], sourceUrl: 'https://bu.edu/libraries', qualifier: null });
const hours = {
  marciano: { hours: [dated('2026-10-28', 7, 21)], hoursStatus: 'published' },
  gsu: { hours: [dated('2026-10-28', 11.75, 23)], hoursStatus: 'published' }, // opens 11:45: only 15 min of the 11 o'clock hour
  // Mugar usually closes 2 AM on Wednesdays; today 6 PM.
  mugar: { hours: [dated('2026-10-21', 8, 26), dated('2026-10-28', 8, 18), dated('2026-11-04', 8, 26)], hoursStatus: 'published' },
  // SEL keeps its usual hours; nothing to say.
  sel: { hours: [dated('2026-10-21', 9, 17), dated('2026-10-28', 9, 17)], hoursStatus: 'published' },
};
const curve = (id: string, shares: Record<number, number>) => ({ locationId: id, day: '2026-10-28', hours: Array.from({ length: 24 }, (_, hour) => ({ hour, share: shares[hour] ?? 0.9 })) });
const forecasts = [curve('marciano', { 11: 0.5, 12: 0.3, 13: 0.1 }), curve('gsu', { 11: 0.05, 12: 0.6 })];
const schedule = [item('CAS 101', '10:10', '11:00', 'cas'), item('CDS 112', '12:30', '13:45', 'cds'), item('Thu', '09:00', '10:00', 'cas', '2026-10-29')];
const event = (id: string, start: string, day = '2026-10-28'): CampusEvent => ({ id, title: id, locationId: null, venue: 'GSU', start: new Date(at(start, day)).toISOString(),
  end: null, organizer: null, clubId: null, source: 'terrier-central', mapStatus: 'location-unmapped' });
const venue = (id: string, name: string, capacities: Record<string, number>, nearestStations: string[]) => ({ id, name, position: [0, 0] as [number, number], locationId: null, capacities, defaultSetup: Object.keys(capacities)[0], nearestStations });
const calendar: VenueCalendar = {
  venues: [venue('fenway-park', 'Fenway Park', { ballpark: 37755 }, ['Kenmore', 'Fenway']), venue('agganis', 'Agganis Arena', { hockey: 6150 }, ['Babcock Street', 'Boston University Central']),
    venue('new-balance-field', 'New Balance Field', { field: 500 }, ['Babcock Street'])],
  events: [
    { id: 'mlb:1', venueId: 'fenway-park', name: 'Red Sox vs. Yankees', kind: 'mlb', setup: 'ballpark', start: '2026-10-28T19:10:00-04:00', end: '2026-10-28T22:10:00-04:00', source: 'mlb', sourceUrl: 'https://mlb.test/1' },
    { id: 'hockey:1', venueId: 'agganis', name: 'BU Hockey vs. Maine', kind: 'bu-hockey', setup: 'hockey', start: '2026-10-28T19:00:00-04:00', end: null, attendance: 5170, source: 'goterriers', sourceUrl: 'https://goterriers.test' },
    { id: 'play', venueId: 'agganis', name: 'Student play', kind: 'theatre', setup: null, start: '2026-10-28T20:00:00-04:00', end: null, source: 'campus', sourceUrl: '' },
    { id: 'fh', venueId: 'new-balance-field', name: 'Field Hockey', kind: 'bu-field-hockey', setup: 'field', start: '2026-10-28T18:00:00-04:00', end: null, source: 'goterriers', sourceUrl: '' },
    { id: 'mlb:2', venueId: 'fenway-park', name: 'Tomorrow', kind: 'mlb', setup: 'ballpark', start: '2026-10-29T19:10:00-04:00', end: null, source: 'mlb', sourceUrl: '' },
  ],
};
const input = (overrides: Partial<BriefInput> = {}): BriefInput => ({ schedule, locations, geo: { positions: {}, walkMeters: walk }, hours, forecasts,
  profile: { lunchTime: '12:00' }, homeLocationId: 'warren', campusEvents: [event('Today', '17:00'), event('Earlier', '07:00'), event('Tomorrow', '17:00', '2026-10-29')],
  venues: calendar, now: at('08:00'), ...overrides });

test('first class with its leave-by from home, then the next class once it has started', () => {
  const brief = composeBrief(input());
  assert.equal(brief.classCount, 2);
  assert.equal(brief.firstClass?.label, 'first');
  assert.equal(brief.firstClass?.item.id, 'CAS 101');
  assert.equal(brief.firstClass?.from, 'warren');
  assert.equal(brief.firstClass?.walkMinutes, 10);
  assert.equal(brief.firstClass?.leaveBy, at('09:55'));
  const later = composeBrief(input({ now: at('10:30') }));
  assert.equal(later.firstClass?.label, 'next');
  assert.equal(later.firstClass?.item.id, 'CDS 112');
  assert.equal(later.firstClass?.from, 'cas');
  assert.equal(later.firstClass?.leaveBy, at('12:20'));
  assert.equal(composeBrief(input({ now: at('15:00') })).firstClass, null);
  // No home building: the class, but no leave-by.
  assert.equal(composeBrief(input({ homeLocationId: null })).firstClass?.leaveBy, null);
});

test('lunch: the quietest projected hour near lunch time, open by published hours and outside classes', () => {
  // GSU is quietest at 11 but opens 11:45; 1 PM is mostly class; noon at Marciano (30 free minutes) wins.
  const { lunch } = composeBrief(input());
  assert.equal(lunch?.locationId, 'marciano');
  assert.equal(lunch?.start, at('12:00'));
  assert.equal(lunch?.share, 0.3);
  // Without projections there is no pick.
  assert.equal(composeBrief(input({ forecasts: [] })).lunch, null);
  // A later lunch time moves the window: 11 o'clock is out of range, and 2 PM is quieter than noon.
  const late = input({ profile: { lunchTime: '13:30' }, forecasts: [curve('marciano', { 11: 0.01, 12: 0.3, 14: 0.2 })] });
  assert.equal(composeBrief(late).lunch?.start, at('14:00'));
});

test('libraries closing earlier than usual on this weekday, by published hours', () => {
  const { earlyClosings } = composeBrief(input());
  assert.deepEqual(earlyClosings.map((c) => c.locationId), ['mugar']);
  assert.equal(earlyClosings[0].closesAt, at('18:00'));
  assert.equal(earlyClosings[0].usualClosesAt, at('02:00', '2026-10-29'));
  assert.equal(earlyClosings[0].sourceUrl, 'https://bu.edu/libraries');
  assert.equal(weekdayName('2026-10-28'), 'Wednesday');
  // Closed all day is called out too; no comparable day, nothing said.
  const closed = composeBrief(input({ hours: { ...hours, mugar: { hours: [dated('2026-10-21', 8, 26), dated('2026-10-28', 0, null)], hoursStatus: 'published' } } }));
  assert.equal(closed.earlyClosings[0].closesAt, null);
  const alone = composeBrief(input({ hours: { ...hours, mugar: { hours: [dated('2026-10-28', 8, 18)], hoursStatus: 'published' } } }));
  assert.equal(alone.earlyClosings.length, 0);
});

test("today's campus events and the venue events that crowd Kenmore or the B line, with estimates", () => {
  const brief = composeBrief(input());
  assert.deepEqual(brief.campusEvents.map((e) => e.id), ['Today']);
  assert.deepEqual(brief.venueEvents.map((e) => e.id), ['hockey:1', 'mlb:1'], 'small rooms and a 500-seat field are left out');
  const [hockey, sox] = brief.venueEvents;
  assert.deepEqual([hockey.area, hockey.estimate, hockey.estimateBasis], ['b-line', 5170, 'published-attendance']);
  assert.deepEqual([sox.area, sox.estimate, sox.estimateBasis], ['kenmore', 37755, 'venue-capacity']);
  assert.equal(sox.end, at('22:10'));
  assert.equal(composeBrief(input({ venues: null })).venueEvents.length, 0);
  // With three past box scores for the kind at the venue, their median stands in (and can drop it under the threshold).
  const past = (id: string, attendance: number) => ({ ...calendar.events[0], id, start: '2026-09-0' + id.slice(-1) + 'T19:10:00-04:00', attendance });
  const typical = composeBrief(input({ venues: { ...calendar, referenceEvents: [past('p1', 30000), past('p2', 33000), past('p3', 36000)] } })).venueEvents.find((e) => e.id === 'mlb:1')!;
  assert.deepEqual([typical.estimate, typical.estimateBasis], [33000, 'typical-attendance']);
  const smallGames = composeBrief(input({ venues: { ...calendar, referenceEvents: [past('p1', 900), past('p2', 1000), past('p3', 1200)] } }));
  assert.equal(smallGames.venueEvents.some((e) => e.id === 'mlb:1'), false);
});

test('the brief opens on the first view of each day, then stays collapsed', () => {
  assert.equal(briefStartsOpen(null, '2026-10-28'), true);
  assert.equal(briefStartsOpen('2026-10-27', '2026-10-28'), true);
  assert.equal(briefStartsOpen('2026-10-28', '2026-10-28'), false);
});
