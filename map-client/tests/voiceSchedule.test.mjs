import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { loadVoiceSchedule } = await import('../src/voiceSchedule.ts');
const at = new Date('2026-10-25T15:00:00Z');
const identity = async () => ({ userId: 'user-a', accessToken: 'private-token' });
const item = { title: 'Calculus', start: '2026-10-26T15:00:00Z', end: '2026-10-26T16:00:00Z', locationId: 'cas', note: 'not shared' };
const signal = () => new AbortController().signal;

test('signed-out voice never requests a private calendar', async () => {
  const result = await loadVoiceSchedule(async () => null, signal(), async () => { throw new Error('unexpected request'); }, at);
  assert.equal(result.userId, null);
  assert.equal(result.personalSchedule, undefined);
});

test('voice loads authenticated schedule and shares only bounded calendar context', async () => {
  const result = await loadVoiceSchedule(identity, signal(), async (url, options) => {
    assert.equal(url, '/api/dashboard/schedule');
    assert.equal(options.headers.Authorization, 'Bearer private-token');
    assert.equal(options.cache, 'no-store');
    return Response.json({ items: [item, { ...item, start: '2027-01-01T15:00:00Z', end: '2027-01-01T16:00:00Z' }] });
  }, at);
  assert.equal(result.userId, 'user-a');
  assert.equal(result.personalSchedule.asOf, at.toISOString());
  assert.equal(result.personalSchedule.items.length, 1);
  assert.equal(result.personalSchedule.items[0].title, 'Calculus');
  assert.equal('note' in result.personalSchedule.items[0], false);
  assert.equal(JSON.stringify(result).includes('private-token'), false);
});

test('account switch during calendar load discards the previous account data', async () => {
  let reads = 0;
  await assert.rejects(loadVoiceSchedule(async () => ++reads === 1 ? identity() : null, signal(),
    async () => Response.json({ items: [item] }), at), /account changed/);
});

test('failed and malformed calendars never masquerade as an empty schedule', async () => {
  for (const response of [Response.json({}, { status: 401 }), Response.json({}), Response.json({ items: [null] })]) {
    await assert.rejects(loadVoiceSchedule(identity, signal(), async () => response, at), /schedule/);
  }
});

test('ending voice aborts calendar loading and prevents returned personal context', async () => {
  const abort = new AbortController();
  await assert.rejects(loadVoiceSchedule(identity, abort.signal, async () => {
    abort.abort(); return Response.json({ items: [item] });
  }, at), { name: 'AbortError' });
});
