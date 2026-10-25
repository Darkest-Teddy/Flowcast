// Student organizations against a real PostgreSQL test database (TEST_DATABASE_URL), like dashboard.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { database, migrate } from '../src/dashboard/db';
import { importSources } from '../src/dashboard/import';
import { dashboardRouter } from '../src/dashboard/router';
import { DashboardAuthError, type VerifiedUser } from '../src/dashboard/auth';
import { clubCalendar, freeCounts, MIN_SHARED_MEMBERS } from '../src/dashboard/orgs';

test('free-time counts: a member is busy in any hour a class overlaps, and only counts come out', () => {
  const now = new Date('2026-10-26T12:00:00Z'); // Monday 8:00 AM Boston
  const cls = (start: string, end: string) => ({ id: start, title: 'Secret seminar', start, end, locationId: null, source: 'calendar' as const });
  const days = freeCounts([
    [cls('2026-10-26T14:00:00Z', '2026-10-26T15:15:00Z')], // 10:00–11:15 Boston
    [cls('2026-10-26T14:30:00Z', '2026-10-26T15:00:00Z')], // 10:30–11:00
    [],
  ], now);
  assert.equal(days.length, 7);
  assert.equal(days[0].date, '2026-10-26');
  assert.equal(days[0].weekday, 0);
  const at = (h: number) => days[0].hours.find((x) => x.hour === h)!.free;
  assert.equal(at(9), 3);
  assert.equal(at(10), 1);
  assert.equal(at(11), 2); // 11:00–11:15 still overlaps the first member's class
  assert.equal(at(12), 3);
  assert.ok(!JSON.stringify(days).includes('Secret'));
});

test('a club calendar escapes text and marks cancelled meetings', () => {
  const ics = clubCalendar('Debate; Society', [{ uid: 'meeting:1', title: 'Practice, round 1', start: '2026-10-28T23:00:00.000Z', end: '2026-10-29T01:00:00.000Z', location: 'Room 211, CAS', cancelled: true }], new Date('2026-10-25T00:00:00Z'));
  assert.match(ics, /X-WR-CALNAME:Debate\\; Society \(Flowcast\)/);
  assert.match(ics, /SUMMARY:Practice\\, round 1/);
  assert.match(ics, /DTSTART:20261028T230000Z/);
  assert.match(ics, /STATUS:CANCELLED/);
  assert.ok(ics.endsWith('END:VCALENDAR\r\n'));
});

