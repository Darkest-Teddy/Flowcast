// BU faculty and staff (sim/staff.ts): the published employee headcount as a roster, a modeled
// weekday at a mapped academic building, and no effect on any student's day.
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) { if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) return next(`${specifier}.ts`, context); throw error; }
} });
const { buildPopulation } = await import('../src/sim/population.ts');
const { buildSourceDay } = await import('../src/sim/sourceDay.ts');
const { expandDay } = await import('../src/sim/playback.ts');
const { dateForWeekday } = await import('../src/data/campusData.ts');
const { STAFF_ASSUMPTIONS, planStaffDay, workplaceOrder, isStaff, buildStaffRoster } = await import('../src/sim/staff.ts');

const read = (name) => JSON.parse(readFileSync(new URL(`../public/data/${name}.json`, import.meta.url)));
const data = read('campus-data');
const population = read('population');
const demo = expandDay(read('demo-day'));
const base = buildPopulation(demo, data, population);
const studentsOnly = buildPopulation(demo, data, population, { staff: false });
const H = 3600;

test('the roster adds one agent per published employee, after the students, without changing them', () => {
  const staff = base.agents.filter(isStaff);
  assert.equal(population.employees.total, 11140);
  assert.equal(staff.length, population.employees.charlesRiver + population.employees.medical);
  assert.equal(staff.filter(a => a.campus === 'charles-river').length, 7871);
  assert.equal(staff.filter(a => a.campus === 'medical').length, 3269);
  assert.ok(staff.every(a => a.home === 'off-campus' && a.residency === 'commuter' && !a.studentLevel && a.academicCampus === a.campus));
  assert.equal(base.populationSummary.total, 36977);
  assert.equal(base.populationSummary.staff, 11140);
  assert.equal(base.agents.length, 36977 + 11140);
  assert.equal(new Set(base.agents.map(a => a.id)).size, base.agents.length);
  // Students first, identical to a students-only roster.
  assert.deepEqual(base.agents.slice(0, 36977), studentsOnly.agents);
  assert.equal(studentsOnly.populationSummary.staff, 0);
  assert.deepEqual(buildStaffRoster(undefined, ['charles-river']), []);
});

const wednesday = buildSourceDay(base, data, 2, undefined, { eventDate: dateForWeekday(data, 2) });
const wednesdayStudents = buildSourceDay(studentsOnly, data, 2, undefined, { eventDate: dateForWeekday(data, 2) });

test('employees never change a student’s day: they are planned after every student', () => {
  const student = (row) => !row.agent.startsWith('staff:');
  const studentStays = wednesday.stays.filter(student);
  assert.equal(studentStays.length, wednesdayStudents.stays.length);
  assert.deepEqual(studentStays, wednesdayStudents.stays);
  assert.deepEqual(wednesday.trips.filter(student).map(t => [t.agent, t.from, t.to, t.timestamps[0]]), wednesdayStudents.trips.map(t => [t.agent, t.from, t.to, t.timestamps[0]]));
  assert.deepEqual(wednesday.sourceAssignments, wednesdayStudents.sourceAssignments);
  assert.equal(wednesday.sourceStats.unassignedStudents, wednesdayStudents.sourceStats.unassignedStudents);
});

test('employees take no class seats and keep complete, contiguous itineraries', () => {
  assert.ok(!wednesday.sourceAssignments.some(row => row.agentId.startsWith('staff:')));
  const locations = new Map(wednesday.locations.map(l => [l.id, l]));
  const parts = new Map(base.agents.filter(isStaff).map(a => [a.id, []]));
  for (const stay of wednesday.stays) {
    if (!parts.has(stay.agent)) continue;
    assert.notEqual(stay.purpose?.kind, 'class');
    parts.get(stay.agent).push({ start: stay.start, end: stay.end, from: stay.location, to: stay.location, stay });
  }
  for (const trip of wednesday.trips) if (parts.has(trip.agent)) parts.get(trip.agent).push({ start: trip.timestamps[0], end: trip.timestamps.at(-1), from: trip.from, to: trip.to });
  for (const [id, rows] of parts) {
    rows.sort((a, b) => a.start - b.start || a.end - b.end);
    assert.equal(rows[0].start, 0, id);
    assert.equal(rows.at(-1).end, 86400, id);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(Math.abs(rows[i].start - rows[i - 1].end) < 1e-7, `${id}: gap or overlap`);
      if (rows[i].from === rows[i - 1].to) continue;
      // Places sharing a doorway (Breadwinners in Questrom) are a zero-length step, as in campusCapacity.test.mjs.
      const from = locations.get(rows[i - 1].to), to = locations.get(rows[i].from);
      assert.ok(wednesday.walkRoutes?.[`${from.id}>${to.id}`]?.cumulative.at(-1) === 0 || Math.hypot((from.position[0] - to.position[0]) * 82400,
        (from.position[1] - to.position[1]) * 110540) <= 1, `${id}: transition without walking`);
    }
    const campus = id.split(':')[1];
    for (const row of rows) if (row.stay?.purpose?.kind === 'work') {
      const place = locations.get(row.stay.location);
      assert.equal(place.kind, 'classroom', `${id} works in ${place.id}`);
      assert.equal(place.campus ?? 'charles-river', campus);
    }
  }
});

