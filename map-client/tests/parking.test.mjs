import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
    throw error;
  }
} });
const {
  ARRIVE_BEFORE, LEAVE_AFTER, FULL_SHARE, baselineShare, campusParkingEvents, createParkingModel, eventRamp, eventsOn, levelIndex,
  parkingAt, parkingDayKind,
} = await import('../src/sim/parking.ts');

const H = 3600;
const square = ([x, y]) => [[x - 0.0003, y - 0.0002], [x + 0.0003, y - 0.0002], [x + 0.0003, y + 0.0002], [x - 0.0003, y + 0.0002]];
const lot = (id, position, extra = {}) => ({
  id, name: id, short: id, kind: 'surface', operator: 'Test', bu: false, campus: 'charles-river', position, polygon: square(position),
  height: 0, underBuilding: false, capacity: 100, capacityBasis: 'osm', capacityNote: '', profile: 'public', eventParking: true,
  osm: null, sourceUrl: '', ...extra,
});
// A venue at the origin, lots 100 m, 300 m and 900 m east (the last outside a 600 m walk).
const east = (m) => [-71.1 + m / (111320 * Math.cos((42.35 * Math.PI) / 180)), 42.35];
const data = (events, lots) => ({
  schemaVersion: 1, generatedAt: '', notes: [], sources: [],
  lots: lots ?? [lot('near', east(100)), lot('next', east(300)), lot('far', east(900)), lot('hospital', east(50), { eventParking: false, profile: 'medical' })],
  venues: [{ id: 'arena', name: 'Arena', position: east(0), walkRadius: 600 }],
  events,
});
const game = (extra = {}) => ({ id: 'g1', venue: 'arena', name: 'Game', date: '2026-10-30', start: 19 * H, end: 22 * H, cars: 120, sample: false, source: '', sourceUrl: '', ...extra });
const friday = { date: '2026-10-30', weekday: 4, kind: 'weekday' };
const saturday = { date: '2026-10-31', weekday: 5, kind: 'weekend' };

test('BU commuter lots fill 7-9 am, hold, and drain 4-7 pm; weekends stay much lower', () => {
  const bu = { id: 'agganis-garage', profile: 'bu-commuter' };
  const at = (h, kind = 'weekday') => baselineShare(bu, kind, h * H);
  assert.ok(at(3) < 0.15, 'nearly empty overnight');
  assert.ok(at(7) < at(8) && at(8) < at(9.5), 'fills through the morning');
  assert.ok(at(10) > 0.8 && at(14) > 0.8, 'plateau through the day');
  assert.ok(at(16) > at(17.5) && at(17.5) > at(19.5), 'drains in the evening');
  assert.ok(at(19.5) < 0.35);
  for (const h of [9, 11, 14]) assert.ok(at(h, 'weekend') < at(h) / 2, `weekend at ${h}h is well below a weekday`);
  // Holidays and breaks empty BU's own lots, but hospital garages keep their weekday shape.
  assert.ok(at(11, 'holiday') < at(11) && at(11, 'break') < at(11));
  const medical = { id: 'bmc', profile: 'medical' };
  assert.equal(baselineShare(medical, 'holiday', 11 * H), baselineShare(medical, 'weekday', 11 * H));
  assert.ok(baselineShare(medical, 'weekday', 3 * H) > 0.25, 'hospital garages are never empty');
});

test('baselines are deterministic and stay within capacity', () => {
  for (const profile of ['bu-commuter', 'bu-mixed', 'medical', 'public']) {
    for (let t = 0; t <= 86400; t += 900) {
      const a = baselineShare({ id: 'x', profile }, 'weekday', t);
      assert.equal(a, baselineShare({ id: 'x', profile }, 'weekday', t));
      assert.ok(a >= 0 && a <= 1);
    }
  }
});

test('event ramp: up over 2 h to the start, holds to the end, drains over the hour after', () => {
  const e = { start: 19 * H, end: 22 * H };
  assert.equal(eventRamp(e, e.start - ARRIVE_BEFORE - 1), 0);
  assert.equal(eventRamp(e, e.start - ARRIVE_BEFORE), 0);
  assert.ok(Math.abs(eventRamp(e, e.start - ARRIVE_BEFORE / 2) - 0.5) < 1e-9, 'half the cars an hour before');
  assert.ok(eventRamp(e, e.start - 30 * 60) > eventRamp(e, e.start - 90 * 60), 'rising');
  assert.equal(eventRamp(e, e.start), 1, 'peaks at the start');
  assert.equal(eventRamp(e, 21 * H), 1, 'holds');
  assert.equal(eventRamp(e, e.end), 1);
  assert.ok(eventRamp(e, e.end + LEAVE_AFTER / 2) > 0 && eventRamp(e, e.end + LEAVE_AFTER / 2) < 1, 'draining');
  assert.equal(eventRamp(e, e.end + LEAVE_AFTER), 0, 'clear an hour after the end');
  // A concert that runs past midnight still holds until its end.
  assert.equal(eventRamp({ start: 21 * H, end: 0.5 * H }, 23.9 * H), 1);
});

