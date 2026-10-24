import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { Playback } = await import('../src/sim/playback.ts');

const loc = (id, kind = 'classroom') => ({ id, name: id, short: id, kind, position: [-71.1, 42.35], capacity: 10, building: `b-${id}` });
const event = (agentId, at, outcome = 'injured', extra = {}) => ({ agentId, outcome, at, position: [-71.1, 42.35], cause: 'fire', buildingId: 'b-hall', ...extra });

/** a: in hall then walks to lib. b: outdoor on quad. c: waits at a stop and boards. d: unaffected in hall. */
function day(casualties) {
  const walk = { agent: 'a', from: 'hall', to: 'lib', path: [[-71.1, 42.35], [-71.0, 42.35], [-71.0, 42.4]], timestamps: [1000, 2000, 3000] };
  const late = { agent: 'a', from: 'lib', to: 'hall', path: [[-71.0, 42.4], [-71.1, 42.35]], timestamps: [5000, 6000] };
  const data = {
    day: 'Monday', buildings: [], locations: [loc('hall'), loc('lib', 'library'), loc('quad', 'outdoor')],
    agents: ['a', 'b', 'c', 'd'].map(id => ({ id, home: 'off-campus', model: 1 })),
    trips: [walk, late],
    stays: [
      { agent: 'a', location: 'hall', start: 0, end: 1000 }, { agent: 'a', location: 'lib', start: 3000, end: 5000 },
      { agent: 'a', location: 'hall', start: 6000, end: 86400 },
      { agent: 'b', location: 'quad', start: 0, end: 86400 },
      { agent: 'c', location: 'off-campus', start: 0, end: 86400 },
      { agent: 'd', location: 'hall', start: 0, end: 86400 },
    ],
    transitRides: [
      { agent: 'c', kind: 'board', trip: 'T1', route: 'Green-B', direction: 0, stop: 's', time: 4000, waitStart: 3500, position: [-71.1, 42.35] },
      { agent: 'c', kind: 'alight', trip: 'T0', route: 'Green-B', direction: 0, stop: 's', time: 3400, position: [-71.1, 42.35] },
    ],
  };
  if (casualties) data.casualties = casualties;
  return data;
}
const count = (pb, t, id) => pb.occupancyAt(t).find(o => o.location.id === id).count;
const conserved = (p) => p.indoors + p.outdoors + p.walking + p.offCampus + p.injured + p.fatalities === p.total;

test('baseline days report zero casualties with the original census', () => {
  const pb = new Playback(day());
  for (const t of [0, 1500, 3700, 86000]) {
    const p = pb.populationAt(t);
    assert.equal(p.total, 4); assert.equal(p.injured, 0); assert.equal(p.fatalities, 0); assert.equal(p.alive, 4);
    assert.ok(conserved(p) && p.offCampus >= 0);
  }
  assert.deepEqual(pb.casualtiesAt(86400), []);
});

test('casualtiesAt never reveals future events and is inclusive at the event time', () => {
  const events = [event('d', 2000, 'fatality'), event('b', 500)];
  const input = structuredClone(events);
  const pb = new Playback(day(events));
  assert.deepEqual(events, input, 'caller records are not reordered or mutated');
  assert.deepEqual(pb.casualtiesAt(499.999), []);
  assert.deepEqual(pb.casualtiesAt(500).map(e => e.agentId), ['b']);
  assert.deepEqual(pb.casualtiesAt(2000).map(e => e.agentId), ['b', 'd']);
  assert.deepEqual(pb.casualtiesAt(NaN), []);
});

test('ties are ordered by agent id', () => {
  const pb = new Playback(day([event('d', 100), event('b', 100, 'fatality')]));
  assert.deepEqual(pb.casualtiesAt(100).map(e => e.agentId), ['b', 'd']);
});

test('occupancy drops at the event boundary and restores on rewind without corrupting the index', () => {
  const pb = new Playback(day([event('d', 2000, 'fatality'), event('b', 2500)]));
  const baseline = new Playback(day());
  const times = [0, 1999.999, 2000, 2499, 2500, 4000, 2000, 1999.999, 0, 86399, 1500];
  for (const t of times) {
    const expectHall = (t < 1000 ? 1 : 0) + (t >= 6000 ? 1 : 0) + (t < 2000 ? 1 : 0);
    assert.equal(count(pb, t, 'hall'), expectHall, `hall at ${t}`);
    assert.equal(count(pb, t, 'quad'), t < 2500 ? 1 : 0, `quad at ${t}`);
    assert.equal(pb.outdoorAt(t).length, t < 2500 ? 1 : 0);
    assert.deepEqual(baseline.occupancyAt(t), new Playback(day()).occupancyAt(t));
  }
  // Repeated reads at the same time agree (no in-place subtraction leaking between calls).
  assert.deepEqual(pb.occupancyAt(3000), pb.occupancyAt(3000));
  assert.equal(count(pb, 100, 'hall'), 2);
});

