// best_times (a place's quietest and busiest open hours across the week) and event_slots (rooms
// and evenings for a club event), on the real public bundle, plus GET /api/dashboard/event-slots.
// No day is simulated here: both read the event-impact build, the schedules and the hours.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { RunContext } from '@openai/agents';
import { loadCampusModel, type CampusModel } from '../src/campus';
import { createTools, mapOutput, newToolLog } from '../src/tools';
import { createApp } from '../src/app';
import { publicBestTimes } from '../src/dashboard/router';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { findEventSlots, metresBetween, VENUE_BUFFER_SEC, VENUE_RADIUS_M } from '../src/eventSlots';
import { datasetsForResult } from '../src/directory';
import { buildVisuals } from '../src/visuals';
import { openAt, walkBetween } from '../../map-client/src/insights';
import { bestTimesForPlace, weekBestTimes, weekFrom, type HourlyImpact } from '../../map-client/src/bestTimes';
import { WEEKDAYS } from '../../map-client/src/data/campusData';
import type { ServerAskContext } from '../src/facts';

let campus: CampusModel;
let ctx: ServerAskContext;
before(() => {
  campus = loadCampusModel({});
  ctx = {
    locations: campus.locations, walkRoutes: campus.walkRoutes, meetings: campus.meetings, occupancyAt: () => [],
    time: 12.5 * 3600, weekday: 2, campus: 'charles-river', data: campus.facts.data, facts: campus.facts,
  };
});

async function call(name: string, args: object, c: ServerAskContext = ctx) {
  const log = newToolLog();
  const t = createTools(c, log).find((x) => x.name === name)!;
  assert.ok(t, name);
  const out = await t.invoke(new RunContext(), JSON.stringify(args));
  return { out: (typeof out === 'string' ? (() => { try { return JSON.parse(out); } catch { return { error: out }; } })() : out) as any, log, map: mapOutput(log) };
}

const clockHour = (text: string) => {
  const m = text.match(/^(\d{1,2}):00 (AM|PM)$/)!;
  return (Number(m[1]) % 12) + (m[2] === 'PM' ? 12 : 0);
};
const weekdayOf = (day: string) => WEEKDAYS.indexOf(day as (typeof WEEKDAYS)[number]);

// ---------------------------------------------------------------- best_times core

const impact: HourlyImpact = {
  baseline: { '0': { gym: [0, 0, 0, 0, 0, 0, 0, 5, 20, 40, 60, 80, 90, 70, 50, 30, 10, 0, 0, 0, 0, 0, 0, 0] }, '1': { gym: Array(24).fill(10) } },
  dates: { '2026-10-27': { occupancy: { gym: Array.from({ length: 24 }, (_, h) => (h === 12 ? 2 : 50)) } } },
};
const days = [{ date: '2026-10-26', weekday: 0 }, { date: '2026-10-27', weekday: 1 }, { date: '2026-10-28', weekday: 2 }];

