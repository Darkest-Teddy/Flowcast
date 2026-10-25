import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import type { CampusEvent, CampusLocation } from '../src/data/types.ts';
import type { MeetingFilter } from '../src/lib/clubMeetings.ts';
// clubMeetings.ts imports the study finder without an extension: load through Vite, as departure.test.ts does.
const vite = await createServer({ configFile: false, root: fileURLToPath(new URL('..', import.meta.url)), server: { middlewareMode: true, watch: null } });
const { findMeetings, meetingIcs, meetingKind } = await vite.ssrLoadModule('/src/lib/clubMeetings.ts') as typeof import('../src/lib/clubMeetings.ts');
await vite.close();

const ev = (over: Partial<CampusEvent>): CampusEvent => ({ id: 'e', title: 'Meeting', locationId: 'cas', venue: 'CAS 211', start: '2026-10-28T19:00:00-04:00', end: '2026-10-28T21:00:00-04:00',
  organizer: 'Debate Society - 1124', clubId: 'organizer:debate', source: 'terrier-central', mapStatus: 'simulated', ...over });
const locations = [{ id: 'cas', name: 'College of Arts & Sciences' }, { id: 'warren', name: 'Warren Towers' }] as CampusLocation[];
const geo = { positions: {}, walkMeters: { 'cas>warren': 420 } };
const now = Date.parse('2026-10-25T16:00:00Z');
const filter = (over: Partial<MeetingFilter> = {}): MeetingFilter => ({ query: '', following: [], onlyFollowing: false, withinDays: 30, now, home: null, ...over });
const events = [
  ev({ id: 'debate', title: 'Debate practice' }),
  ev({ id: 'film', title: 'BU Film Society Weekly Meeting', organizer: 'Film Society - 1153', clubId: 'organizer:film', locationId: null, venue: null,
    start: '2026-09-09T19:00:00-04:00', end: '2026-12-02T21:00:00-05:00' }),
  ev({ id: 'past', title: 'Last week', start: '2026-10-20T19:00:00-04:00', end: '2026-10-20T20:00:00-04:00' }),
  ev({ id: 'later', title: 'Spring social', start: '2027-02-10T19:00:00-05:00', end: '2027-02-10T21:00:00-05:00' }),
  ev({ id: 'soon', title: 'Stage Troupe rehearsal', organizer: 'Stage Troupe - 1377', clubId: 'organizer:stage', start: '2026-10-26T18:00:00-04:00', end: null }),
];

test('a listing spanning several days is a series; a one-evening meeting is once', () => {
  assert.equal(meetingKind(events[0]), 'once');
  assert.equal(meetingKind(events[1]), 'series');
  assert.equal(meetingKind(ev({ end: null })), 'once');
  // Ending after midnight the same night is still one meeting.
  assert.equal(meetingKind(ev({ start: '2026-10-28T22:00:00-04:00', end: '2026-10-29T01:00:00-04:00' })), 'once');
});

test('upcoming meetings within the range, one-offs by time first, then series; past and far-off ones left out', () => {
  assert.deepEqual(findMeetings(events, locations, geo, filter()).map((m) => m.event.id), ['soon', 'debate', 'film']);
  assert.deepEqual(findMeetings(events, locations, geo, filter({ withinDays: null })).map((m) => m.event.id), ['soon', 'debate', 'later', 'film']);
  assert.deepEqual(findMeetings(events, locations, geo, filter({ withinDays: 2 })).map((m) => m.event.id), ['soon', 'film']);
});

test('search by club, meeting, room or building; followed clubs only; walks from home', () => {
  assert.deepEqual(findMeetings(events, locations, geo, filter({ query: 'debate' })).map((m) => m.event.id), ['debate']);
  assert.deepEqual(findMeetings(events, locations, geo, filter({ query: 'arts sciences' })).map((m) => m.event.id), ['soon', 'debate']);
  assert.deepEqual(findMeetings(events, locations, geo, filter({ onlyFollowing: true, following: ['organizer:film'] })).map((m) => m.event.id), ['film']);
  const withHome = findMeetings(events, locations, geo, filter({ home: 'warren' }));
  assert.equal(withHome.find((m) => m.event.id === 'debate')!.walk, 5);
  assert.equal(withHome.find((m) => m.event.id === 'film')!.walk, null);
  assert.equal(withHome.find((m) => m.event.id === 'debate')!.building, 'College of Arts & Sciences');
});

test('a calendar file only for single meetings, with escaped text', () => {
  const [debate] = findMeetings([ev({ id: 'x', title: 'Debate; practice, round 1' })], locations, geo, filter());
  const ics = meetingIcs(debate, now)!;
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /DTSTART:20261028T230000Z/);
  assert.match(ics, /DTEND:20261029T010000Z/);
  assert.match(ics, /SUMMARY:Debate\\; practice\\, round 1/);
  assert.match(ics, /LOCATION:CAS 211\\, College of Arts & Sciences/);
  const film = findMeetings(events, locations, geo, filter({ query: 'film' }))[0];
  assert.equal(meetingIcs(film, now), null);
});
