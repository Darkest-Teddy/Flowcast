import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildingLabelPriority } from '../src/tags/buildingLabelPriority.ts';
import { createPlacer } from '../src/layers/placement.ts';

const buildings = Array.from({ length: 30 }, (_, i) => ({ id: String(i), share: i / 30 }));
const options = { zoom: 14, width: 1440, height: 900, selectedId: null, hoveredId: null, focusedId: null, all: false };

test('overview labels are bounded by zoom and screen area without modifying source data', () => {
  assert.equal(buildingLabelPriority(buildings, options).length, 4);
  assert.equal(buildingLabelPriority(buildings, { ...options, zoom: 16 }).length, 8);
  assert.equal(buildingLabelPriority(buildings, { ...options, zoom: 18 }).length, 16);
  assert.equal(buildingLabelPriority(buildings, { ...options, zoom: 18, width: 390, height: 844 }).length, 4);
  assert.equal(buildings[0].id, '0');
});

test('selected, hovered and keyboard-focused buildings survive ahead of events and busy buildings', () => {
  const items = buildings.map(b => b.id === '3' ? { ...b, event: { text: 'Event' } } : b);
  const chosen = buildingLabelPriority(items, { ...options, selectedId: '0', hoveredId: '1', focusedId: '2' });
  assert.deepEqual(new Set(chosen.map(b => b.id)), new Set(['0', '1', '2', '3']));
  assert.deepEqual(chosen.map(b => b.id), ['2', '0', '1', '3']);
  const placed = createPlacer(() => [100, 100]).place(chosen.slice(0, 3), {
    position: () => [0, 0], width: () => 100, height: 30, direction: -1, maxLift: 2,
  });
  assert.deepEqual([...placed.keys()].map(b => b.id), ['2', '0', '1']);
});

test('all labels bypasses the budget but keeps interaction targets first', () => {
  const chosen = buildingLabelPriority(buildings, { ...options, all: true, selectedId: '0' });
  assert.equal(chosen.length, buildings.length);
  assert.equal(chosen[0].id, '0');
  assert.equal(chosen[1].id, '29');
});
