import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countInterval, UNMODELLED_MIN, UNMODELLED_SHARE } from '../src/sim/uncertainty.ts';

test('an empty building is never certainly empty', () => {
  const { low, high } = countInterval(0, 600);
  assert.equal(low, 0);
  assert.equal(high, Math.ceil(UNMODELLED_SHARE * 600));
  assert.equal(countInterval(0, 0).high, UNMODELLED_MIN);
});

test('the band contains the count, widens with it, and stays non-negative', () => {
  let last = 0;
  for (const count of [1, 5, 20, 100, 500, 2000]) {
    const { low, high } = countInterval(count, 1000);
    assert.ok(low >= 0 && low <= count && high >= count);
    assert.ok(high - low >= last);
    last = high - low;
  }
  // ~±(1.645·√400 + 15%) ≈ ±93 around 400, plus up to 3% of capacity on top.
  const { low, high } = countInterval(400, 1000);
  assert.ok(low >= 300 && low <= 310 && high >= 520 && high <= 530);
});
