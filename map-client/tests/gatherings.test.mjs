import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { gatheringsOnDate, gatheringExclusion, weekdayOf, mondayOf, addDays, GATHERING_ATTENDANCE_PROBABILITY, UNKNOWN_ROOM_SEATS } = await import('../src/sim/gatherings.ts');

const HOUR = 3600;
const iso = (date, seconds) => {
  const h = String(Math.floor(seconds / HOUR)).padStart(2, '0'), m = String(Math.floor(seconds % HOUR / 60)).padStart(2, '0');
  return `${date}T${h}:${m}:00-04:00`;
};
const event = (id, date, start, end, extra = {}) => ({ id, name: id, start: iso(date, start), end: end === null ? null : iso(date, end),
  locationId: 'hall', locationName: 'Hall', registrationCount: null, sourceUrl: `https://terriercentral.bu.edu/web/rsvp_boot?id=${id}`, ...extra });

/** Small synthetic campus: a dorm, a classroom with Monday/Wednesday classes, an event hall and a dining hall. */
function world(agentCount, events, { hallCapacity = 1000 } = {}) {
  const kinds = { home: 'dorm', class: 'classroom', hall: 'classroom', meal: 'dining' };
  const locations = Object.entries(kinds).map(([id, kind], index) => ({ id, name: id, short: id, kind, position: [-71.1 - index * 0.001, 42.35],
    capacity: id === 'hall' ? hallCapacity : 1000, building: id, campus: 'main' }));
  const walkRoutes = {};
  for (const from of locations) for (const to of locations) {
    if (from.id !== to.id) walkRoutes[`${from.id}>${to.id}`] = { path: [from.position, to.position], cumulative: [0, 140] };
  }
  const base = { day: 'Monday', locations, buildings: [], walkRoutes, trips: [],
    agents: Array.from({ length: agentCount }, (_, i) => ({ id: `s${i}`, home: 'home', model: i % 12, campus: 'main', residency: 'resident' })) };
  const data = { schemaVersion: 1, term: 'FALL 2026', collectedAt: '2026-10-24', referenceWeekStart: '2026-10-19', coverage: {}, locations: {},
    events, libraryHistory: {}, signals: [], assumptions: [], inputFiles: [] };
  for (const location of locations) data.locations[location.id] = { id: location.id, buildingCodes: [], meetings: [], evidence: [],
    hours: location.kind === 'dining' ? Array.from({ length: 7 }, (_, weekday) => ({ date: null, weekday, windows: [[7 * HOUR, 22 * HOUR]], text: 'weekly', sourceUrl: 'source', qualifier: null })) : [] };
  const meeting = (id, weekday, start, end) => ({ id, courseCode: `CAS ${id}`, title: id, section: 'A1', roomCode: '100',
    intervals: [{ weekday, startSec: weekday * 86400 + start, endSec: weekday * 86400 + end }], roomCapacity: 200, notes: null, calendarRestricted: false, sharedKey: null, sourceUrl: 'https://www.bu.edu/' });
  data.locations.class.meetings = [meeting('101', 0, 10 * HOUR, 11 * HOUR), meeting('102', 0, 14 * HOUR, 15 * HOUR), meeting('103', 2, 18 * HOUR, 19 * HOUR)];
  return { base, data };
}

