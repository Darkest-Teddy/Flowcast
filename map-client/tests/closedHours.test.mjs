// Places closed by their published hours: the day's open windows (with the tail of a late night),
// a closed check that never fires on unknown hours, and buildings that read closed only when all of
// them is.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return nextResolve(`${specifier}.ts`, context); throw error; }
} });
const { publishedOpenWindows } = await import('../src/sim/sourceDay.ts');
const { closedAt, reopensAt, Playback } = await import('../src/sim/playback.ts');

const h = (hour, minute = 0) => hour * 3600 + minute * 60;
const entry = (date, windows) => ({ date, windows, text: '', sourceUrl: 'https://www.bu.edu/', qualifier: null });
const library = { id: 'mugar', kind: 'library' };

test("a day's published windows, with last night's late opening carried past midnight", () => {
  const hours = [entry('2026-10-26', [[h(7), h(26)]]), entry('2026-10-27', [[h(7), h(26)]])];
  assert.deepEqual(publishedOpenWindows(library, hours, '2026-10-27', 1).openWindows, [[0, h(2)], [h(7), h(24)]]);
  // The first day has no previous night on record: open from 7.
  assert.deepEqual(publishedOpenWindows(library, hours, '2026-10-26', 0).openWindows, [[h(7), h(24)]]);
});

test('a published closure is a closed day; unknown hours and residences are never closed', () => {
  const hours = [entry('2026-10-26', [[h(7), h(22)]]), entry('2026-10-27', []), entry('2026-10-28', [[h(7), h(22)]])];
  const closedDay = publishedOpenWindows(library, hours, '2026-10-27', 1);
  assert.deepEqual(closedDay.openWindows, []);
  assert.equal(closedAt(closedDay, h(12)), true);
  assert.equal('openWindows' in publishedOpenWindows(library, [], '2026-10-27', 1), false);
  assert.equal('openWindows' in publishedOpenWindows({ id: 'warren', kind: 'dorm' }, hours, '2026-10-26', 0), false);
  assert.equal(closedAt({}, h(3)), false);
});

test('closed outside the windows, open inside them (the closing second is closed)', () => {
  const place = { openWindows: [[h(7), h(22)]] };
  assert.equal(closedAt(place, h(6)), true);
  assert.equal(closedAt(place, h(7)), false);
  assert.equal(closedAt(place, h(22) - 1), false);
  assert.equal(closedAt(place, h(22)), true);
});

test('a building reads closed only when every place in it is closed', () => {
  const place = (id, kind, building) => ({ id, name: id, short: id, kind, building, position: [0, 0], capacity: 100 });
  const byBuilding = (occupancy) => Playback.prototype.byBuilding.call(null, occupancy);
  // A dorm over its dining hall: the dining hall closed, the dorm open, so the building is open (the dorm).
  const [mixed] = byBuilding([
    { location: place('dining', 'dining', 'w'), count: 0, share: 0, closed: true },
    { location: place('dorm', 'dorm', 'w'), count: 40, share: 0.4, closed: false },
  ]);
  assert.equal(mixed.closed, false);
  assert.equal(mixed.name, 'dorm');
  // Busier but closed never beats open, in either order.
  const [reversed] = byBuilding([
    { location: place('dorm', 'dorm', 'w'), count: 1, share: 0.01, closed: false },
    { location: place('dining', 'dining', 'w'), count: 90, share: 0.9, closed: true },
  ]);
  assert.equal(reversed.name, 'dorm');
  const [shut] = byBuilding([{ location: place('library', 'library', 'l'), count: 0, share: 0, closed: true }]);
  assert.equal(shut.closed, true);
});

test("the shipped bundle carries BU's published academic building hours, valid weekly windows with sources", async () => {
  const { readFileSync } = await import('node:fs');
  const data = JSON.parse(readFileSync(new URL('../public/data/campus-data.json', import.meta.url), 'utf8'));
  const withHours = Object.entries(data.locations).filter(([, l]) => l.buildingHours);
  assert.ok(withHours.length >= 10);
  for (const [id, location] of withHours) {
    assert.equal(location.hours.length, 0, `${id} keeps venue hours and building hours apart`);
    for (const entry of location.buildingHours) {
      assert.ok(entry.date === null && entry.weekday >= 0 && entry.weekday <= 6 && entry.validFrom <= entry.validTo);
      assert.match(entry.sourceUrl, /^https:\/\/www\.(bu|bumc\.bu)\.edu\//);
      for (const [from, to] of entry.windows) assert.ok(from >= 0 && from < to && to <= 86400);
    }
  }
  // COM is closed at weekends while classes are in session.
  assert.deepEqual(data.locations.com.buildingHours.find((e) => e.weekday === 5).windows, []);
});

test('a closed place says when it opens again: later today, tomorrow, or on a named day', () => {
  const hours = [entry('2026-10-30', [[h(7), h(22)]]), entry('2026-10-31', []), entry('2026-11-01', []), entry('2026-11-02', [[h(7, 30), h(22)]])];
  const friday = publishedOpenWindows(library, hours, '2026-10-30', 4);
  assert.equal(reopensAt(friday, h(5)), 'Opens 7:00 AM');
  // Closed all weekend: Monday's opening, by name.
  assert.deepEqual(friday.nextOpening, { days: 3, weekday: 0, sec: h(7.5) });
  assert.equal(reopensAt(friday, h(23)), 'Opens Monday 7:30 AM');
  const sunday = publishedOpenWindows(library, hours, '2026-11-01', 6);
  assert.equal(reopensAt(sunday, h(12)), 'Opens tomorrow 7:30 AM');
  // Past the published dates the next opening is unknown, so nothing is promised.
  assert.equal(reopensAt(publishedOpenWindows(library, hours, '2026-11-02', 0), h(23)), null);
});
