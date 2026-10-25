import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { campusFromUrl, finiteParam, playbackFromUrl } from '../src/map/deepLink.ts';

const params = (query) => new URLSearchParams(query);

test('dashboard event handoff retains its date, clock and paused speed', () => {
  assert.deepEqual(playbackFromUrl(params('date=2026-10-30&at=14%3A15&speed=0')), {
    date: '2026-10-30', at: 51300, speed: 0, live: false,
  });
  assert.equal(playbackFromUrl(params('at=00:00')).at, 0);
});

test('malformed playback links fall back to live time instead of corrupting simulation state', () => {
  for (const query of ['date=2026-99-99', 'date=2026-02-30', 'at=99:99', 'at=24:00', 'at=12:60', 'speed=Infinity', 'speed=-1', 'speed=oops', 'speed=']) {
    assert.deepEqual(playbackFromUrl(params(query)), { date: null, at: null, speed: null, live: true }, query);
  }
  assert.equal(playbackFromUrl(params('date=2028-02-29')).date, '2028-02-29');
});

test('camera parameters reject nonfinite and out-of-range values while retaining zero', () => {
  for (const value of ['oops', 'Infinity', '', '91', '-91']) {
    assert.equal(finiteParam(params(`lat=${value}`), 'lat', -90, 90), null);
  }
  assert.equal(finiteParam(params('pitch=0'), 'pitch', 0, 85), 0);
});

test('dashboard coordinates select matching panels for every mapped campus location', () => {
  const { locations } = JSON.parse(readFileSync(new URL('../public/data/demo-day.json', import.meta.url), 'utf8'));
  const campuses = new Set();
  for (const location of locations.filter((place) => place.campus)) {
    campuses.add(location.campus);
    const [lng, lat] = location.position;
    assert.equal(campusFromUrl(params(`lng=${lng.toFixed(5)}&lat=${lat.toFixed(5)}`), locations), location.campus, location.id);
  }
  assert.deepEqual([...campuses].sort(), ['charles-river', 'fenway', 'medical']);
  assert.equal(campusFromUrl(params('zoom=17'), locations), 'charles-river');
  assert.equal(campusFromUrl(params('lng=NaN&lat=Infinity'), locations), 'charles-river');
});
