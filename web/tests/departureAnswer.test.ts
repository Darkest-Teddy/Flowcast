import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { departureAnswer } = await vite.ssrLoadModule('/src/lib/departureAnswer.ts');
await vite.close();
import type { CampusLocation, ScheduleItem } from '../src/data/types.ts';
const locations: CampusLocation[] = [
  { id: 'home', name: 'Home dorm', short: 'Home', kind: 'dorm', capacity: 100 },
  { id: 'cas', name: 'CAS', short: 'CAS', kind: 'classroom', capacity: 100 },
];
const item: ScheduleItem = { id: 'class', title: 'MA 123', locationId: 'cas', locationText: 'CAS 101', source: 'calendar', start: '2026-10-26T14:00:00Z', end: '2026-10-26T15:00:00Z' };
const now = Date.parse('2026-10-26T13:30:00Z');
test('personal answer uses route rounding, arrival buffer, Boston time and room text', () => {
  const answer = departureAnswer([item], locations, { positions: {}, walkMeters: { 'cas>home': 253 } }, 'home', now);
  assert.match(answer.text, /CAS 101/);
  assert.match(answer.text, /9:51 AM/);
  assert.match(answer.text, /4 min walking plus 5 min/);
  assert.deepEqual(answer.focus, ['home', 'cas']);
});
test('unmapped class keeps its location text without inventing a route', () => {
  const answer = departureAnswer([{ ...item, locationId: '', locationText: 'Unknown room' }], locations, { positions: {}, walkMeters: {} }, 'home', now);
  assert.match(answer.text, /Unknown room/);
  assert.match(answer.text, /Match this class/);
  assert.doesNotMatch(answer.text, /leave by/);
});
test('empty schedule offers import, not an invented next class', () => {
  assert.match(departureAnswer([], locations, { positions: {}, walkMeters: {} }, 'home', now).text, /Import your class calendar/);
});