test('event cars fill the nearest lot first, then spill to the next, never past capacity', () => {
  const model = createParkingModel(data([game({ cars: 400 })]));
  const s = parkingAt(model, friday, 19 * H);
  const [near, next, far, hospital] = s.lots;
  assert.ok(near.full && near.cars === 100, 'nearest is FULL');
  assert.ok(next.full && next.cars === 100, 'spills to the next nearest');
  assert.equal(far.eventCars, 0, 'beyond the walking radius');
  assert.equal(hospital.eventCars, 0, 'lots without event parking take none');
  assert.ok(hospital.share < 1);
  const ev = s.events[0];
  assert.equal(ev.parked + ev.unparked, 400);
  assert.ok(ev.unparked > 0, 'the rest finds no lot nearby');
  for (const l of s.lots) assert.ok(l.cars <= l.lot.capacity && l.share <= 1);
  assert.equal(s.totals.full, 2);
});

test('a small event only touches the nearest lot; none before the ramp', () => {
  const model = createParkingModel(data([game({ cars: 20 })]));
  const s = parkingAt(model, friday, 19 * H);
  assert.equal(s.lots[0].eventCars, 20);
  assert.equal(s.lots[0].event?.id, 'g1');
  assert.equal(s.lots[1].eventCars, 0);
  const early = parkingAt(model, friday, 16 * H);
  assert.ok(early.lots.every((l) => l.eventCars === 0));
  assert.equal(early.events.length, 1, 'still listed as the day\'s event');
  assert.equal(early.events[0].arriveFrom, 17 * H);
  assert.equal(early.events[0].clearBy, 23 * H);
});

test('events only count on their own date, and trends follow the ramp', () => {
  const model = createParkingModel(data([game({ cars: 40 })]));
  assert.equal(eventsOn(model, '2026-10-31').length, 0);
  const otherDay = parkingAt(model, saturday, 19 * H);
  assert.ok(otherDay.lots.every((l) => l.eventCars === 0));
  const arriving = parkingAt(model, friday, 17.5 * H);
  assert.equal(arriving.lots[0].trend, 'filling');
  const leaving = parkingAt(model, friday, 22.3 * H);
  assert.equal(leaving.lots[0].trend, 'emptying');
});

test('levels match the crowd scale and FULL is reported', () => {
  assert.deepEqual([0, 0.29, 0.3, 0.59, 0.6, 0.84, 0.85, 1].map(levelIndex), [0, 0, 1, 1, 2, 2, 3, 3]);
  const model = createParkingModel(data([game({ cars: 10_000 })]));
  const s = parkingAt(model, friday, 20 * H);
  assert.ok(s.lots[0].share >= FULL_SHARE && s.lots[0].full && s.lots[0].free === 0);
  assert.match(s.levelKey, /3F3F/);
});

test('BU holidays and breaks come from the academic calendar', () => {
  const terms = [{ classesStart: '2026-09-02', classesEnd: '2026-12-10', suspendedDates: ['2026-11-25'], events: [{ kind: 'exams', end: '2026-12-18' }] }];
  assert.equal(parkingDayKind('2026-10-28', 2, terms), 'weekday');
  assert.equal(parkingDayKind('2026-10-31', 5, terms), 'weekend');
  assert.equal(parkingDayKind('2026-11-25', 2, terms), 'holiday');
  assert.equal(parkingDayKind('2026-12-16', 2, terms), 'weekday', 'exams are in term');
  assert.equal(parkingDayKind('2026-07-15', 2, terms), 'break');
  assert.equal(parkingDayKind('2026-07-15', 2, undefined), 'weekday');
});

test('campus events become small single-day demands; multi-day listings are skipped', () => {
  const events = campusParkingEvents([
    { id: 'a', name: 'Movie night', start: '2026-10-25T16:00:00-04:00', end: '2026-10-25T18:30:00-04:00', registrationCount: 1, sourceUrl: 'u' },
    { id: 'b', name: 'Weekly meeting', start: '2026-09-09T19:00:00-04:00', end: '2026-12-02T21:00:00-05:00', registrationCount: 3, sourceUrl: 'u' },
    { id: 'c', name: 'Big talk', start: '2026-10-26T17:00:00-04:00', end: null, registrationCount: 400, sourceUrl: 'u' },
  ]);
  assert.deepEqual(events.map((e) => e.id), ['campus:a', 'campus:c']);
  assert.equal(events[0].start, 16 * H);
  assert.equal(events[0].end, 18.5 * H);
  assert.equal(events[0].cars, 5);
  assert.equal(events[1].end, 19 * H);
  assert.equal(events[1].cars, 50);
});

