import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { ask, walkBetween, nextMeeting, meetingsFor, coursesFor, parseTime, placeMentions, courseMentions } = await import('../src/insights.ts');

const loc = (id, name, short, kind, position, capacity, extra = {}) => ({ id, name, short, kind, position, capacity, building: `way/${id}`, campus: 'charles-river', ...extra });
const locations = [
  loc('warren', 'Warren Towers', 'Warren Towers', 'dorm', [-71.10402, 42.34933], 1800),
  loc('cas', 'College of Arts and Sciences', 'CAS', 'classroom', [-71.10559, 42.35028], 900),
  loc('cds', 'Computing & Data Sciences', 'CDS', 'classroom', [-71.1029, 42.35003], 600),
  loc('mugar', 'Mugar Memorial Library', 'Mugar Library', 'library', [-71.108, 42.351], 800),
  loc('pardee', 'Pardee Library', 'Pardee Library', 'library', [-71.09968, 42.34962], 250),
  loc('gsu', 'George Sherman Union', 'GSU', 'dining', [-71.10886, 42.35097], 600),
  loc('warren-dining', 'Warren Towers Dining Hall', 'Warren Dining', 'dining', [-71.10406, 42.3494], 500),
  loc('fenway-dining', 'Fenway Campus Dining Hall', 'Fenway Dining', 'dining', [-71.1, 42.34], 300, { campus: 'fenway' }),
];
const walkRoutes = {
  'cas>mugar': { path: [[-71.10559, 42.35028], [-71.107, 42.3506], [-71.108, 42.351]], cumulative: [0, 120, 230] },
  'cds>cas': { path: [[-71.1029, 42.35003], [-71.10559, 42.35028]], cumulative: [0, 310] },
};
// Counts by hour: Mugar fills through the day, Pardee is busy at midday.
const counts = (t) => {
  const h = Math.floor(t / 3600);
  return { mugar: 40 * h, pardee: h >= 11 && h <= 14 ? 200 : 25, gsu: h === 12 ? 560 : 120, 'warren-dining': h === 18 ? 450 : 100, 'fenway-dining': 0, cas: 300, cds: 200, warren: 900 };
};
const occupancyAt = (t) => locations.map((location) => ({ location, count: counts(t)[location.id] ?? 0, share: (counts(t)[location.id] ?? 0) / location.capacity, modeled: true }));
const meeting = (courseCode, section, roomCode, intervals) => ({ id: `${courseCode}-${section}`, courseCode, title: 'Course', section, roomCode, intervals, roomCapacity: 30, notes: null, calendarRestricted: false, sharedKey: null, sourceUrl: '' });
const meetings = [
  { locationId: 'cds', meeting: meeting('CAS CS 132', 'B1', '364', [{ weekday: 0, startSec: 36600, endSec: 39600 }]) },
  { locationId: 'cds', meeting: meeting('CAS CS 132', 'B2', '364', [{ weekday: 0, startSec: 40500, endSec: 43500 }]) },
  { locationId: 'cas', meeting: meeting('CAS CS 132', 'A1', '205', [{ weekday: 1, startSec: 86400 + 45000, endSec: 86400 + 49500 }]) },
  { locationId: 'cas', meeting: meeting('CDS DS 340', 'C3', '204B', [{ weekday: 3, startSec: 3 * 86400 + 40000, endSec: 3 * 86400 + 43000 }]) },
];
const ctx = (over = {}) => ({ locations, walkRoutes, meetings, occupancyAt, time: 10 * 3600, weekday: 0, campus: 'charles-river', ...over });

test('walks follow the bundled route in either direction and estimate the rest', () => {
  const byId = Object.fromEntries(locations.map((l) => [l.id, l]));
  const there = walkBetween(byId.cas, byId.mugar, walkRoutes);
  const back = walkBetween(byId.mugar, byId.cas, walkRoutes);
  assert.deepEqual([there.meters, there.minutes, there.basis], [230, 3, 'route']);
  assert.deepEqual(back.path, [...there.path].reverse());
  const est = walkBetween(byId.gsu, byId.pardee, walkRoutes);
  assert.equal(est.basis, 'estimate');
  assert.equal(est.path.length, 2);
  assert.ok(est.meters > 900 && est.meters < 1100, String(est.meters));
});

test('least crowded library uses the simulation at the shown time, and a named time moves it', () => {
  const morning = ask('least crowded library', ctx({ time: 8 * 3600 }));
  assert.equal(morning.kind, 'leastCrowded');
  assert.equal(morning.ranked[0].location.id, 'pardee'); // 25/250 = 10% vs Mugar 320/800 = 40%
  const noon = ask('least crowded library at 12pm', ctx({ time: 8 * 3600 }));
  assert.equal(noon.time, 12 * 3600);
  assert.equal(noon.ranked[0].location.id, 'mugar'); // 480/800 = 60% vs Pardee 200/250 = 80%
});

test('rankings stay on the campus in view and walk from a named place', () => {
  const a = ask('quietest dining hall near CAS at 6pm', ctx());
  assert.equal(a.kind, 'leastCrowded');
  assert.deepEqual(a.ranked.map((r) => r.location.id), ['gsu', 'warren-dining']);
  assert.equal(a.from.locationId, 'cas');
  assert.equal(a.ranked[0].walk.basis, 'estimate');
});

test('places whose capacity is not comparable rank after the ones that are', () => {
  const odd = locations.map((l) => (l.id === 'pardee' ? { ...l, capacityBasis: 'estimated_student_capacity' } : l));
  const a = ask('least crowded library', ctx({ locations: odd, occupancyAt: (t) => occupancyAt(t).map((o) => (o.location.id === 'pardee' ? { ...o, location: odd[4] } : o)) }));
  assert.deepEqual(a.ranked.map((r) => [r.location.id, r.share === null]), [['mugar', false], ['pardee', true]]);
});