test('best times rank only whole open hours, skip unmodeled hours, and use dated figures with events', () => {
  // Monday open 7:30 AM–2 PM (7 AM is only half open); Tuesday 9 AM–5 PM; Wednesday hours unknown.
  const open = (day: { weekday: number }, s: number) => (day.weekday === 2 ? null : day.weekday === 0 ? s >= 7.5 * 3600 && s < 14 * 3600 : s >= 9 * 3600 && s < 17 * 3600);
  const r = bestTimesForPlace({ impact, placeId: 'gym', capacity: 100, days, open });
  assert.equal(r.measure, 'share');
  const monday = r.hours.filter((h) => h.weekday === 0).map((h) => h.hour);
  assert.deepEqual(monday, [8, 9, 10, 11, 12, 13]); // 7 AM is half closed: never ranked as quiet
  assert.ok(r.hours.every((h) => h.students > 0));
  // Tuesday uses the dated figures (simulated events), whose noon dip is the week's quietest hour.
  assert.deepEqual(r.quietest[0], { date: '2026-10-27', weekday: 1, hour: 12, students: 2, share: 0.02, withEvents: true });
  assert.equal(r.busiest[0].hour, 12);
  assert.equal(r.busiest[0].weekday, 0);
  // At most one hour per day, and Wednesday (unknown hours) is listed, never ranked.
  assert.equal(new Set(r.quietest.map((h) => h.date)).size, r.quietest.length);
  assert.deepEqual(r.daysWithoutHours.map((d) => d.date), ['2026-10-28']);
  assert.equal(r.byDay.find((d) => d.weekday === 2)!.openHours, 0);
  // A window keeps the ranking inside it.
  const evening = bestTimesForPlace({ impact, placeId: 'gym', capacity: 100, days, open, fromHour: 13, toHour: 17 });
  assert.ok(evening.hours.every((h) => h.hour >= 13 && h.hour < 17));
  // Closed all window: listed as closed, not quiet.
  const late = bestTimesForPlace({ impact, placeId: 'gym', capacity: 100, days: days.slice(0, 1), open, fromHour: 18, toHour: 22 });
  assert.deepEqual(late.hours, []);
  assert.deepEqual(late.daysClosed.map((d) => d.date), ['2026-10-26']);
  // Without a comparable capacity it ranks by students.
  assert.equal(bestTimesForPlace({ impact, placeId: 'gym', capacity: null, days, open }).quietest[0].share, null);
  // weekBestTimes leaves out places with nothing ranked.
  const week = weekBestTimes({ ...impact, referenceWeekStart: '2026-10-26' }, [{ id: 'gym', capacity: 100 }, { id: 'nowhere', capacity: 50 }], days, (_id, d, s) => open(d, s));
  assert.deepEqual(week.map((w) => w.locationId), ['gym']);
  assert.match(week[0].basis, /Model-derived/);
});

test('weekFrom gives consecutive dates with Monday-based weekdays', () => {
  assert.deepEqual(weekFrom('2026-10-25', 3), [{ date: '2026-10-25', weekday: 6 }, { date: '2026-10-26', weekday: 0 }, { date: '2026-10-27', weekday: 1 }]);
});

// ---------------------------------------------------------------- best_times tool

test('best_times: FitRec’s quietest and busiest open hours across the reference week, model-derived', async () => {
  const { out, map } = await call('best_times', { place: 'FitRec', days: null, from: null, to: null });
  assert.equal(out.label, 'model-derived');
  assert.match(out.week, /^reference week 2026-10-26 to 2026-11-01$/);
  assert.match(out.measure, /percent/);
  assert.ok(out.quietest.length >= 1 && out.busiest.length >= 1);
  assert.ok(out.quietest[0].percent <= out.busiest[0].percent);
  assert.equal(new Set(out.quietest.map((h: any) => h.day)).size, out.quietest.length);
  // Every ranked hour is open by published hours for the whole hour.
  for (const h of [...out.quietest, ...out.busiest]) {
    const w = weekdayOf(h.day), hour = clockHour(h.time);
    for (const s of [0, 1800, 3599]) assert.equal(openAt('fitrec', w, hour * 3600 + s, ctx.data!).open, true, `${h.day} ${h.time}`);
  }
  // The figure matches the event-impact build for that date (dated with events, else the weekday baseline).
  const ei = ctx.facts!.chat!.eventImpact!;
  const q = out.quietest[0];
  const counts = ei.dates[q.date]?.occupancy.fitrec ?? ei.baseline[String(weekdayOf(q.day))].fitrec;
  const capacity = ctx.locations.find((l) => l.id === 'fitrec')!.capacity;
  assert.equal(q.percent, Math.round((counts[clockHour(q.time)] / capacity) * 100));
  assert.equal(map.show?.select, 'fitrec');
  assert.match(out.method, /not live/);
});

