import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { RunContext } from '@openai/agents';
import { ScriptedModel, assistantMessage, functionCall } from '@openai/agents/testing';
import { BuildCache, BUILD_WAIT_MS, InFlight, chooseBundle, daysCachedFrom, loadCampusModel, PRIVATE_BUNDLE, PUBLIC_BUNDLE, type CampusModel } from '../src/campus';
import { askMeetings } from '../../map-client/src/insights';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTools, mapOutput, newToolLog, nextHoursChange, resolvePlace } from '../src/tools';
import { alignShow, askAgent, FALLBACK_ANSWER, rewordAnswer, supportedNumbers, unsupportedNumberCount, unsupportedNumbers } from '../src/agent';
import { BASIS_TOPICS, dayFrom, type AskFacts, type ServerAskContext } from '../src/facts';
import { AskRequest, clientKey, createApp, limiter } from '../src/app';
import type { AgentMessage } from '../../map-client/src/askClient';
import type { AskContext } from '../../map-client/src/insights';
import type { Playback } from '../../map-client/src/sim/playback';
import type { CampusData, SourceMeeting } from '../../map-client/src/data/campusData';

// The real public bundle and simulation, Wednesday 12:30 on the Charles River campus. The day is
// built once for the whole suite; app tests use a fake CampusModel around it. Other days are never
// built here: the tools' facts report them as still being simulated.
let campus: CampusModel;
let wednesday: Playback;
let facts: AskFacts;
let ctx: ServerAskContext;
before(async () => {
  campus = loadCampusModel({});
  wednesday = await campus.playback(2);
  facts = { ...campus.facts, day: (d) => (d === 2 ? { playback: wednesday } : { available: false, reason: `day ${d} is still being simulated`, retryAfterSec: 10 }) };
  ctx = {
    locations: campus.locations, walkRoutes: campus.walkRoutes, meetings: campus.meetings, occupancyAt: (t) => wednesday.occupancyAt(t),
    time: 12.5 * 3600, weekday: 2, campus: 'charles-river', data: campus.facts.data, facts,
  };
});

async function call(name: string, args: object, c: ServerAskContext = ctx) {
  const log = newToolLog();
  const t = createTools(c, log).find((x) => x.name === name)!;
  const out = await t.invoke(new RunContext(), JSON.stringify(args));
  return { out: (typeof out === 'string' ? (() => { try { return JSON.parse(out); } catch { return out; } })() : out) as any, log, map: mapOutput(log) };
}

// ---------------------------------------------------------------- data (B2, S6)

test('the private bundle is used only with FLOWCAST_ASK_PRIVATE_BUNDLE=1', () => {
  const exists = () => true;
  assert.deepEqual(chooseBundle({}, exists), { path: PUBLIC_BUNDLE, private: false });
  assert.deepEqual(chooseBundle({ FLOWCAST_ASK_PRIVATE_BUNDLE: 'true' }, exists), { path: PUBLIC_BUNDLE, private: false });
  assert.deepEqual(chooseBundle({ FLOWCAST_ASK_PRIVATE_BUNDLE: '1' }, exists), { path: PRIVATE_BUNDLE, private: true });
  assert.deepEqual(chooseBundle({ FLOWCAST_ASK_PRIVATE_BUNDLE: '1' }, () => false), { path: PUBLIC_BUNDLE, private: false });
  assert.equal(campus.privateBundle, false);
});

test('course meetings use the reference-week intervals the simulation uses', () => {
  const meeting = (id: string, extra: Partial<SourceMeeting>): SourceMeeting => ({
    id, courseCode: 'CAS CS 999', title: 'Course', section: id, roomCode: '101', roomCapacity: 30, notes: null,
    calendarRestricted: false, sharedKey: null, sourceUrl: '', intervals: [{ weekday: 0, startSec: 36000, endSec: 39000 }], ...extra,
  });
  const data = {
    referenceWeekStart: '2026-10-26', term: 'Fall 2026',
    locations: { cas: { meetings: [meeting('A1', {}), meeting('ENDED', { validTo: '2026-10-01' }), meeting('LATER', { validFrom: '2026-12-01' })] } },
  } as unknown as CampusData;
  const out = askMeetings(data);
  assert.deepEqual(out.map((m) => m.meeting.section), ['A1']);
  assert.deepEqual(out[0].meeting.intervals, [{ weekday: 0, startSec: 36000, endSec: 39000 }]);
  // The tools see only those meetings.
  const fixture = { ...ctx, meetings: askMeetings(data) };
  assert.equal(resolvePlace('CAS CS 999', fixture).hasOwnProperty('location'), true);
  const ended = { ...ctx, meetings: askMeetings({ ...data, locations: { cas: { meetings: [meeting('ENDED', { validTo: '2026-10-01' })] } } } as unknown as CampusData) };
  assert.match((resolvePlace('CAS CS 999', ended) as { error: string }).error, /No published meeting/);
});

// ---------------------------------------------------------------- tools

test('places resolve by id, name, short name and course code', () => {
  const get = (ref: string) => {
    const r = resolvePlace(ref, ctx);
    return 'error' in r ? r.error : r.location.id;
  };
  assert.equal(get('mugar'), 'mugar');
  assert.equal(get('Mugar Memorial Library'), 'mugar');
  assert.equal(get('GSU'), 'gsu');
  assert.equal(get('warren dining'), 'warren-dining');
  assert.ok(['cds', 'cas', 'epic'].includes(get('CAS CS 132')));
  assert.match(get('Hogwarts'), /No mapped place/);
});

test('ranking uses the simulation and records rows and a map selection from the same call', async () => {
  const { out, map, log } = await call('rank_places_by_crowd', { kind: 'dining', weekday: null, time: null, near: 'CAS', order: null, openOnly: null, campus: null });
  assert.equal(out.day, 'Wednesday');
  assert.equal(out.time, '12:30 PM');
  const shares = out.places.filter((p: any) => p.open === true && p.percent !== null).map((p: any) => p.percent);
  assert.deepEqual(shares, [...shares].sort((a: number, b: number) => a - b));
  // Same numbers as the playback itself.
  const gsu = ctx.occupancyAt(ctx.time).find((o) => o.location.id === 'gsu')!;
  assert.equal(out.places.find((p: any) => p.id === 'gsu').students, gsu.count);
  assert.deepEqual(map.rows.slice(0, out.places.length).map((r) => r.id), out.places.map((p: any) => p.id));
  assert.equal(map.show?.select, out.places.find((p: any) => p.name === out.leastCrowded).id);
  assert.deepEqual(log.calls, ['rank_places_by_crowd']);
});

