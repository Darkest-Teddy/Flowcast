// A simulated Red Sox game is an ordinary calendar event at Fenway: sold out, timed from the chosen
// first pitch, and in place of any real game there that day.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { GAME_ID, GAME_MINUTES, simulatedGameEvent, withSimulatedGame } = await import('../src/sim/simulatedGame.ts');
const { planEventDay } = await import('../src/sim/eventAttendance.ts');
const calendar = JSON.parse(readFileSync(new URL('../public/data/event-calendar.json', import.meta.url), 'utf8'));
const H = 3600;

test('the game is a sold-out Fenway event from first pitch, with Boston’s offset', () => {
  const event = simulatedGameEvent('2026-10-28', { firstPitch: 19 * H + 10 * 60, opponent: 'New York Yankees' });
  assert.equal(event.start, '2026-10-28T19:10:00-04:00');
  assert.equal(event.end, '2026-10-28T21:50:00-04:00');
  assert.equal(simulatedGameEvent('2026-11-04', { firstPitch: 13 * H, opponent: 'x' }).start, '2026-11-04T13:00:00-05:00');
  assert.equal(simulatedGameEvent('2026-11-04', { firstPitch: 13 * H, opponent: 'x' }).setup, 'ballpark-day');
  // Past midnight it ends the next day.
  assert.equal(GAME_MINUTES, 160);
  assert.equal(simulatedGameEvent('2026-10-28', { firstPitch: 23 * H, opponent: 'x' }).end, '2026-10-29T01:40:00-04:00');
  const sources = { calendar, popularity: null, routes: null };
  const day = planEventDay(withSimulatedGame(sources, '2026-10-28', { firstPitch: 19 * H, opponent: 'New York Yankees' }), '2026-10-28');
  const game = day.events.find((e) => e.event.id === GAME_ID);
  assert.ok(game, 'game planned');
  assert.ok(game.attendees > 30000 && game.visitors > 0, `${game.attendees} attendees`);
  assert.ok(game.arrivalFrom < 19 * H && game.departureTo > 21 * H);
  assert.equal(day.events.filter((e) => e.venue.id === 'fenway-park').length, 1);
  // No game, or no date: the sources are untouched.
  assert.equal(withSimulatedGame(sources, '2026-10-28', null), sources);
  assert.equal(withSimulatedGame(sources, null, { firstPitch: 0, opponent: 'x' }), sources);
});

test('a real game at Fenway that day is replaced, not doubled', () => {
  const real = calendar.events.find((e) => e.venueId === 'fenway-park');
  const date = real.start.slice(0, 10);
  const merged = withSimulatedGame({ calendar, popularity: null, routes: null }, date, { firstPitch: 18 * H, opponent: 'Tampa Bay Rays' });
  const fenway = merged.calendar.events.filter((e) => e.venueId === 'fenway-park' && e.start.slice(0, 10) === date);
  assert.deepEqual(fenway.map((e) => e.id), [GAME_ID]);
  assert.ok(calendar.events.includes(real), 'the loaded calendar is not changed');
});