test('best_times: a time window and chosen days, and places without published hours are not ranked', async () => {
  const { out } = await call('best_times', { place: 'Mugar', days: [0, 2], from: '18:00', to: '22:00' });
  assert.equal(out.window, '6:00 PM to 10:00 PM');
  assert.ok(out.byDay.every((d: any) => d.day === 'Monday' || d.day === 'Wednesday'));
  for (const h of [...out.quietest, ...out.busiest]) {
    const hour = clockHour(h.time);
    assert.ok(hour >= 18 && hour < 22, h.time);
  }
  const cas = (await call('best_times', { place: 'CAS', days: null, from: null, to: null })).out;
  assert.deepEqual(cas.quietest, []);
  assert.equal(cas.hoursStatus, 'unknown');
  assert.match(cas.note, /doesn’t publish opening hours/);
  assert.deepEqual(datasetsForResult('best_times', cas, () => 'classroom'), []);
  assert.match((await call('best_times', { place: 'Mugar', days: null, from: '22:00', to: '18:00' })).out.error, /end after/);
  assert.match((await call('best_times', { place: 'Mugar', days: null, from: '25:00', to: null })).out.error, /HH:MM/);
});

test('best_times: days whose hours aren’t in the data are named, not ranked', async () => {
  // A copy of the bundle where Mugar's hours cover Monday only.
  const data = structuredClone(ctx.data!);
  const monday = ctx.data!.referenceWeekStart;
  data.locations.mugar.hours = [{ date: monday, weekday: 0, windows: [[8 * 3600, 22 * 3600]], text: '8:00 AM–10:00 PM', qualifier: null } as any];
  const { out } = await call('best_times', { place: 'Mugar', days: null, from: null, to: null }, { ...ctx, data });
  assert.ok(out.quietest.every((h: any) => h.day === 'Monday'));
  assert.equal(out.hoursNotInData.days, 'Tuesday to Sunday');
  assert.deepEqual(datasetsForResult('best_times', out, () => 'library'), ['eventImpact', 'libraryHours']);
  const visual = buildVisuals([{ tool: 'best_times', value: out }]);
  assert.equal(visual[0].kind, 'table');
  assert.equal(visual[0].source, 'simulated');
});

// ---------------------------------------------------------------- event_slots

test('event_slots: rooms with enough seats, no class, no nearby venue event, with the caveat', async () => {
  const { out, map } = await call('event_slots', { headcount: 40, days: null, from: null, to: null, durationMinutes: null, campus: null });
  assert.equal(out.window, '6:00 PM to 10:00 PM');
  assert.equal(out.durationMinutes, 90);
  assert.ok(out.slots.length >= 1 && out.slots.length <= 5);
  assert.match(out.caveat, /may still be in use or locked/);
  assert.match(out.caveat, /Nothing is booked/);
  assert.equal(map.show?.select !== null, true);
  // The core result behind it: check each slot against the schedules.
  const chat = ctx.facts!.chat!;
  const r = findEventSlots({ headcount: 40, days: null, fromSec: 18 * 3600, toSec: 22 * 3600, durationMin: 90, campus: 'charles-river', limit: 20, maxPerDay: 3 }, {
    locations: ctx.locations, meetings: ctx.meetings, referenceWeekStart: ctx.data!.referenceWeekStart, impact: chat.eventImpact, venues: chat.venues, parking: chat.parking,
  });
  assert.ok(r.slots.length >= 5);
  assert.equal(r.counts.checked, r.counts.withClass + r.counts.withListedEvent + r.counts.nearVenueEvent + r.counts.free);
  const venues = new Map(chat.venues!.venues.map((v) => [v.id, v]));
  for (const s of r.slots) {
    assert.ok(s.seats >= 40);
    assert.equal(s.campus, 'charles-river');
    assert.ok(s.startSec >= 18 * 3600 && s.endSec <= 22 * 3600 && s.endSec - s.startSec === 5400);
    const t0 = s.weekday * 86400 + s.startSec, t1 = s.weekday * 86400 + s.endSec;
    const classes = ctx.meetings.filter((m) => m.locationId === s.locationId && m.meeting.roomCode === s.room).flatMap((m) => m.meeting.intervals);
    assert.ok(classes.length > 0, 'rooms come from the published class schedule');
    assert.ok(classes.every((iv) => !(iv.startSec < t1 && iv.endSec > t0)), `${s.building} ${s.room} has a class`);
    const loc = ctx.locations.find((l) => l.id === s.locationId)!;
    for (const e of chat.venues!.events) {
      const v = venues.get(e.venueId);
      if (!v?.position || metresBetween(loc.position, v.position) > VENUE_RADIUS_M) continue;
      const start = new Date(e.start).getTime(), end = e.end ? new Date(e.end).getTime() : start + 3 * 3600_000;
      const slotStart = new Date(`${s.date}T00:00:00-04:00`).getTime() + s.startSec * 1000;
      const slotEnd = slotStart + 5400_000;
      assert.ok(!(start - VENUE_BUFFER_SEC * 1000 < slotEnd && end + VENUE_BUFFER_SEC * 1000 > slotStart), `${e.name} overlaps ${s.date} ${s.start}`);
    }
  }
  // Variety: one room per building per day, at most three slots a day.
  const perDay = new Map<string, number>();
  for (const s of r.slots) perDay.set(s.date, (perDay.get(s.date) ?? 0) + 1);
  assert.ok([...perDay.values()].every((n) => n <= 3));
  assert.equal(new Set(r.slots.map((s) => `${s.locationId}|${s.date}`)).size, r.slots.length);
  // Ranked by nearby modeled crowding first.
  const steps = r.slots.map((s) => Math.round((s.nearbyCrowd?.percent ?? 0) / 5));
  assert.ok(steps.every((x, i) => i === 0 || steps[i - 1] <= x + 1), steps.join(','));
});