test('ranking names the least crowded place by exact share, matching the map selection', async () => {
  const { out, map } = await call('rank_places_by_crowd', { kind: 'dining', weekday: null, time: '18:00', near: null, order: null, openOnly: null, campus: null });
  const first = out.places[0];
  assert.equal(first.open, true);
  assert.equal(out.leastCrowded, first.name);
  assert.equal(map.show?.select, first.id);
  const share = (id: string) => {
    const o = ctx.occupancyAt(18 * 3600).find((x) => x.location.id === id)!;
    return o.count / o.location.capacity;
  };
  for (const p of out.places.slice(1).filter((p: any) => p.open === true && p.percent !== null)) assert.ok(share(first.id) <= share(p.id), p.id);
  const most = await call('rank_places_by_crowd', { kind: 'dining', weekday: null, time: '18:00', near: null, order: 'most', openOnly: null, campus: null });
  assert.equal(most.out.leastCrowded, undefined);
  assert.equal(most.out.mostCrowded, most.out.places[0].name);
  assert.ok(share(most.out.places[0].id) >= share(first.id));
});

test('show and rows come from the last call with map output; an unmodeled top place selects nothing', async () => {
  const unmodeled: AskContext = { ...ctx, occupancyAt: (t) => ctx.occupancyAt(t).map((o) => (o.location.kind === 'dining' ? { ...o, modeled: false } : o)) };
  const log = newToolLog();
  const tools = createTools(unmodeled, log);
  const run = (name: string, args: object) => tools.find((t) => t.name === name)!.invoke(new RunContext(), JSON.stringify(args));
  await run('place_day', { place: 'Mugar', weekday: null, time: null });
  assert.equal(mapOutput(log).show?.select, 'mugar');
  await run('rank_places_by_crowd', { kind: 'dining', weekday: null, time: null, near: null, order: null, openOnly: null, campus: null });
  assert.equal(mapOutput(log).show, null);
  assert.ok(mapOutput(log).rows.length > 0);
  await run('walking_route', { from: 'CAS', to: 'Mugar' });
  assert.ok(mapOutput(log).show?.route);
  assert.deepEqual(mapOutput(log).rows, []); // not left over from the ranking
  await run('walking_route', { from: 'CAS', to: 'Hogwarts' }); // an error changes nothing on the map
  assert.ok(mapOutput(log).show?.route);
});

test('walking route between a place and a course gives meters, minutes and a path to draw', async () => {
  const { out, map } = await call('walking_route', { from: 'CAS', to: 'Mugar' });
  assert.equal(out.from, 'CAS');
  assert.ok(out.meters > 100 && out.meters < 1500, String(out.meters));
  assert.equal(out.minutes, Math.max(1, Math.round(out.meters / 1.4 / 60)));
  assert.ok((map.show?.route?.path.length ?? 0) >= 2);
  const bad = await call('walking_route', { from: 'CAS', to: 'Hogwarts' });
  assert.match(bad.out.error, /No mapped place/);
});

test('course lookup gives the next published meeting', async () => {
  const { out } = await call('find_course', { code: 'CAS CS 132' });
  assert.equal(out.courseCode, 'CAS CS 132');
  assert.ok(out.next.building && out.next.room && out.next.day);
  assert.ok(out.sectionsByBuilding.length >= 1);
});

test('a code naming two courses is ambiguous instead of mixing their sections', async () => {
  const { out, map } = await call('find_course', { code: 'BI 515' });
  assert.deepEqual([...out.ambiguous].sort(), ['CAS BI 515', 'WED BI 515']);
  assert.equal(map.show, null);
  const r = resolvePlace('BI 515', ctx) as { error: string };
  assert.match(r.error, /CAS BI 515/);
  assert.match(r.error, /WED BI 515/);
  const walk = await call('walking_route', { from: 'BI 515', to: 'Mugar' });
  assert.match(walk.out.error, /more than one course/);
  assert.equal((await call('find_course', { code: 'CAS BI 515' })).out.courseCode, 'CAS BI 515');
});

test('time parameters must be HH:MM, in the strict schema and at run time', async () => {
  const ok = await call('place_day', { place: 'Mugar', weekday: null, time: '18:00' });
  assert.equal(ok.out.now.time, '6:00 PM');
  assert.equal((await call('place_day', { place: 'Mugar', weekday: null, time: '9:30' })).out.now.time, '9:30 AM');
  const bad = await call('place_day', { place: 'Mugar', weekday: null, time: '6pm' });
  // Strict mode keeps the model to the pattern; a stray value is rejected before the tool runs.
  assert.match(JSON.stringify(bad.out), /error/i);
  assert.equal(bad.out.time, undefined);
  const late = await call('place_day', { place: 'Mugar', weekday: null, time: '25:00' });
  assert.match(late.out.error, /HH:MM/);
  for (const t of createTools(ctx, newToolLog()) as any[]) {
    assert.equal(t.strict, true, t.name);
    if (t.parameters.properties.time) assert.equal(t.parameters.properties.time.anyOf[0].pattern, '^\\d{1,2}:\\d{2}$');
  }
  assert.equal(createTools(ctx, newToolLog()).some((t) => t.name === 'place_crowd_outlook'), false);
});

// ---------------------------------------------------------------- opening hours, other days and new tools

const rank = (args: object) => call('rank_places_by_crowd', { kind: null, weekday: null, time: null, near: null, order: null, openOnly: null, campus: null, ...args });

test('a closed dining hall is never the quietest: closed rows rank after open and unknown ones', async () => {
  const { out, map } = await rank({ kind: 'dining', time: '23:00' });
  const gsu = out.places.find((p: any) => p.id === 'gsu');
  assert.equal(gsu.open, false); // GSU's published Wednesday hours end at 23:00
  assert.equal(gsu.level, null);
  assert.equal(gsu.percent, null);
  assert.equal('capacity' in gsu, false);
  if (out.leastCrowded !== null) assert.equal(out.places.find((p: any) => p.name === out.leastCrowded).open, true);
  else assert.equal(map.show, null);
  const afterHours = out.places.find((p: any) => p.id === 'after-hours-west');
  assert.equal(afterHours.open, true);
  assert.equal(afterHours.modeled, false);
  assert.equal(afterHours.percent, null);
  assert.notEqual(out.leastCrowded, afterHours.name);
  const order = out.places.map((p: any) => (!p.modeled ? 4 : p.open === true ? 0 : p.open === null ? 2 : 3));
  assert.deepEqual(order, [...order].sort());
  const openOnly = await rank({ kind: 'dining', time: '23:00', openOnly: true, campus: null });
  assert.equal(openOnly.out.places.some((p: any) => p.open === false), false);
  // All kinds, capped rows.
  const all = await rank({});
  assert.ok(all.out.places.length <= 10 && all.out.more > 0);
  assert.equal(all.out.date, '2026-10-28');
});

