import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const ea = await import('../src/sim/eventAttendance.ts');
const { planVisitors, visitorsAt, walkingCounts, VISITOR_DRAW_CAP, NO_VISITORS } = await import('../src/sim/visitors.ts');
const { loadEventSources } = await import('../src/data/eventCalendar.ts');

const HOUR = 3600;
const venue = { id: 'agganis', name: 'Agganis Arena', position: [-71.11774, 42.35222], locationId: 'agganis',
  capacities: { hockey: 6150, 'end-stage': 7500 }, defaultSetup: 'end-stage', capacitySource: 'test' };
const event = (id, extra = {}) => ({ id, venueId: 'agganis', name: id, kind: 'bu-hockey', setup: 'hockey',
  start: '2026-11-07T19:00:00-05:00', end: null, trendsTerms: ['BU hockey'], source: 'test', sourceUrl: 'https://example.org', ...extra });
const popularity = (scores, fit = null) => ({
  schemaVersion: 1, generatedAt: '', builtFor: '2026-10-24', geo: 'US-MA-506', geoLabel: 'Boston DMA', windowDays: 90,
  anchor: { term: 'TD Garden', ladder: [] }, method: [], counts: { trends: 0, prior: 0 },
  calibration: { 'bu-hockey': { referenceScore: 4, fit, points: [] }, concert: { referenceScore: 2, fit: null, points: [] } },
  events: Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, { eventId: id, kind: 'bu-hockey', group: 'bu-hockey', terms: ['BU hockey'],
    window: { from: '2026-07-26', to: '2026-10-24' }, source: score === null ? 'prior' : 'trends', score,
    termScores: score === null ? [] : [{ term: 'BU hockey', score, peakScore: score * 3, series: [1, 2, 3, 2, 5], anchorSeries: [], via: 'Agganis Arena' }] }])),
});
const line = (from, to, metres) => ({ path: [from, to], cumulative: [0, metres] });
const routes = { schemaVersion: 1, generatedAt: '', source: 'test', venues: { agganis: { name: 'Agganis Arena', osm: 'way/1', doors: [], origins: [
  { id: 'place-babck', kind: 'transit', name: 'Babcock Street', position: [-71.1199, 42.3516], capacity: null, door: 'yes', metres: 170, ...line([-71.1199, 42.3516], [-71.1182, 42.3517], 170) },
  { id: 'garage', kind: 'parking', name: 'Garage', position: [-71.1171, 42.3505], capacity: 350, door: 'yes', metres: 265, ...line([-71.1171, 42.3505], [-71.1182, 42.3517], 265) },
  { id: 'dropoff', kind: 'rideshare', name: 'Drop-off', position: [-71.1184, 42.3514], capacity: null, door: 'yes', metres: 74, ...line([-71.1184, 42.3514], [-71.1182, 42.3517], 74) },
] } } };
const calendar = (events) => ({ schemaVersion: 1, generatedAt: '', venues: [venue], events });

test('popularity scores move fill monotonically and never past capacity', () => {
  const pop = popularity({ low: 1, typical: 4, high: 16, viral: 4000 });
  const fill = (id) => ea.estimateEvent(event(id), venue, pop).fill;
  assert.ok(fill('low') < fill('typical') && fill('typical') < fill('high'));
  assert.equal(fill('typical').toFixed(4), ea.KIND_MODELS['bu-hockey'].fill.toFixed(4), 'a typical score fills to the kind’s base');
  const viral = ea.estimateEvent(event('viral'), venue, pop);
  assert.ok(viral.fill <= 1 && viral.attendees <= 6150 && viral.attendeesRange[1] <= 6150);
});

test('a calibration fit replaces the prior base and elasticity', () => {
  const fit = { base: 0.7, elasticity: 0.5, residualSd: 0.1, n: 12 };
  const e = ea.estimateEvent(event('x'), venue, popularity({ x: 16 }, fit));
  assert.ok(Math.abs(e.fill - 0.7 * 4 ** 0.5) < 1e-9 || e.fill === 1);
  assert.ok(e.popularity.calibrated);
});

test('missing popularity file: every event falls back to its kind prior', () => {
  const e = ea.estimateEvent(event('x'), venue, null);
  assert.equal(e.popularity.source, 'prior');
  assert.equal(e.fill, ea.KIND_MODELS['bu-hockey'].fill);
  assert.ok(e.fillRange[0] < e.fill && e.fill < e.fillRange[1], 'the prior carries a wider range');
  const day = ea.planEventDay({ calendar: calendar([event('x')]), popularity: null, routes: null }, '2026-11-07');
  assert.equal(day.events.length, 1);
  assert.equal(ea.planEventDay({ calendar: null, popularity: null, routes: null }, '2026-11-07').events.length, 0);
});

test('missing files load as null without throwing', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, json: async () => ({}) });
  try {
    assert.deepEqual(await loadEventSources(), { calendar: null, popularity: null, routes: null });
    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.deepEqual(await loadEventSources(), { calendar: null, popularity: null, routes: null });
  } finally {
    globalThis.fetch = original;
  }
});

