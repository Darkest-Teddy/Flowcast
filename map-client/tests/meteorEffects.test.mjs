import assert from 'node:assert/strict';
import { test } from 'node:test';
import { disasterLayers } from '../src/layers/disasterEffects.ts';

const frame = (time) => ({ kind: 'meteor', start: 1000, time,
  center: [-71, 42], baseHeight: 10, damage: [],
  hazard: { radiusMetres: 100, activeUntil: 2800, affectedBuildingIds: [], affectedLocationIds: [] },
});
const dataAt = time => disasterLayers(frame(time)).map(layer => ({ id: layer.id, data: layer.props.data }));

test('meteor approach, impact and aftermath emit finite bounded geometry and replay exactly', () => {
  for (const time of [955, 970, 999.9, 1000, 1001, 1015, 1030, 1060, 1400, 2200]) {
    const data = dataAt(time);
    assert.ok(data.length > 0);
    let count = 0;
    for (const layer of data) for (const particle of layer.data) {
      count++;
      assert.ok(particle.position.every(Number.isFinite));
      assert.ok(particle.position[2] >= 0);
      if (particle.color) assert.ok(particle.color.every(c => Number.isFinite(c) && c >= 0 && c <= 255));
    }
    assert.ok(count < 400);
    dataAt(2500);
    assert.deepEqual(dataAt(time), data);
  }
  assert.deepEqual(dataAt(954), []);
  assert.deepEqual(dataAt(2800), []);
});

test('approach has a solid tumbling core and impact sends debris away from center', () => {
  const core = dataAt(980).find(layer => layer.id === 'incident-meteor-ejecta').data;
  assert.equal(core.length, 1);
  assert.ok(core[0].position[2] > 0);
  const debris = dataAt(1003).find(layer => layer.id === 'incident-meteor-ejecta').data;
  assert.ok(debris.length > 1);
  assert.ok(debris.some(p => Math.abs(p.position[0] + 71) > 0.00001));
});