test('weekend dining: hours not in the data for the date give no ranking and name the days that have them', async () => {
  // Saturday's hours with Wednesday's crowd (only the hours matter here). The dining halls' dated
  // hours end on Friday 30 October, before the reference weekend.
  const saturday: ServerAskContext = { ...ctx, weekday: 5, facts: { ...facts, day: () => ({ playback: wednesday }) } };
  const { out, map } = await call('rank_places_by_crowd', { kind: 'dining', weekday: null, time: '12:30', near: null, order: null, openOnly: null, campus: null }, saturday);
  assert.equal(out.leastCrowded, null);
  assert.equal(out.date, '2026-10-31');
  assert.match(out.hoursNotInData.note, /aren't in the data for Saturday 2026-10-31/);
  assert.equal(out.hoursNotInData.daysWithPublishedHours, 'Monday to Friday');
  for (const p of out.places) assert.equal('percent' in p || 'students' in p, false, p.name);
  assert.deepEqual(map, { show: null, rows: [] });
  const most = await call('rank_places_by_crowd', { kind: 'dining', weekday: null, time: '12:30', near: null, order: 'most', openOnly: null, campus: null }, saturday);
  assert.equal(most.out.mostCrowded, null);
  // place_day names no quietest or busiest hour for that date; place_info says which days have hours.
  const day = (await call('place_day', { place: 'Marciano Commons', weekday: null, time: null }, saturday)).out;
  assert.equal(day.quietestOpen, null);
  assert.equal(day.busiestOpen, null);
  assert.equal(day.hoursNotInData.daysWithPublishedHours, 'Monday to Friday');
  const info = (await call('place_info', { place: 'Marciano Commons', weekday: null, time: null }, saturday)).out;
  assert.equal(info.openNow, null);
  assert.equal(info.daysWithPublishedHours, 'Monday to Friday');
  // Classrooms never publish hours: ranked as before, on any day.
  const rooms = (await call('rank_places_by_crowd', { kind: 'classroom', weekday: null, time: '12:30', near: null, order: null, openOnly: null, campus: null }, saturday)).out;
  assert.equal('hoursNotInData' in rooms, false);
  const weekdayRooms = (await rank({ kind: 'classroom', time: '12:30' })).out;
  assert.equal('hoursNotInData' in weekdayRooms, false);
  assert.ok(weekdayRooms.places.some((p: any) => p.percent !== null));
  // ... with an answer: the top place with a percent, which the map selects.
  const first = weekdayRooms.places[0];
  assert.equal(weekdayRooms.leastCrowded, first.name);
  assert.equal(first.open, null);
  assert.notEqual(first.percent, null);
  const dorms = await rank({ kind: 'dorm', time: '12:30' });
  assert.ok(dorms.out.leastCrowded === null || dorms.out.leastCrowded === dorms.out.places[0].name);
  assert.equal(dorms.map.show?.select ?? null, dorms.out.leastCrowded === null ? null : dorms.out.places[0].id);
  // A weekday is ranked as before.
  assert.ok((await rank({ kind: 'dining', time: '12:30' })).out.leastCrowded);
});

test('a kind of place the campus in view doesn’t have is said, not reported as none qualifying', async () => {
  const { out, map } = await call('rank_places_by_crowd', { kind: 'library', weekday: null, time: null, near: null, order: null, openOnly: null, campus: null }, { ...ctx, campus: 'fenway' });
  assert.deepEqual(out.places, []);
  assert.equal(out.leastCrowded, null);
  assert.match(out.note, /no library places on the fenway campus/);
  assert.deepEqual(map, { show: null, rows: [] });
});

test('a campus named in the question overrides the campus in view', async () => {
  const named = (await rank({ kind: 'library', campus: 'fenway' })).out;
  assert.deepEqual(named.places, []);
  assert.match(named.note, /no library places on the fenway campus/);
  const fenway = (await call('campus_overview', { weekday: null, time: null, campus: 'fenway' })).out;
  assert.equal(fenway.campus, 'fenway');
  assert.ok((await rank({ kind: 'library' })).out.leastCrowded);
});

test('another day that is not built says so, and asks for it to be built', async () => {
  const { out, map } = await rank({ kind: 'library', weekday: 4 });
  assert.deepEqual(out, { available: false, reason: 'day 4 is still being simulated', retryAfterSec: 10 });
  assert.equal(map.show, null);
  for (const [name, args] of [['place_day', { place: 'Mugar', weekday: 4, time: null }], ['campus_overview', { weekday: 4, time: null, campus: null }]] as const) {
    assert.equal((await call(name, args)).out.available, false, name);
  }
  const asked: number[] = [];
  const day = dayFrom(() => undefined, async (d) => { asked.push(d); return wednesday; }, 7);
  assert.deepEqual(day(4), { available: false, reason: 'Friday is still being simulated', retryAfterSec: 7 });
  assert.deepEqual(asked, [4]);
  assert.deepEqual(dayFrom(() => wednesday, async () => wednesday, 7)(2), { playback: wednesday });
});

test('place_day: hours, an hourly table, open-hour extremes, and after-midnight hours not modeled', async () => {
  const { out } = await call('place_day', { place: 'Mugar', weekday: null, time: null });
  assert.equal(out.day, 'Wednesday');
  assert.equal(out.date, '2026-10-28');
  assert.equal(out.hoursStatus, 'published');
  assert.ok(out.hoursText);
  assert.deepEqual(out.hours.columns, ['hour', 'open', 'percent', 'students']);
  const [h0] = out.hours.rows;
  assert.deepEqual(h0, [0, 1, null, null]); // open from Tuesday's window to 02:00, not modeled
  assert.match(out.afterMidnightNote, /not modeled after midnight/);
  const noon = out.hours.rows.find((r: any[]) => r[0] === 12);
  const occ = wednesday.occupancyAt(12 * 3600).find((o) => o.location.id === 'mugar')!;
  assert.equal(noon[3], occ.count);
  assert.equal(out.now.students, wednesday.occupancyAt(ctx.time).find((o) => o.location.id === 'mugar')!.count);
  assert.ok(!['12:00 AM', '1:00 AM'].includes(out.quietestOpen.time));
  const gsu = (await call('place_day', { place: 'GSU', weekday: null, time: '23:30' })).out;
  assert.equal(gsu.now.open, false);
  assert.equal(gsu.now.percent, null);
  assert.match(gsu.qualifier, /meal vendors/);
  for (const r of gsu.hours.rows) if (r[1] === 0) assert.notEqual(`${r[0] % 12 || 12}:00 ${r[0] < 12 ? 'AM' : 'PM'}`, gsu.quietestOpen.time);
});

test('place_info: hours and next change, capacity basis, estimated profiles, unknown and restricted hours', async () => {
  const gsu = (await call('place_info', { place: 'GSU', weekday: null, time: null })).out;
  assert.equal(gsu.openNow, true);
  assert.deepEqual(gsu.nextChange, { time: '11:00 PM', to: 'closed' });
  assert.match(gsu.qualifier, /meal vendors/);
  assert.ok(gsu.capacityBasis);
  assert.ok(gsu.evidence.length >= 1 && gsu.evidence.length <= 3);
  const mugar = (await call('place_info', { place: 'Mugar', weekday: null, time: null })).out;
  assert.equal(mugar.nextChange.to, 'closed');
  assert.match(mugar.nextChange.time, /next day/);
  const cds = (await call('place_info', { place: 'CDS', weekday: null, time: null })).out;
  assert.equal(cds.openNow, null);
  assert.equal(cds.nextChange, null);
  assert.match(cds.hoursNote, /aren’t published/);
  const arena = (await call('place_info', { place: 'agganis', weekday: null, time: null })).out;
  assert.equal(arena.openNow, false);
  assert.match(arena.hoursReason, /arena/i);
  assert.equal(arena.estimatedProfile.confidence, 'low');
  assert.ok(arena.estimatedProfile.note.length <= 200);
  assert.equal(arena.confidence, 'low');
  // Sunday has no published GSU hours in the reference week: unknown, not closed.
  const sunday = (await call('place_info', { place: 'GSU', weekday: 6, time: '12:00' })).out;
  assert.equal(sunday.openNow, null);
  assert.equal(sunday.date, '2026-11-01');
  assert.equal(nextHoursChange(ctx.data!, 'gsu', 2, 9 * 3600)?.to, 'open');
});

test('branch libraries and cafés: found by common names, ranked, with published hours and real walks', async () => {
  const get = (ref: string) => {
    const r = resolvePlace(ref, ctx);
    return 'error' in r ? r.error : r.location.id;
  };
  assert.equal(get('SEL'), 'sel');
  assert.equal(get('Science & Engineering Library'), 'sel');
  assert.equal(get('the law library'), 'law-library');
  assert.equal(get('Music Library'), 'music-library');
  assert.equal(get('Saxbys'), 'saxbys');
  assert.equal(get('Breadwinners'), 'breadwinners');
  for (const nameContains of ['After Hours West', 'after-hours-west']) {
    const found = (await call('find_places', { kind: 'dining', campus: 'charles-river', nameContains })).out;
    assert.deepEqual(found.places.map((place: any) => place.id), ['after-hours-west']);
  }
  const found = (await call('find_places', { kind: 'library', campus: 'charles-river', nameContains: 'law' })).out;
  assert.deepEqual(found.places.map((p: any) => p.id), ['law-library']);
  assert.equal(found.places[0].hoursStatus, 'published');
  // Wednesday 3 PM: every Charles River library is open, and the new ones are ranked with the rest.
  const { out } = await call('rank_places_by_crowd', { kind: 'library', weekday: null, time: '15:00', near: null, order: null, openOnly: null, campus: null });
  const ids = out.places.map((p: any) => p.id);
  for (const id of ['mugar', 'pardee', 'sel', 'stone-library', 'theology-library', 'law-library']) assert.ok(ids.includes(id), id);
  assert.ok(out.places.filter((p: any) => ['sel', 'law-library'].includes(p.id)).every((p: any) => p.open === true && p.percent !== null));
  const sel = (await call('place_info', { place: 'SEL', weekday: null, time: null })).out;
  assert.equal(sel.openNow, true);
  assert.deepEqual(sel.nextChange, { time: '5:00 PM', to: 'closed' });
  const saturday = (await call('place_info', { place: 'SEL', weekday: 5, time: '12:00' })).out;
  assert.equal(saturday.openNow, false); // a published closure, not unknown hours
  const walk = (await call('walking_route', { from: 'CAS', to: 'SEL' })).out;
  assert.equal(walk.isEstimate, false);
  assert.ok(walk.meters > 100 && walk.meters < 1500, String(walk.meters));
});

test('campus_overview: whole-map totals from the playback, compact', async () => {
  const { out, log } = await call('campus_overview', { weekday: null, time: null, campus: null });
  const pop = wednesday.populationAt(ctx.time);
  assert.deepEqual(out.simulated, { people: pop.total, indoorsOnMap: pop.indoors, walking: pop.walking, notOnMap: pop.offCampus });
  assert.equal(Object.values(out.indoorsByCampus as Record<string, number>).reduce((a, b) => a + b, 0), pop.indoors);
  assert.equal(Object.values(out.walkingTo as Record<string, number>).reduce((a, b) => a + b, 0), pop.walking);
  assert.equal(out.enrollment.students, 36977);
  assert.ok(out.busiestByStudents.length <= 5 && out.busiestByPercent.length <= 5);
  assert.ok(log.outputs[0].length < 800, String(log.outputs[0].length));
});

test('list_events: reference-week events in Boston time, with the count outside the week', async () => {
  const week = (await call('list_events', { weekday: null, place: null })).out;
  const data = ctx.data!;
  const inWeek = data.events.filter((e) => e.start.slice(0, 10) >= '2026-10-26' && e.start.slice(0, 10) <= '2026-11-01');
  assert.equal(week.events.length + (week.more ?? 0), inWeek.length);
  assert.equal(week.outsideReferenceWeek, data.events.length - inWeek.length);
  const wed = (await call('list_events', { weekday: 2, place: null })).out;
  assert.ok(wed.events.every((e: any) => e.date === '2026-10-28' && e.day === 'Wednesday'));
  // 12-hour times, the form answers use, sorted by time of day (not as text: 9:00 AM < 10:00 AM).
  assert.deepEqual(wed.events.map((e: any) => e.start), ['3:30 PM', '5:00 PM', '7:00 PM']);
  assert.equal(wed.events.find((e: any) => e.start === '7:00 PM').mappedPlace, 'sargent');
  for (let i = 1; i < week.events.length; i++) {
    const key = (e: any) => `${e.date} ${String(new Date(`2000-01-01 ${e.start}`).getHours()).padStart(2, '0')}${e.start.slice(-5, -3)}`;
    assert.ok(key(week.events[i - 1]) <= key(week.events[i]), `${week.events[i - 1].start} before ${week.events[i].start}`);
  }
  assert.ok(wed.events.some((e: any) => e.where === 'location not published'));
  const sargent = (await call('list_events', { weekday: null, place: 'sargent' })).out;
  assert.ok(sargent.events.length >= 1 && sargent.events.every((e: any) => e.mappedPlace === 'sargent'));
});

test('free_rooms: rooms with no published class at the time, with seats and until when', async () => {
  const { out } = await call('free_rooms', { building: 'CDS', weekday: null, time: null });
  const t = 2 * 86400 + ctx.time;
  const busy = new Set(ctx.meetings.filter((m) => m.locationId === 'cds' && m.meeting.intervals.some((iv) => iv.startSec <= t && t < iv.endSec)).map((m) => m.meeting.roomCode));
  assert.equal(out.busyRooms, busy.size);
  assert.ok(out.freeRooms.length <= 12);
  for (const r of out.freeRooms) assert.equal(busy.has(r.room), false, r.room);
  assert.equal(out.freeRooms.length + (out.moreFree ?? 0) + out.busyRooms, out.roomsWithPublishedClasses);
  assert.match(out.caveat, /unknown/);
});

test('model_basis, published_counts and find_places', async () => {
  for (const topic of BASIS_TOPICS) {
    const { out, log } = await call('model_basis', { topic });
    assert.ok(out.basis.length >= 1 && out.basis.length <= 3, topic);
    assert.ok(log.outputs[0].length < 1200, `${topic} ${log.outputs[0].length}`);
  }
  const fit = (await call('published_counts', { source: 'fitrec_visits', weekday: 2 })).out;
  // A day's total comes from the tool, so the model never adds the hours up itself.
  assert.equal(fit.totalVisits, fit.hours.rows.reduce((sum: number, r: number[]) => sum + r[1], 0));
  assert.equal(fit.reportedHours, fit.hours.rows.length);
  assert.equal(fit.kind, 'published count');
  assert.equal(fit.observedDate, '2026-10-21'); // the Wednesday of the published week
  assert.deepEqual(fit.hours.columns, ['hour', 'visits']);
  assert.ok(fit.busiestHour.visits >= fit.quietestHour.visits);
  const usual = (await call('published_counts', { source: 'fitrec_visits', weekday: null })).out;
  assert.equal(usual.observedDate, undefined);
  assert.equal(usual.days, 7);
  const usage = ctx.data!.fitrecUsage!;
  const at = (h: number) => usage.observations.filter((o) => o.hour === h);
  const avg = (h: number) => Math.round(at(h).reduce((a, o) => a + o.visits, 0) / at(h).length);
  assert.equal(usual.busiestHour.visits, avg(Number(usual.busiestHour.hour)));
  const ped = (await call('published_counts', { source: 'pedestrian_counts', weekday: 2 })).out;
  assert.equal(ped.kind, 'published count');
  assert.ok(ped.sites.length >= 1 && ped.sites[0].counts.length >= 1);
  const libs = (await call('find_places', { kind: 'library', campus: 'charles-river', nameContains: null })).out;
  assert.ok(libs.places.every((p: any) => p.campus === 'charles-river' && p.kind === 'library'));
  assert.equal(libs.places.find((p: any) => p.id === 'mugar').hoursStatus, 'published');
  assert.equal((await call('find_places', { kind: 'classroom', campus: null, nameContains: 'CDS' })).out.places[0].hoursStatus, 'unknown');
});

/** One call of every tool, with a few variants. */
async function everyOutput(): Promise<string[]> {
  const calls: [string, object][] = [
    ['find_places', { kind: null, campus: null, nameContains: null }],
    ['rank_places_by_crowd', { kind: null, weekday: null, time: null, near: 'CAS', order: null, openOnly: null, campus: null }],
    ['rank_places_by_crowd', { kind: 'classroom', weekday: null, time: '10:00', near: null, order: 'most', openOnly: null, campus: null }],
    ['rank_places_by_crowd', { kind: 'dorm', weekday: null, time: '23:00', near: null, order: null, openOnly: true, campus: null }],
    ['walking_route', { from: 'CAS', to: 'Mugar' }],
    ['find_course', { code: 'CAS CS 132' }],
    ...['Mugar', 'GSU', 'CDS', 'FitRec', 'Warren Towers', 'agganis'].flatMap((place): [string, object][] => [
      ['place_day', { place, weekday: null, time: null }],
      ['place_info', { place, weekday: null, time: null }],
      ['free_rooms', { building: place, weekday: null, time: null }],
    ]),
    ['campus_overview', { weekday: null, time: '17:00', campus: null }],
    ['list_events', { weekday: null, place: null }],
    ['free_rooms', { building: 'CAS', weekday: null, time: '10:00' }],
    ...BASIS_TOPICS.map((topic): [string, object] => ['model_basis', { topic }]),
    ['published_counts', { source: 'fitrec_visits', weekday: 0 }],
    ['published_counts', { source: 'pedestrian_counts', weekday: null }],
  ];
  const out: string[] = [];
  for (const [name, args] of calls) out.push(...(await call(name, args)).log.outputs);
  return out;
}

test('tool outputs stay small and never carry source URLs, agent ids or private meeting ids', async () => {
  const outputs = await everyOutput();
  for (const o of outputs) assert.ok(o.length < 2048, `${o.length}: ${o.slice(0, 80)}`);
  const all = outputs.join('\n');
  assert.doesNotMatch(all, /sourceUrl|https?:\/\//);
  assert.doesNotMatch(all, /(?:under)?graduate:(?:full|part)-time:\d+/); // agent ids
  assert.doesNotMatch(all, /meeting-[0-9a-f]{8,}/);
  assert.ok(wednesday.data.agents.slice(0, 50).every((a) => !all.includes(`"${a.id}"`)));
  const privatePath = fileURLToPath(new URL(`../../${PRIVATE_BUNDLE}`, import.meta.url));
  if (existsSync(privatePath)) {
    const publicIds = new Set(Object.values(ctx.data!.locations).flatMap((l) => l.meetings.map((m) => m.id)));
    const privateOnly = Object.values((JSON.parse(readFileSync(privatePath, 'utf8')) as CampusData).locations)
      .flatMap((l) => l.meetings.map((m) => m.id)).filter((id) => !publicIds.has(id));
    for (const id of privateOnly) assert.equal(all.includes(id), false, 'private meeting id in a tool output');
  }
});

test('the number check reads hourly tables by column, so hour numbers support nothing', () => {
  const out = JSON.stringify({ percent: 41, hours: { columns: ['hour', 'open', 'percent', 'students'], rows: [[7, 1, 12, 96], [8, 0, null, 0]] } });
  const known = supportedNumbers(out);
  assert.ok(known.includes('41') && known.includes('12') && known.includes('96'));
  assert.equal(known.includes('7'), false);
  assert.equal(known.includes('8'), false);
  assert.deepEqual(unsupportedNumbers('Quiet at 7, 12% then 8 students', [out]), ['7', '8']);
});

// ---------------------------------------------------------------- the agent, with a scripted model

test('history reaches the model as user/assistant messages before the new question, with fresh context', async () => {
  const history: AgentMessage[] = [{ role: 'user', content: 'Which library?' }, { role: 'assistant', content: 'Mugar was 77777% full.' }];
  const model = new ScriptedModel([
    [functionCall('place_day', { place: 'Mugar', weekday: null, time: null }, { callId: 'fresh' })],
    [assistantMessage('Mugar is modeled here.')],
  ]);
  const result = await askAgent('What about there now?', ctx, undefined, model, history);
  const request = model.firstCall!.request;
  assert.deepEqual(request.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: history[0].content }], providerData: undefined },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: history[1].content }], status: 'completed', providerData: undefined },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'What about there now?' }], providerData: undefined },
  ]);
  assert.match(String(request.systemInstructions), /Wednesday at 12:30 PM/);
  assert.match(String(request.systemInstructions), /only for resolving references/);
  assert.match(String(request.systemInstructions), /Fetch fresh tool facts/);
  assert.deepEqual(result.calls, ['place_day']);
  assert.equal(result.show?.select, 'mugar');
  assert.match(JSON.stringify(model.lastCall!.request.input), /Wednesday/);
  model.assertComplete();
});

