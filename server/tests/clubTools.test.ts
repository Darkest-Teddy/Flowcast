// Club tools against a real PostgreSQL test database (TEST_DATABASE_URL). Run database test files one
// at a time (--test-concurrency=1): they share the test database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { database, migrate } from '../src/dashboard/db';
import { importSources } from '../src/dashboard/import';
import { dashboardRouter } from '../src/dashboard/router';
import { DashboardAuthError, type VerifiedUser } from '../src/dashboard/auth';
import { bostonInstant, weeklyDates } from '../src/dashboard/orgs';
import { CHECKLIST_TEMPLATE, weatherFor } from '../src/dashboard/clubTools';

test('weekly dates and Boston wall times across the November clock change', () => {
  assert.deepEqual(weeklyDates('2026-10-28', '2026-11-11'), ['2026-10-28', '2026-11-04', '2026-11-11']);
  assert.equal(weeklyDates('2026-01-01', '2027-12-31').length, 26);
  assert.equal(bostonInstant('2026-10-28', '19:00')!.toISOString(), '2026-10-28T23:00:00.000Z'); // EDT
  assert.equal(bostonInstant('2026-11-04', '19:00')!.toISOString(), '2026-11-05T00:00:00.000Z'); // EST
  assert.equal(bostonInstant('2026-03-08', '02:30'), null); // skipped by the spring clock change
});

test('weather: forecast periods overlapping a meeting, or why there are none', () => {
  const p = (start: string, end: string, rain: number) => ({ name: 'x', start, end, temperatureF: 44, rainChance: rain, summary: 'Rain' });
  const periods = [p('2026-10-28T18:00:00-04:00', '2026-10-29T06:00:00-04:00', 70), p('2026-10-29T06:00:00-04:00', '2026-10-29T18:00:00-04:00', 10)];
  const hit = weatherFor(periods, '2026-10-28T19:00:00-04:00', '2026-10-28T20:30:00-04:00');
  assert.equal(hit.available, true);
  assert.deepEqual(hit.periods.map((x) => x.rainChance), [70]);
  assert.match(weatherFor(periods, '2026-11-20T19:00:00-05:00', '2026-11-20T20:00:00-05:00').reason!, /next seven days/);
  assert.match(weatherFor(null, '2026-10-28T19:00:00-04:00', '2026-10-28T20:00:00-04:00').reason!, /couldn’t be reached/);
});