test('on a weekday most employees arrive 08:00–09:00 and leave 17:00–18:00, within the stated windows', () => {
  const stats = wednesday.sourceStats.staff;
  assert.equal(stats.roster, 11140);
  assert.ok(Math.abs(stats.onSite / stats.roster - STAFF_ASSUMPTIONS.onSiteShare) < 0.02, `${stats.onSite} on site`);
  assert.equal(stats.inMappedBuildings + stats.workingOffMap, stats.onSite);
  assert.ok(stats.inMappedBuildings > 0.8 * stats.onSite, `${stats.inMappedBuildings} in mapped buildings`);
  assert.ok(stats.gymVisits > 0 && stats.lunchAtDining > 0 && stats.lunchOffCampus > 0);
  const first = new Map(), last = new Map();
  for (const activity of wednesday.sourceActivities) {
    if (!activity.agentId.startsWith('staff:') || activity.kind !== 'work') continue;
    first.set(activity.agentId, Math.min(first.get(activity.agentId) ?? Infinity, activity.startSec));
    last.set(activity.agentId, Math.max(last.get(activity.agentId) ?? 0, activity.endSec));
  }
  assert.equal(first.size, stats.inMappedBuildings);
  const starts = [...first.values()], ends = [...last.values()];
  assert.ok(starts.every(t => t >= STAFF_ASSUMPTIONS.arriveShoulder[0] * H - 1 && t <= 10.5 * H + 1));
  assert.ok(ends.every(t => t >= STAFF_ASSUMPTIONS.leaveShoulder[0] * H - 1 && t <= 21 * H));
  const inCore = (values, [from, to]) => values.filter(t => t >= from * H && t <= to * H).length / values.length;
  assert.ok(inCore(starts, STAFF_ASSUMPTIONS.arrive) > 0.6, `arrivals in 08–09: ${inCore(starts, STAFF_ASSUMPTIONS.arrive)}`);
  assert.ok(inCore(ends, STAFF_ASSUMPTIONS.leave) > 0.45, `departures in 17–18: ${inCore(ends, STAFF_ASSUMPTIONS.leave)}`);
  // Gym and lunch visits are at gyms and dining venues; nobody is on campus overnight.
  const kinds = new Map(wednesday.locations.map(l => [l.id, l.kind]));
  for (const activity of wednesday.sourceActivities) if (activity.agentId.startsWith('staff:') && ['gym', 'dining'].includes(activity.kind)) assert.equal(kinds.get(activity.locationId), activity.kind);
  for (const stay of wednesday.stays) if (stay.agent.startsWith('staff:') && stay.location !== 'off-campus') assert.ok(stay.start >= 5 * H && stay.end <= 22 * H, `${stay.agent} at ${stay.location}`);
});

test('nobody works on campus at the weekend or on a university holiday', () => {
  const saturday = buildSourceDay(base, data, 5, undefined, { eventDate: dateForWeekday(data, 5) });
  assert.equal(saturday.sourceStats.staff.onSite, 0);
  assert.ok(saturday.stays.filter(s => s.agent.startsWith('staff:')).every(s => s.location === 'off-campus' && s.start === 0 && s.end === 86400));
  const ctx = { agent: { id: 'staff:charles-river:1', home: 'off-campus', model: 0, role: 'staff' }, weekday: 0, workplaces: [{ id: 'cas', weight: 1 }],
    dining: [], gyms: [], walk: () => 60, isOpen: () => true, commit: () => true, rider: false, venueWeight: () => 1 };
  assert.equal(planStaffDay(ctx, true).onSite, false);
  assert.equal(planStaffDay({ ...ctx, weekday: 6 }, false).onSite, false);
});

test('an employee whose buildings are full works off the map; workplaces are stable weighted draws', () => {
  const ids = Array.from({ length: 200 }, (_, i) => `staff:charles-river:${i}`);
  const committed = [];
  const ctx = (id, fits) => ({ agent: { id, home: 'off-campus', model: 0, role: 'staff' }, weekday: 1, workplaces: [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }],
    dining: [], gyms: [], walk: () => 60, isOpen: () => true, commit: (stops) => { committed.push(stops); return fits; }, rider: false, venueWeight: () => 1 });
  let onSite = 0;
  for (const id of ids) {
    const outcome = planStaffDay(ctx(id, false), false);
    if (outcome.onSite) { onSite++; assert.equal(outcome.placed, false); }
  }
  assert.ok(onSite > 120 && onSite < 180);
  assert.deepEqual(workplaceOrder('x', [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }], 4).sort(), ['a', 'b']);
  assert.deepEqual(workplaceOrder('x', [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }], 4), workplaceOrder('x', [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }], 4));
  const first = ids.map(id => workplaceOrder(id, [{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }], 1)[0]);
  const share = first.filter(id => id === 'a').length / first.length;
  assert.ok(share > 0.65 && share < 0.85, `capacity-weighted: ${share}`);
});