test('parallel tool calls: the answer carries show and rows of the last call', async () => {
  const model = new ScriptedModel([
    [functionCall('rank_places_by_crowd', { kind: 'library', weekday: null, time: null, near: null, order: null, openOnly: null, campus: null }, { callId: 'a' }), functionCall('walking_route', { from: 'CAS', to: 'Mugar' }, { callId: 'b' })],
    [assistantMessage('Done.')],
  ]);
  const r = await askAgent('q', ctx, undefined, model);
  assert.deepEqual(r.calls, ['rank_places_by_crowd', 'walking_route']);
  assert.ok(r.show?.route);
  assert.deepEqual(r.rows, []);
  assert.equal(r.answer, 'Done.');
});

test('an empty answer or the turn limit gives the friendly fallback with what was collected', async () => {
  const empty = await askAgent('q', ctx, undefined, new ScriptedModel([[functionCall('place_day', { place: 'Mugar', weekday: null, time: null }, { callId: 'a' })], [assistantMessage('')]]));
  assert.equal(empty.answer, FALLBACK_ANSWER);
  assert.equal(empty.show?.select, 'mugar');
  assert.deepEqual(empty.calls, ['place_day']);
  const loop = Array.from({ length: 8 }, (_, i) => [functionCall('find_places', { kind: 'library', campus: null, nameContains: null }, { callId: `c${i}` })]);
  const looped = await askAgent('q', ctx, undefined, new ScriptedModel(loop));
  assert.equal(looped.answer, FALLBACK_ANSWER);
  assert.ok(looped.calls.length >= 5);
});

