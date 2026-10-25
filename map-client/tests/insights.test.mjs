import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { ask, walkBetween, nextMeeting, meetingsFor, coursesFor, parseTime, placeMentions, courseMentions, openAt, rankByCrowd, rankTier, busyOutlook, daysWithPublishedHours, dayList, comparable, shownCapacity } = await import('../src/insights.ts');

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

test('local crowd answers never substitute the shown day for another named weekday', () => {
  const context = ctx({ occupancyAt: () => { throw new Error('Wrong day occupancy requested'); } });
  assert.deepEqual(ask('least crowded dining hall on Saturday at 2pm', context), { kind: 'differentDay', weekday: 5 });
  assert.deepEqual(ask('is Mugar busy on Tuesday?', context), { kind: 'differentDay', weekday: 1 });
  assert.equal(ask('least crowded library on Monday', ctx()).kind, 'leastCrowded');
  assert.equal(ask('how far is CAS from Mugar on Saturday?', context).kind, 'distance');
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

// ---------------------------------------------------------------- opening hours
// Reference week starts Monday 2026-10-26. Mugar's Sunday and Monday windows run to 02:00
// (26:00); GSU has a dated closure on Tuesday; Warren Dining and CDS publish no hours.
const hours = (date, windows, text, qualifier = null) => ({ date, windows, text, qualifier, sourceUrl: '' });
const source = (hoursStatus, list = [], hoursReason) => ({ id: 'x', buildingCodes: [], meetings: [], evidence: [], hours: list, ...(hoursStatus ? { hoursStatus } : {}), ...(hoursReason ? { hoursReason } : {}) });
const data = {
  referenceWeekStart: '2026-10-26',
  locations: {
    mugar: source('published', [hours('2026-10-25', [[36000, 93600]], '10:00am – 2:00am'), hours('2026-10-26', [[25200, 93600]], '7:00am – 2:00am')]),
    pardee: source('published', [hours('2026-10-26', [[28800, 79200]], '8:00am – 10:00pm')]),
    gsu: source('published', [hours('2026-10-26', [[39600, 82800]], '11:00–23:00', 'Union of four meal vendors'), hours('2026-10-27', [], 'Closed')]),
    'warren-dining': source(undefined),
    agganis: source('restricted', [], 'Event arena; no published general recreation access'),
  },
};
const withData = (over = {}) => ctx({ data, ...over });

test('openAt: published windows, the qualifier, exact-date closures and unpublished dates', () => {
  const noon = openAt('gsu', 0, 12 * 3600, data);
  assert.deepEqual([noon.open, noon.date, noon.hoursText, noon.qualifier], [true, '2026-10-26', '11:00–23:00', 'Union of four meal vendors']);
  assert.equal(openAt('gsu', 0, 23 * 3600, data).open, false); // windows are [open, close)
  assert.equal(openAt('gsu', 1, 12 * 3600, data).open, false); // dated closure
  const wed = openAt('gsu', 2, 12 * 3600, data);
  assert.equal(wed.open, null); // no hours for 2026-10-28: unknown, not closed
  assert.match(wed.reason, /2026-10-28/);
});

test('openAt: a window past midnight covers the small hours of the next date', () => {
  const late = openAt('mugar', 0, 3600, data); // Monday 01:00, from Sunday's 10:00–26:00
  assert.deepEqual([late.open, late.fromPreviousDay, late.hoursText], [true, true, '10:00am – 2:00am']);
  assert.equal(openAt('mugar', 1, 3600, data).open, true); // Tuesday 01:00, from Monday's window
  assert.equal(openAt('mugar', 0, 3 * 3600, data).open, false); // closed 02:00–07:00
  assert.equal(openAt('mugar', 0, 2 * 3600, data).open, false);
  assert.equal(openAt('mugar', 0, 8 * 3600, data).fromPreviousDay, undefined);
});

test('openAt: no published hours is unknown; restricted access is closed with its reason', () => {
  assert.equal(openAt('cds', 0, 12 * 3600, data).open, null);
  assert.equal(openAt('warren-dining', 0, 12 * 3600, data).open, null);
  const arena = openAt('agganis', 0, 12 * 3600, data);
  assert.equal(arena.open, false);
  assert.match(arena.reason, /Event arena/);
});

test('rankings put open places first, then unknown hours, then closed, then unmodeled', () => {
  // 23:00: Pardee (10%) is closed, Mugar (115%) is open, so Mugar ranks first.
  const night = ask('quietest library at 11pm', withData());
  assert.deepEqual(night.ranked.map((r) => [r.location.id, r.open, rankTier(r)]), [['mugar', true, 0], ['pardee', false, 3]]);
  assert.equal(ask('quietest library at 11pm', ctx()).ranked[0].location.id, 'pardee'); // without data: as before
  const noon = rankByCrowd(withData(), 'dining', 12 * 3600, null);
  assert.deepEqual(noon.map((r) => [r.location.id, rankTier(r)]), [['gsu', 0], ['warren-dining', 2]]);
  const unmodeled = (t) => occupancyAt(t).map((o) => (o.location.id === 'gsu' ? { ...o, modeled: false } : o));
  const late = rankByCrowd(withData({ occupancyAt: unmodeled }), 'dining', 23 * 3600, null);
  assert.deepEqual(late.map((r) => [r.location.id, rankTier(r)]), [['warren-dining', 2], ['gsu', 4]]);
  // Unknown hours: comparable percentages before headcounts.
  const odd = locations.map((l) => (l.id === 'warren-dining' ? { ...l, capacityBasis: 'estimated_student_capacity' } : l));
  const fen = { ...data, locations: { ...data.locations, gsu: source(undefined) } };
  const both = rankByCrowd(ctx({ data: fen, locations: odd, occupancyAt: (t) => occupancyAt(t).map((o) => (o.location.id === 'warren-dining' ? { ...o, location: odd[6] } : o)) }), 'dining', 12 * 3600, null);
  assert.deepEqual(both.map((r) => [r.location.id, r.share === null]), [['gsu', false], ['warren-dining', true]]);
  // All kinds at once.
  assert.equal(rankByCrowd(withData(), null, 12 * 3600, null).length, 7);
});

test('the outlook skips closed hours and flags open hours after midnight', () => {
  const gsu = ask('when is GSU quiet', withData({ time: 9 * 3600 }));
  assert.equal(gsu.openNow.open, false);
  assert.equal(gsu.quiet.time, 11 * 3600); // first open hour, not 09:00 when it's closed
  assert.equal(gsu.busy.time, 12 * 3600);
  assert.equal(ask('when is GSU quiet', ctx({ time: 9 * 3600 })).quiet.time, 9 * 3600); // without data: as before
  const location = locations.find((l) => l.id === 'mugar');
  const mugar = busyOutlook(withData(), location, 30 * 60);
  assert.equal(mugar.afterMidnight, true);
  assert.equal(mugar.openNow.fromPreviousDay, true);
  assert.equal(mugar.quiet.time, 7 * 3600);
  // The shown time is itself a candidate when it is open.
  assert.equal(busyOutlook(withData(), location, 7.5 * 3600).quiet.time, 7.5 * 3600);
  assert.equal(busyOutlook(ctx(), location, 7.5 * 3600).quiet.time, 8 * 3600);
});

test('an empty venue without published hours gets no percent and ranks after measured places', () => {
  const data = { referenceWeekStart: '2026-10-26', locations: {
    mugar: { hours: [{ date: '2026-10-26', windows: [[0, 86400]], text: 'open', sourceUrl: '', qualifier: null }], hoursStatus: 'published' },
    pardee: { hours: [], hoursStatus: 'unknown' },
  } };
  const occ = (t) => occupancyAt(t).map((o) => (o.location.id === 'pardee' ? { ...o, count: 0, share: 0 } : o));
  const a = ask('least crowded library', ctx({ time: 8 * 3600, occupancyAt: occ, data }));
  assert.deepEqual(a.ranked.map((r) => [r.location.id, r.share === null]), [['mugar', false], ['pardee', true]]);
});

test('a residence with classrooms (Kilachand) gets a percentage of its beds; without a bed count it stays a headcount', () => {
  const kilachand = { id: 'kilachand', kind: 'dorm', capacity: 748, capacityBasis: 'residential_beds_plus_classroom_seats', residentialBeds: 550, activityModeled: true };
  assert.equal(comparable(kilachand, true), true);
  assert.equal(shownCapacity(kilachand), 550);
  const unknownBeds = { ...kilachand, residentialBeds: undefined };
  assert.equal(comparable(unknownBeds, true), false);
  assert.equal(shownCapacity(unknownBeds), 748);
  assert.equal(shownCapacity({ id: 'warren', kind: 'dorm', capacity: 600 }), 600);
});

test('days with published hours: the dining halls have every day of the reference week, weekends from their listed hours', () => {
  const data = JSON.parse(readFileSync(new URL('../public/data/campus-data.json', import.meta.url), 'utf8'));
  const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  assert.deepEqual(daysWithPublishedHours(['marciano', 'warren-dining'], data), [0, 1, 2, 3, 4, 5, 6]);
  // Weekend brunch to dinner, as BU Dining published the weekend before (Sat 9-9, Sun 10-9); the
  // listing is labelled a fallback, so date-specific exceptions stay unverified.
  const saturday = openAt('marciano', 5, 12 * 3600, data);
  assert.equal(saturday.open, true);
  assert.match(saturday.qualifier, /fallback/);
  assert.equal(openAt('marciano', 5, 8 * 3600, data).open, false);
  assert.equal(openAt('marciano', 6, 9.5 * 3600, data).open, false);
  assert.equal(openAt('marciano', 6, 12 * 3600, data).open, true);
  assert.equal(openAt('marciano', 6, 22 * 3600, data).open, false);
  assert.deepEqual(daysWithPublishedHours(['not-a-place'], data), []);
  assert.equal(dayList([0, 1, 2, 3, 4], WEEKDAYS), 'Monday to Friday');
  assert.equal(dayList([0, 2, 4], WEEKDAYS), 'Monday, Wednesday and Friday');
  assert.equal(dayList([5, 6], WEEKDAYS), 'Saturday and Sunday');
  assert.equal(dayList([3], WEEKDAYS), 'Thursday');
  assert.equal(dayList([], WEEKDAYS), '');
});
