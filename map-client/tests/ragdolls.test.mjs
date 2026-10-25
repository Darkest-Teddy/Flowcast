// Meteor fatalities fly away from the impact, tumbling, and then lie still where they land.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { ragdollsAt } = await import('../src/layers/ragdolls.ts');

const impact = [-71.1, 42.35];
const east = (m) => [impact[0] + m / (111320 * Math.cos(42.35 * Math.PI / 180)), impact[1]];
const event = (agentId, at, position, extra = {}) => ({ agentId, outcome: 'fatality', at, position, cause: 'meteor', ...extra });
const model = () => 3;

test('only meteor fatalities that have happened become ragdolls', () => {
  const events = [event('a', 100, east(20)), event('b', 100, east(20), { outcome: 'injured' }), event('c', 100, east(20), { cause: 'fire' }), event('d', 500, east(20))];
  assert.deepEqual(ragdollsAt(events, impact, 100, 200, model).map((p) => p.id), ['a']);
});

test('thrown up and away from the impact, then flat on the ground and still', () => {
  const events = [event('a', 100, east(20))];
  const mid = ragdollsAt(events, impact, 100, 101.5, model)[0];
  assert.ok(mid.position[2] > 3, `airborne ${mid.position[2]} m`);
  assert.ok(mid.position[0] > east(20)[0], 'moving away from the impact (east)');
  assert.equal(mid.landed, false);
  const after = ragdollsAt(events, impact, 100, 200, model)[0];
  const later = ragdollsAt(events, impact, 100, 5000, model)[0];
  assert.equal(after.landed, true);
  assert.equal(after.position[2], 0);
  assert.deepEqual(later.position, after.position, 'no movement after landing');
  assert.deepEqual(later.orientation, after.orientation);
  assert.ok(Math.abs(after.orientation[0] % 360) < 1e-6 && Math.abs(after.orientation[2] % 360) < 1e-6, 'lying flat');
  assert.equal(after.model, 3);
  // Deterministic: the same person always lands in the same place.
  assert.deepEqual(ragdollsAt(events, impact, 100, 200, model), [after]);
});

test('people nearer the impact are thrown further', () => {
  const near = ragdollsAt([event('p', 0, east(5))], impact, 200, 100, model)[0];
  const far = ragdollsAt([event('p', 0, east(190))], impact, 200, 100, model)[0];
  const flown = (pose, start) => Math.abs(pose.position[0] - start[0]);
  assert.ok(flown(near, east(5)) > flown(far, east(190)));
});