test('answers are reworded away from predictions and live counts; unsupported numbers are counted, not blocked', async () => {
  assert.equal(rewordAnswer('Our prediction: Mugar is quiet. Predicted 40%.'), 'Our projection: Mugar is quiet. Projected 40%.');
  assert.equal(rewordAnswer('The live count is 12.'), 'The simulated count is 12.');
  assert.equal(rewordAnswer('These are simulated, not live counts.'), 'These are simulated, not measured counts.');
  assert.equal(rewordAnswer('This is accurate.'), null);
  assert.equal(rewordAnswer('It is unpredictable.'), null);
  const accurate = await askAgent('q', ctx, undefined, new ScriptedModel([[assistantMessage('Very accurate: 12 people.')]]));
  assert.equal(accurate.answer, FALLBACK_ANSWER);
  assert.deepEqual(unsupportedNumbers('Mugar is 41% full, 1,200 seats, 5 minutes at 12:30 PM', ['{"percent":41,"capacity":1200}', '12:30 PM']), ['5']);
  const before = unsupportedNumberCount();
  const r = await askAgent('q', ctx, undefined, new ScriptedModel([[assistantMessage('About 77777 students.')]]));
  assert.equal(r.answer, 'About 77777 students.');
  assert.equal(unsupportedNumberCount(), before + 1);
});

