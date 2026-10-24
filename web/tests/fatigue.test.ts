import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FATIGUE_ASSUMPTIONS, circadian, modelFatigue, sleepPressure } from '../src/lib/fatigue.ts';
import type { CampusLocation, ScheduleItem } from '../src/data/types.ts';

const locations: CampusLocation[] = [
  { id: 'cas', name: 'College of Arts & Sciences', short: 'CAS', kind: 'classroom', capacity: 400 },
  { id: 'mugar', name: 'Mugar Library', short: 'Mugar', kind: 'library', capacity: 600 },
  { id: 'warren', name: 'Warren Dining', short: 'Warren', kind: 'dining', capacity: 500 },
  { id: 'fitrec', name: 'FitRec', short: 'FitRec', kind: 'gym', capacity: 300 },
];

const item = (id: string, locationId: string, start: string, end: string, extra: Partial<ScheduleItem> = {}): ScheduleItem => ({
  id, title: id, locationId, start, end, source: 'calendar', ...extra,
});

const day = { wakeAt: '2026-10-26T12:00:00.000Z', until: '2026-10-27T03:00:00.000Z' }; // 8am-11pm EDT

test('sleep pressure starts at the wake value and rises monotonically toward 1', () => {
  assert.ok(Math.abs(sleepPressure(0) - FATIGUE_ASSUMPTIONS.pressureOnWake) < 1e-12);
  assert.ok(sleepPressure(8) > sleepPressure(4));
  assert.ok(sleepPressure(100) < 1 && sleepPressure(100) > 0.99);
});

test('circadian term is most negative at the alert peak hour', () => {
  assert.ok(circadian(17) < circadian(4));
  assert.ok(Math.abs(circadian(17) + FATIGUE_ASSUMPTIONS.circadianAmplitude) < 1e-12);
});

test('a packed day ends more tired than an empty one', () => {
  const packed = [
    item('lec1', 'cas', '2026-10-26T13:00:00Z', '2026-10-26T15:00:00Z'),
    item('lec2', 'mugar', '2026-10-26T15:05:00Z', '2026-10-26T18:00:00Z'),
    item('gym', 'fitrec', '2026-10-26T22:00:00Z', '2026-10-26T23:30:00Z'),
  ];
  const busy = modelFatigue(packed, locations, { ...day, utcOffsetHours: -4 });
  const idle = modelFatigue([], locations, { ...day, utcOffsetHours: -4 });
  assert.ok(busy.mean > idle.mean);
  assert.equal(busy.rushes, 1);
  assert.ok(busy.samples.every((s) => s.score >= 0 && s.score <= 1));
});

test('a meal lowers load compared with staying in class', () => {
  const withLunch = [item('lunch', 'warren', '2026-10-26T16:00:00Z', '2026-10-26T17:00:00Z')];
  const withClass = [item('lab', 'cas', '2026-10-26T16:00:00Z', '2026-10-26T17:00:00Z')];
  const at = '2026-10-26T17:00:00.000Z';
  const lunch = modelFatigue(withLunch, locations, day).samples.find((s) => s.at === at)!;
  const lab = modelFatigue(withClass, locations, day).samples.find((s) => s.at === at)!;
  assert.ok(lunch.load < lab.load);
});

test('unaccepted suggestions are ignored; accepted ones count', () => {
  const s = (accepted: boolean) => [item('sug', 'fitrec', '2026-10-26T14:00:00Z', '2026-10-26T16:00:00Z', { source: 'suggested', accepted })];
  assert.ok(modelFatigue(s(true), locations, day).mean > modelFatigue(s(false), locations, day).mean);
});

test('empty and invalid ranges', () => {
  assert.deepEqual(modelFatigue([], locations, { wakeAt: day.until, until: day.wakeAt }).samples, []);
  assert.throws(() => modelFatigue([], locations, { wakeAt: 'nope', until: day.until }));
});

test('load does not depend on step size', () => {
  const lec = [item('lec', 'cas', '2026-10-26T13:00:00Z', '2026-10-26T18:00:00Z')];
  const at = '2026-10-26T18:00:00.000Z';
  const coarse = modelFatigue(lec, locations, { ...day, stepMinutes: 60 }).samples.find((s) => s.at === at)!;
  const fine = modelFatigue(lec, locations, { ...day, stepMinutes: 1 }).samples.find((s) => s.at === at)!;
  assert.ok(Math.abs(coarse.load - fine.load) / fine.load < 0.02, `${coarse.load} vs ${fine.load}`);
});

test('overlapping items add their load', () => {
  const both = [
    item('lec', 'cas', '2026-10-26T13:00:00Z', '2026-10-26T15:00:00Z'),
    item('gym', 'fitrec', '2026-10-26T13:30:00Z', '2026-10-26T14:30:00Z'),
  ];
  const at = '2026-10-26T14:30:00.000Z';
  const overlap = modelFatigue(both, locations, day).samples.find((s) => s.at === at)!;
  const solo = modelFatigue(both.slice(0, 1), locations, day).samples.find((s) => s.at === at)!;
  assert.ok(overlap.load > solo.load);
});

test('same inputs give identical output', () => {
  const lec = [item('lec', 'cas', '2026-10-26T13:00:00Z', '2026-10-26T15:00:00Z')];
  assert.deepEqual(modelFatigue(lec, locations, day), modelFatigue(lec, locations, day));
});
