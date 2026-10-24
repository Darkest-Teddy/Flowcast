import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('production map does not import demo population or capacity generators', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // These legacy modules create independent riders or resize capacities to fit synthetic peaks.
  // A real transit-mode model must use the shared roster before it can replace this boundary.
  assert.doesNotMatch(app, /from\s+['"]\.\/(?:sim\/(?:riders|calibrate)|layers\/riders)['"]/);
  assert.doesNotMatch(app, /\badjustOccupancy\s*\(/, 'weather must change person timelines before it can change occupancy');
});
