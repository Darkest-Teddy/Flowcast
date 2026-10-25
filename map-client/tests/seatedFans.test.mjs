// Fenway's seated fans: seats from the manifest's rows, a fixed fill order, and occupancy that
// follows the event visitors' gate arrivals and departures.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { expandSeats, occupiedSeats, fenwayEvent, fenwayFanData, fanData, fenwayFanLayers, MIN_ZOOM } = await import('../src/layers/seatedFans.ts');

const seating = { total: 7, rows: [[-71.098, 42.346, -71.097, 42.346, 2.5, 4, 45, 0], [-71.098, 42.347, -71.097, 42.347, 11.5, 3, 90, 1]] };

test('seats are spread evenly along each row, with the row height and facing', () => {
  const s = expandSeats(seating);
  assert.equal(s.count, 7);
  assert.deepEqual([...s.position.slice(0, 3)], [-71.098, 42.346, 2.5]);
  assert.ok(Math.abs(s.position[3 * 3] - -71.097) < 1e-12); // the row's last seat at its end
  assert.equal(s.position[4 * 3 + 2], 11.5);
  assert.deepEqual([...s.bearing], [45, 45, 45, 45, 90, 90, 90]);
  // The fill order is a fixed permutation of every seat.
  assert.deepEqual([...s.order].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6]);
  assert.deepEqual([...expandSeats(seating).order], [...s.order]);
  assert.equal(expandSeats(null), null);
});

const event = (arrive, depart) => ({ n: arrive.length, arrive: Float64Array.from(arrive), depart: Float64Array.from(depart), estimate: { venue: { id: 'fenway-park' } } });

test('fans sit down at the gate and leave when they leave, one seat each', () => {
  const s = expandSeats(seating);
  const e = event([100, 200, 300], [1000, 500, 1000]);
  assert.equal(occupiedSeats(s, e, 50).length, 0);
  assert.deepEqual([...occupiedSeats(s, e, 250)], [s.order[0], s.order[1]]);
  assert.deepEqual([...occupiedSeats(s, e, 600)], [s.order[0], s.order[2]]); // visitor 1 has left
  assert.equal(occupiedSeats(s, e, 1000).length, 0);
  assert.equal(occupiedSeats(s, null, 600).length, 0);
});

test('a sellout bigger than the model shares seats, so the stands fill in proportion', () => {
  const s = expandSeats(seating);
  const n = 70;
  const e = event(Array.from({ length: n }, (_, i) => i), Array.from({ length: n }, () => 1e9));
  assert.equal(occupiedSeats(s, e, 34).length, 4); // half the fans in: about half the seats
  assert.equal(occupiedSeats(s, e, 1000).length, 7); // everyone in: every seat
});

test('the Fenway game is found by venue', () => {
  assert.equal(fenwayEvent({ date: null, events: [event([1], [2]), { ...event([1], [2]), estimate: { venue: { id: 'agganis' } } }] }).estimate.venue.id, 'fenway-park');
  assert.equal(fenwayEvent({ date: null, events: [] }), null);
});

test('the layer data is the same object frame after frame until the crowd changes (deck.gl recomputes on new data)', () => {
  const plan = { date: null, events: [event([100, 200, 300], [1000, 500, 1000])] };
  const a = fenwayFanData(seating, plan, 250);
  const b = fenwayFanData(seating, plan, 251); // same 20 s step
  assert.equal(b.data, a.data);
  assert.equal(b.data.all, a.data.all);
  const c = fenwayFanData(seating, plan, 259.9);
  assert.equal(c.data, a.data);
  const d = fenwayFanData(seating, plan, 290); // a new step, the same people seated: still the same arrays
  assert.equal(d.data, a.data);
  const e = fenwayFanData(seating, plan, 620); // visitor 1 left: new data, new version
  assert.notEqual(e.data, a.data);
  assert.ok(e.data.version > a.data.version);
  assert.equal(e.data.all.length, 2);
  // The half set is a stable subset for middle zooms.
  const h = fanData(Uint32Array.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]), 1);
  assert.ok(h.half.length < 10 && h.half.every((s) => h.all.includes(s)));
  assert.deepEqual([...fanData(h.all, 2).half], [...h.half]);
  // Far out, no layer at all; outside a browser (no document) nothing is drawn either.
  assert.deepEqual(fenwayFanLayers(seating, plan, 620, MIN_ZOOM - 1), []);
});

test('the shipped manifest seats Fenway: rows in the park, sane heights and counts', () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/data/building-models.json', import.meta.url), 'utf8'));
  const park = manifest.campuses.flatMap((c) => c.buildings).find((b) => b.seating);
  assert.equal(park.name, 'Fenway Park');
  const { rows, total } = park.seating;
  assert.equal(rows.reduce((s, r) => s + r[5], 0), total);
  assert.ok(total > 20000 && total < 40000, `${total} seats`);
  for (const [x0, y0, x1, y1, h, n, facing, section] of rows) {
    for (const [x, y] of [[x0, y0], [x1, y1]]) assert.ok(x > -71.1 && x < -71.095 && y > 42.345 && y < 42.348);
    assert.ok(h >= 1 && h <= 25 && n >= 2 && facing >= -180 && facing <= 180 && [0, 1, 2].includes(section));
  }
  assert.ok(park.floodlights.stands.length > 10);
});
