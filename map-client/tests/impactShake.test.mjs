import assert from 'node:assert/strict';
import { test } from 'node:test';
import { impactShake } from '../src/layers/impactShake.ts';

test('impact shake is bounded, decays, and rewinds without accumulating camera drift', () => {
  const samples = [0, 1, 5, 15, 30, 44].map(t => impactShake(t, 500));
  for (const pair of samples) for (const n of pair) assert.ok(Number.isFinite(n) && Math.abs(n) <= 14);
  assert.ok(Math.hypot(...samples.at(-1)) < 0.001);
  impactShake(1000, 500);
  assert.deepEqual([0, 1, 5, 15, 30, 44].map(t => impactShake(t, 500)), samples);
});

test('no displacement before impact, after settling, or with reduced motion', () => {
  for (const t of [-45, -0.01, 45, 5000]) assert.deepEqual(impactShake(t, 100), [0, 0]);
  for (const t of [0, 1, 20]) assert.deepEqual(impactShake(t, 100, true), [0, 0]);
});