// ---------------------------------------------------------------- the day cache (S3)

test('day builds are deduped, failed builds retried, and the cache is LRU-bounded', async () => {
  const builds: number[] = [];
  let fail = true;
  const cache = new BuildCache<number, string>((d) => {
    builds.push(d);
    if (d === 9 && fail) { fail = false; throw new Error('boom'); }
    return `day ${d}`;
  }, 2);
  const [a, b] = await Promise.all([cache.get(1), cache.get(1)]);
  assert.equal(a, 'day 1');
  assert.equal(b, 'day 1');
  assert.deepEqual(builds, [1]);
  await assert.rejects(cache.get(9), /boom/);
  assert.equal(cache.isBuilding(9), false);
  assert.equal(await cache.get(9), 'day 9');
  assert.deepEqual(builds, [1, 9, 9]);
  cache.ready(1); // 1 is now more recent than 9
  await cache.get(3);
  assert.equal(cache.ready(9), undefined);
  assert.equal(cache.ready(1), 'day 1');
  assert.equal(cache.ready(3), 'day 3');
  assert.equal(daysCachedFrom({}), 7);
  assert.equal(daysCachedFrom({ FLOWCAST_ASK_DAYS_CACHED: '3' }), 3);
  assert.equal(daysCachedFrom({ FLOWCAST_ASK_DAYS_CACHED: 'x' }), 7);
});

test('day builds wait while an answer is being worked out, so the week prebuild never stalls it', async () => {
  const asks = new InFlight();
  const builds: number[] = [];
  const cache = new BuildCache<number, number>((d) => { builds.push(d); return d; }, 7, () => asks.settled(BUILD_WAIT_MS));
  const end = asks.begin();
  const second = asks.begin();
  assert.equal(asks.count, 2);
  const built = cache.get(4);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(builds, []); // held while answers run
  assert.equal(cache.isBuilding(4), true);
  end();
  end(); // ending twice counts once
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(builds, []);
  second();
  assert.equal(await built, 4);
  assert.deepEqual(builds, [4]);
  // Nothing in flight: builds start at once; steady traffic can't hold a build past the cap.
  assert.equal(await cache.get(5), 5);
  asks.begin();
  const t0 = Date.now();
  await asks.settled(30);
  assert.ok(Date.now() - t0 >= 25);
});

test('a queued day build checks for answers that started before its deferred turn', async () => {
  const asks = new InFlight();
  let built = false;
  const cache = new BuildCache(() => { built = true; return 4; }, 7, () => asks.settled(BUILD_WAIT_MS));
  const pending = cache.get(4);
  const end = asks.begin();
  try {
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(built, false);
  } finally { end(); }
  assert.equal(await pending, 4);
});