test('sold out and published attendance override the score', () => {
  const pop = popularity({ x: 0.5 });
  assert.ok(ea.estimateEvent(event('x', { soldOut: true }), venue, pop).fill >= 0.95);
  const past = ea.estimateEvent(event('x', { attendance: 5464 }), venue, pop);
  assert.equal(past.attendees, 5464);
  assert.equal(past.popularity.source, 'published');
});

test('students plus visitors make the attendance; visitor range brackets the estimate', () => {
  for (const kind of ['bu-hockey', 'concert', 'mlb', 'comedy']) {
    const e = ea.estimateEvent(event('x', { kind, setup: kind === 'bu-hockey' ? 'hockey' : 'end-stage' }), venue, null);
    assert.equal(e.students + e.visitors, e.attendees);
    assert.ok(e.visitorsRange[0] <= e.visitors && e.visitors <= e.visitorsRange[1]);
    assert.ok(e.attendeesRange[0] <= e.attendees && e.attendees <= e.attendeesRange[1]);
  }
  const concert = ea.estimateEvent(event('c', { kind: 'concert', setup: 'end-stage' }), venue, null);
  const hockey = ea.estimateEvent(event('h'), venue, null);
  assert.ok(concert.visitors / concert.attendees > hockey.visitors / hockey.attendees, 'concerts are mostly visitors');
  assert.equal(ea.estimateEvent(event('s', { kind: 'campus' }), venue, null), null, 'student events add no visitors');
});

test('arrival curve ramps from 90 minutes before, peaks before the start, then a dismissal surge', () => {
  const e = ea.estimateEvent(event('x'), venue, null);
  const start = 19 * HOUR;
  assert.equal(e.startSec, start);
  assert.equal(e.endSec, start + 150 * 60, 'typical hockey duration when no end is published');
  assert.equal(ea.arrivedShare(e, start - 91 * 60), 0);
  assert.ok(ea.arrivedShare(e, start) > 0.6 && ea.arrivedShare(e, start) < 1);
  assert.equal(ea.arrivedShare(e, start + 21 * 60), 1);
  // Arrival rate is highest around the peak.
  const rate = (t) => ea.arrivedShare(e, t + 60) - ea.arrivedShare(e, t);
  assert.ok(rate(start - 11 * 60) > rate(start - 60 * 60) && rate(start - 11 * 60) > rate(start + 15 * 60));
  assert.ok(ea.insideShare(e, start + HOUR) > 0.99);
  assert.ok(ea.departedShare(e, e.endSec) > 0 && ea.departedShare(e, e.endSec) <= 0.11, 'a few leave early');
  assert.ok(Math.abs(ea.departedShare(e, e.endSec + 36 * 60) - 1) < 1e-9);
  for (const u of [0.01, 0.2, 0.5, 0.9]) {
    const t = ea.triangularQuantile(u, 0, 30, 100);
    assert.ok(Math.abs(ea.triangularCdf(t, 0, 30, 100) - u) < 1e-9);
    assert.ok(Math.abs(ea.departedShare(e, ea.departureQuantile(e, u)) - u) < 1e-9);
  }
});

test('eventLoadAt: phases and counts over the evening, null when nothing is on', () => {
  const day = ea.planEventDay({ calendar: calendar([event('x')]), popularity: null, routes }, '2026-11-07');
  const e = day.events[0];
  assert.equal(ea.eventLoadAt(day, 'agganis', 12 * HOUR), null);
  assert.equal(ea.eventLoadAt(day, 'fenway-park', 19 * HOUR), null);
  const before = ea.eventLoadAt(day, 'agganis', 18 * HOUR + 30 * 60);
  assert.equal(before.phase, 'arriving');
  const during = ea.eventLoadAt(day, 'agganis', 20 * HOUR);
  assert.equal(during.phase, 'in');
  assert.equal(during.attendees, e.attendees);
  assert.equal(during.visitors + during.students, during.attendees);
  const after = ea.eventLoadAt(day, 'agganis', e.endSec + 10 * 60);
  assert.equal(after.phase, 'leaving');
  assert.ok(after.visitorsWalking > before.visitorsWalking, 'the dismissal surge is denser than the arrival');
  assert.match(ea.eventLoadLabel(during).text, /at event \(≈[\d,]+ visitors\)/);
  const parking = ea.parkingDemandAt(day, 'agganis', 20 * HOUR);
  assert.ok(Math.abs(parking.cars - Math.round(e.visitors * e.modes.parking / ea.PEOPLE_PER_CAR)) <= 1);
  assert.equal(Object.keys(parking.byOrigin).join(), 'garage');
});

