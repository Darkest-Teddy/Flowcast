import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discoverClubs, errorText, officerMeetingEvents, perkSummary, rankTablingSpots, turnoutPreview } from '../src/lib/orgs.ts';
import type { OfficerMeeting } from '../src/data/types.ts';

test('error text drops the request prefix', () => {
  assert.equal(errorText(new Error('Dashboard request failed (403): Only verified officers of this club can do that.')), 'Only verified officers of this club can do that.');
  assert.equal(errorText('nope', 'Fallback'), 'Fallback');
});

test('officer meetings join the list as events, cancelled ones left out', () => {
  const m = (over: Partial<OfficerMeeting>): OfficerMeeting => ({ id: '1', eventId: 'meeting:1', clubId: 'c', title: 'Weekly', locationId: 'cas', room: '211',
    start: '2026-10-28T23:00:00.000Z', end: '2026-10-29T00:30:00.000Z', notes: '', cancelled: false, updatedAt: '', ...over });
  const events = officerMeetingEvents([m({}), m({ id: '2', eventId: 'meeting:2', cancelled: true }), m({ id: '3', eventId: 'meeting:3', room: '' })], new Map([['c', 'Debate Society']]));
  assert.deepEqual(events.map((e) => [e.id, e.venue, e.organizer, e.clubId, e.source]), [['meeting:1', 'Room 211', 'Debate Society', 'c', 'manual'], ['meeting:3', null, 'Debate Society', 'c', 'manual']]);
});

test('turnout preview adds attendees by overlap on top of the modeled crowd', () => {
  const impact = { places: [{ id: 'gsu', name: 'GSU', short: 'GSU', kind: 'dining' as const, campus: 'charles-river', capacity: 600 }, { id: 'none', name: 'X', short: 'X', kind: 'venue' as const, campus: 'charles-river', capacity: 0 }],
    baseline: { '3': { gsu: Array.from({ length: 24 }, (_, h) => (h === 19 ? 300 : h === 20 ? 200 : 0)) } } };
  const p = turnoutPreview(impact, 'gsu', 3, 19.5 * 3600, 90, 80)!;
  assert.deepEqual([p[19].normal, p[19].withEvent], [300, 340]); // half an hour of 19:00–20:00
  assert.deepEqual([p[20].normal, p[20].withEvent], [200, 280]);
  assert.equal(p[21].withEvent, 0);
  assert.equal(p[19].capacity, 600);
  assert.equal(turnoutPreview(impact, 'none', 3, 0, 60, 10), null);
  assert.equal(turnoutPreview(impact, 'gsu', 5, 19 * 3600, 60, 10)![19].withEvent, 10); // no baseline that day: attendees only
});

test('tabling spots rank by people walking in during the window', () => {
  const hours = (peak: number, n: number) => Array.from({ length: 24 }, (_, h) => (h === peak ? n : 1));
  const foot = { measure: 'm', spots: [{ id: 'marsh', name: 'Marsh Plaza', kind: 'plaza', position: [0, 0] as [number, number], radiusMetres: 20 },
    { id: 'around-gsu', name: 'Around GSU', kind: 'building-front', position: [0, 0] as [number, number], radiusMetres: 30, locationId: 'gsu' }],
    baseline: { '1': { marsh: hours(12, 400), 'around-gsu': hours(17, 900) } } };
  const noon = rankTablingSpots(foot, 1, 11, 14);
  assert.deepEqual(noon.map((s) => [s.id, s.total, s.peakHour]), [['marsh', 402, 12], ['around-gsu', 3, 11]]);
  assert.equal(noon[1].locationId, 'gsu');
  assert.deepEqual(rankTablingSpots(foot, 1, 16, 19).map((s) => s.id), ['around-gsu', 'marsh']);
  assert.deepEqual(rankTablingSpots(foot, 6, 9, 17).map((s) => s.total), [0, 0]);
});

test('club discovery: next meeting, shortest walk from home, first meeting clear of classes', () => {
  const now = Date.parse('2026-10-26T12:00:00Z');
  const ev = (id: string, clubId: string, start: string, end: string, locationId: string | null) => ({ id, title: id, locationId, venue: null, start, end, organizer: null, clubId, source: 'terrier-central' as const, mapStatus: 'simulated' as const });
  const events = [
    ev('a1', 'a', '2026-10-27T22:00:00Z', '2026-10-27T23:00:00Z', 'cas'), // overlaps a class
    ev('a2', 'a', '2026-10-29T22:00:00Z', '2026-10-29T23:00:00Z', 'gsu'),
    ev('b1', 'b', '2026-12-30T22:00:00Z', '2026-12-30T23:00:00Z', 'cas'), // past the horizon
    ev('c-series', 'c', '2026-09-01T22:00:00Z', '2026-12-01T23:00:00Z', 'cas'), // a series, not a single meeting
  ];
  const walks: Record<string, number> = { cas: 9, gsu: 4 };
  const d = discoverClubs(events, [{ start: '2026-10-27T21:30:00Z', end: '2026-10-27T22:45:00Z' }], now, (id) => walks[id] ?? null);
  assert.deepEqual([...d.keys()], ['a']);
  assert.deepEqual([d.get('a')!.next!.id, d.get('a')!.walk, d.get('a')!.freeFit!.id], ['a1', 4, 'a2']);
});

test('perk summary for cards', () => {
  assert.equal(perkSummary({ perks: ['food', 'swag'], perksNote: 'Pizza' }), 'Free food · Free swag · Pizza');
  assert.equal(perkSummary({}), '');
});
