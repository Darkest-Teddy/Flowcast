import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { isFreshObservation, parseObservationTime, ShuttleObservationClock } from '../src/transit/liveFreshness.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const { pollShuttleVehicles } = await import('../src/transit/buShuttle.ts');

test('MBTA observation expires even if its response was received again recently', () => {
  const observedAt = parseObservationTime('2026-10-24T12:00:00-04:00');
  assert.equal(observedAt, Date.UTC(2026, 9, 24, 16));
  assert.equal(isFreshObservation(observedAt, observedAt + 90_000), true);
  assert.equal(isFreshObservation(observedAt, observedAt + 90_001), false);
  assert.equal(isFreshObservation(parseObservationTime('2026-10-24T12:00:00-04:00'), observedAt + 120_000), false);
});

test('missing, invalid and future observation times cannot establish a current location', () => {
  const now = Date.UTC(2026, 9, 24, 16);
  for (const value of [null, undefined, '', 'invalid']) {
    assert.equal(parseObservationTime(value), null);
    assert.equal(isFreshObservation(parseObservationTime(value), now), false);
  }
  assert.equal(isFreshObservation(NaN, now), false);
  assert.equal(isFreshObservation(now + 6 * 3_600_000, now), false);
});

test('shuttle normalization preserves source observation time across repeated polls', async (t) => {
  const observedAt = Date.UTC(2026, 9, 24, 16);
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    json: async () => [{ VehicleID: 18, RouteID: 1, Latitude: 42.35, Longitude: -71.1,
      Heading: 90, GroundSpeed: 10, Name: '2127', TimeStamp: `/Date(${observedAt}-0600)/` }],
  }));
  const [first] = await pollShuttleVehicles();
  const [second] = await pollShuttleVehicles();
  assert.equal(first.observedAt, observedAt);
  assert.equal(second.observedAt, observedAt);
  assert.equal(isFreshObservation(second.observedAt, observedAt + 120_000), false);
});

test('future-clock shuttle reports expire on feed failure or unchanged source timestamps', () => {
  const clock = new ShuttleObservationClock();
  const now = Date.UTC(2026, 9, 24, 16);
  const sourceTime = now + 6 * 3_600_000;
  const first = clock.observe('bus', sourceTime, now);
  assert.equal(isFreshObservation(first, now), true);
  assert.equal(isFreshObservation(first, now + 90_001), false);
  const repeated = clock.observe('bus', sourceTime, now + 120_000);
  assert.equal(repeated, first);
  assert.equal(isFreshObservation(repeated, now + 120_000), false);
  const changed = clock.observe('bus', sourceTime + 120_000, now + 120_000);
  assert.equal(isFreshObservation(changed, now + 120_000), true);
});

test('shuttle source clock retains valid old timestamps and rejects missing ones', () => {
  const clock = new ShuttleObservationClock();
  const now = Date.UTC(2026, 9, 24, 16);
  assert.equal(clock.observe('fresh', now - 10_000, now), now - 10_000);
  assert.equal(isFreshObservation(clock.observe('stale', now - 120_000, now), now), false);
  assert.equal(clock.observe('missing', null, now), null);
});