test('walking stops at the event and the trail is clipped at the interpolated position', () => {
  const pb = new Playback(day([event('a', 1500)]));
  assert.equal(pb.walkingAt(1499).length, 1);
  assert.equal(pb.walkingAt(1500).length, 0);
  assert.equal(pb.walkingAt(5500).length, 0, 'a later walk is not shown');
  assert.equal(count(pb, 4000, 'lib'), 0); assert.equal(count(pb, 7000, 'hall'), 1, 'only d remains in hall');
  const trails = pb.trailsAt(1500, 600);
  const own = trails.filter(trip => trip.agent === 'a');
  assert.equal(own.length, 1);
  assert.deepEqual(own[0].timestamps, [1000, 1500]);
  assert.deepEqual(own[0].path.at(-1), [-71.05, 42.35]);
  assert.equal(pb.trailsAt(1510, 600), trails, 'candidate cache stays stable');
  for (const t of [4000, 5500, 6100, 86000]) {
    for (const trip of pb.trailsAt(t, 600)) assert.ok(trip.timestamps.at(-1) <= 1500, 'no post-event movement in trails');
  }
  // Rewinding before the event still shows the pre-event part of the same walk.
  assert.equal(pb.walkingAt(1200)[0].position[0], -71.08);
  assert.ok(pb.trailsAt(1200, 600).some(trip => trip.agent === 'a'));
});

test('clipping does not mutate shared baseline trip arrays', () => {
  const data = day([event('a', 2500)]);
  const before = structuredClone(data.trips);
  const pb = new Playback(data);
  assert.deepEqual(data.trips, before);
  const own = pb.trailsAt(2500, 600).find(trip => trip.agent === 'a');
  assert.deepEqual(own.timestamps, [1000, 2000, 2500]);
  assert.deepEqual(own.path.at(-1), [-71.0, 42.375]);
  assert.equal(pb.endTime, 6000, 'day bounds come from the baseline');
});

test('an event exactly on a path vertex keeps a two-point trail', () => {
  const pb = new Playback(day([event('a', 2000)]));
  const own = pb.trailsAt(2000, 600).find(trip => trip.agent === 'a');
  assert.deepEqual(own.timestamps, [1000, 2000]);
  assert.deepEqual(own.path, [[-71.1, 42.35], [-71.0, 42.35]]);
});

test('waiting riders and students aboard drop casualties and restore on rewind', () => {
  const pb = new Playback(day([event('c', 3700)]));
  assert.equal(pb.waitingAt(3600).length, 1);
  assert.equal(pb.waitingAt(3700).length, 0);
  assert.equal(pb.studentsAboard('T0', 3300), 1);
  assert.equal(pb.studentsAboard('T1', 4100), 0, 'never boards');
  assert.equal(pb.waitingAt(3699).length, 1, 'rewind restores the waiting rider');
  const base = new Playback(day());
  assert.equal(base.studentsAboard('T1', 4100), 1);
  // An event while aboard removes the student from the vehicle count from then on.
  const aboard = new Playback(day([event('c', 4500)]));
  assert.equal(aboard.studentsAboard('T1', 4400), 1);
  assert.equal(aboard.studentsAboard('T1', 4500), 0);
});

test('population is conserved and alive excludes only fatalities', () => {
  const pb = new Playback(day([event('a', 1500, 'injured'), event('b', 2500, 'fatality'), event('d', 2500, 'fatality'), event('c', 3700)]));
  for (const t of [0, 1499, 1500, 2499, 2500, 3600, 3700, 5500, 86399, 2000, 0]) {
    const p = pb.populationAt(t);
    assert.equal(p.total, 4);
    assert.ok(conserved(p), `conserved at ${t}`);
    assert.ok(p.offCampus >= 0);
    assert.equal(p.alive, p.total - p.fatalities);
  }
  assert.deepEqual(pb.populationAt(86399), { total: 4, indoors: 0, outdoors: 0, walking: 0, offCampus: 0, injured: 2, fatalities: 2, alive: 2 });
  assert.deepEqual(pb.populationAt(1499), { total: 4, indoors: 1, outdoors: 1, walking: 1, offCampus: 1, injured: 0, fatalities: 0, alive: 4 });
});

test('trip-only days (no stays) also hide casualties from occupancy', () => {
  const data = { day: 'Monday', buildings: [], locations: [loc('hall')], agents: [{ id: 'a', home: 'hall', model: 0 }, { id: 'b', home: 'hall', model: 0 }], trips: [],
    casualties: [event('a', 100)] };
  const pb = new Playback(data);
  assert.equal(pb.occupancyAt(99)[0].count, 2);
  assert.equal(pb.occupancyAt(100)[0].count, 1);
  assert.ok(conserved(pb.populationAt(100)));
});

test('invalid casualty records are rejected', () => {
  const bad = [
    [event('zz', 100)], [event('a', 100), event('a', 200)],
    [event('a', NaN)], [event('a', -1)], [event('a', 90000)], [event('a', '100')],
    [event('a', 100, 'missing')], [event('a', 100, 'injured', { cause: 'flood' })],
    [event('a', 100, 'injured', { position: [NaN, 42] })], [event('a', 100, 'injured', { position: [-71] })],
    [event('a', 100, 'injured', { position: [-200, 42] })], [event('a', 100, 'injured', { buildingId: 7 })],
  ];
  for (const casualties of bad) assert.throws(() => new Playback(day(casualties)), /asualt/, JSON.stringify(casualties));
  assert.throws(() => new Playback(day('nope')), /asualt/);
  const { buildingId, ...noBuilding } = event('a', 100);
  assert.doesNotThrow(() => new Playback(day([noBuilding])));
});
