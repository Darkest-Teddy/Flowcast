import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildFootprintIndex, coveredByModels, insideFootprint } from '../src/map/footprintCover.ts';

const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];
const index = buildFootprintIndex([{ rings: [sq(-71.1, 42.35, 0.0004)] }]);

test('a base-map building inside our footprint is covered, whatever its id', () => {
  assert.equal(insideFootprint(index, [-71.0998, 42.3502]), true);
  assert.equal(coveredByModels(index, [sq(-71.0999, 42.3501, 0.0002)]), true);
  // The same building split by a tile edge: either piece is still covered.
  assert.equal(coveredByModels(index, [sq(-71.0999, 42.3501, 0.0001)]), true);
});

test('a neighbour sharing a wall, or one across the street, is not', () => {
  assert.equal(coveredByModels(index, [sq(-71.0996, 42.35, 0.0004)]), false); // shares the east wall
  assert.equal(coveredByModels(index, [sq(-71.0990, 42.35, 0.0003)]), false);
});
