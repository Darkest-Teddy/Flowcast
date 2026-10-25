import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLink } from '../src/lib/mapLink.ts';
import { answerMapLink } from '../src/lib/askMapLink.ts';
import { safeMapLink } from '../src/lib/chatParse.ts';

test('map handoffs preserve configured queries and fragments, overriding duplicate keys', () => {
  const base = 'https://campus.example/map/?quality=low&events=0#view';
  const link = new URL(mapLink(base, { date: '2026-10-30', at: '14:15', events: '1' }));
  assert.equal(link.pathname, '/map/');
  assert.equal(link.hash, '#view');
  assert.equal(link.searchParams.get('quality'), 'low');
  assert.equal(link.searchParams.get('date'), '2026-10-30');
  assert.equal(link.searchParams.get('at'), '14:15');
  assert.deepEqual(link.searchParams.getAll('events'), ['1']);
  const camera = new URL(answerMapLink(base, [[-71.1, 42.35]])!);
  assert.equal(camera.searchParams.get('lng'), '-71.10000');
  assert.equal(camera.searchParams.get('quality'), 'low');
  assert.equal(camera.hash, '#view');
});

test('chat handoffs keep the trusted map destination and merge the validated query', () => {
  const link = new URL(safeMapLink('/map?at=12:20&speed=1', 'https://campus.example/map?quality=low#view')!);
  assert.equal(link.origin, 'https://campus.example');
  assert.equal(link.searchParams.get('at'), '12:20');
  assert.equal(link.searchParams.get('quality'), 'low');
  assert.equal(link.hash, '#view');
  assert.equal(safeMapLink('//evil.example/map'), null);
  assert.equal(mapLink('/map', { tab: 'data' }), '/map?tab=data');
});
