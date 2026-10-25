import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BluebikesFeed, estimateDock, freshDock } from '../src/bikes/bluebikes.ts';
import { activeWeather, forecastAt, forecastHours, freshWeather, fetchWeather } from '../src/weather/weather.ts';

const station = { id: 'dock', gbfsId: '1', capacity: null, profile: { arrivals: [2], departures: [0] } };
const status = (extra = {}) => ({ bikes: 4, ebikes: 1, docks: 6, reportedAt: Date.now(), renting: true, returning: true, ...extra });
const reading = (observedAt, temperatureF = 60) => ({ observedAt, code: 0, condition: 'clear', text: 'Clear', temperatureF,
  feelsLikeF: temperatureF, windMph: 4, windFromDeg: 250, cloudCover: 0, precipMmPerHour: 0, snowCmPerHour: 0 });

test('dock availability needs a fresh valid observation, never assumed capacity or fill', () => {
  assert.equal(estimateDock(station, undefined, 3600, 0, 3600), undefined);
  for (const reportedAt of [NaN, 0, Date.now() + 60_000, Date.now() - 120_001]) {
    assert.equal(freshDock(status({ reportedAt })), false);
    assert.equal(estimateDock(station, status({ reportedAt }), 3600, 0, 3600), undefined);
  }
  assert.deepEqual(estimateDock(station, status(), 3600, 0, 0), { bikes: 4, ebikes: 1, docks: 6, estimated: false });
  assert.deepEqual(estimateDock(station, status(), 3600, 0, 3600), { bikes: 6, ebikes: 2, docks: 4, estimated: true });
  assert.equal(estimateDock(station, status({ bikes: 0, ebikes: 0 }), 3600, 0, 3600).ebikes, null);
  assert.equal(estimateDock(station, status({ ebikes: null }), 3600, 0, 3600).ebikes, null);
  assert.equal(estimateDock(station, status(), 0, 0, 3600), undefined);
});

test('poll failure immediately withdraws old dock availability; malformed counts are excluded', async (t) => {
  let rerun;
  const previousWindow = globalThis.window;
  globalThis.window = { setTimeout: (run) => { rerun = run; return 0; } };
  t.after(() => { if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow; });
  let fail = false;
  t.mock.method(globalThis, 'fetch', async () => {
    if (fail) throw new Error('offline');
    return { ok: true, json: async () => ({ data: { stations: [
      { station_id: '1', num_bikes_available: 4, num_docks_available: 6, last_reported: Math.floor(Date.now() / 1000) },
      { station_id: '2', num_bikes_available: null, num_docks_available: 6, last_reported: Math.floor(Date.now() / 1000) },
    ] } }) };
  });
  let changed;
  const first = new Promise((resolve) => { changed = resolve; });
  const feed = new BluebikesFeed([station, { ...station, gbfsId: '2' }], () => changed());
  feed.start();
  await first;
  assert.equal(feed.status(station).bikes, 4);
  assert.equal(feed.status(station).ebikes, null);
  assert.equal(feed.status({ ...station, gbfsId: '2' }), undefined);
  fail = true;
  await rerun();
  assert.equal(feed.status(station), undefined);
  assert.match(feed.state.error, /unavailable/);
  feed.stop();
});

test('weather playback uses only its selected calendar date, including next midnight', () => {
  const forecast = new Map([
    ['2026-09-23T23:00', reading('2026-09-23T23:00', 50)],
    ['2026-09-24T00:00', reading('2026-09-24T00:00', 60)],
  ]);
  assert.equal(forecastAt(forecast, 23.5 * 3600, '2026-09-23').temperatureF, 55);
  assert.equal(forecastHours(forecast, 23 * 3600, 2, '2026-09-23').length, 2);
  assert.equal(activeWeather('live', reading('2026-09-23T23:00'), forecast,
    { live: false, seconds: 23 * 3600, date: '2026-09-22' }).source, 'none');
  const active = activeWeather('live', null, forecast, { live: false, seconds: 23 * 3600, date: '2026-09-23' });
  assert.equal(active.source, 'forecast');
  assert.equal(active.reading.observedAt, '2026-09-23T23:00');
  assert.match(active.when, /2026-09-23/);
  assert.equal(activeWeather('live', null, null, { live: false, seconds: 0, date: '2026-09-23' }).source, 'none');
});

test('weather freshness follows Boston source time, not poll arrival time', () => {
  const now = new Date('2026-10-25T16:00:00Z');
  assert.equal(freshWeather(reading('2026-10-25T11:45'), now), true);
  for (const time of ['2026-10-25T11:00', '2026-10-25T13:00', 'invalid']) {
    assert.equal(freshWeather(reading(time), now), false);
  }
  assert.equal(activeWeather('live', reading('2000-01-01T00:00'), null, { live: true, seconds: null }).source, 'none');
});

test('incomplete weather source values cannot become invented zero measurements', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ current: { weather_code: 0, time: '2026-10-25T12:00' } }) }));
  await assert.rejects(fetchWeather(), /incomplete weather reading/);
});
