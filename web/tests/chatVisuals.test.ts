import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatValue, tickText, visualToTable, xLabelIndexes, yScale } from '../src/lib/chatVisuals.ts';
import type { Visual } from '@map/chatContract';

test('line to table: one row per x, one column per series, gaps as dashes', () => {
  const v: Visual = {
    id: 'l', kind: 'line', title: 'Libraries', source: 'simulated', note: null, unit: '% full',
    x: ['8 AM', '9 AM', '10 AM'],
    series: [{ name: 'Mugar', values: [20, 35.25, null] }, { name: 'SEL', values: [10, null, 1547] }],
    marker: { index: 1, label: 'Now' },
  };
  const t = visualToTable(v);
  assert.deepEqual(t.columns.map((c) => c.label), ['Time', 'Mugar (% full)', 'SEL (% full)']);
  assert.deepEqual(t.rows, [
    { x: '8 AM', s0: '20', s1: '10' },
    { x: '9 AM (Now)', s0: '35.3', s1: '—' },
    { x: '10 AM', s0: '—', s1: '1,547' },
  ]);
});

test('bar to table keeps the crowd word next to the value', () => {
  const v: Visual = {
    id: 'b', kind: 'bar', title: 'At 2 PM', source: 'simulated', note: null, unit: '% full',
    bars: [{ label: 'Mugar', value: 78, level: 'Busy', detail: '1,547 of 1,980 seats' }, { label: 'Stone', value: null, level: null, detail: null }],
  };
  const t = visualToTable(v);
  assert.deepEqual(t.columns.map((c) => c.key), ['label', 'value', 'level', 'detail']);
  assert.equal(t.columns[1].label, 'Value (% full)');
  assert.deepEqual(t.rows[0], { label: 'Mugar', value: '78', level: 'Busy', detail: '1,547 of 1,980 seats' });
  assert.deepEqual(t.rows[1], { label: 'Stone', value: '—', level: '—', detail: '—' });
  // No level or detail anywhere: no empty columns.
  const plain = visualToTable({ ...v, bars: [{ label: 'A', value: 1, level: null, detail: null }] });
  assert.deepEqual(plain.columns.map((c) => c.key), ['label', 'value']);
});

test('table and stats to table', () => {
  const t = visualToTable({
    id: 't', kind: 'table', title: 'Hours', source: 'published', note: null,
    columns: [{ key: 'n', label: 'Name', align: 'left' }, { key: 's', label: 'Seats', align: 'right' }],
    rows: [{ n: 'GSU', s: 600 }, { n: 'Fenway', s: null }],
  });
  assert.deepEqual(t.columns.map((c) => c.align), ['left', 'right']);
  assert.deepEqual(t.rows, [{ n: 'GSU', s: '600' }, { n: 'Fenway', s: '—' }]);
  const s = visualToTable({ id: 's', kind: 'stats', title: 'Now', source: 'mixed', note: null, items: [{ label: 'Open', value: '5 of 6', detail: null }] });
  assert.deepEqual(s.columns.map((c) => c.key), ['label', 'value']);
  assert.deepEqual(s.rows, [{ label: 'Open', value: '5 of 6' }]);
});

test('values with units', () => {
  assert.equal(formatValue(71, '% full'), '71% full');
  assert.equal(formatValue(1547, 'students'), '1,547 students');
  assert.equal(formatValue(null, 'students'), '—');
  assert.equal(formatValue(2.345, ''), '2.3');
  assert.equal(tickText(1500), '1.5K');
  assert.equal(tickText(40), '40');
});

test('y scale: percent shows 0–100 at least, round ticks', () => {
  assert.deepEqual(yScale([20, 60, null], '% full'), { min: 0, max: 100, ticks: [0, 25, 50, 75, 100] });
  const s = yScale([0, 1547], 'students');
  assert.equal(s.min, 0);
  assert.ok(s.max >= 1547 && s.ticks.at(-1) === s.max);
  assert.deepEqual(yScale([null, null], ''), { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] });
  const neg = yScale([-12, 30], 'change');
  assert.ok(neg.min <= -12 && neg.ticks.includes(0));
});

test('x labels thin out but keep both ends', () => {
  assert.deepEqual(xLabelIndexes(5, 10), [0, 1, 2, 3, 4]);
  const idx = xLabelIndexes(24, 6);
  assert.equal(idx[0], 0);
  assert.equal(idx.at(-1), 23);
  assert.ok(idx.length <= 7);
});