test('club tools: series, perks, check-in and attendance, team, members, co-hosts, checklists, tags, stats, fair, venue events and weather',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const pool = database(process.env.TEST_DATABASE_URL)!;
  const users = new Map<string, VerifiedUser>();
  let clock = new Date('2026-10-25T16:00:00Z');
  const app = express(); app.use(express.json());
  app.use('/api/dashboard', dashboardRouter(pool, {
    verifyUser: async (token) => { const u = users.get(token); if (!u) throw new DashboardAuthError(401); return u; },
    admins: new Set(['admin@example.test']), now: () => clock,
    venues: () => ({ window: { from: '2026-09-01', to: '2027-04-30' }, venues: [{ id: 'agganis', name: 'Agganis Arena', locationId: 'agganis', position: [-71.1177, 42.3522], capacities: {}, defaultSetup: null }],
      events: [{ name: 'BU Hockey vs. BC', venueId: 'agganis', kind: 'bu-hockey', setup: null, start: '2026-10-30T19:00:00-04:00', end: null } as never] }),
    forecast: async () => [{ name: 'Wednesday Night', start: '2026-10-28T18:00:00-04:00', end: '2026-10-29T06:00:00-04:00', temperatureF: 41, rainChance: 80, summary: 'Rain Likely' }],
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, token = '', method = 'GET', body?: unknown) => {
    const r = await fetch(`${origin}/api/dashboard${path}`, { method, headers: { Authorization: token ? `Bearer ${token}` : '', Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    return { status: r.status, body: text ? JSON.parse(text) : undefined };
  };
  const ids = Array.from({ length: 5 }, () => randomUUID());
  const [officerId, coId, memberId, partnerId, adminId] = ids;
  users.set('officer', { id: officerId, email: 'lead@example.test', name: 'Lead' });
  users.set('co', { id: coId, email: 'Co@Example.test', name: 'Co Officer' });
  users.set('member', { id: memberId, email: 'member@example.test', name: 'Mo Member' });
  users.set('partner', { id: partnerId, email: 'partner@example.test', name: 'Partner' });
  users.set('admin', { id: adminId, email: 'admin@example.test', name: 'Admin' });
  try {
    await migrate(pool); await migrate(pool);
    await importSources(pool);
    const pub = (await call('/public')).body;
    const [clubA, clubB] = [pub.clubs[0].id, pub.clubs[1].id] as string[];
    const A = encodeURIComponent(clubA), B = encodeURIComponent(clubB);
    const place = pub.locations.find((l: { kind: string }) => l.kind === 'classroom').id;
    // Officers: lead runs A (approved by the admin), partner runs B.
    for (const [token, club] of [['officer', clubA], ['partner', clubB]] as const) {
      const req = await call('/officer-requests', token, 'POST', { clubId: club, officerName: token, note: '' });
      assert.equal((await call(`/admin/officer-requests/${req.body.id}`, 'admin', 'POST', { status: 'approved' })).status, 200);
    }
    for (const token of ['co', 'member']) await call('/me', token); // accounts exist (with email)
    await call(`/following/${A}`, 'member', 'PUT', { following: true });
    await call('/preferences', 'member', 'PATCH', { clubEvents: true });

    // A weekly series across the clock change, with free food; one announcement for the series.
    const meeting = { title: 'Weekly', locationId: place, room: '211', start: '2026-10-28T23:00:00Z', end: '2026-10-29T00:30:00Z', notes: '', perks: ['food'], perksNote: 'Pizza' };
    assert.equal((await call(`/clubs/${A}/meetings`, 'officer', 'POST', { ...meeting, repeatUntil: '2026-10-01' })).status, 400);
    assert.equal((await call(`/clubs/${A}/meetings`, 'officer', 'POST', { ...meeting, perks: ['caviar'] })).status, 400);
    const series = await call(`/clubs/${A}/meetings`, 'officer', 'POST', { ...meeting, repeatUntil: '2026-11-11' });
    assert.equal(series.status, 201);
    assert.deepEqual(series.body.series.map((m: { start: string }) => m.start), ['2026-10-28T23:00:00.000Z', '2026-11-05T00:00:00.000Z', '2026-11-12T00:00:00.000Z']);
    assert.ok(series.body.series.every((m: { seriesId: string; perks: string[] }) => m.seriesId === series.body.seriesId && m.perks[0] === 'food'));
    const notes = (await call('/notifications', 'member')).body.items;
    assert.equal(notes.length, 1);
    assert.match(notes[0].body, /^New weekly meeting: Weekly, Wednesdays at 7:00 PM, Oct 28 to Nov 11 in Room 211, .*\. Free food: Pizza\.$/);
    // Change the room for this and later meetings from the second one: two updated, one announcement.
    const second = series.body.series[1];
    const moved = await call(`/clubs/${A}/meetings/${second.id}`, 'officer', 'PATCH', { room: '313', scope: 'series' });
    assert.deepEqual(moved.body.series.map((m: { room: string }) => m.room), ['313', '313']);
    // New time for the series keeps each date.
    const retimed = await call(`/clubs/${A}/meetings/${second.id}`, 'officer', 'PATCH', { start: '2026-11-05T00:30:00Z', end: '2026-11-05T02:00:00Z', scope: 'series' });
    assert.deepEqual(retimed.body.series.map((m: { start: string }) => m.start), ['2026-11-05T00:30:00.000Z', '2026-11-12T00:30:00.000Z']);
    const after = (await call('/notifications', 'member')).body.items.map((n: { body: string }) => n.body);
    assert.match(after[1], /^Weekly: now in Room 313, .* \(2 meetings from Nov 4\)\.$/);
    assert.match(after[0], /^Weekly: now at 7:30 PM \(2 meetings from Nov 4\)\.$/);

    // Check-in: officers get a code; members check in during the window only, with the right code.
    const first = series.body.series[0];
    assert.equal((await call(`/clubs/${A}/meetings/${first.id}/checkin`, 'member')).status, 403);
    const code = (await call(`/clubs/${A}/meetings/${first.id}/checkin`, 'officer')).body;
    assert.equal(code.path, `/checkin/${first.id}?code=${code.code}`);
    assert.equal((await call(`/clubs/${A}/meetings/${first.id}/checkin`, 'officer')).body.code, code.code); // stable
    assert.equal((await call('/checkins', 'member', 'POST', { meetingId: first.id, code: code.code })).status, 409); // too early
    clock = new Date('2026-10-28T23:10:00Z');
    assert.equal((await call('/checkins', 'member', 'POST', { meetingId: first.id, code: 'wrong-code' })).status, 404);
    for (const t of ['member', 'co', 'member']) assert.equal((await call('/checkins', t, 'POST', { meetingId: first.id, code: code.code })).status, 201);
    clock = new Date('2026-10-29T02:00:00Z');
    assert.equal((await call('/checkins', 'partner', 'POST', { meetingId: first.id, code: code.code })).status, 409); // closed
    const attendance = (await call(`/clubs/${A}/attendance`, 'officer')).body;
    assert.equal(attendance.meetings[0].checkins, 2);
    assert.deepEqual([attendance.recentAverage, attendance.basedOn], [2, 1]);
    assert.deepEqual((await call('/clubs-me', 'member')).body.checkedIn, [`meeting:${first.id}`]);

    // Team: add a co-officer by sign-in email (any case), retitle, never remove the last officer.
    assert.equal((await call(`/clubs/${A}/officers`, 'officer', 'POST', { email: 'nobody@example.test', title: 'Treasurer' })).status, 404);
    assert.equal((await call(`/clubs/${A}/officers`, 'officer', 'POST', { email: 'co@example.test', title: 'Treasurer' })).status, 201);
    assert.deepEqual((await call('/me', 'co')).body.session.roles, ['clubOfficer']);
    assert.equal((await call(`/clubs/${A}/officers/${coId}`, 'co', 'PATCH', { title: 'Events chair' })).status, 200);
    const team = (await call(`/clubs/${A}/officers`, 'officer')).body;
    assert.deepEqual(team.map((o: { title: string }) => o.title).sort(), ['Events chair', 'Officer']);
    assert.equal((await call(`/clubs/${A}/officers/${coId}`, 'officer', 'DELETE')).status, 204);
    assert.equal((await call(`/clubs/${A}/officers/${officerId}`, 'officer', 'DELETE')).status, 409);

    // Members: counts, and names only of those who chose to show them.
    await call(`/clubs/${A}/share-availability`, 'member', 'PUT', { share: true });
    let members = (await call(`/clubs/${A}/members`, 'officer')).body;
    assert.deepEqual([members.followers, members.sharingFreeTime, members.visible], [1, 1, []]);
    await call(`/clubs/${A}/visibility`, 'member', 'PUT', { visible: true });
    members = (await call(`/clubs/${A}/members`, 'officer')).body;
    assert.deepEqual(members.visible, [{ name: 'Mo Member' }]);

    // Co-hosting: B accepts; B's followers hear about it; combined free time is allowed only then.
    const third = series.body.series[2];
    assert.equal((await call(`/clubs/${A}/availability?with=${B}`, 'officer')).status, 403);
    assert.equal((await call(`/clubs/${A}/meetings/${third.id}/cohosts`, 'officer', 'POST', { clubId: clubB })).status, 201);
    const invites = (await call(`/clubs/${B}/cohost-invites`, 'partner')).body;
    assert.equal(invites[0].invited, true);
    assert.equal((await call(`/cohost-invites/${invites[0].id}`, 'officer', 'POST', { accept: true })).status, 403);
    const accepted = await call(`/cohost-invites/${invites[0].id}`, 'partner', 'POST', { accept: true });
    assert.deepEqual(accepted.body.cohosts, [clubB]);
    assert.equal((await call(`/clubs/${A}/availability?with=${B}`, 'officer')).status, 200);
    assert.ok((await call('/club-meetings')).body.meetings.some((m: { id: string; cohosts: string[] }) => m.id === third.id && m.cohosts.includes(clubB)));

    // Checklist from the template, due dates counted back from the meeting.
    const tasks = (await call(`/clubs/${A}/meetings/${third.id}/tasks`, 'officer', 'POST', { template: true })).body;
    assert.equal(tasks.length, CHECKLIST_TEMPLATE.length);
    assert.deepEqual(tasks[0], { id: tasks[0].id, label: 'Book the room through BU', daysBefore: 21, due: '2026-10-21', done: false });
    assert.equal((await call(`/clubs/${A}/tasks/${tasks[0].id}`, 'officer', 'PATCH', { done: true })).status, 200);
    assert.equal((await call(`/clubs/${B}/meetings/${third.id}/tasks`, 'partner')).body[0].done, true); // co-hosts share it

    // Tags, stats, fair, venue events and weather.
    assert.equal((await call(`/clubs/${A}/profile`, 'officer', 'PUT', { tags: ['debate', 'nonsense'], blurb: '' })).status, 400);
    await call(`/clubs/${A}/profile`, 'officer', 'PUT', { tags: ['debate', 'social'], blurb: 'Weekly practice rounds.' });
    assert.deepEqual((await call('/club-profiles')).body[clubA], { tags: ['debate', 'social'], blurb: 'Weekly practice rounds.' });
    const stats = (await call(`/clubs/${A}/stats`, 'officer')).body;
    assert.equal(stats.followers, 1);
    assert.equal(stats.followerSeries.length, 60);
    assert.equal(stats.followerSeries.at(-1).followers, 1);
    assert.equal(stats.followerSeries[0].followers, 0); // before the follow
    assert.ok(stats.announcements.length >= 3);
    assert.equal((await call('/fairs', 'officer', 'POST', { name: 'Fair', date: '2026-10-30', locationId: null, starts: '11:00', ends: '15:00' })).status, 403);
    const fair = await call('/fairs', 'admin', 'POST', { name: 'Fall involvement fair', date: '2026-10-30', locationId: 'gsu', starts: '11:00', ends: '15:00' });
    assert.equal((await call(`/fairs/${fair.body.id}/tables/${A}`, 'officer', 'PUT', { table: 'B12', note: 'Free stickers' })).status, 200);
    assert.equal((await call(`/fairs/${fair.body.id}/tables/${A}`, 'member', 'PUT', { table: 'X', note: '' })).status, 403);
    const fairs = (await call('/fairs')).body;
    assert.deepEqual(fairs.find((f: { id: string }) => f.id === fair.body.id).tables, [{ clubId: clubA, table: 'B12', note: 'Free stickers' }]);
    const venue = (await call('/venue-events?from=2026-10-30&to=2026-10-30')).body;
    assert.deepEqual(venue.events.map((e: { title: string; venue: string }) => [e.title, e.venue]), [['BU Hockey vs. BC', 'Agganis Arena']]);
    const weather = (await call(`/weather?start=${encodeURIComponent('2026-10-28T23:00:00Z')}&end=${encodeURIComponent('2026-10-29T00:30:00Z')}`)).body;
    assert.deepEqual([weather.available, weather.periods[0].rainChance], [true, 80]);

    // Export and deletion.
    const exported = (await call('/export', 'member')).body.organizations;
    assert.equal(exported.checkIns.length, 1);
    assert.deepEqual(exported.nameVisibleTo, [clubA]);
    assert.equal((await call('/me', 'member', 'DELETE')).status, 204);
    for (const table of ['dashboard_checkins', 'dashboard_member_visibility']) assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE account_id=$1`, [memberId])).rowCount, 0, table);
  } finally {
    await pool.query('DELETE FROM dashboard_fairs');
    await pool.query('DELETE FROM dashboard_club_profiles');
    await pool.query('DELETE FROM dashboard_follow_events');
    await pool.query('DELETE FROM dashboard_announcements');
    await pool.query('DELETE FROM dashboard_club_meetings');
    await pool.query('DELETE FROM dashboard_accounts WHERE id = ANY($1::uuid[])', [ids]);
    server.closeAllConnections(); server.close();
    await pool.end();
  }
});
