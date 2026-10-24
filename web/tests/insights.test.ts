import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPlaces, interpret, nextClass, parseTime, rankByCrowd, walkBetween, type InsightData } from '../src/lib/insights.ts';
import type { CampusGeo, CampusLocation, HourlyForecast, ScheduleItem } from '../src/data/types.ts';

// Local-time dates so the tests pass in any timezone.
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 26 + dayOffset, h, m);
const iso = (h: number, m = 0, dayOffset = 0) => at(h, m, dayOffset).toISOString();

const locations: CampusLocation[] = [
  { id: 'warren', name: 'Warren Towers', short: 'Warren Towers', kind: 'dorm', capacity: 1800 },
  { id: 'cas', name: 'College of Arts and Sciences', short: 'CAS', kind: 'classroom', capacity: 900 },
  { id: 'cds', name: 'Computing & Data Sciences', short: 'CDS', kind: 'classroom', capacity: 600 },
  { id: 'mugar', name: 'Mugar Memorial Library', short: 'Mugar', kind: 'library', capacity: 800 },
  { id: 'pardee', name: 'Pardee Management Library', short: 'Pardee', kind: 'library', capacity: 250 },
  { id: 'sel', name: 'Science & Engineering Library', short: 'SEL', kind: 'library', capacity: 300 },
  { id: 'gsu', name: 'George Sherman Union', short: 'GSU', kind: 'dining', capacity: 600 },
  { id: 'warren-dining', name: 'Warren Towers Dining Hall', short: 'Warren Dining', kind: 'dining', capacity: 500 },
];

const geo: CampusGeo = {
  positions: {
    warren: [-71.10402, 42.34933],
    cas: [-71.10559, 42.35028],
    cds: [-71.1029, 42.35003],
    mugar: [-71.108, 42.351],
    pardee: [-71.09968, 42.34962],
    gsu: [-71.10886, 42.35097],
    'warren-dining': [-71.10406, 42.3494],
  },
  walkMeters: { 'cas>cds': 260, 'cas>warren': 219, 'mugar>warren': 420, 'mugar>warren-dining': 410, 'gsu>warren-dining': 500 },
};

const item = (id: string, title: string, locationId: string, start: string, end: string, extra: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id, title, locationId, start, end, source: 'calendar', ...extra,
});

const schedule: ScheduleItem[] = [
  item('s1', 'CS 132', 'cas', iso(9, 5), iso(9, 55)),
  item('s2', 'Lunch', 'gsu', iso(12), iso(12, 40), { source: 'suggested' }),
  item('s3', 'DS 340', 'cds', iso(14, 30), iso(15, 45)),
  item('s5', 'Study', 'mugar', iso(20, 15), iso(22), { source: 'habit' }),
  item('s6', 'CS 132', 'cas', iso(9, 5, 2), iso(9, 55, 2)),
];

const curve = (peaks: number[]) => peaks.map((share, i) => ({ hour: 8 + i, share }));
const hourly: HourlyForecast[] = [
  { locationId: 'mugar', day: iso(0), hours: curve([0.08, 0.15, 0.25, 0.32, 0.3, 0.38, 0.45, 0.5, 0.48, 0.52, 0.6]) },
  { locationId: 'pardee', day: iso(0), hours: curve([0.1, 0.2, 0.42, 0.55, 0.5, 0.62, 0.7, 0.58, 0.4, 0.3, 0.26]) },
  { locationId: 'sel', day: iso(0), hours: curve([0.05, 0.12, 0.2, 0.26, 0.24, 0.3, 0.36, 0.4, 0.34, 0.3, 0.32]) },
  { locationId: 'gsu', day: iso(0), hours: curve([0.12, 0.22, 0.35, 0.62, 0.94, 0.81, 0.44, 0.33, 0.41, 0.58, 0.72]) },
  { locationId: 'warren-dining', day: iso(0), hours: curve([0.3, 0.2, 0.15, 0.4, 0.88, 0.7, 0.25, 0.15, 0.2, 0.55, 0.8]) },
];

const data: InsightData = { locations, schedule, hourly, geo, homeLocationId: 'warren' };

test('walking distance uses the bundled route in either direction', () => {
  const there = walkBetween('cds', 'cas', geo)!;
  const back = walkBetween('cas', 'cds', geo)!;
  assert.equal(there.meters, 260);
  assert.equal(there.basis, 'route');
  assert.deepEqual([back.meters, back.minutes], [there.meters, there.minutes]);
  assert.equal(there.minutes, 3); // 260 m at 1.4 m/s
});