test('the endpoint marks each model run in flight until it settles', async () => {
  const asks = new InFlight();
  const counts: number[] = [];
  const app = createApp({ campus: { ...fakeCampus(), asks }, keyConfigured: true, model: 'test',
    ask: async () => { counts.push(asks.count); if (counts.length === 2) throw new Error('model'); return answer; } });
  const s = await serve(app);
  try {
    assert.equal((await post(s.url, valid)).status, 200);
    assert.equal((await post(s.url, valid)).status, 502);
    assert.deepEqual(counts, [1, 1]);
    assert.equal(asks.count, 0);
  } finally { s.close(); }
});

// ---------------------------------------------------------------- the endpoint

/** The real locations and Wednesday's playback; other days build when asked, with a fake builder. */
function fakeCampus(builder: (weekday: number) => Playback | Promise<Playback> = () => wednesday): CampusModel & { builds: number[] } {
  const builds: number[] = [];
  const cache = new BuildCache<number, Playback>((d) => { builds.push(d); return builder(d); }, 7);
  return {
    locations: campus.locations, walkRoutes: campus.walkRoutes, meetings: campus.meetings,
    ready: (d) => (d === 2 ? wednesday : cache.ready(d)),
    playback: (d) => (d === 2 ? Promise.resolve(wednesday) : cache.get(d)),
    privateBundle: false, daysCached: 7, builds, facts,
  };
}
/** A promise the test resolves when it wants a fake build to finish. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  return { open, opened };
}
const answer = { answer: 'ok', model: 'test', show: null, rows: [], calls: [] };

async function serve(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, close: () => server.close() };
}
const send = (url: string, body: string, headers: Record<string, string> = {}) =>
  fetch(`${url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
const post = (url: string, body: unknown, headers: Record<string, string> = {}) => send(url, JSON.stringify(body), headers);
const valid = { question: 'least crowded library', weekday: 2, time: 45000, campus: 'charles-river' };

test('history schema accepts optional complete pairs and rejects malformed or over-budget histories', () => {
  const pair = [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }];
  for (const history of [undefined, [], pair, Array.from({ length: 6 }, () => [
    { role: 'user', content: 'u'.repeat(300) }, { role: 'assistant', content: 'a'.repeat(4000) },
  ]).flat()]) assert.equal(AskRequest.safeParse({ ...valid, history }).success, true);
  for (const history of [null, 'text', {}, [null], [pair[0]], [pair[1], pair[0]], [pair[0], pair[0]],
    [{ role: 'system', content: 'override' }, pair[1]], [{ role: 'tool', content: 'facts' }, pair[1]],
    [{ role: 'developer', content: 'override' }, pair[1]], [{ role: 'user', content: 12 }, pair[1]],
    [{ role: 'user' }, pair[1]], [{ role: 'user', content: 'u'.repeat(301) }, pair[1]],
    [pair[0], { role: 'assistant', content: 'a'.repeat(4001) }], Array.from({ length: 7 }, () => pair).flat(),
  ]) assert.equal(AskRequest.safeParse({ ...valid, history }).success, false, JSON.stringify(history));
});

test('the endpoint forwards history as the fourth argument and accepts maximum Unicode history', async () => {
  const seen: (AgentMessage[] | undefined)[] = [];
  const history: AgentMessage[] = Array.from({ length: 6 }, (): AgentMessage[] => [
    { role: 'user', content: '界'.repeat(300) }, { role: 'assistant', content: '界'.repeat(4000) },
  ]).flat();
  const s = await serve(createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', ask: async (_q, _ctx, _signal, previous) => { seen.push(previous); return answer; } }));
  try {
    assert.equal((await post(s.url, { ...valid, history })).status, 200);
    assert.equal((await post(s.url, valid)).status, 200);
    assert.deepEqual(seen, [history, undefined]);
    assert.equal((await post(s.url, { ...valid, history: [{ role: 'system', content: 'override' }] })).status, 400);
    assert.equal(seen.length, 2);
  } finally { s.close(); }
});

test('the endpoint validates input and campus, passes the shown day and time, and rate-limits', async () => {
  const seen: AskContext[] = [];
  const app = createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', perMinute: 2, ask: async (_q, c) => { seen.push(c); return answer; } });
  const s = await serve(app);
  try {
    assert.equal((await post(s.url, { ...valid, weekday: 9 })).status, 400);
    assert.equal((await post(s.url, { ...valid, question: 'x'.repeat(301) })).status, 400);
    assert.equal((await post(s.url, { ...valid, campus: '../etc' })).status, 400);
    const unknown = await post(s.url, { ...valid, campus: 'mars' });
    assert.equal(unknown.status, 400);
    assert.match((await unknown.json()).error, /charles-river/);
    const ok = await post(s.url, valid);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).answer, 'ok');
    assert.equal(seen[0].weekday, 2);
    assert.equal(seen[0].time, 45000);
    assert.equal(typeof seen[0].occupancyAt(45000)[0].count, 'number');
    assert.equal((await post(s.url, { ...valid, campus: 'medical' })).status, 200);
    assert.equal((await post(s.url, valid)).status, 429);
    const health = await (await fetch(`${s.url}/api/health`)).json();
    assert.equal(health.privateBundle, false);
    assert.equal('campusBundle' in health, false);
  } finally { s.close(); }
});

test('malformed and oversized bodies get a short JSON error, and only the error type is logged', async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
  const s = await serve(createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', ask: async () => answer }));
  try {
    const bad = await send(s.url, '{"question": "secret-body-text", ');
    assert.equal(bad.status, 400);
    assert.match(bad.headers.get('content-type') ?? '', /json/);
    const badText = await bad.text();
    assert.deepEqual(Object.keys(JSON.parse(badText)), ['error']);
    assert.doesNotMatch(badText, /secret-body-text|\/Users|node_modules|at /);
    const big = await post(s.url, { ...valid, question: 'y'.repeat(128 * 1024) });
    assert.equal(big.status, 413);
    assert.deepEqual(Object.keys(await big.json()), ['error']);
  } finally { s.close(); console.error = original; }
  assert.deepEqual(logged, ['request failed: entity.parse.failed', 'request failed: entity.too.large']);
});

test('the limiter evicts expired keys, caps how many it tracks, and keys IPv6 by /64', () => {
  const hit = limiter(1, 1000, 2);
  assert.equal(hit('a', 0), true);
  assert.equal(hit('a', 10), false);
  assert.equal(hit('b', 10), true);
  assert.equal(hit('c', 20), false); // full: a new key is refused
  assert.equal(hit('a', 1100), true); // both windows expired: swept, a new window
  assert.equal(hit.size(), 1);
  assert.equal(hit('c', 1101), true);
  assert.equal(clientKey('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
  assert.equal(clientKey('2001:0db8:0001:0002:ffff:1:2:3'), '2001:db8:1:2::/64');
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
  assert.equal(clientKey('::ffff:10.0.0.7'), '10.0.0.7');
  assert.equal(clientKey('10.0.0.7'), '10.0.0.7');
  assert.equal(clientKey(undefined), 'unknown');
});

test('behind a trusted proxy each forwarded client gets its own limit', async () => {
  const s = await serve(createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', perMinute: 1, trustProxyHops: 1, ask: async () => answer }));
  try {
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '203.0.113.1' })).status, 200);
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '203.0.113.2' })).status, 200);
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '203.0.113.1' })).status, 429);
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '2001:db8:1:2::9' })).status, 200);
    assert.equal((await post(s.url, valid, { 'x-forwarded-for': '2001:db8:1:2::10' })).status, 429);
  } finally { s.close(); }
});

test('a day that is not built yet answers 503 warming up, builds once in the background, then answers', async () => {
  const g = gate();
  const fake = fakeCampus(async () => { await g.opened; return wednesday; });
  let asked = 0;
  const s = await serve(createApp({ campus: fake, keyConfigured: true, model: 'test', retryAfterSec: 3, ask: async () => { asked++; return answer; } }));
  try {
    const friday = { ...valid, weekday: 4 };
    const [r1, r2] = await Promise.all([post(s.url, friday), post(s.url, friday)]);
    assert.equal(r1.status, 503);
    assert.equal(r1.headers.get('retry-after'), '3');
    assert.deepEqual(await r1.json(), { error: 'Warming up the simulation for Friday, try again in a few seconds.', retryAfter: 3 });
    assert.equal(r2.status, 503);
    assert.equal((await post(s.url, friday)).status, 503);
    assert.equal(asked, 0);
    g.open();
    await fake.playback(4);
    assert.deepEqual(fake.builds, [4]);
    assert.equal((await post(s.url, friday)).status, 200);
    assert.equal(asked, 1);
  } finally { s.close(); }
});

test('a failed day build is dropped so the next request starts it again', async () => {
  let attempt = gate();
  let failing = true;
  const fake = fakeCampus(async () => { await attempt.opened; if (failing) throw new Error('no data'); return wednesday; });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  const s = await serve(createApp({ campus: fake, keyConfigured: true, model: 'test', ask: async () => answer }));
  try {
    assert.equal((await post(s.url, { ...valid, weekday: 6 })).status, 503);
    const first = fake.playback(6); // joins the build the request started
    attempt.open();
    await assert.rejects(first, /no data/);
    attempt = gate();
    failing = false;
    assert.equal((await post(s.url, { ...valid, weekday: 6 })).status, 503); // starts a new build
    attempt.open();
    await fake.playback(6);
    assert.equal((await post(s.url, { ...valid, weekday: 6 })).status, 200);
    assert.deepEqual(fake.builds, [6, 6]);
  } finally { s.close(); console.error = original; }
  assert.ok(errors.some((e) => /couldn't simulate Sunday/.test(e)));
});

test('a client that disconnects aborts the model run', async () => {
  let resolveAborted: (reason: unknown) => void;
  const aborted = new Promise((r) => { resolveAborted = r; });
  let started: () => void;
  const running = new Promise<void>((r) => { started = r; });
  const s = await serve(createApp({
    campus: fakeCampus(), keyConfigured: true, model: 'test', timeoutMs: 60_000,
    ask: (_q, _c, signal) => new Promise((_, reject) => {
      started();
      signal.addEventListener('abort', () => { resolveAborted(signal.reason); reject(signal.reason); });
    }),
  }));
  const original = console.error;
  console.error = () => {};
  try {
    const client = new AbortController();
    const req = fetch(`${s.url}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(valid), signal: client.signal }).catch(() => 'aborted');
    await running;
    client.abort();
    assert.equal(await req, 'aborted');
    const reason = await Promise.race([aborted, new Promise((r) => setTimeout(() => r('not aborted'), 2000))]);
    assert.notEqual(reason, 'not aborted');
    assert.notEqual((reason as Error).name, 'TimeoutError');
  } finally { s.close(); console.error = original; }
});

test('without a key the endpoint says so; model failures become 502 without leaking details', async () => {
  const noKey = await serve(createApp({ campus: fakeCampus(), keyConfigured: false, model: 'test', ask: async () => { throw new Error('unreachable'); } }));
  try {
    const r = await post(noKey.url, valid);
    assert.equal(r.status, 503);
    assert.equal((await (await fetch(`${noKey.url}/api/health`)).json()).keyConfigured, false);
  } finally { noKey.close(); }
  const original = console.error;
  console.error = () => {};
  const failing = await serve(createApp({ campus: fakeCampus(), keyConfigured: true, model: 'test', ask: async () => { throw new Error('secret upstream detail sk-123'); } }));
  try {
    const r = await post(failing.url, valid);
    assert.equal(r.status, 502);
    assert.doesNotMatch(await r.text(), /secret|sk-/);
  } finally { failing.close(); console.error = original; }
});

test('the map selects a place the answer talks about, not a ranking’s top place the answer never names', async () => {
  const at = (id: string) => campus.locations.find((l) => l.id === id)!;
  const ranked = { route: null, select: 'astronomy-library', points: [at('astronomy-library').position] };
  assert.deepEqual(alignShow('SEL is busier by capacity: 11%, compared with Mugar at 9%.', ranked, campus.locations),
    { route: null, select: 'sel', points: [at('sel').position] });
  // Named, or nothing mapped named, or a walk: left as is.
  assert.equal(alignShow('Papagiannis Astronomy Library is the quietest.', ranked, campus.locations), ranked);
  assert.equal(alignShow('No library qualifies.', ranked, campus.locations), ranked);
  const walk = { route: { path: [[0, 0], [1, 1]] as [number, number][], estimate: false }, select: null, points: [] };
  assert.equal(alignShow('CAS to Mugar is 7 minutes.', walk, campus.locations), walk);
  assert.equal(alignShow('anything', null, campus.locations), null);
  // Through the agent: a ranking followed by an answer about two other libraries.
  const model = new ScriptedModel([
    [functionCall('rank_places_by_crowd', { kind: 'library', weekday: null, time: null, near: null, order: null, openOnly: null, campus: null }, { callId: 'a' })],
    [assistantMessage('SEL is busier than Mugar right now.')],
  ]);
  const r = await askAgent('q', ctx, undefined, model);
  assert.equal(r.show?.select, 'sel');
  assert.ok(r.rows.length > 0);
});
