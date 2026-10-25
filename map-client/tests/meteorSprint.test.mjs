import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { agentLayers } = await import('../src/layers/agents.ts');

test('only fleeing people use the sprint clip and resume walking when cleared', () => {
  const people = ['escaping', 'bystander'].map(id => ({ id, model: 0, position: [-71, 42, 0], bearing: 90, to: 'safe' }));
  const layers = agentLayers(people, [{}], 1010, { zoom: 17, runningIds: new Set(['escaping']) });
  const visible = layers.filter(layer => layer.props.data.length);
  const runner = visible.find(layer => layer.props.data.some(p => p.id === 'escaping'));
  const walker = visible.find(layer => layer.props.data.some(p => p.id === 'bystander'));
  assert.equal(runner.props._animations.sprint.playing, true);
  assert.equal(walker.props._animations.walk.playing, true);
  assert.equal(visible.flatMap(layer => layer.props.data).length, 2);
  const reset = agentLayers(people, [{}], 900, { zoom: 17 });
  assert.ok(reset.filter(layer => layer.props.data.length).every(layer => layer.props._animations.walk.playing));
});
