import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAN, eventSlotsQuery, parseEventSlots, planProblem, slotRoom } from '../src/lib/eventSlots.ts';

test('a plan becomes the event-slots query, with days only when some are chosen', () => {
  const q = new URLSearchParams(eventSlotsQuery({ ...DEFAULT_PLAN, headcount: 40, days: [4, 2, 2, 9] }));
  assert.equal(q.get('headcount'), '40');
  assert.equal(q.get('days'), '2,4');
  assert.equal(q.get('from'), '18:00');
  assert.equal(q.get('to'), '22:00');
  assert.equal(q.get('duration'), '90');
  assert.equal(q.get('campus'), 'charles-river');
  assert.equal(new URLSearchParams(eventSlotsQuery(DEFAULT_PLAN)).has('days'), false);
  assert.equal(new URLSearchParams(eventSlotsQuery({ ...DEFAULT_PLAN, days: [0, 1, 2, 3, 4, 5, 6] })).has('days'), false);
});

test('members\' places go along as near, deduplicated, valid ids only, at most twelve', () => {
  assert.equal(new URLSearchParams(eventSlotsQuery(DEFAULT_PLAN)).has('near'), false);
  const q = new URLSearchParams(eventSlotsQuery({ ...DEFAULT_PLAN, near: ['warren', 'myles', 'warren', 'Bad Id!'] }));
  assert.equal(q.get('near'), 'warren,myles');
  const many = Array.from({ length: 15 }, (_, i) => `place-${i}`);
  assert.equal(new URLSearchParams(eventSlotsQuery({ ...DEFAULT_PLAN, near: many })).get('near')!.split(',').length, 12);
});

test('walks in the answer are kept when well-formed and dropped otherwise', () => {
  const base = { date: '2026-10-26', weekday: 0, start: '6:00 PM', end: '7:00 PM', building: 'CAS', room: '1', seats: 30, campus: 'charles-river', nearbyCrowd: null,
    parking: { spaces: 0, lots: 0, nearest: null }, venueEventsSameDay: [] };
  const body = { headcount: 20, days: [], window: { from: '6:00 PM', to: '10:00 PM' }, durationMin: 60, counts: {}, largestRoom: null, caveat: 'c', method: 'm', near: ['Warren Towers', 3],
    slots: [{ ...base, walk: { average: 6, longest: 11, from: 'Myles Standish Hall' } }, { ...base, room: '2', walk: { average: 'far' } }, { ...base, room: '3' }] };
  const r = parseEventSlots(body);
  assert.deepEqual(r.slots.map((s) => s.walk), [{ average: 6, longest: 11, from: 'Myles Standish Hall' }, null, null]);
  assert.deepEqual(r.near, ['Warren Towers']);
});

test('plans that cannot be sent say why', () => {
  assert.equal(planProblem(DEFAULT_PLAN), null);
  assert.match(planProblem({ ...DEFAULT_PLAN, headcount: Number.NaN })!, /how many/);
  assert.match(planProblem({ ...DEFAULT_PLAN, headcount: 5000 })!, /2,000/);
  assert.match(planProblem({ ...DEFAULT_PLAN, from: '21:00', to: '22:00' })!, /doesn’t fit/);
  assert.match(planProblem({ ...DEFAULT_PLAN, from: '' })!, /start and end/);
});

test('the answer is checked before it is shown, and keeps the caveat', () => {
  const slot = { date: '2026-10-26', weekday: 0, start: '6:00 PM', end: '7:30 PM', building: 'Questrom School of Business', room: '220', seats: 40, campus: 'charles-river',
    nearbyCrowd: { percent: 12, place: 'Marciano Commons' }, parking: { spaces: 900, lots: 2, nearest: { name: 'Warren Towers Garage', metres: 300 } }, venueEventsSameDay: [] };
  const body = { headcount: 40, days: [{ date: '2026-10-26', weekday: 0 }], window: { from: '6:00 PM', to: '10:00 PM' }, durationMin: 90,
    slots: [slot, { room: 7 }], counts: { rooms: 1, roomsWithSeats: 1, checked: 7, withClass: 0, withListedEvent: 0, nearVenueEvent: 0, free: 7 },
    largestRoom: null, caveat: 'A free room may still be in use or locked. Nothing is booked.', method: 'm' };
  const parsed = parseEventSlots(body);
  assert.equal(parsed.slots.length, 1);
  assert.deepEqual(parsed.venueConflicts, []);
  assert.match(parsed.caveat, /in use or locked/);
  assert.equal(slotRoom(parsed.slots[0]), 'Room 220, Questrom School of Business');
  assert.throws(() => parseEventSlots({ slots: [] }), /can’t read/);
  assert.throws(() => parseEventSlots(null), /can’t read/);
});
