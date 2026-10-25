import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { GapInput } from '../src/lib/gapPlanner.ts';
import type { ScheduleItem, CampusLocation } from '../src/data/types.ts';
// gapPlanner.ts imports the study finder without an extension: load through Vite.
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { planGap } = await vite.ssrLoadModule('/src/lib/gapPlanner.ts') as typeof import('../src/lib/gapPlanner.ts');
await vite.close();

// Wednesday 28 Oct 2026, Boston is UTC-4. Classes in CAS 10:10-11:00 and CDS 12:30-13:45.
const at = (hhmm: string) => Date.parse(`2026-10-28T${hhmm}:00-04:00`);
const item = (id: string, start: string, end: string, locationId: string): ScheduleItem =>
  ({ id, title: id, start: new Date(at(start)).toISOString(), end: new Date(at(end)).toISOString(), locationId, source: 'calendar' });
const loc = (id: string, kind: CampusLocation['kind']): CampusLocation => ({ id, name: id.toUpperCase(), short: id, kind, capacity: 100 });
const locations = [loc('cas', 'classroom'), loc('cds', 'classroom'), loc('warren', 'dorm'), loc('marciano', 'dining'), loc('gsu', 'dining'), loc('mugar', 'library'), loc('sel', 'library'), loc('fitrec', 'gym')];
// Metres along routes (84 m a minute): CAS-CDS 5 min, the rest a few minutes apart.
const walk = { 'cas>cds': 420, 'cas>marciano': 336, 'cds>marciano': 420, 'cas>gsu': 168, 'cds>gsu': 336, 'cas>mugar': 168, 'cds>mugar': 336,
  'cas>sel': 840, 'cds>sel': 1260, 'cas>fitrec': 1260, 'cds>fitrec': 1680, 'cas>warren': 840, 'cds>warren': 1260 };
const open = (from: string, to: string) => ({ hours: [{ date: '2026-10-28', windows: [[+from * 3600, +to * 3600]] as [number, number][], sourceUrl: 'https://bu.edu/x', qualifier: null }], hoursStatus: 'published' });
const hours = { marciano: open('7', '21'), gsu: open('7', '23'), mugar: open('8', '24'), sel: open('9', '17'), fitrec: open('6', '23') };
const forecast = (id: string, share: number) => ({ locationId: id, day: '2026-10-28', hours: Array.from({ length: 24 }, (_, hour) => ({ hour, share })) });
const forecasts = [forecast('marciano', 0.3), forecast('gsu', 0.9), forecast('mugar', 0.5), forecast('sel', 0.1), forecast('fitrec', 0.4)];
const schedule = [item('CAS 101', '10:10', '11:00', 'cas'), item('CDS 112', '12:30', '13:45', 'cds')];
const input = (overrides: Partial<GapInput> = {}): GapInput => ({ schedule, locations, geo: { positions: {}, walkMeters: walk }, hours, forecasts,
  profile: { lunchTime: '12:00', dinnerTime: '18:00', studySpotId: null }, homeLocationId: 'warren', now: at('11:05'), ...overrides });

test('after class: the gap to the next class, with one place per activity that fits and is open', () => {
  const plan = planGap(input());
  assert.equal(plan.status, 'gap');
  assert.equal(plan.next?.id, 'CDS 112');
  assert.equal(plan.from, 'cas');
  assert.equal(plan.leaveForClassBy, at('12:20')); // 12:30 - 5 buffer - 5 walk
  assert.equal(plan.gapMinutes, 75);
  const byActivity = Object.fromEntries(plan.options.map((o) => [o.activity, o]));
  assert.equal(byActivity.eat.locationId, 'marciano', 'quieter than GSU, close enough');
  assert.equal(byActivity.eat.leaveBy, at('12:20')); // 5 buffer + 5 min back
  assert.ok(byActivity.eat.stayMinutes >= 20 && byActivity.eat.stayMinutes <= 40);
  assert.equal(byActivity.study.locationId, 'mugar', 'SEL is quieter but far, and closes at 5');
  assert.equal(byActivity.study.closesAt, at('00:00') + 24 * 3600_000);
  // FitRec: 15 min there, 20 back to CDS, so 45 min to work out; leave by 12:05.
  assert.equal(byActivity.gym.locationId, 'fitrec');
  assert.equal(byActivity.gym.stayMinutes, 45);
  assert.equal(byActivity.gym.leaveBy, at('12:05'));
  // A shorter gap leaves no time for a workout.
  const short = planGap(input({ schedule: [schedule[0], item('CDS 112', '11:55', '13:00', 'cds')] }));
  assert.equal(short.options.some((o) => o.activity === 'gym'), false);
  for (const o of plan.options) assert.ok(o.arriveAt >= at('11:05') && o.leaveBy <= at('12:25'));
});

test('during class the gap starts when it ends; the saved study spot gets a head start', () => {
  const plan = planGap(input({ now: at('10:30'), profile: { lunchTime: '12:00', dinnerTime: '18:00', studySpotId: 'sel' } }));
  assert.equal(plan.current?.id, 'CAS 101');
  assert.equal(plan.startsAt, at('11:00'));
  assert.equal(plan.options.find((o) => o.activity === 'study')?.locationId, 'sel');
});

test('meals only near the saved meal time; no hours, no offer', () => {
  const morning = planGap(input({ schedule: [item('Early', '08:00', '08:50', 'cas'), item('Late', '10:30', '11:20', 'cds')], now: at('08:55') }));
  assert.equal(morning.status, 'gap');
  assert.equal(morning.options.some((o) => o.activity === 'eat'), false, 'breakfast-time gap, lunch saved at 12:00');
  const noHours = planGap(input({ hours: {} }));
  assert.deepEqual(noHours.options, []);
});

test('a short gap says head straight there; no class left today, no card', () => {
  const tight = planGap(input({ schedule: [item('A', '10:10', '11:00', 'cas'), item('B', '11:30', '12:20', 'cds')], now: at('11:01') }));
  assert.equal(tight.status, 'tight');
  assert.equal(tight.leaveForClassBy, at('11:20'));
  assert.equal(planGap(input({ now: at('14:00') })).status, 'no-next');
  assert.equal(planGap(input({ now: at('07:00'), homeLocationId: null })).status, 'unknown-origin');
  assert.equal(planGap(input({ now: at('07:00') })).from, 'warren');
});
