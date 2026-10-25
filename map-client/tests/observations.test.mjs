import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const O = await import('../src/data/observations.ts');

// A site at the origin of a tiny local frame; 1e-4 degrees of latitude is about 11 m.
const SITE = [-71.1, 42.35];
const north = (metres) => [SITE[0], SITE[1] + metres / 110540];
const hourBins = (hours) => hours.map((h) => ({ start: `${String(h).padStart(2, '0')}:00`, end: `${String(h + 1).padStart(2, '0')}:00`, value: 0 }));

test('a cordon counts each pass once, including walks that start inside it', () => {
  const through = [north(-100), north(-5), north(100)];
  assert.deepEqual(O.screenEvents(through, SITE, { type: 'cordon', radiusMetres: 20 }).map((e) => e.segment), [0]);
  const event = O.screenEvents(through, SITE, { type: 'cordon', radiusMetres: 20 })[0];
  assert.ok(Math.abs(event.fraction * 95 - 80) < 0.5, 'enters 20 m before the centre');
  assert.equal(O.screenEvents([north(5), north(100)], SITE, { type: 'cordon', radiusMetres: 20 }).length, 1);
  assert.equal(O.screenEvents([north(50), north(100)], SITE, { type: 'cordon', radiusMetres: 20 }).length, 0);
  const outAndBack = [north(-100), north(0), north(-100), north(0)];
  assert.equal(O.screenEvents(outAndBack, SITE, { type: 'cordon', radiusMetres: 20 }).length, 2);
});

test('a screenline counts crossings in either direction', () => {
  const line = { type: 'line', from: [SITE[0] - 0.0002, SITE[1]], to: [SITE[0] + 0.0002, SITE[1]] };
  assert.equal(O.screenEvents([north(-30), north(30)], SITE, line).length, 1);
  assert.equal(O.screenEvents([north(30), north(-30), north(30)], SITE, line).length, 2);
  assert.equal(O.screenEvents([north(10), north(30)], SITE, line).length, 0);
});

test('simulated pedestrians are binned by the time they pass the site', () => {
  const site = { id: 's', site: 'test', position: SITE, date: '', dayType: 'weekday', bins: hourBins([8, 9]), unit: '', direction: null, source: '', expectedStudentShare: [0, 1], screen: { type: 'cordon', radiusMetres: 20 } };
  const path = [north(-200), north(200)];
  // 400 m at 1 m/s: the walk reaches the cordon 180 s after it starts.
  const trips = [
    { path, timestamps: [8 * 3600, 8 * 3600 + 400] },
    { path, timestamps: [9 * 3600 - 100, 9 * 3600 + 300] },
    { path, timestamps: [9 * 3600 - 300, 9 * 3600 + 100] },
    { path: [north(500), north(600)], timestamps: [8 * 3600, 8 * 3600 + 100] },
  ];
  assert.deepEqual(O.simulatedPedestrians(trips, site), [2, 1]);
});

test('simulated transit matches stop, route, direction and kind; gated entries use the time riders reach the station', () => {
  const series = (kind, route, direction) => ({ id: 'x', kind, mode: 'light-rail', stop: { name: 'K', mapStopId: 'place-kencl', mbtaStopIds: [], position: SITE },
    route, direction, dayType: 'weekday', bins: [{ start: '08:00', end: '08:30', value: 10 }, { start: '08:30', end: '09:00', value: 10 }], unit: '', source: '', expectedStudentShare: [0, 1] });
  const rides = [
    { kind: 'board', route: 'Green-B', direction: 1, stop: 'place-kencl', time: 8 * 3600 + 1900, waitStart: 8 * 3600 + 1700 },
    { kind: 'board', route: 'Green-C', direction: 0, stop: 'place-kencl', time: 8 * 3600 + 100 },
    { kind: 'alight', route: 'Green-B', direction: 1, stop: 'place-kencl', time: 8 * 3600 + 100 },
    { kind: 'board', route: 'Green-B', direction: 1, stop: 'place-bucen', time: 8 * 3600 + 100 },
    { kind: 'board', route: '57', direction: 1, stop: 'place-kencl', time: 8 * 3600 + 100 },
    { kind: 'board', route: 'Green-B', direction: 1, stop: 'place-kencl', time: 8 * 3600 + 200, cancelledAt: 8 * 3600 },
  ];
  assert.deepEqual(O.simulatedTransit(rides, series('gated-entries', 'Green', null)), [2, 0], 'by wait start, every Green branch');
  assert.deepEqual(O.simulatedTransit(rides, series('apc-boardings', 'Green-B', 1)), [0, 1], 'by departure');
  assert.deepEqual(O.simulatedTransit(rides, series('apc-alightings', 'Green-B', 1)), [1, 0]);
  assert.deepEqual(O.simulatedTransit(rides, series('apc-boardings', 'Green-C', 1)), [0, 0]);
});

