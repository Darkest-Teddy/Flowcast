// A meteor at Fenway during a game hits the fans too: walkers and the crowd in the stands, counted apart from students.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { fanCasualties, NO_FAN_CASUALTIES } = await import('../src/sim/fanCasualties.ts');
const { withSimulatedGame } = await import('../src/sim/simulatedGame.ts');
const { planEventDay } = await import('../src/sim/eventAttendance.ts');
const { planVisitors, NO_VISITORS } = await import('../src/sim/visitors.ts');
const { FENWAY_PARK } = await import('../src/sim/landmarks.ts');
const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url), 'utf8'));
const H = 3600, date = '2026-10-28';
const sources = { calendar: read('event-calendar'), popularity: null, routes: read('event-visitor-routes') };
const plan = planVisitors(planEventDay(withSimulatedGame(sources, date, { firstPitch: 19 * H, opponent: 'New York Yankees' }), date));

test('mid-game at Fenway: fans in the stands are hit, the dead nearest the impact become ragdolls', () => {
  const hit = fanCasualties(plan, FENWAY_PARK.position, 250, 20 * H, 'm1');
  assert.ok(hit.fatalities > 1000 && hit.injured > 0, `${hit.fatalities} killed, ${hit.injured} injured`);
  assert.equal(hit.harmed.size, hit.fatalities + hit.injured);
  assert.ok(hit.ragdolls.length > 0 && hit.ragdolls.length <= 300);
  assert.ok(hit.ragdolls.every((event) => event.outcome === 'fatality' && event.cause === 'meteor' && event.agentId.startsWith('visitor:')));
  assert.ok([...hit.harmed.values()].every((at) => at >= 20 * H && at <= hit.settledAt));
  assert.deepEqual(fanCasualties(plan, FENWAY_PARK.position, 250, 20 * H, 'm1').ragdolls, hit.ragdolls, 'deterministic');
});

test('no fans in range, no game, or no radius: nobody is hit', () => {
  const far = [FENWAY_PARK.position[0] - 0.03, FENWAY_PARK.position[1]]; // ~2.5 km west
  assert.equal(fanCasualties(plan, far, 250, 20 * H, 'm2').harmed.size, 0);
  assert.equal(fanCasualties(plan, FENWAY_PARK.position, 250, 4 * H, 'm3').harmed.size, 0, 'before anyone arrives');
  assert.equal(fanCasualties(NO_VISITORS, FENWAY_PARK.position, 250, 20 * H, 'm4'), NO_FAN_CASUALTIES);
  assert.equal(fanCasualties(plan, FENWAY_PARK.position, 0, 20 * H, 'm5'), NO_FAN_CASUALTIES);
});
