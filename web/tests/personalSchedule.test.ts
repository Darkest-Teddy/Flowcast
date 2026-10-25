import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPersonalSchedule } from '../src/lib/personalSchedule.ts';
import { routeQuestion } from '../src/lib/askRouting.ts';

const at = new Date('2026-10-25T15:00:00Z');
const item = { id: 'private-id', title: 'Calculus', start: '2026-10-26T15:00:00Z', end: '2026-10-26T16:00:00Z', locationId: 'cas', locationText: 'CAS 101', source: 'class' as const, note: 'private note' };
test('schedule context bounds dates and excludes unrelated metadata', () => {
  const result = buildPersonalSchedule([item, {...item, start: 'invalid'}, {...item, start: '2026-11-25T15:00:00Z', end: '2026-11-25T16:00:00Z'}], at);
  assert.equal(result.items.length, 1);
  assert.deepEqual(Object.keys(result.items[0]).sort(), ['end', 'locationId', 'locationText', 'start', 'title']);
  assert.equal(result.asOf, at.toISOString());
  assert.equal(result.truncated, false);
});
test('large schedules are bounded and flagged', () => {
  const result = buildPersonalSchedule(Array.from({length: 101}, () => item), at);
  assert.equal(result.items.length, 100);
  assert.equal(result.truncated, true);
});
test('explicit schedule context lets personal questions reach the agent', async () => {
  let called = false;
  const result = await routeQuestion('Where is my next class?', async () => { called = true; return {ok: true, value: 'CAS'}; }, null, {scheduleShared: true, afterDevice: false, locationNames: []});
  assert.equal(called, true);
  assert.equal(result.source, 'agent');
});
