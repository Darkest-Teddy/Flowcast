import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { DepartureInput } from '../src/lib/departure.ts';
// departure.ts imports the transit planner (and map-client modules) without extensions: load through Vite.
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { bostonDay, bostonDayLabel, bostonTime, bostonDateTime, getDeparturePlan } = await vite.ssrLoadModule('/src/lib/departure.ts') as typeof import('../src/lib/departure.ts');
await vite.close();
import type { ScheduleItem } from '../src/data/types.ts';

const item = (id: string, start: string, end: string, locationId = 'b'): ScheduleItem => ({ id, title: id, start, end, locationId, source: 'calendar' });
const lecture = item('next', '2026-10-24T15:00:00Z', '2026-10-24T16:00:00Z');
const base: DepartureInput = { items: [lecture], now: Date.parse('2026-10-24T14:00:00Z'),
  locations: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], homeLocationId: 'a', geo: { positions: {}, walkMeters: { 'a>b': 841, 'b>c': 84 } } };
const plan = (overrides: Partial<DepartureInput> = {}) => getDeparturePlan({ ...base, ...overrides });

test('ceil saved distance at 1.4 m/s, default buffer and exact departure', () => {
  const result = plan();
  assert.equal(result.walkMinutes, 11);
  assert.equal(result.bufferMinutes, 5);
  assert.equal(result.leaveBy, Date.parse('2026-10-24T14:44:00Z'));
  assert.equal(result.arrivalTarget, Date.parse('2026-10-24T14:55:00Z'));
  assert.equal(result.originSource, 'home');
});
test('canonical sorted route keys and zero/ten minute buffers', () => {
  assert.equal(plan({ fromLocationId: 'c', bufferMinutes: 0 }).walkMinutes, 1);
  assert.equal(plan({ bufferMinutes: 10 }).leaveBy, Date.parse('2026-10-24T14:39:00Z'));
});
test('same building needs no route but retains buffer', () => {
  const result = plan({ fromLocationId: 'b' });
  assert.equal(result.walkMinutes, 0);
  assert.equal(result.leaveBy, Date.parse('2026-10-24T14:55:00Z'));
});
test('unknown origin/destination or missing/invalid route never guesses', () => {
  assert.equal(plan({ fromLocationId: 'missing' }).routeStatus, 'choose-origin');
  assert.equal(plan({ items: [{ ...lecture, locationId: '' }] }).routeStatus, 'unmapped-destination');
  for (const meters of [undefined, NaN, -1, Infinity]) {
    const result = plan({ geo: { positions: { a: [-71, 42], b: [-71, 42] }, walkMeters: meters === undefined ? {} : { 'a>b': meters } } });
    assert.equal(result.routeStatus, 'no-route');
    assert.equal(result.leaveBy, null);
  }
});
test('current class and next class are distinct, end boundary is exclusive', () => {
  const current = item('current', '2026-10-24T13:00:00Z', '2026-10-24T14:30:00Z', 'c');
  const result = plan({ items: [lecture, current] });
  assert.equal(result.current?.id, 'current');
  assert.equal(result.next?.id, 'next');
  assert.equal(result.target?.id, 'next');
  assert.equal(result.fromLocationId, 'c');
  assert.equal(plan({ items: [current], now: Date.parse(current.end) }).target, null);
  assert.equal(plan({ items: [current] }).target?.id, 'current');
});
test('unmapped current or previous class requires origin, not home', () => {
  for (const end of ['2026-10-24T14:30:00Z', '2026-10-24T13:30:00Z']) {
    const result = plan({ items: [item('previous', '2026-10-24T13:00:00Z', end, ''), lecture] });
    assert.equal(result.routeStatus, 'choose-origin');
    assert.equal(result.fromLocationId, null);
  }
});
test('tomorrow defaults home rather than current or yesterday class', () => {
  const result = plan({ items: [item('current', '2026-10-24T13:00:00Z', '2026-10-24T14:30:00Z', 'c'),
    item('tomorrow', '2026-10-25T15:00:00Z', '2026-10-25T16:00:00Z')] });
  assert.equal(result.fromLocationId, 'a');
  assert.equal(result.originSource, 'home');
  assert.equal(result.previous, null);
});
test('overlaps and impossible connections include arrival buffer', () => {
  const previous = item('previous', '2026-10-24T13:00:00Z', '2026-10-24T14:56:00Z', 'c');
  assert.equal(plan({ items: [previous, lecture] }).connectionShortfallMinutes, 2);
  assert.equal(plan({ items: [{ ...previous, end: '2026-10-24T15:10:00Z' }, lecture] }).overlap, true);
  const simultaneous = plan({ items: [previous, item('other', '2026-10-24T13:30:00Z', '2026-10-24T14:30:00Z', 'a'), lecture] });
  assert.equal(simultaneous.ambiguousCurrent, true);
  assert.equal(simultaneous.fromLocationId, null);
});
test('late duration measures projected arrival against buffered target', () => {
  assert.equal(plan({ now: Date.parse('2026-10-24T14:44:00Z') }).lateMinutes, 0);
  assert.equal(plan({ now: Date.parse('2026-10-24T14:44:01Z') }).lateMinutes, 1);
});
test('Boston midnight and DST formatting ignore browser timezone', () => {
  assert.equal(bostonDay('2026-10-25T03:59:00Z'), '2026-10-24');
  assert.equal(bostonDay('2026-10-25T04:00:00Z'), '2026-10-25');
  assert.equal(bostonTime('2026-03-08T06:59:00Z'), '1:59 AM');
  assert.equal(bostonTime('2026-03-08T07:00:00Z'), '3:00 AM');
  assert.match(bostonDateTime('2026-11-01T05:30:00Z'), /EDT/);
  assert.match(bostonDateTime('2026-11-01T06:30:00Z'), /EST/);
  assert.equal(bostonDayLabel('2026-10-25T03:59:00Z', Date.parse('2026-10-24T12:00:00Z')), 'Today · Boston time');
  const result = plan({ now: Date.parse('2026-03-08T06:00:00Z'), items: [item('dst', '2026-03-08T07:05:00Z', '2026-03-08T08:00:00Z')] });
  assert.equal(result.leaveBy, Date.parse('2026-03-08T06:49:00Z'));
});
test('empty and malformed schedules are safe and inputs are unchanged', () => {
  assert.equal(plan({ items: [] }).routeStatus, 'no-class');
  assert.equal(plan({ items: [{ ...lecture, start: 'invalid' }] }).target, null);
  const before = JSON.stringify(base);
  plan();
  assert.equal(JSON.stringify(base), before);
});

test('a long overlapping class cannot be hidden by a later shorter class', () => {
  const long = item('long', '2026-10-24T12:00:00Z', '2026-10-24T15:10:00Z', 'c');
  const short = item('short', '2026-10-24T13:00:00Z', '2026-10-24T13:30:00Z', 'a');
  const result = plan({ items: [long, short, lecture] });
  assert.equal(result.fromLocationId, 'c');
  assert.equal(result.previous?.id, 'long');
  assert.equal(result.overlap, true);
});
test('overlapping classes today do not supply tomorrow origin', () => {
  const first = item('first', '2026-10-24T12:00:00Z', '2026-10-24T15:10:00Z', 'c');
  const second = item('second', '2026-10-24T13:00:00Z', '2026-10-24T14:30:00Z', 'b');
  const tomorrow = item('tomorrow', '2026-10-25T15:00:00Z', '2026-10-25T16:00:00Z');
  assert.equal(plan({ items: [first, second, tomorrow] }).originSource, 'home');
});
