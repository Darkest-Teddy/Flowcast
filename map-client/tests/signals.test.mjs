import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { lampAt, planAt, registerSignals, timingLabel } from '../src/sim/signals.ts';

const street = JSON.parse(readFileSync(new URL('../public/data/street.json', import.meta.url)));
registerSignals(street.signals, street.intersections);
const babcock = street.intersections.find(i => i.node === 2);

test('Babcock follows published AM split, clearance, and offset', () => {
  // Existing Conditions, PDF page 580: 100 s cycle, offset 48,
  // EB split 51 s including 3 s yellow and 1 s all-red.
  const start = 8 * 3600 + 48;
  assert.equal(planAt(start, babcock.group).cycle, 100);
  for (const [elapsed, lamp] of [[0, 'green'], [46.9, 'green'], [47, 'amber'], [50, 'red'], [99, 'red'], [100, 'green']]) {
    assert.equal(lampAt(start + elapsed, babcock.group, 0, false, 'EB'), lamp);
  }
});

test('published PM plan and off-peak reuse retain separate provenance', () => {
  const pm = planAt(17 * 3600, babcock.group);
  assert.equal(pm.cycle, 110);
  assert.equal(pm.offset, 66);
  assert.equal(pm.basis, 'published');
  assert.match(pm.sourceUrl, /#page=631$/);
  assert.equal(planAt(12 * 3600, babcock.group).basis, 'reused');
  assert.match(timingLabel(12 * 3600, babcock.group), /Reused published timing/);
  assert.equal(planAt(2 * 3600, babcock.group).name, 'Night');
});

test('every shipped plan identifies its basis; published plans cite dated pages', () => {
  for (const intersection of street.intersections) {
    for (const plan of intersection.plans) {
      assert.ok(['published', 'reused', 'estimated', 'proposed'].includes(plan.basis));
      if (plan.basis === 'published' || plan.basis === 'reused') {
        assert.equal(plan.sourceDate, '2012-05-16');
        assert.match(plan.sourceUrl, /#page=\d+$/);
      }
      assert.ok(plan.cycle > 0);
      for (const split of plan.splits) assert.ok(split.green >= 0 && split.yellow >= 0 && split.allRed >= 0);
    }
  }
});
