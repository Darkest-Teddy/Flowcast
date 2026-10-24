import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { buApiMiddleware } from '../server/buApi.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { hackathonRoutes, hackathonVehicles, hackathonArrivals } = await import('../src/transit/buShuttle.ts');

async function request(middleware, url, method = 'GET') {
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(body) { this.body = body; } };
  await middleware({ url, method }, res, () => { res.next = true; });
  return res;
}

test('proxy keeps authentication upstream, caches requests, and blocks arbitrary endpoints', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ vehicles: [], stale: false }) };
  });
  const middleware = buApiMiddleware('test-key', '/does-not-exist');
  const responses = await Promise.all([
    request(middleware, '/api/bu/transit/bus/vehicles'),
    request(middleware, '/api/bu/transit/bus/vehicles'),
  ]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['X-API-Key'], 'test-key');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].url, 'https://public.api-nonprod.bu.edu/api/v1/transit/bus/vehicles');
  assert.equal(responses[0].body, responses[1].body);
  assert.equal(responses[0].headers['Cache-Control'], 'no-store');
  assert.ok(!responses[0].body.includes('test-key'));
  for (const path of ['/api/bu/transit/bus/vehicles?url=https://example.com', '/api/bu/transit/bus/notices', '/api/bu/transit/bus/stops/0/arrivals']) {
    assert.equal((await request(middleware, path)).statusCode, 404);
  }
  assert.equal((await request(middleware, '/api/bu/transit/bus/vehicles', 'POST')).statusCode, 404);
  assert.equal(calls.length, 1);
});

test('proxy rejects stale/error responses without leaking upstream details or credentials', async (t) => {
  const middleware = buApiMiddleware('test-key', '/does-not-exist');
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ stale: true }) }));
  assert.equal((await request(middleware, '/api/bu/transit/bus/vehicles')).statusCode, 502);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('test-key'); });
  const failed = await request(middleware, '/api/bu/transit/bus/vehicles');
  assert.equal(failed.statusCode, 502);
  assert.ok(!failed.body.includes('test-key'));
  assert.equal((await request(buApiMiddleware('', '/missing'), '/api/bu/transit/bus/routes')).statusCode, 503);
});

test('API route/stop identities and source timestamps survive normalization', () => {
  const [route] = hackathonRoutes({ routes: [{ id: 1, name: 'BU', encoded_polyline: 'line', is_running: true, color: '#ffffff',
    stops: [{ id: 20, physical_stop_id: 3, name: 'A', latitude: 42, longitude: -71, order: 2 },
      { id: 10, physical_stop_id: 2, name: 'B', latitude: 42, longitude: -71, order: 1 }] }] });
  assert.equal(route.RouteID, 1);
  assert.deepEqual(route.Stops.map((s) => [s.RouteStopID, s.AddressID]), [[10, 2], [20, 3]]);
  const observed = '2026-10-24T12:00:00-04:00';
  const payload = { vehicles: [{ id: 987, route_id: 1, latitude: 42, longitude: -71, heading: 90, ground_speed: 10, name: 'Bus', reported_at: observed }] };
  const first = hackathonVehicles(payload)[0];
  assert.equal(first.observedAt, Date.parse(observed));
  assert.equal(hackathonVehicles(payload)[0].observedAt, first.observedAt);
  assert.deepEqual(first.position, [-71, 42]);
  assert.equal(first.speed, 4.4704);
  assert.throws(() => hackathonVehicles({ ...payload, stale: true }), /stale/);
  const arrivals = hackathonArrivals({ groups: [{ route_id: 1, route_stop_id: 10, arrivals: [
    { estimate_at: null, scheduled_at: observed, is_departed: false },
    { estimate_at: observed, scheduled_at: null, is_departed: true },
  ] }] }, new Map([[10, 'BU-stop-2']]));
  assert.deepEqual(arrivals, [{ stop: 'BU-stop-2', route: 'BU-1', direction: 0, time: Date.parse(observed) }]);
});

test('proxy bounds upstream requests across distinct stop IDs', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return { ok: true, json: async () => ({ groups: [], stale: false }) };
  });
  const middleware = buApiMiddleware('test-key', '/missing');
  for (let id = 1; id <= 80; id++) {
    assert.equal((await request(middleware, `/api/bu/transit/bus/stops/${id}/arrivals`)).statusCode, 200);
  }
  assert.equal((await request(middleware, '/api/bu/transit/bus/stops/81/arrivals')).statusCode, 502);
  assert.equal(calls, 80);
  assert.equal((await request(middleware, '/api/bu/transit/bus/stops/1/arrivals')).statusCode, 200);
  assert.equal(calls, 80);
});