/** Every student is in exactly one place or trip for the whole day, beginning and ending at home. */
function assertCompleteTimelines(day) {
  const parts = new Map(day.agents.map(agent => [agent.id, []]));
  for (const stay of day.stays) parts.get(stay.agent).push([stay.start, stay.end]);
  for (const trip of day.trips) parts.get(trip.agent).push([trip.timestamps[0], trip.timestamps.at(-1)]);
  for (const intervals of parts.values()) {
    intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let end = 0;
    for (const [start, stop] of intervals) { assert.ok(Math.abs(start - end) < 1e-7, 'no gap or overlap'); end = stop; }
    assert.equal(end, 86400);
  }
}
const peak = (day, location) => {
  const changes = day.stays.filter(s => s.location === location).flatMap(s => [[s.start, 1], [s.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let count = 0, max = 0;
  for (const [, delta] of changes) { count += delta; max = Math.max(max, count); }
  return max;
};
const countAt = (day, location, t) => day.stays.filter(s => s.location === location && s.start <= t && t < s.end).length;

test('event dates map onto simulated weekdays and outside weeks are labelled projected', () => {
  assert.equal(mondayOf('2026-10-29'), '2026-10-26');
  assert.equal(weekdayOf('2026-10-25'), 6);
  assert.equal(addDays('2026-10-31', 2), '2026-11-02');
  const { data } = world(1, [event('in', '2026-10-21', 18 * HOUR, 20 * HOUR), event('later', '2026-11-18', 18 * HOUR, 20 * HOUR)]);
  assert.equal(gatheringsOnDate(data, '2026-10-21')[0].projected, false);
  assert.equal(gatheringsOnDate(data, '2026-11-18')[0].projected, true);
  assert.equal(gatheringsOnDate(data, '2026-11-18')[0].attendanceProbability, GATHERING_ATTENDANCE_PROBABILITY);
});

test('unmapped, multi-day and open-ended events are handled without inventing anything', () => {
  assert.equal(gatheringExclusion(event('x', '2026-10-21', 18 * HOUR, 20 * HOUR, { locationId: null })), 'location-unmapped');
  assert.equal(gatheringExclusion({ ...event('x', '2026-10-21', 9 * HOUR, 0), end: '2026-10-23T20:00:00-04:00' }), 'multi-day');
  const { data } = world(1, [event('open', '2026-10-21', 19 * HOUR, null), event('room', '2026-10-21', 9 * HOUR, 10 * HOUR, { roomCode: 'B36', roomCapacity: null })]);
  const [room, open] = gatheringsOnDate(data, '2026-10-21');
  assert.equal(open.endSec - open.startSec, 2 * HOUR);
  assert.equal(open.endEstimated, true);
  assert.equal(room.roomSeats, UNKNOWN_ROOM_SEATS);
});

test('an event draws free students to its venue; class assignments and the baseline do not change', () => {
  const { base, data } = world(80, [event('talk', '2026-10-19', 17 * HOUR, 19 * HOUR)]);
  const baseline = buildSourceDay(base, data, 0);
  const withEvent = buildSourceDay(base, data, 0, { eventDate: '2026-10-19' });
  assertCompleteTimelines(withEvent);
  assert.equal(baseline.eventDate, null);
  assert.deepEqual(baseline.gatherings, []);
  assert.equal(countAt(baseline, 'hall', 18 * HOUR), 0);
  const [talk] = withEvent.gatherings;
  assert.ok(talk.attendees > 5 && talk.attendees < 40, `about a quarter of 80 attend, got ${talk.attendees}`);
  assert.equal(countAt(withEvent, 'hall', 18 * HOUR), talk.attendees);
  assert.deepEqual(withEvent.sourceAssignments, baseline.sourceAssignments);
  assert.equal(withEvent.sourceActivities.filter(a => a.kind === 'gathering').length, talk.attendees);
  assert.ok(withEvent.sourceActivities.filter(a => a.kind === 'gathering').every(a => a.eventId === 'talk' && a.projected === false && a.estimated));
  assert.ok(withEvent.sourceStats.assumptions.some(text => text.includes('Gathering')));
  // The baseline is cached separately and not altered by the event run.
  assert.equal(buildSourceDay(base, data, 0), baseline);
  assert.throws(() => buildSourceDay(base, data, 1, { eventDate: '2026-10-19' }), /does not fall on weekday/);
});

test('students in class during an event never attend it, and room seats cap attendance', () => {
  const { base, data } = world(200, [event('clash', '2026-10-19', 10 * HOUR, 11 * HOUR),
    event('seminar', '2026-10-19', 16 * HOUR, 17 * HOUR, { roomCode: '101', roomCapacity: 12 })]);
  const day = buildSourceDay(base, data, 0, { eventDate: '2026-10-19' });
  assertCompleteTimelines(day);
  const inClass = new Set(day.sourceAssignments.filter(a => a.startSec < 11 * HOUR && a.endSec > 10 * HOUR).map(a => a.agentId));
  assert.ok(inClass.size > 0);
  assert.ok(day.sourceActivities.filter(a => a.eventId === 'clash').every(a => !inClass.has(a.agentId)));
  const seminar = day.gatherings.find(g => g.eventId === 'seminar');
  assert.equal(seminar.capacity, 12);
  assert.equal(seminar.attendees, 12);
});

// Property-based: generated event days on random worlds. A seeded generator keeps failures reproducible.
function generator(seed) {
  let state = seed >>> 0;
  const next = () => { state = (Math.imul(state ^ (state >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return state / 4294967296; };
  return { next, int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)) };
}

test('property: generated event days conserve people, respect caps and keep classes fixed', () => {
  for (let run = 0; run < 100; run++) {
    const g = generator(1000 + run);
    const weekday = g.int(0, 6), date = addDays('2026-10-19', weekday + 7 * g.int(0, 3));
    const events = Array.from({ length: g.int(1, 4) }, (_, index) => {
      const start = g.int(8, 21) * HOUR + g.int(0, 3) * 900;
      const end = g.next() < 0.2 ? null : Math.min(23 * HOUR + 3599, start + g.int(1, 8) * 900);
      const room = g.next() < 0.5 ? { roomCode: `${100 + index}`, roomCapacity: g.next() < 0.5 ? g.int(1, 30) : null } : {};
      return event(`e${run}-${index}`, date, start, end, { locationId: g.next() < 0.15 ? 'meal' : 'hall', ...room });
    });
    const { base, data } = world(g.int(20, 120), events, { hallCapacity: g.int(5, 200) });
    const baseline = buildSourceDay(base, data, weekday);
    const day = buildSourceDay(base, data, weekday, { eventDate: date });
    const label = `seed ${1000 + run}`;
    assertCompleteTimelines(day);
    assert.deepEqual(day.sourceAssignments, baseline.sourceAssignments, `${label}: classes unchanged`);
    assert.equal(day.gatherings.length, gatheringsOnDate(data, date).length, label);
    const perStudent = new Map();
    for (const activity of day.sourceActivities.filter(a => a.kind === 'gathering')) {
      const gathering = day.gatherings.find(row => row.eventId === activity.eventId);
      assert.ok(gathering.startSec <= activity.startSec && activity.endSec <= gathering.endSec, `${label}: attendance inside the event window`);
      perStudent.set(activity.agentId, (perStudent.get(activity.agentId) ?? 0) + 1);
    }
    assert.ok([...perStudent.values()].every(count => count === 1), `${label}: at most one event per student`);
    for (const gathering of day.gatherings) {
      assert.ok(gathering.attendees <= gathering.capacity, `${label}: attendance within its cap`);
      assert.equal(gathering.projected, date > '2026-10-25', label);
    }
    for (const location of day.locations) assert.ok(peak(day, location.id) <= Math.max(location.capacity, peak(baseline, location.id)), `${label}: ${location.id} never exceeds capacity because of events`);
  }
});

test('real bundle: a mapped event date raises its venue during the event only', async () => {
  const read = name => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
  const source = read('campus-data');
  const date = source.events.filter(e => gatheringsOnDate(source, e.start.slice(0, 10)).length).map(e => e.start.slice(0, 10)).sort()[0];
  assert.ok(date, 'the saved bundle has at least one mapped event');
  const { buildPopulation } = await import('../src/sim/population.ts');
  const base = buildPopulation(read('demo-day'), source, read('population'));
  const weekday = weekdayOf(date);
  const baseline = buildSourceDay(base, source, weekday);
  const day = buildSourceDay(base, source, weekday, { eventDate: date });
  assert.deepEqual(day.sourceAssignments, baseline.sourceAssignments);
  assert.ok(day.gatherings.some(g => g.attendees > 0));
  for (const g of day.gatherings.filter(row => row.attendees > 0)) {
    assert.ok(countAt(day, g.locationId, (g.startSec + g.endSec) / 2) > countAt(baseline, g.locationId, (g.startSec + g.endSec) / 2));
  }
  assert.equal(day.agents.length, baseline.agents.length);
});
