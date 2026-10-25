import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { CLASSROOM_SUFFIX, countedLocation, splitResidenceIds, splitResidences, splitResidenceStays, splitsResidence } = await import('../src/sim/residenceSplit.ts');
const { Playback } = await import('../src/sim/playback.ts');

const kilachand = {
  id: 'kilachand', name: 'Kilachand Hall', short: 'Kilachand', kind: 'dorm', position: [-71.097, 42.35], building: 'way/1', campus: 'charles-river',
  capacity: 748, referenceCapacity: 748, capacityBasis: 'residential_beds_plus_classroom_seats', residentialBeds: 550,
};
const cas = { id: 'cas', name: 'College of Arts and Sciences', short: 'CAS', kind: 'classroom', position: [-71.1, 42.35], building: 'way/2', capacity: 900 };
const warren = { id: 'warren', name: 'Warren Towers', short: 'Warren', kind: 'dorm', position: [-71.1, 42.34], building: 'way/3', capacity: 600, residentialBeds: 600, capacityBasis: 'residential_beds' };

test('only a dorm with both beds and classroom seats splits', () => {
  assert.equal(splitsResidence(kilachand), true);
  assert.equal(splitsResidence(cas), false);
  assert.equal(splitsResidence(warren), false);
  assert.equal(splitsResidence({ ...kilachand, residentialBeds: 0 }), false, 'no beds: no denominator for the dorm');
  assert.equal(splitsResidence({ ...kilachand, capacity: 550 }), false, 'no seats left over: no denominator for the classrooms');
});

test('a split residence becomes its dorm (beds) and its classrooms (seats) on one building', () => {
  const [dorm, rooms, ...rest] = splitResidences([kilachand, cas]);
  assert.deepEqual(rest.map((l) => l.id), ['cas']);
  assert.equal(dorm.id, 'kilachand');
  assert.equal(dorm.kind, 'dorm');
  assert.equal(dorm.capacity, 550);
  assert.equal(dorm.referenceCapacity, 550);
  assert.equal(dorm.capacityBasis, 'residential_beds');
  assert.equal(rooms.id, `kilachand${CLASSROOM_SUFFIX}`);
  assert.equal(rooms.kind, 'classroom');
  assert.equal(rooms.capacity, 198);
  assert.equal(rooms.residentialBeds, undefined);
  assert.equal(rooms.building, dorm.building, 'one building on the map');
  assert.deepEqual(rooms.position, dorm.position, 'one entrance');
});

test('people at home stay in the dorm; everyone else there is counted in its classrooms', () => {
  const split = splitResidenceIds([kilachand, cas]);
  assert.equal(countedLocation({ location: 'kilachand', purpose: { kind: 'home', fixed: false } }, split), 'kilachand');
  for (const kind of ['class', 'study', 'wait', 'gathering']) {
    assert.equal(countedLocation({ location: 'kilachand', purpose: { kind, fixed: false } }, split), 'kilachand-classrooms', kind);
  }
  assert.equal(countedLocation({ location: 'cas', purpose: { kind: 'class', fixed: true } }, split), 'cas');
  const stays = [{ agent: 'a', location: 'cas', start: 0, end: 1 }];
  assert.equal(splitResidenceStays(stays, [cas])[0], stays[0], 'nothing to split: the same objects');
});

test('the map counts the dorm and its classrooms apart, without changing the day', () => {
  const day = {
    day: 'Tuesday', locations: [kilachand, cas],
    agents: [{ id: 'resident', home: 'kilachand', model: 0 }, { id: 'visitor', home: 'off-campus', model: 0 }],
    trips: [],
    stays: [
      { agent: 'resident', location: 'kilachand', start: 0, end: 36000, purpose: { kind: 'home', fixed: false } },
      { agent: 'resident', location: 'kilachand', start: 36000, end: 39600, purpose: { kind: 'class', fixed: true } },
      { agent: 'visitor', location: 'kilachand', start: 36000, end: 39600, purpose: { kind: 'study', fixed: false } },
    ],
  };
  const playback = new Playback(day);
  const at = (t) => Object.fromEntries(playback.occupancyAt(t).map((o) => [o.location.id, o.count]));
  assert.deepEqual(at(3600), { kilachand: 1, 'kilachand-classrooms': 0, cas: 0 });
  assert.deepEqual(at(37000), { kilachand: 0, 'kilachand-classrooms': 2, cas: 0 });
  assert.equal(day.stays[1].location, 'kilachand', 'the stays themselves are unchanged');
});
