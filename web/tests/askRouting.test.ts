import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bostonClock, isPersonalQuestion, mentionsHome, planQuestion, routeQuestion } from '../src/lib/askRouting.ts';

const PERSONAL = [
  'Where is my next class?',
  'where’s my next class',
  'My classes today',
  'How far apart are my classes today?',
  'how long is the walk between classes',
  "What's next?",
  'When do I have class tomorrow?',
  'What is my schedule today',
  'Do I have a lecture this afternoon?',
  'Where should I eat between classes?',
  'How far is Mugar from my next lecture',
];
/** Name only the person's home: sent with the home's place name, never kept local. */
const HOME = [
  ['How far is Mugar from my dorm?', 'How far is Mugar from Warren Towers?'],
  ['walk from my room to CAS', 'walk from Warren Towers to CAS'],
  ['walk from my dorm room to CAS', 'walk from Warren Towers to CAS'],
  ['quietest library near my dorm', 'quietest library near Warren Towers'],
  ['How long to get home from the GSU', 'How long to get home from the GSU'], // "get home" isn't a place
  ['how far is FitRec from home', 'how far is FitRec from Warren Towers'],
  ['Is My Dorm busy right now?', 'Is Warren Towers busy right now?'],
];
const CAMPUS = [
  'Quietest dining hall at 6pm',
  'Least crowded library right now',
  'How far is CS 132 from DS 340?',
  'Where is CAS CS 132?',
  'When is GSU quiet?',
  'Where should I eat?',
  'any events tonight',
  'Is my favorite library busy?',
  'where can I find an empty classroom',
  'Where do I find food after 10pm?',
];

test('questions that need the asker’s own schedule are personal', () => {
  for (const q of PERSONAL) assert.equal(isPersonalQuestion(q), true, q);
});

test('campus questions are not personal', () => {
  for (const q of CAMPUS) assert.equal(isPersonalQuestion(q), false, q);
});

test('a question that only names the person’s home is sent with the home’s place name', () => {
  for (const [q, sent] of HOME) {
    assert.equal(isPersonalQuestion(q), false, q);
    assert.deepEqual(planQuestion(q, 'Warren Towers'), { local: false, question: sent }, q);
  }
  assert.equal(mentionsHome('How far is Mugar from my dorm?'), true);
  assert.equal(mentionsHome('How far is Mugar from CAS?'), false);
  assert.deepEqual(planQuestion('walk from my dorm to CAS', '$& Hall'), { local: false, question: 'walk from $& Hall to CAS' });
  // Without a home on the profile there is nothing to send, so it stays on the device.
  assert.deepEqual(planQuestion('How far is Mugar from my dorm?', null), { local: true });
  // Schedule questions stay local even with a home.
  assert.deepEqual(planQuestion('How far is my next class from my dorm?', 'Warren Towers'), { local: true });
});

test('personal questions never reach the agent; campus questions do', async () => {
  const sent: string[] = [];
  const agent = async (q: string) => { sent.push(q); return { ok: true as const, value: `agent: ${q}` }; };
  for (const q of PERSONAL) assert.deepEqual(await routeQuestion(q, agent), { source: 'device', reason: 'personal' });
  assert.deepEqual(sent, []);
  assert.deepEqual(await routeQuestion('Quietest dining hall at 6pm', agent), { source: 'agent', answer: 'agent: Quietest dining hall at 6pm', question: 'Quietest dining hall at 6pm' });
  assert.deepEqual(sent, ['Quietest dining hall at 6pm']);
  // Only the home's place name leaves the device.
  assert.deepEqual(await routeQuestion('How far is Mugar from my dorm?', agent, 'Warren Towers'),
    { source: 'agent', answer: 'agent: How far is Mugar from Warren Towers?', question: 'How far is Mugar from Warren Towers?' });
  assert.deepEqual(await routeQuestion('How far is Mugar from my dorm?', agent, null), { source: 'device', reason: 'personal' });
  assert.deepEqual(sent, ['Quietest dining hall at 6pm', 'How far is Mugar from Warren Towers?']);
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

test('follow-ups after personal context stay on-device until a self-contained place question', async () => {
  const sent: string[] = [];
  const agent = async (q: string) => { sent.push(q); return { ok: true as const, value: 'Campus answer' }; };
  const context = { afterDevice: true, locationNames: ['Mugar Memorial Library', 'Mugar', 'CAS'] };
  for (const question of ['How far is it?', 'When should I leave?', 'What about tomorrow?', 'Is that near Mugar?', 'How about there?', 'Mugar instead?', 'Is it busy at CAS?', 'Where should I eat?']) {
    assert.deepEqual(await routeQuestion(question, agent, null, context), { source: 'device', reason: 'privateFollowup' }, question);
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(await routeQuestion('When is Mugar quiet?', agent, null, context), { source: 'agent', question: 'When is Mugar quiet?', answer: 'Campus answer' });
  assert.deepEqual(sent, ['When is Mugar quiet?']);
});

test('named places never override personal-question protection', async () => {
  let calls = 0;
  const result = await routeQuestion('How far is my next class from Mugar?', async () => {
    calls++;
    return { ok: true as const, value: 'Must not run' };
  }, null, { afterDevice: true, locationNames: ['Mugar'] });
  assert.equal(calls, 0);
  assert.deepEqual(result, { source: 'device', reason: 'personal' });
});

test('public follow-ups and repeated questions may reach the agent', async () => {
  const sent: string[] = [];
  const agent = async (q: string) => { sent.push(q); return { ok: true as const, value: 'Answer' }; };
  for (const question of ['When is Mugar quiet?', 'How about tomorrow?', 'How about tomorrow?']) {
    assert.equal((await routeQuestion(question, agent, null, { afterDevice: false, locationNames: [] })).source, 'agent');
  }
  assert.deepEqual(sent, ['When is Mugar quiet?', 'How about tomorrow?', 'How about tomorrow?']);
});