test('shape, peak and magnitude metrics', () => {
  assert.equal(O.pearson([1, 2, 3], [2, 4, 6]), 1);
  assert.equal(O.pearson([1, 2, 3], [3, 2, 1]), -1);
  assert.equal(O.pearson([1, 2], [1, 2]), null, 'two bins carry no shape');
  assert.equal(O.pearson([1, 1, 1], [1, 2, 3]), null);
  const bins = hourBins([7, 8, 9, 10]);
  assert.equal(O.peakHoursApart(bins, [0, 5, 1, 0], [0, 1, 1, 6]), 2);
  assert.equal(O.peakHoursApart(bins, [0, 0, 0, 0], [0, 1, 1, 6]), null);
  const observed = bins.map((b, i) => ({ ...b, value: [10, 20, 10, 0][i] }));
  const score = O.compareSeries('a', 'apc-boardings', observed, [5, 10, 5, 0], [0.4, 0.6]);
  assert.equal(score.ratio, 0.5);
  assert.equal(score.inBand, true);
  assert.equal(score.binsOutOfBand, 0);
  assert.ok(Math.abs(score.pearson - 1) < 1e-12);
  assert.equal(O.compareSeries('a', 'k', observed, [20, 10, 5, 0], [0.4, 0.6]).binsOutOfBand, 1);
});

test('day types: bus splits Friday off, rail and pedestrian counts do not', () => {
  assert.equal(O.dayTypeFor(2, 'bus'), 'weekday');
  assert.equal(O.dayTypeFor(4, 'bus'), 'friday');
  assert.equal(O.dayTypeFor(4, 'light-rail'), 'weekday');
  assert.equal(O.dayTypeFor(5, 'pedestrian'), 'saturday');
  assert.equal(O.dayTypeFor(6, 'subway'), 'sunday');
  assert.equal(O.clockSeconds('24:00'), 86400);
});

test('dated crossing surveys are used only on their recorded weekdays', () => {
  const site = (id, weekdays) => ({ id, dayType: 'weekday', quality: 'primary', weekdays });
  const data = { transit: [], pedestrian: [site('tuesday', [1]), site('thursday', [3]), site('pooled-wed-thu', [2, 3])] };
  const ids = day => O.seriesForWeekday(data, day, { primaryOnly: true }).pedestrian.map(row => row.id);
  assert.deepEqual(ids(0), []);
  assert.deepEqual(ids(1), ['tuesday']);
  assert.deepEqual(ids(2), ['pooled-wed-thu']);
  assert.deepEqual(ids(3), ['thursday', 'pooled-wed-thu']);
  assert.deepEqual(ids(5), []);
});

test('sparse observed bins retain gaps instead of smoothing across missing periods', () => {
  const bins = hourBins([8, 9, 17]);
  assert.deepEqual(O.smoothObservedBins([0, 12, 100], bins), [3, 9, 100]);
  const s = { kind: 'gated-entries', route: 'Green', direction: null, stop: { mapStopId: 'place-kencl' }, bins };
  const ride = hour => ({ kind: 'board', route: 'Green-B', direction: 0, stop: 'place-kencl', time: hour * 3600 });
  assert.deepEqual(O.simulatedTransit([ride(8), ride(12), ride(17)], s), [1, 0, 1], 'a noon ride is not scored against an unobserved bin');
});

test('the bundled observations file is well formed and every series sits inside the map', async () => {
  const data = JSON.parse(readFileSync(new URL('../public/data/calibration-observations.json', import.meta.url)));
  assert.ok(O.isObservations(data));
  assert.equal(O.isObservations(null), false);
  const sources = new Set(data.sources.map((s) => s.id));
  const inMap = ([x, y]) => x > -71.13 && x < -71.06 && y > 42.33 && y < 42.36;
  for (const s of data.transit) {
    assert.ok(sources.has(s.source), `${s.id} cites a listed source`);
    assert.ok(inMap(s.stop.position), s.id);
    assert.ok(s.bins.length > 0 && s.bins.every((b) => Number.isFinite(b.value) && b.value >= 0 && O.clockSeconds(b.end) > O.clockSeconds(b.start)), s.id);
    assert.ok(s.expectedStudentShare[0] <= s.expectedStudentShare[1]);
  }
  for (const s of data.pedestrian) {
    assert.ok(sources.has(s.source), `${s.id} cites a listed source`);
    assert.ok(inMap(s.position), s.id);
  }
  for (const id of ['kenmore-gated-entries-fall-2025-weekday', 'green-b-bucen-1-weekday-ons', 'ped-warren-2023-comm-granby', 'ped-cds-2018-comm-silber', 'ped-bmc-2019-albany-massave']) {
    assert.ok([...data.transit, ...data.pedestrian].some((s) => s.id === id), id);
  }
  const ids = [...data.transit, ...data.pedestrian].map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'series ids are unique');
  // The loader rejects a missing file, so the app falls back to students only.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 404 });
  try { await assert.rejects(O.loadObservations()); } finally { globalThis.fetch = realFetch; }
});
