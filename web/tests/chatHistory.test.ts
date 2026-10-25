import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildChatRequest,
  clockSeconds,
  clockText,
  historyForRequest,
  restoreConversation,
  serializeConversation,
  weekdayOfDate,
  type ChatMessage,
} from '../src/lib/chatHistory.ts';
import { parseChatBody } from '../src/lib/chatParse.ts';
import type { ChatResponse } from '@map/chatContract';

const response = (answer: string): ChatResponse => ({ answer, visuals: [], show: null, mapLink: null, sources: [], followUps: [], model: 'm', calls: [] });
const user = (id: string, text: string): ChatMessage => ({ id, role: 'user', text });
const answer = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', status: 'answer', response: response(text) });

function pairs(n: number): ChatMessage[] {
  return Array.from({ length: n }, (_, i) => [user(`u${i}`, `Q${i}`), answer(`a${i}`, `A${i}`)]).flat();
}

test('history ends with the new question', () => {
  assert.deepEqual(historyForRequest([], ' When is GSU quiet? '), [{ role: 'user', text: 'When is GSU quiet?' }]);
  assert.deepEqual(historyForRequest(pairs(1), 'Next'), [
    { role: 'user', text: 'Q0' },
    { role: 'assistant', text: 'A0' },
    { role: 'user', text: 'Next' },
  ]);
});

test('history is trimmed to 12 turns, oldest dropped, never starting with an answer', () => {
  const h = historyForRequest(pairs(20), 'New');
  assert.ok(h.length <= 12);
  assert.equal(h[0].role, 'user');
  assert.deepEqual(h.at(-1), { role: 'user', text: 'New' });
  assert.deepEqual(h.at(-2), { role: 'assistant', text: 'A19' });
  assert.deepEqual(h[0], { role: 'user', text: 'Q15' });
  assert.equal(h.length, 11); // 5 pairs + the question: a 6th pair would have to start with an answer
  assert.equal(historyForRequest(pairs(20), 'New', 4).length, 3);
  assert.equal(historyForRequest(pairs(20), 'New', 1).length, 1);
  // Exactly at the limit.
  assert.equal(historyForRequest(pairs(5), 'New').length, 11);
});

test('personal, failed and sample turns never go to the server', () => {
  const messages: ChatMessage[] = [
    user('u0', 'Where is my next class?'),
    { id: 'd0', role: 'assistant', status: 'device', text: 'CS 132 at CAS, 2 PM', rows: [], note: '' },
    user('u1', 'Quiet library?'),
    { id: 'e1', role: 'assistant', status: 'error', error: { kind: 'timeout', message: 'slow' }, question: 'Quiet library?' },
    user('u2', 'Sample?'),
    { id: 's2', role: 'assistant', status: 'answer', response: response('sample'), sample: true },
    user('u3', 'GSU now?'),
    answer('a3', 'GSU is quiet.'),
  ];
  const h = historyForRequest(messages, 'And at 6?');
  assert.deepEqual(h, [
    { role: 'user', text: 'GSU now?' },
    { role: 'assistant', text: 'GSU is quiet.' },
    { role: 'user', text: 'And at 6?' },
  ]);
  assert.ok(!JSON.stringify(h).includes('CS 132'));
  assert.ok(!JSON.stringify(h).includes('next class'));
});

test('long turns are cut to the contract', () => {
  const h = historyForRequest([user('u', 'q'.repeat(400)), answer('a', 'a'.repeat(3000))], 'x'.repeat(500));
  assert.deepEqual(h.map((t) => t.text.length), [300, 2000, 300]);
});

test('request carries the context', () => {
  const r = buildChatRequest([], 'Hi', { weekday: 3, time: '14:05', campus: 'fenway', date: '2026-10-29' });
  assert.deepEqual(r, { messages: [{ role: 'user', text: 'Hi' }], weekday: 3, time: 14 * 3600 + 300, campus: 'fenway', date: '2026-10-29' });
  const bad = buildChatRequest([], 'Hi', { weekday: 9, time: 'bad', campus: 'medical', date: '2026-13-40' });
  assert.equal(bad.date, null);
  assert.equal(bad.weekday, 6);
});

test('clock and date helpers', () => {
  assert.equal(clockText(14 * 3600 + 5 * 60 + 9), '14:05');
  assert.equal(clockText(-60), '23:59');
  assert.equal(clockSeconds('7:30'), 7 * 3600 + 1800);
  assert.equal(clockSeconds('24:00'), null);
  assert.equal(weekdayOfDate('2026-10-24'), 5); // a Saturday
  assert.equal(weekdayOfDate('2026-10-26'), 0); // a Monday
  assert.equal(weekdayOfDate('2026-02-30'), null);
});

test('stored conversations round-trip and junk is dropped', () => {
  const messages: ChatMessage[] = [
    ...pairs(2),
    { id: 's', role: 'assistant', status: 'answer', response: response('sample'), sample: true },
    { id: 'e', role: 'assistant', status: 'error', error: { kind: 'network', message: 'down' }, question: 'Q' },
  ];
  const back = restoreConversation(serializeConversation(messages), parseChatBody);
  assert.deepEqual(back.map((m) => m.id), ['u0', 'a0', 'u1', 'a1', 'e']); // the sample isn't stored
  assert.deepEqual(restoreConversation(null, parseChatBody), []);
  assert.deepEqual(restoreConversation('not json', parseChatBody), []);
  assert.deepEqual(restoreConversation('{"a":1}', parseChatBody), []);
  const junk = [{ id: 'x', role: 'assistant', status: 'answer', response: { answer: '' } }, { role: 'user', text: 'no id' }, 5];
  assert.deepEqual(restoreConversation(JSON.stringify(junk), parseChatBody), []);
});

test('legacy development samples cannot be restored as genuine answers', () => {
  const raw = JSON.stringify([{ id: 'old-demo', role: 'assistant', status: 'answer', response: response('made-up'), sample: true }]);
  assert.deepEqual(restoreConversation(raw, (body) => body as ChatResponse), []);
});