test('without a route, walking distance is a labelled straight-line estimate; without a position, none', () => {
  const est = walkBetween('pardee', 'gsu', geo)!;
  assert.equal(est.basis, 'estimate');
  assert.ok(est.meters > 700 && est.meters < 1100, `${est.meters}`);
  assert.equal(walkBetween('sel', 'cas', geo), null);
  assert.equal(walkBetween('cas', 'cas', geo)!.meters, 0);
});

test('next class skips the class in progress and non-class items', () => {
  const during = nextClass(schedule, at(9, 30));
  assert.equal(during.inProgress?.id, 's1');
  assert.equal(during.item?.id, 's3');
  assert.equal(nextClass(schedule, at(16)).item?.id, 's6');
  assert.equal(nextClass(schedule, at(10, 0, 3)).item, null);
});

test('"where is my next class" walks from the last place attended, not an unaccepted suggestion', () => {
  const a = interpret('Where is my next class?', data, at(10));
  assert.equal(a.kind, 'nextClass');
  if (a.kind !== 'nextClass') return;
  assert.equal(a.item.id, 's3');
  assert.equal(a.from?.locationId, 'cas'); // Lunch at GSU is only suggested
  assert.equal(a.walk?.meters, 260);

  const accepted = { ...data, schedule: schedule.map((s) => (s.id === 's2' ? { ...s, accepted: true } : s)) };
  const b = interpret('where is my next class', accepted, at(10));
  assert.equal(b.kind === 'nextClass' && b.from?.locationId, 'gsu');
});

test('least crowded library ranks by projected share at the asked hour', () => {
  const a = interpret('least crowded library', data, at(9, 10));
  assert.equal(a.kind, 'leastCrowded');
  if (a.kind !== 'leastCrowded') return;
  assert.deepEqual(a.ranked.map((r) => r.locationId), ['sel', 'mugar', 'pardee']);
  assert.equal(a.ranked[0].share, 0.12);
  assert.equal(a.ranked[0].walk, null); // SEL has no position in the map data
});

test('a named time changes the hour; places without a projection rank last', () => {
  const a = interpret('Quietest dining hall at 6pm', data, at(9));
  assert.equal(a.kind, 'leastCrowded');
  if (a.kind !== 'leastCrowded') return;
  assert.equal(a.at.getHours(), 18);
  assert.deepEqual(a.ranked.map((r) => r.locationId), ['gsu', 'warren-dining']);
  assert.equal(a.ranked[0].share, 0.72);

  const late = rankByCrowd(data, 'library', at(23), 'warren');
  assert.ok(late.every((r) => r.share === null));
});

test('distance between two classes resolves each to its building', () => {
  const a = interpret('How far is CS 132 from DS 340?', data, at(8));
  assert.equal(a.kind, 'distance');
  if (a.kind !== 'distance') return;
  assert.equal(a.legs.length, 1);
  assert.deepEqual([a.legs[0].from.locationId, a.legs[0].to.locationId], ['cas', 'cds']);
  assert.equal(a.legs[0].walk?.meters, 260);
  assert.equal(interpret('how far apart are cs132 and ds340', data, at(8)).kind, 'distance');
});

test('the longer place name wins where names overlap', () => {
  assert.deepEqual(findPlaces('how far is Warren Dining from Mugar', data, at(8)).map((p) => p.locationId), ['warren-dining', 'mugar']);
  assert.deepEqual(findPlaces('walk from warren to cas', data, at(8)).map((p) => p.locationId), ['warren', 'cas']);
});

test('one place means a walk from where you are; "my classes" means each walk between today\'s classes', () => {
  const one = interpret('how far is Mugar', data, at(8));
  assert.equal(one.kind === 'distance' && one.legs[0].from.locationId, 'warren'); // home before the first class
  const legs = interpret('How far apart are my classes today?', data, at(8));
  assert.equal(legs.kind, 'distance');
  if (legs.kind !== 'distance') return;
  assert.deepEqual(legs.legs.map((l) => `${l.from.locationId}>${l.to.locationId}`), ['cas>cds']);
});

test('naming a place without a superlative asks how busy it gets', () => {
  assert.deepEqual(interpret('when is Mugar quiet?', data, at(8)), { kind: 'busy', locationId: 'mugar' });
  assert.equal(interpret('what is the meaning of life', data, at(8)).kind, 'unknown');
});

test('times parse in 12-hour form and common words', () => {
  assert.equal(parseTime('at 12am', at(9))!.getHours(), 0);
  assert.equal(parseTime('3:30 pm', at(9))!.getMinutes(), 30);
  assert.equal(parseTime('around noon', at(9))!.getHours(), 12);
  assert.equal(parseTime('right now', at(9)), null);
});
