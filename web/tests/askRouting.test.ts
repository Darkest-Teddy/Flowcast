import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bostonClock, isPersonalQuestion, routeQuestion } from '../src/lib/askRouting.ts';

const PERSONAL = [
  'Where is my next class?',
  'where’s my next class',
  'My classes today',
  'How far apart are my classes today?',
  'how long is the walk between classes',
  "What's next?",
  'When do I have class tomorrow?',
  'How far is Mugar from my dorm?',
];
const CAMPUS = [
  'Quietest dining hall at 6pm',
  'Least crowded library right now',
  'How far is CS 132 from DS 340?',
  'Where is CAS CS 132?',
  'When is GSU quiet?',
  'Where should I eat?',
  'any events tonight',
];

test('questions about the asker’s own schedule or places are personal', () => {
  for (const q of PERSONAL) assert.equal(isPersonalQuestion(q), true, q);
});

test('campus questions are not personal', () => {
  for (const q of CAMPUS) assert.equal(isPersonalQuestion(q), false, q);
});

test('personal questions never reach the agent; campus questions do', async () => {
  const sent: string[] = [];
  const agent = async (q: string) => { sent.push(q); return { ok: true as const, value: `agent: ${q}` }; };
  for (const q of PERSONAL) assert.deepEqual(await routeQuestion(q, agent), { source: 'device', reason: 'personal' });
  assert.deepEqual(sent, []);
  assert.deepEqual(await routeQuestion('Quietest dining hall at 6pm', agent), { source: 'agent', answer: 'agent: Quietest dining hall at 6pm' });
  assert.deepEqual(sent, ['Quietest dining hall at 6pm']);
});

test('agent failures fall back to the device; a cancelled question is dropped', async () => {
  const error = { kind: 'network', message: 'down' };
  assert.deepEqual(await routeQuestion('least crowded gym', async () => ({ ok: false as const, error })), { source: 'device', reason: 'failed', error });
  assert.deepEqual(await routeQuestion('least crowded gym', async () => ({ ok: false as const, error: { kind: 'aborted', message: '' } })), { source: 'cancelled' });
});

test('Boston clock: Monday is 0 and time is Eastern, across daylight saving', () => {
  // Monday 26 Oct 2026, 18:00 EDT = 22:00 UTC.
  assert.deepEqual(bostonClock(new Date('2026-10-26T22:00:00Z')), { weekday: 0, time: 18 * 3600 });
  // Sunday 1 Nov 2026, 01:30 UTC is still Saturday 21:30 EDT.
  assert.deepEqual(bostonClock(new Date('2026-11-01T01:30:00Z')), { weekday: 5, time: 21.5 * 3600 });
  // After the change: Monday 2 Nov 2026, 00:05 EST = 05:05 UTC.
  assert.deepEqual(bostonClock(new Date('2026-11-02T05:05:00Z')), { weekday: 0, time: 300 });
});