test('event_slots: the Friday hockey game rules evenings near Agganis out, and too large a headcount says so', async () => {
  const friday = (await call('event_slots', { headcount: 30, days: [4], from: '18:00', to: '22:00', durationMinutes: 90, campus: null })).out;
  assert.ok(friday.checked.nearVenueEvent > 0);
  assert.ok(friday.ruledOutByVenueEvents.some((e: string) => /Agganis|Walter Brown|Nickerson/.test(e)));
  const agganis = ctx.locations.find((l) => l.id === 'agganis')!;
  for (const s of friday.slots) {
    const loc = ctx.locations.find((l) => l.name.startsWith(s.building.replace('…', '')))!;
    assert.ok(metresBetween(loc.position, agganis.position) > VENUE_RADIUS_M, s.building);
  }
  const huge = (await call('event_slots', { headcount: 1500, days: null, from: null, to: null, durationMinutes: null, campus: null })).out;
  assert.deepEqual(huge.slots, []);
  assert.match(huge.note, /No room with published seats holds 1500; the largest is/);
  assert.match((await call('event_slots', { headcount: 20, days: null, from: '20:00', to: '21:00', durationMinutes: 90, campus: null })).out.error, /doesn’t fit/);
  const visual = buildVisuals([{ tool: 'event_slots', value: friday }]);
  assert.equal(visual[0]?.kind, 'table');
  assert.equal(visual[0]?.source, 'mixed');
});

test('the dashboard’s best times this week: places with published hours, open hours only, from today', () => {
  const impact = JSON.parse(readFileSync(fileURLToPath(new URL('../../map-client/public/data/event-impact.json', import.meta.url)), 'utf8'));
  const weeks = publicBestTimes(impact, ctx.data!, '2026-10-25');
  assert.ok(weeks.length >= 3);
  for (const w of weeks) {
    assert.equal(ctx.data!.locations[w.locationId].hoursStatus, 'published', w.locationId);
    assert.deepEqual(w.byDay.map((d) => d.date), weekFrom('2026-10-25').map((d) => d.date));
    for (const h of [...w.quietest, ...w.busiest]) assert.ok(h.students > 0);
  }
  const fitrec = weeks.find((w) => w.locationId === 'fitrec')!;
  assert.ok(fitrec.quietest.length >= 1);
  // Sunday the 25th reads Sunday hours from its own week (Monday the 19th); its quietest hour is open then.
  const sunday = fitrec.byDay[0];
  const shifted = { ...ctx.data!, referenceWeekStart: '2026-10-19' };
  if (sunday.quietest) assert.equal(openAt('fitrec', 6, sunday.quietest.hour * 3600, shifted).open, true);
});