test('organizations: officer requests and review, meetings, announcements, RSVPs, shared free time, conflicts, export and deletion',
  { skip: !process.env.TEST_DATABASE_URL }, async () => {
  assert.notEqual(process.env.TEST_DATABASE_URL, process.env.DATABASE_URL);
  const pool = database(process.env.TEST_DATABASE_URL)!;
  const users = new Map<string, VerifiedUser>();
  const verifyUser = async (token: string) => { const u = users.get(token); if (!u) throw new DashboardAuthError(401); return u; };
  const app = express(); app.use(express.json());
  app.use('/api/dashboard', dashboardRouter(pool, {
    verifyUser, admins: new Set(['admin@example.test']),
    conflicts: (date, near) => ({ date, weekday: 2, academic: { period: 'classes', label: 'FALL 2026 classes in session' }, venueEvents: [], near, venueWindow: null }),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (path: string, token = '', method = 'GET', body?: unknown) => fetch(`${origin}/api/dashboard${path}`, {
    method, headers: { Authorization: token ? `Bearer ${token}` : '', Origin: origin, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = async (r: Response) => { const body = await r.json(); return { status: r.status, body }; };
  const ids = Array.from({ length: 6 }, () => randomUUID());
  const [adminId, officerId, memberId, m2, m3, outsiderId] = ids;
  users.set('admin', { id: adminId, email: 'Admin@Example.test', name: 'Admin' });
  users.set('officer', { id: officerId, email: 'officer@example.test', name: 'Olive Officer' });
  users.set('member', { id: memberId, email: 'member@example.test', name: 'Mo Member' });
  users.set('m2', { id: m2, email: 'm2@example.test', name: 'M2' });
  users.set('m3', { id: m3, email: 'm3@example.test', name: 'M3' });
  users.set('outsider', { id: outsiderId, email: 'out@example.test', name: 'Out' });
  try {
    await migrate(pool); await migrate(pool);
    const rls = await pool.query(`SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1)`, [['dashboard_officers', 'dashboard_club_meetings', 'dashboard_rsvps', 'dashboard_announcements', 'dashboard_availability_shares', 'dashboard_officer_requests']]);
    assert.equal(rls.rows.length, 6);
    assert.ok(rls.rows.every((r) => r.relrowsecurity));
    await importSources(pool);
    const pub = (await json(await call('/public'))).body;
    const clubId: string = pub.clubs[0].id;
    const enc = encodeURIComponent(clubId);
    const place: string = pub.locations.find((l: { kind: string }) => l.kind === 'classroom').id;

    // Officer request: one pending per club, reviewed only by admins.
    const req = await json(await call('/officer-requests', 'officer', 'POST', { clubId, officerName: 'Olive Officer', note: 'President this year.' }));
    assert.equal(req.status, 201);
    assert.equal(req.body.status, 'pending');
    assert.equal(req.body.officerEmail, 'officer@example.test');
    assert.equal((await call('/officer-requests', 'officer', 'POST', { clubId, officerName: 'Olive', note: '' })).status, 409);
    assert.equal((await call('/officer-requests', 'officer', 'POST', { clubId: 'organizer:Nobody', officerName: 'Olive', note: '' })).status, 404);
    assert.equal((await call('/admin/officer-requests', 'officer')).status, 403);
    assert.equal((await call(`/admin/officer-requests/${req.body.id}`, 'officer', 'POST', { status: 'approved' })).status, 403);
    const listed = await json(await call('/admin/officer-requests', 'admin'));
    assert.ok(listed.body.some((a: { id: string }) => a.id === req.body.id));
    assert.deepEqual((await json(await call('/me', 'officer'))).body.session.roles, []);
    // Not an officer yet: can't post.
    const meeting = { title: 'Weekly meeting', locationId: place, room: '211', start: '2026-10-28T23:00:00Z', end: '2026-10-29T00:30:00Z', notes: '' };
    assert.equal((await call(`/clubs/${enc}/meetings`, 'officer', 'POST', meeting)).status, 403);
    const approved = await json(await call(`/admin/officer-requests/${req.body.id}`, 'admin', 'POST', { status: 'approved', note: 'Checked with SAO.' }));
    assert.equal(approved.body.status, 'approved');
    assert.equal(approved.body.reviewNote, 'Checked with SAO.');
    const me = (await json(await call('/me', 'officer'))).body.session;
    assert.deepEqual(me.roles, ['clubOfficer']);
    assert.equal(me.officerOfClubId, clubId);
    assert.deepEqual((await json(await call('/me', 'admin'))).body.session.roles, ['admin']);

    // Followers with club updates on hear about new meetings and changes; others don't.
    for (const token of ['member', 'outsider']) await call(`/following/${enc}`, token, 'PUT', { following: token === 'member' });
    await call('/preferences', 'member', 'PATCH', { clubEvents: true });
    assert.equal((await call(`/clubs/${enc}/meetings`, 'officer', 'POST', { ...meeting, locationId: 'nowhere' })).status, 400);
    assert.equal((await call(`/clubs/${enc}/meetings`, 'officer', 'POST', { ...meeting, end: meeting.start })).status, 400);
    const posted = await json(await call(`/clubs/${enc}/meetings`, 'officer', 'POST', meeting));
    assert.equal(posted.status, 201);
    assert.equal(posted.body.eventId, `meeting:${posted.body.id}`);
    assert.equal((await call(`/clubs/${enc}/meetings/${posted.body.id}`, 'member', 'PATCH', { room: '1' })).status, 403);
    await call(`/clubs/${enc}/meetings/${posted.body.id}`, 'officer', 'PATCH', { room: '313' });
    await call(`/clubs/${enc}/meetings/${posted.body.id}`, 'officer', 'PATCH', { notes: 'Bring laptops' }); // no announcement for notes
    await call(`/clubs/${enc}/meetings/${posted.body.id}`, 'officer', 'PATCH', { cancelled: true });
    assert.equal((await call(`/clubs/${enc}/announcements`, 'member', 'POST', { body: 'hi' })).status, 403);
    assert.equal((await call(`/clubs/${enc}/announcements`, 'officer', 'POST', { body: 'Bring a friend!' })).status, 201);
    const notes = (await json(await call('/notifications', 'member'))).body;
    assert.equal(notes.enabled, true);
    assert.deepEqual(notes.items.map((n: { body: string }) => n.body), [
      'Bring a friend!', 'Weekly meeting: cancelled.', 'Weekly meeting: now in Room 313, ' + pub.locations.find((l: { id: string }) => l.id === place).name + '.',
      notes.items[3].body,
    ]);
    assert.match(notes.items[3].body, /^New meeting: Weekly meeting, /);
    assert.ok(notes.items.every((n: { unread: boolean }) => n.unread));
    assert.equal((await call('/notifications/read', 'member', 'POST')).status, 204);
    assert.ok((await json(await call('/notifications', 'member'))).body.items.every((n: { unread: boolean }) => !n.unread));
    const outsider = (await json(await call('/notifications', 'outsider'))).body;
    assert.deepEqual([outsider.enabled, outsider.items], [false, []]);

    // Public: meetings (cancelled ones flagged) with RSVP counts, and the subscribable calendar.
    await call(`/clubs/${enc}/meetings/${posted.body.id}`, 'officer', 'PATCH', { cancelled: false });
    const rsvp = await json(await call(`/rsvps/${encodeURIComponent(posted.body.eventId)}`, 'member', 'PUT', { going: true }));
    assert.deepEqual(rsvp.body, { eventId: posted.body.eventId, going: true, count: 1 });
    await call(`/rsvps/${encodeURIComponent(posted.body.eventId)}`, 'm2', 'PUT', { going: true });
    await call(`/rsvps/${encodeURIComponent(posted.body.eventId)}`, 'm2', 'PUT', { going: false });
    const publicMeetings = (await json(await call('/club-meetings'))).body;
    assert.ok(publicMeetings.meetings.some((m: { id: string; room: string; cancelled: boolean }) => m.id === posted.body.id && m.room === '313' && !m.cancelled));
    assert.equal(publicMeetings.rsvps[posted.body.eventId], 1);
    assert.ok(!JSON.stringify(publicMeetings).includes(memberId));
    const ics = await call(`/clubs/${enc}/calendar.ics`);
    assert.equal(ics.status, 200);
    assert.match(ics.headers.get('content-type') ?? '', /text\/calendar/);
    assert.match(await ics.text(), /SUMMARY:Weekly meeting/);
    assert.deepEqual((await json(await call('/orgs/me', 'member'))).body.rsvps, [posted.body.eventId]);

    // Shared free time: counts only, and nothing below the minimum.
    const items = [{ id: 'c1', title: 'Private class', start: '2026-10-28T14:00:00Z', end: '2026-10-28T15:15:00Z', locationId: null, source: 'calendar' }];
    await pool.query("UPDATE dashboard_accounts SET schedule=$1::jsonb WHERE id = ANY($2::uuid[])", [JSON.stringify(items), [memberId, m2, m3]]);
    assert.equal((await call(`/clubs/${enc}/availability`, 'member')).status, 403);
    for (const token of ['member', 'm2']) assert.equal((await json(await call(`/clubs/${enc}/share-availability`, token, 'PUT', { share: true }))).body.share, true);
    const few = (await json(await call(`/clubs/${enc}/availability`, 'officer'))).body;
    assert.deepEqual([few.members, few.minimum, few.days], [2, MIN_SHARED_MEMBERS, null]);
    await call(`/clubs/${enc}/share-availability`, 'm3', 'PUT', { share: true });
    const enough = await call(`/clubs/${enc}/availability`, 'officer');
    const text = await enough.text();
    const body = JSON.parse(text);
    assert.equal(body.members, 3);
    assert.equal(body.days.length, 7);
    assert.ok(!text.includes('Private class') && !text.includes(memberId));
    assert.ok(body.days.every((d: { hours: { free: number }[] }) => d.hours.every((h) => h.free >= 0 && h.free <= 3)));

    // Conflicts: academic period and the officer's meeting on that date.
    const conflicts = (await json(await call('/conflicts?date=2026-10-28'))).body;
    assert.equal(conflicts.academic.period, 'classes');
    assert.ok(conflicts.clubEvents.some((e: { id: string; source: string }) => e.id === posted.body.eventId && e.source === 'officer'));
    assert.equal((await call('/conflicts?date=tomorrow')).status, 400);

    // Export includes organizations; deleting the account removes its rows and keeps the club's meetings.
    const exported = (await json(await call('/export', 'member'))).body.organizations;
    assert.equal(exported.rsvps.length, 1);
    assert.equal(exported.sharingFreeTimeWith[0].club_id, clubId);
    assert.equal((await call('/me', 'officer', 'DELETE')).status, 204);
    assert.equal((await call('/me', 'member', 'DELETE')).status, 204);
    for (const table of ['dashboard_officers', 'dashboard_rsvps', 'dashboard_availability_shares', 'dashboard_officer_requests']) {
      assert.equal((await pool.query(`SELECT 1 FROM ${table} WHERE account_id = ANY($1::uuid[])`, [[officerId, memberId]])).rowCount, 0, table);
    }
    const kept = await pool.query('SELECT created_by FROM dashboard_club_meetings WHERE id=$1', [posted.body.id]);
    assert.equal(kept.rows[0].created_by, null);
  } finally {
    await pool.query('DELETE FROM dashboard_announcements WHERE club_id IN (SELECT club_id FROM dashboard_club_meetings)');
    await pool.query('DELETE FROM dashboard_club_meetings');
    await pool.query('DELETE FROM dashboard_accounts WHERE id = ANY($1::uuid[])', [ids]);
    server.closeAllConnections(); server.close();
    await pool.end();
  }
});
