import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openingHoursForDate } from '../src/data/campusData.ts';

const weekly = { date:null, weekday:5, validFrom:'2026-09-01',validTo:'2026-12-31',windows:[[36000,72000]],text:'10 AM–8 PM',sourceUrl:'https://www.bu.edu/',qualifier:null };
test('date-specific closure overrides a weekly opening schedule', () => {
  const closure = {...weekly,date:'2026-10-24',windows:[],text:'Closed'};
  assert.deepEqual(openingHoursForDate([weekly,closure],'2026-10-24',5),[closure]);
});
test('unknown undated snapshots and weekly schedules for other days or terms are excluded', () => {
  assert.deepEqual(openingHoursForDate([{...weekly,weekday:undefined}],'2026-10-24',5),[]);
  assert.deepEqual(openingHoursForDate([weekly],'2026-10-23',4),[]);
  assert.deepEqual(openingHoursForDate([weekly],'2027-01-02',5),[]);
  assert.deepEqual(openingHoursForDate([weekly],'2026-10-24',5),[weekly]);
});
