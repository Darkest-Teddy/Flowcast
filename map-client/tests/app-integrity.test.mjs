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

test('event visitors are drawn beside the students, never counted as students or occupancy', () => {
  const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  // Visitors join only the drawn walker list; the HUD's walking count and every occupancy stay the roster's.
  assert.match(app, /withVisitors\(inView\(nearView\(walking,/);
  assert.match(app, /walking: walking\.length, occupancy/);
  assert.doesNotMatch(app, /occupancyAt\([^)]*visitor/i);
  const playback = readFileSync(new URL('../src/sim/playback.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(playback, /eventAttendance|sim\/visitors|from '\.\/visitors'/);
});
