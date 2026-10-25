import assert from 'node:assert/strict';
import { test } from 'node:test';

const { applyMotion, keyMotion, PAN_SPEED, ROTATE_SPEED } = await import('../src/map/hotkeys.ts');

const camera = { center: [-71.1, 42.35], zoom: 16, pitch: 0, bearing: 0 };
const still = { panX: 0, panY: 0, rotate: 0, tilt: 0, zoom: 0 };

test('arrows pan on screen axes, Shift turns them into rotate and tilt', () => {
  assert.deepEqual(keyMotion('ArrowUp', false), { panY: PAN_SPEED });
  assert.deepEqual(keyMotion('ArrowLeft', true), { rotate: -ROTATE_SPEED });
  assert.ok(keyMotion('ArrowDown', true).tilt < 0);
  assert.ok(keyMotion('+', true).zoom > 0, '+ is typed with Shift and still zooms');
  assert.equal(keyMotion('x', false), null);
});

test('a pan follows the bearing: "up" is north facing north and east facing east', () => {
  const north = applyMotion(camera, { ...still, panY: 100 }, 85);
  assert.ok(north.center[1] > camera.center[1]);
  assert.ok(Math.abs(north.center[0] - camera.center[0]) < 1e-9);

  const east = applyMotion({ ...camera, bearing: 90 }, { ...still, panY: 100 }, 85);
  assert.ok(east.center[0] > camera.center[0]);
  assert.ok(Math.abs(east.center[1] - camera.center[1]) < 1e-9);

  const right = applyMotion(camera, { ...still, panX: 100 }, 85);
  assert.ok(right.center[0] > camera.center[0]);
});

test('tilt stays inside the map limits and zoom adds up', () => {
  assert.equal(applyMotion(camera, { ...still, tilt: -20 }, 85).pitch, 0);
  assert.equal(applyMotion({ ...camera, pitch: 80 }, { ...still, tilt: 20 }, 85).pitch, 85);
  assert.equal(applyMotion(camera, { ...still, zoom: 0.5 }, 85).zoom, 16.5);
});