test('event slots for a club: rooms nearest the members\' places first, with their average and longest walk', () => {
  const chat = ctx.facts!.chat!;
  const byId = new Map(ctx.locations.map((l) => [l.id, l]));
  const walkMinutes = (a: string, b: string) => walkBetween(byId.get(a)!, byId.get(b)!, ctx.walkRoutes).minutes;
  const src = { locations: ctx.locations, meetings: ctx.meetings, referenceWeekStart: ctx.data!.referenceWeekStart, impact: chat.eventImpact, venues: chat.venues, parking: chat.parking, walkMinutes };
  const query = { headcount: 25, days: null, fromSec: 18 * 3600, toSec: 22 * 3600, durationMin: 60, campus: 'charles-river', limit: 12, maxPerDay: 3 };
  const near = ['warren', 'myles', 'unknown-place'];
  const r = findEventSlots({ ...query, near }, src);
  assert.deepEqual(r.near, ['Warren Towers', 'Myles Standish Hall'].map((n) => ctx.locations.find((l) => l.name.startsWith(n.split(' ')[0]))!.name));
  assert.ok(r.slots.length >= 5);
  for (const s of r.slots) {
    assert.ok(s.walk, `${s.building} has a walk`);
    assert.ok(s.walk!.average <= s.walk!.longest);
    const each = ['warren', 'myles'].map((id) => walkMinutes(id, s.locationId)!);
    assert.equal(s.walk!.longest, Math.max(...each));
    assert.ok(s.seats >= 25);
  }
  // Ranked by average walk (2-minute steps) before anything else.
  const steps = r.slots.map((s) => Math.round(s.walk!.average / 2));
  assert.ok(steps.every((x, i) => i === 0 || steps[i - 1] <= x), steps.join(','));
  // Without near: no walks, and the crowding order as before.
  const plain = findEventSlots(query, src);
  assert.ok(plain.slots.every((s) => s.walk === null));
  assert.deepEqual(plain.near, []);
  // The nearest slot is at least as close on average as the plain ranking's first one.
  const plainFirst = ['warren', 'myles'].map((id) => walkMinutes(id, plain.slots[0].locationId)!);
  assert.ok(r.slots[0].walk!.average <= Math.round(plainFirst.reduce((a, b) => a + b, 0) / plainFirst.length));
});

// ---------------------------------------------------------------- GET /api/dashboard/event-slots

test('GET /api/dashboard/event-slots: public, no database, validated, never books', async () => {
  const app = createApp({ campus, keyConfigured: false, model: 'test', ask: async () => { throw new Error('unused'); } });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/dashboard/event-slots`;
  try {
    const ok = await fetch(`${url}?headcount=40&days=0,1,2&from=18:00&to=22:00&duration=90&limit=8`);
    assert.equal(ok.status, 200);
    const body = await ok.json();
    assert.ok(body.slots.length >= 1 && body.slots.length <= 8);
    assert.ok(body.slots.every((s: any) => s.weekday <= 2 && s.seats >= 40));
    assert.match(body.caveat, /may still be in use or locked/);
    assert.equal(body.label, 'published schedule and model-derived');
    const near = await (await fetch(`${url}?headcount=20&near=warren,claflin&duration=60`)).json();
    assert.ok(near.slots.length >= 1 && near.slots.every((s: any) => s.walk && s.walk.average <= s.walk.longest));
    assert.equal(near.near.length, 2);
    for (const bad of ['', '?headcount=0', '?headcount=40&days=7', '?headcount=40&from=6pm', '?headcount=40&from=21:00&to=22:00', '?headcount=40&book=1', '?headcount=40&near=Warren%20Towers', `?headcount=40&near=${Array(13).fill('warren').join(',')}`]) {
      assert.equal((await fetch(`${url}${bad}`)).status, 400, bad);
    }
    assert.equal((await fetch(url, { method: 'POST', headers: { origin: 'http://elsewhere.example' } })).status, 403);
  } finally {
    server.close();
  }
});