test('the shipped parking data is complete and every lot has provenance', () => {
  const shipped = JSON.parse(readFileSync(new URL('../public/data/parking.json', import.meta.url)));
  assert.equal(shipped.schemaVersion, 1);
  assert.ok(shipped.lots.length >= 15);
  const ids = new Set();
  for (const l of shipped.lots) {
    assert.ok(!ids.has(l.id), `unique id ${l.id}`);
    ids.add(l.id);
    assert.ok(l.capacity > 0 && Number.isInteger(l.capacity), l.id);
    assert.ok(['osm', 'published', 'estimate'].includes(l.capacityBasis), l.id);
    assert.ok(l.capacityNote.length > 0 && l.sourceUrl.startsWith('http'), `${l.id} has provenance`);
    assert.ok(l.polygon.length >= 3, l.id);
  }
  const venues = new Set(shipped.venues.map((v) => v.id));
  for (const id of ['fenway-park', 'agganis', 'mgm-music-hall', 'nickerson', 'bu-campus']) assert.ok(venues.has(id), id);
  for (const e of shipped.events) {
    assert.ok(venues.has(e.venue), e.id);
    assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(e.cars > 0 && e.start >= 0 && e.start < 86400 && e.source, e.id);
  }
  // A whole day at a busy event never puts a lot past capacity.
  const model = createParkingModel(shipped);
  const busiest = [...new Set(shipped.events.map((e) => e.date))].slice(0, 20);
  for (const date of busiest) {
    for (let t = 0; t < 86400; t += 1800) {
      for (const l of parkingAt(model, { date, weekday: 4, kind: 'weekday' }, t).lots) assert.ok(l.cars <= l.lot.capacity, `${l.lot.id} ${date} ${t}`);
    }
  }
});

test('Parking is off by default and creates nothing while off', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // Off unless the user turned it on before (localStorage), never on by default.
  assert.match(app, /localStorage\.getItem\(PARKING_KEY\) === '1'/);
  assert.match(app, /useState\(storedParking\)/);
  // The layers, tags and estimate are only built behind the toggle.
  assert.match(app, /const parking = showParkingRef\.current \? parkingRef\.current : null;/);
  assert.match(app, /\.\.\.\(parking && parkingState \? parkingLayers\(parking\.data, parkingState\) : \[\]\)/);
  assert.match(app, /\{showParking && <ParkingTags ref=\{parkingTagsRef\} \/>\}/);
  assert.equal(app.match(/parkingLayers\(/g).length, 1, 'one call site');
  assert.equal(app.match(/parkingAt\(/g).length, 1, 'one call site');
  // The data loads only once the toggle is on.
  assert.match(app, /if \(!showParking \|\| parkingRef\.current\) return;\s*let stale = false;\s*loadParking\(\)/);
});

test('parking is an estimate layer: it never feeds the student simulation', () => {
  const model = readFileSync(new URL('../src/sim/parking.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(model, /^import /m, 'the model imports nothing from the simulation');
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /(occupancyAt|buildSourceDay|byBuilding|applyIncident)\([^)]*parking/i);
});

test('all lots draw in two layers whose data arrays never change', async () => {
  const { parkingLayers, parkingUnder } = await import('../src/layers/parking.ts');
  const d = data([game({ cars: 400 })]);
  const model = createParkingModel(d);
  const a = parkingLayers(d, parkingAt(model, friday, 15 * H));
  const b = parkingLayers(d, parkingAt(model, friday, 19 * H));
  assert.equal(a.length, 2);
  assert.deepEqual(a.map((l) => l.id), ['parking-fills', 'parking-outlines']);
  assert.equal(a[0].props.data, b[0].props.data, 'same array: geometry uploads once');
  assert.equal(a[1].props.data, b[1].props.data);
  assert.equal(a[0].props.data.length, d.lots.length);
  assert.notEqual(a[0].props.updateTriggers.getFillColor, b[0].props.updateTriggers.getFillColor, 'colours re-run when levels change');
  assert.equal(parkingUnder(a[0].props.data[2]), 2);
  assert.equal(parkingUnder({ polygon: [], id: 'building' }), null);
});
