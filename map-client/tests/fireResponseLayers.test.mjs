import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const {
  fireResponseRenderData, fireResponseLayers, fireTruckScale, truckPoint, lightOn, waterArcPath, FIRE_TRUCK_MESH, FLASH_PERIOD,
} = await import('../src/layers/fireResponse.ts');

const M = 111320;
const truck = (over = {}) => ({ id: 'engine-1', position: [-71.1, 42.35], bearing: 0, phase: 'responding', speed: 8, ...over });
const target = [-71.1, 42.35 + 30 / M, 9];

test('truck mesh is built once with matching position, normal and colour arrays', () => {
  const { positions, normals, colors } = FIRE_TRUCK_MESH.attributes;
  assert.equal(positions.size, 3);
  assert.equal(positions.value.length % 9, 0); // whole triangles
  assert.equal(normals.value.length, positions.value.length);
  assert.equal(colors.value.length, positions.value.length);
  for (const c of colors.value) assert.ok(c >= 0 && c <= 1);
  // Length about 10 m, width about 2.5 m (plus mirrors), height above 3 m with the ladder.
  let minY = Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.value.length; i += 3) {
    minY = Math.min(minY, positions.value[i + 1]); maxY = Math.max(maxY, positions.value[i + 1]); maxZ = Math.max(maxZ, positions.value[i + 2]);
  }
  assert.ok(maxY - minY > 10 && maxY - minY < 12, `length ${maxY - minY}`);
  assert.ok(maxZ > 3 && maxZ < 3.6, `height ${maxZ}`);
  assert.equal(fireResponseRenderData([truck()], 0, 18).trucks[0].id, 'engine-1');
});

test('local offsets follow the compass bearing in metres', () => {
  const ahead = (bearing) => truckPoint(truck({ bearing }), [0, 10, 0], 1);
  const east = (p) => (p[0] + 71.1) * M * Math.cos(42.35 * Math.PI / 180);
  const north = (p) => (p[1] - 42.35) * M;
  assert.ok(Math.abs(north(ahead(0)) - 10) < 1e-6 && Math.abs(east(ahead(0))) < 1e-6);
  assert.ok(Math.abs(east(ahead(90)) - 10) < 1e-6 && Math.abs(north(ahead(90))) < 1e-6);
  const right = truckPoint(truck({ bearing: 90 }), [2, 0, 1], 3); // right of an east-facing truck is south
  assert.ok(Math.abs(north(right) + 6) < 1e-6);
  assert.equal(right[2], 3);
});

test('scale is true size up close and grows modestly when zoomed out', () => {
  assert.equal(fireTruckScale(19), 1);
  assert.ok(fireTruckScale(15) > 2 && fireTruckScale(15) <= 4);
  assert.equal(fireTruckScale(10), 4);
});

test('lights alternate deterministically with simulation time', () => {
  assert.equal(lightOn(0, 0.1), true);
  assert.equal(lightOn(1, 0.1), false);
  assert.equal(lightOn(0, 0.1 + FLASH_PERIOD / 2), false);
  assert.equal(lightOn(1, 0.1 + FLASH_PERIOD / 2), true);
  const a = fireResponseRenderData([truck(), truck({ id: 'engine-2', position: [-71.101, 42.35] })], 1234.5, 17);
  const b = fireResponseRenderData([truck(), truck({ id: 'engine-2', position: [-71.101, 42.35] })], 1234.5, 17);
  assert.deepEqual(a, b);
  const changes = new Set();
  for (let t = 0; t < FLASH_PERIOD; t += FLASH_PERIOD / 8) changes.add(fireResponseRenderData([truck()], t, 18).lenses.map((l) => l.on).join());
  assert.ok(changes.size >= 2);
  // A departing unit runs dark.
  assert.ok(fireResponseRenderData([truck({ phase: 'leaving' })], 0.1, 18).lenses.every((l) => !l.on));
});

test('water appears only while fighting with a target', () => {
  for (const phase of ['responding', 'staging', 'leaving']) {
    const d = fireResponseRenderData([truck({ phase, waterTarget: target })], 50, 18);
    assert.equal(d.arcs.length + d.hoses.length + d.droplets.length + d.splash.length, 0, phase);
  }
  assert.equal(fireResponseRenderData([truck({ phase: 'fighting' })], 50, 18).arcs.length, 0);
  const d = fireResponseRenderData([truck({ phase: 'fighting', speed: 0, waterTarget: target })], 50, 18);
  assert.equal(d.arcs.length, 1);
  assert.equal(d.hoses.length, 1);
  const arc = d.arcs[0].path;
  assert.deepEqual(arc.at(-1), target);
  assert.ok(Math.max(...arc.map((p) => p[2])) > Math.max(arc[0][2], target[2]));
  assert.ok(d.hoses[0].path.slice(1).every((p) => p[2] < 0.5)); // laid on the ground
  const end = d.hoses[0].path.at(-1);
  assert.ok(Math.abs(end[0] - target[0]) < 1e-9 && Math.abs(end[1] - target[1]) < 1e-9);
  assert.deepEqual(waterArcPath(arc[0], target), arc);
});

test('layers are bounded and empty without trucks', () => {
  assert.deepEqual(fireResponseLayers([], 0, 16), []);
  const idle = fireResponseLayers([truck()], 10, 16);
  assert.equal(idle.length, 3);
  const fighting = fireResponseLayers([truck({ phase: 'fighting', waterTarget: target }), truck({ id: 'engine-2', phase: 'fighting', waterTarget: target })], 10, 16);
  assert.equal(fighting.length, 8);
  assert.equal(fighting[0].props.mesh, FIRE_TRUCK_MESH);
  assert.equal(new Set(fighting.map((l) => l.id)).size, fighting.length);
});