test('visitors: deterministic in sim time, capped, near the camera only, and free when nothing is on', () => {
  const day = ea.planEventDay({ calendar: calendar([event('x', { kind: 'concert', setup: 'end-stage' })]), popularity: null, routes }, '2026-11-07');
  const plan = planVisitors(day);
  const everywhere = () => true;
  const t = day.events[0].endSec + 8 * 60;
  const a = visitorsAt(plan, t, venue.position, null, everywhere);
  const b = visitorsAt(planVisitors(day), t, venue.position, null, everywhere);
  assert.deepEqual(a, b, 'same sim time, same people in the same places');
  assert.ok(a.walking > VISITOR_DRAW_CAP && a.drawn.length <= VISITOR_DRAW_CAP && a.drawn.length > VISITOR_DRAW_CAP / 2);
  const counts = walkingCounts(plan.events[0], t);
  assert.equal(counts.arriving + counts.leaving, a.walking);
  assert.ok(a.drawn.every((w) => w.id.startsWith('visitor:')));
  assert.equal(visitorsAt(plan, t, [-71.06, 42.36], 1200, everywhere).drawn.length, 0, 'far from the camera: nothing drawn');
  assert.equal(visitorsAt(plan, 3 * HOUR, venue.position, null, everywhere).walking, 0);
  assert.equal(visitorsAt(NO_VISITORS, t, venue.position, null, everywhere).drawn.length, 0);
  // Inbound walkers head for the venue, outbound for their origin.
  const before = visitorsAt(plan, day.events[0].startSec - 20 * 60, venue.position, null, everywhere);
  assert.ok(before.drawn.length > 0 && before.drawn.every((w) => w.to === 'agganis'));
  assert.ok(a.drawn.some((w) => w.to !== 'agganis'));
});

test('eventVisitorsAt(time): every walking visitor for other crowd models, by time alone', async () => {
  const { eventVisitorsAt, setCurrentVisitorPlan } = await import('../src/sim/visitors.ts');
  const day = ea.planEventDay({ calendar: calendar([event('x', { kind: 'concert', setup: 'end-stage' })]), popularity: null, routes }, '2026-11-07');
  const plan = planVisitors(day);
  const t = day.events[0].endSec + 8 * 60;
  assert.deepEqual(eventVisitorsAt(t), { walkers: [], walkingByVenue: {} }, 'nothing before the map sets a day');
  setCurrentVisitorPlan(plan);
  ea.setCurrentEventDay(day);
  try {
    const frame = eventVisitorsAt(t);
    assert.equal(frame.walkers.length, frame.walkingByVenue.agganis, 'uncapped: every walker, not just the drawn ones');
    assert.ok(frame.walkers.length > VISITOR_DRAW_CAP);
    assert.ok(frame.walkers.every((w) => w.id.startsWith('visitor:')));
    assert.deepEqual(ea.currentEventLoadAt('agganis', t), ea.eventLoadAt(day, 'agganis', t));
  } finally {
    setCurrentVisitorPlan(NO_VISITORS);
    ea.setCurrentEventDay(ea.NO_EVENT_DAY);
  }
});

test('real bundle: venue events never change student counts or occupancy', async () => {
  const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
  if (!existsSync(new URL('../public/data/event-calendar.json', import.meta.url))) return;
  const { buildPopulation } = await import('../src/sim/population.ts');
  const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
  const { Playback } = await import('../src/sim/playback.ts');
  const { weekdayOf } = await import('../src/sim/gatherings.ts');
  const source = read('campus-data');
  const cal = read('event-calendar');
  const sources = { calendar: cal, popularity: existsSync(new URL('../public/data/event-popularity.json', import.meta.url)) ? read('event-popularity') : null, routes: read('event-visitor-routes') };
  const big = cal.events.find((e) => e.venueId === 'agganis' && e.kind === 'bu-hockey' && e.start >= '2026-10-24');
  assert.ok(big, 'an upcoming Agganis hockey game in the calendar');
  const date = big.start.slice(0, 10);
  const base = buildPopulation(read('demo-day'), source, read('population'));
  const sim = buildSourceDay(base, source, weekdayOf(date), undefined, { eventDate: date });
  const playback = new Playback(sim);
  const times = [17.5, 18.75, 19.5, 21.6, 22].map((h) => h * HOUR);
  const snapshot = () => times.map((t) => ({ occupancy: playback.occupancyAt(t).map((o) => [o.location.id, o.count, o.share]), walking: playback.walkingAt(t).length }));
  const studentsBefore = snapshot();
  const day = ea.planEventDay(sources, date);
  const plan = planVisitors(day);
  assert.ok(day.events.length > 0 && plan.events.length > 0);
  let drawn = 0;
  for (const t of times) drawn += visitorsAt(plan, t, big ? cal.venues.find((v) => v.id === 'agganis').position : [0, 0], null, () => true).drawn.length;
  assert.ok(drawn > 0, 'visitors walk to and from the game');
  assert.deepEqual(snapshot(), studentsBefore);
  assert.equal(sim.agents.length, base.agents.length, 'the roster is the simulated students only');
});