test('distance between two courses resolves each to its next meeting', () => {
  const a = ask('How far is CS 132 from DS 340?', ctx({ time: 9 * 3600 }));
  assert.equal(a.kind, 'distance');
  assert.equal(a.from.locationId, 'cds'); // next CS 132 meeting: Monday 10:10 at CDS
  assert.equal(a.to.locationId, 'cas');
  assert.equal(a.walk.meters, 310);
  assert.equal(ask('how far is CAS from Mugar', ctx()).walk.meters, 230);
  assert.equal(ask('how far is Mugar', ctx()).kind, 'needTwoPlaces');
});

test('"where is" a course gives the next meeting, wrapping into next week', () => {
  const a = ask('Where is CAS CS 132?', ctx({ time: 10 * 3600 + 20 * 60 }));
  assert.equal(a.kind, 'course');
  assert.deepEqual([a.next.section, a.next.locationId], ['B2', 'cds']);
  assert.deepEqual(a.buildings.map((b) => [b.locationId, b.sections.length]), [['cds', 2], ['cas', 1]]);
  const all = meetingsFor('cs132', ctx());
  assert.equal(nextMeeting(all, 4, 12 * 3600).section, 'B1'); // Friday: next is Monday's first
  assert.equal(ask('where is the cs 132 lecture', ctx()).kind, 'course');
  assert.equal(ask('where is CAS XX 999', ctx()).kind, 'noCourse');
});

test('a named place gets its crowd outlook; a named library is not a ranking', () => {
  const a = ask('When is Mugar Library quiet?', ctx({ time: 9 * 3600 }));
  assert.equal(a.kind, 'busy');
  assert.equal(a.location.id, 'mugar');
  assert.equal(a.quiet.time, 9 * 3600);
  assert.equal(a.busy.time, 23 * 3600); // Mugar's modeled count rises every hour to midnight
});

test('the map never claims to know a personal schedule', () => {
  assert.equal(ask('Where is my next class?', ctx()).kind, 'personal');
  assert.equal(ask('what is the meaning of life', ctx()).kind, 'unknown');
});

test('parsing: times, overlapping names and course codes', () => {
  assert.equal(parseTime('at 6pm'), 18 * 3600);
  assert.equal(parseTime('12:30 am'), 30 * 60);
  assert.equal(parseTime('at 14:15'), 14 * 3600 + 15 * 60);
  assert.equal(parseTime('now'), null);
  assert.deepEqual(placeMentions('Warren Dining to Mugar', locations).map((p) => p.location.id), ['warren-dining', 'mugar']);
  assert.deepEqual(courseMentions('CAS CS 132 and ds340').map((c) => c.code), ['cascs132', 'ds340']);
});

test('real published data: CAS CS 132 has a next meeting in a mapped building', () => {
  const data = JSON.parse(readFileSync(new URL('../public/data/campus-data.json', import.meta.url), 'utf8'));
  const real = Object.entries(data.locations).flatMap(([locationId, l]) => l.meetings.map((m) => ({ locationId, meeting: m })));
  const next = nextMeeting(meetingsFor('cascs132', ctx({ meetings: real })), 0, 8 * 3600);
  assert.ok(next, 'CS 132 is on the map');
  assert.ok(['cds', 'cas', 'epic'].includes(next.locationId), next.locationId);
});

test('places the simulation does not model rank last and say so', () => {
  const unmodeled = (t) => occupancyAt(t).map((o) => (o.location.id === 'gsu' ? { ...o, count: 0, modeled: false } : o));
  const a = ask('quietest dining hall', ctx({ occupancyAt: unmodeled }));
  assert.deepEqual(a.ranked.map((r) => [r.location.id, r.modeled]), [['warren-dining', true], ['gsu', false]]);
  const b = ask('when is GSU quiet', ctx({ occupancyAt: unmodeled }));
  assert.equal(b.kind, 'busy');
  assert.equal(b.modeled, false);
});

test('an unprefixed code naming two courses picks the most common one and keeps its sections apart', () => {
  const twoCourses = [
    ...meetings,
    { locationId: 'cas', meeting: meeting('CAS BI 515', 'A1', '101', [{ weekday: 0, startSec: 50000, endSec: 53000 }]) },
    { locationId: 'cas', meeting: meeting('CAS BI 515', 'A2', '101', [{ weekday: 2, startSec: 2 * 86400 + 50000, endSec: 2 * 86400 + 53000 }]) },
    // Sooner than either CAS section on Monday morning, but a different course.
    { locationId: 'cds', meeting: meeting('WED BI 515', 'W1', '200', [{ weekday: 0, startSec: 37000, endSec: 40000 }]) },
  ];
  assert.deepEqual(coursesFor('bi515', ctx({ meetings: twoCourses })).map((c) => c.courseCode), ['CAS BI 515', 'WED BI 515']);
  const a = ask('where is BI 515', ctx({ meetings: twoCourses, time: 9 * 3600 }));
  assert.equal(a.kind, 'course');
  assert.equal(a.courseCode, 'CAS BI 515');
  assert.equal(a.next.section, 'A1');
  assert.deepEqual(a.buildings.map((b) => b.locationId), ['cas']);
  const d = ask('how far is BI 515 from Mugar', ctx({ meetings: twoCourses, time: 9 * 3600 }));
  assert.equal(d.from.locationId, 'cas');
  // With the school prefix there is no ambiguity.
  assert.equal(ask('where is WED BI 515', ctx({ meetings: twoCourses })).courseCode, 'WED BI 515');
});
