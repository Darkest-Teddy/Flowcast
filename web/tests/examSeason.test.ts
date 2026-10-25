import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { CampusLocation } from '../src/data/types.ts';

const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { examSeasonFor, examWindows, examLibraryAssumption, rankExamLibraries, roomsWithoutPublishedClass, formatExamDate } = await vite.ssrLoadModule('/src/lib/examSeason.ts');
await vite.close();

const bundle = JSON.parse(readFileSync(new URL('../../map-client/public/data/campus-data.json', import.meta.url), 'utf8'));
const behavior = JSON.parse(readFileSync(new URL('../../map-client/public/data/behavior.json', import.meta.url), 'utf8'));
const calendar = bundle.academicCalendar;

test('exam season follows the Registrar calendar: Study Period, finals, a 14-day hint, else off', () => {
  const [fall] = examWindows(calendar);
  assert.deepEqual([fall.start, fall.end], ['2026-12-11', '2026-12-18']);
  assert.equal(examSeasonFor('2026-10-25', calendar).mode, 'off');
  assert.equal(examSeasonFor('2026-11-26', calendar).mode, 'off');
  assert.deepEqual(examSeasonFor('2026-11-27', calendar), { mode: 'upcoming', window: fall, daysAway: 14 });
  assert.equal(examSeasonFor('2026-12-10', calendar).daysAway, 1);
  const study = examSeasonFor('2026-12-12', calendar);
  assert.equal(study.mode, 'active');
  assert.equal(study.phase, 'reading-period');
  assert.equal(study.label, 'Study Period');
  assert.equal(examSeasonFor('2026-12-14', calendar).phase, 'finals');
  assert.equal(examSeasonFor('2026-12-18', calendar).phase, 'finals');
  assert.equal(examSeasonFor('2026-12-19', calendar).mode, 'off');
  assert.equal(examSeasonFor('2026-12-14', undefined).mode, 'off');
  assert.equal(formatExamDate('2026-12-11'), 'Fri, Dec 11');
});

test('library assumptions are quoted from the conditions model, not invented', () => {
  const finals = examLibraryAssumption(behavior, 'finals');
  const finalsModifier = behavior.modifiers.find((m: { id: string }) => m.id === 'finals');
  assert.equal(finals.visits, finalsModifier.effects.find((e: { target: string }) => e.target === 'activity.@library.probability').value);
  assert.equal(finals.stay, finalsModifier.effects.find((e: { target: string }) => e.target === 'activity.@library.minutes').value);
  assert.ok(finals.visits > 1);
  assert.ok(examLibraryAssumption(behavior, 'reading-period').visits > 1);
  assert.deepEqual(examLibraryAssumption(null, 'finals'), { phase: 'finals', visits: null, stay: null, note: null, sourceUrl: null });
});

test('libraries rank open first, then the lowest projection over the next hours', () => {
  const locations: CampusLocation[] = [
    { id: 'mugar', name: 'Mugar', short: 'Mugar', kind: 'library', capacity: 800 },
    { id: 'pardee', name: 'Pardee', short: 'Pardee', kind: 'library', capacity: 250 },
    { id: 'sel', name: 'SEL', short: 'SEL', kind: 'library', capacity: 300 },
    { id: 'cas', name: 'CAS', short: 'CAS', kind: 'classroom', capacity: 900 },
  ];
  const day = '2026-12-14';
  const now = Date.parse('2026-12-14T19:00:00Z'); // 2 PM Boston
  const open = { hours: [{ date: day, windows: [[8 * 3600, 23 * 3600]] as [number, number][], sourceUrl: '', qualifier: null }] };
  const closed = { hours: [{ date: day, windows: [] as [number, number][], sourceUrl: '', qualifier: null }] };
  const forecasts = [
    { locationId: 'mugar', day, hours: [{ hour: 14, share: 0.5 }, { hour: 15, share: 0.7 }, { hour: 18, share: 0.95 }] },
    { locationId: 'pardee', day, hours: [{ hour: 14, share: 0.3 }, { hour: 16, share: 0.4 }] },
    { locationId: 'sel', day, hours: [{ hour: 14, share: 0.1 }] },
  ];
  const ranked = rankExamLibraries({ locations, forecasts, hours: { mugar: open, pardee: open, sel: closed }, geo: { positions: {}, walkMeters: {} }, from: '', now, day, hour: 14 });
  assert.deepEqual(ranked.map((r: { locationId: string }) => r.locationId), ['pardee', 'mugar', 'sel']);
  assert.deepEqual([ranked[1].now, ranked[1].peak, ranked[1].peakHour], [0.5, 0.7, 15]);
  assert.equal(ranked[2].open, false);
});

test('classrooms: published classes block rooms during the term; after classes end every room has none', () => {
  const locations: CampusLocation[] = Object.keys(bundle.locations).map((id) => ({ id, name: id, short: id, kind: id === 'warren' ? 'dorm' : 'classroom', capacity: 100 }));
  const args = { data: bundle, locations, geo: { positions: {}, walkMeters: {} }, from: '', hoursAhead: 3 };
  // Monday 2026-12-07, 10 AM: classes in session.
  const term = roomsWithoutPublishedClass({ ...args, date: '2026-12-07', weekday: 0, seconds: 10 * 3600 });
  const cas = term.find((b: { locationId: string }) => b.locationId === 'cas');
  assert.ok(cas.busyRooms > 0, 'CAS has classes on a Monday morning');
  for (const room of cas.rooms) assert.match(room.floor, /floor|Basement|Ground|room/);
  // Monday 2026-12-14 (finals): regular CAS meetings are past the last day of classes.
  const finals = roomsWithoutPublishedClass({ ...args, date: '2026-12-14', weekday: 0, seconds: 10 * 3600 });
  const casFinals = finals.find((b: { locationId: string }) => b.locationId === 'cas');
  assert.equal(casFinals.busyRooms, 0);
  assert.ok(casFinals.rooms.length > cas.rooms.length);
  // Only courses outside the Registrar calendar's schools (e.g. SSW evening classes) keep meeting.
  const later = casFinals.rooms.filter((r: { nextClassAt: number | null }) => r.nextClassAt !== null);
  assert.ok(later.length < casFinals.rooms.length / 4);
  assert.ok(later.every((r: { nextClassAt: number }) => r.nextClassAt >= 13 * 3600));
});
