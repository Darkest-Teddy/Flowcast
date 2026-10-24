import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebMercatorViewport } from '@deck.gl/core';
import { TagProjection } from '../src/tags/projection.ts';

test('stationary labels reuse exact roof projections and invalidate for camera, padding, resize, occupancy and roof data', () => {
  const cache = new TagProjection(60);
  let camera = { center: [-71.1, 42.35], zoom: 16, pitch: 50, bearing: 10 };
  let width = 900, height = 700, padding = [0, 0], calls = 0;
  const project = point => {
    calls++;
    const view = new WebMercatorViewport({ width, height, longitude: camera.center[0], latitude: camera.center[1], ...camera });
    const p = view.project(point); return [p[0] + padding[0], p[1] + padding[1]];
  };
  let items = [{ position: [-71.1, 42.35, 20], minZoom: 15 }], roofs = {};
  const get = () => cache.get(items, camera, width, height, project, item => item.position, roofs, item => item.minZoom);
  let previous = get();
  const p = previous.get(items[0]);
  const view = new WebMercatorViewport({ width, height, longitude: camera.center[0], latitude: camera.center[1], ...camera });
  const expected = view.project(items[0].position);
  assert.ok(p.every((v, i) => Math.abs(v - expected[i]) < 1e-9));
  calls = 0; assert.equal(get(), previous); assert.equal(calls, 1, 'cache hit projects only the padding-sensitive center');
  for (const change of [
    () => camera = { ...camera, bearing: 12 },
    () => camera = { ...camera, pitch: 45 },
    () => camera = { ...camera, zoom: 16.1 },
    () => camera = { ...camera, center: [-71.1001, 42.35] },
    () => width += 10,
    () => height += 10,
    () => padding = [30, 15],
    () => items = [{ ...items[0] }],
    () => roofs = {},
  ]) {
    change(); const next = get(); assert.notEqual(next, previous); assert.equal(next.size, 1); previous = next;
    assert.equal(get(), next);
  }
  camera = { ...camera, zoom: 14 };
  assert.equal(get().size, 0);
});

test('selection can reorder cached anchors without changing their screen geometry', () => {
  const cache = new TagProjection(60);
  const camera = { center: [-71.1, 42.35], zoom: 16, pitch: 0, bearing: 0 };
  const items = [{ id: 'a', share: .9 }, { id: 'b', share: .1 }];
  const anchors = cache.get(items, camera, 800, 600, () => [400, 300], () => [-71.1, 42.35, 0]);
  const ordered = selected => [...anchors.keys()].sort((a, b) => Number(b.id === selected) - Number(a.id === selected) || b.share - a.share).map(x => x.id);
  assert.deepEqual(ordered(null), ['a', 'b']);
  assert.deepEqual(ordered('b'), ['b', 'a']);
});
