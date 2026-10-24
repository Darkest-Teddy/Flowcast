import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitrecVisitStart } from '../src/data/fitrecUsage.ts';
const usage = {metric:'visits', observations:[
  {date:'2026-10-19',hour:9,visits:10}, {date:'2026-10-19',hour:18,visits:30},
  {date:'2026-10-20',hour:12,visits:500},
]};
test('FitRec timing follows relative entry counts and preserves within-hour jitter', () => {
  assert.equal(fitrecVisitStart(usage,'2026-10-19',0.249,0.5),9.5*3600);
  assert.equal(fitrecVisitStart(usage,'2026-10-19',0.25,0.1),18.1*3600);
  assert.equal(fitrecVisitStart(usage,'2026-10-26',0.9,0.25),18.25*3600);
});
test('observations never leak backward, across weekdays, or beyond 28 days', () => {
  for (const date of ['2026-10-12','2026-10-21','2026-11-23']) assert.equal(fitrecVisitStart(usage,date,0,0),undefined);
  assert.equal(fitrecVisitStart(usage,'2026-11-16',0,0),9*3600);
  assert.equal(fitrecVisitStart(undefined,'2026-10-19',0,0),undefined);
});
test('latest matching date replaces older profile; zero/missing counts are not closures', () => {
  const updated = {...usage,observations:[...usage.observations,{date:'2026-10-26',hour:15,visits:2}]};
  assert.equal(fitrecVisitStart(updated,'2026-10-26',0,0),15*3600);
  assert.equal(fitrecVisitStart({metric:'visits',observations:[{date:'2026-10-19',hour:8,visits:0}]},'2026-10-19',0,0),undefined);
});
