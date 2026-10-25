import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendExchange, MAX_HISTORY_LENGTH } from '../src/askConversation.ts';
import { askAgent } from '../src/askClient.ts';

test('exchanges retain the newest six complete pairs without mutating previous history', () => {
  let history = [];
  for (let i = 0; i < 8; i++) history = appendExchange(history, `question ${i}`, `answer ${i}`);
  assert.equal(history.length, 12);
  assert.deepEqual(history.map((message) => message.content), Array.from({ length: 6 }, (_, i) => [`question ${i + 2}`, `answer ${i + 2}`]).flat());
  const before = structuredClone(history);
  const next = appendExchange(history, 'next', 'reply');
  assert.deepEqual(history, before);
  assert.notEqual(next[0], history[2]);
});

test('all retained messages are truncated within the total budget, without splitting Unicode', () => {
  const oversized = Array.from({ length: 6 }, () => [
    { role: 'user', content: 'u'.repeat(1000) },
    { role: 'assistant', content: 'a'.repeat(5000) },
  ]).flat();
  const history = appendExchange(oversized, 'q'.repeat(500), 'a'.repeat(5000));
  assert.equal(history.reduce((sum, message) => sum + message.content.length, 0), MAX_HISTORY_LENGTH);
  assert.ok(history.every((message, i) => message.role === (i % 2 ? 'assistant' : 'user') && message.content.length === (i % 2 ? 4000 : 300)));
  const unicode = appendExchange([], 'x'.repeat(299) + '😀', 'x'.repeat(3999) + '😀');
  assert.equal(unicode[0].content, 'x'.repeat(299));
  assert.equal(unicode[1].content, 'x'.repeat(3999));
});

test('incomplete history is dropped rather than producing orphan turns', () => {
  assert.deepEqual(appendExchange([
    { role: 'assistant', content: 'orphan' },
    { role: 'user', content: 'complete' },
    { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'pending' },
  ], 'new', 'answer'), [
    { role: 'user', content: 'complete' }, { role: 'assistant', content: 'reply' },
    { role: 'user', content: 'new' }, { role: 'assistant', content: 'answer' },
  ]);
});

test('the browser client sends bounded history with the current question', async () => {
  const history = appendExchange([], 'Which library?', 'Mugar.');
  const request = { question: 'Is it open?', weekday: 2, time: 45000, campus: 'charles-river', history };
  let sent;
  const result = await askAgent(request, undefined, { fetchImpl: async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ answer: 'Yes.' }), { status: 200 });
  } });
  assert.deepEqual(sent, request);
  assert.equal(result.ok, true);
});
