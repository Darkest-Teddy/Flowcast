// Student organizations: officer verification, officer-posted meetings, RSVPs, announcements to
// followers, members' shared free time (counts only) and a date conflict check.
//
// Who can do what:
// - Admins are the verified emails in ADMIN_EMAILS. They approve or reject officer requests.
// - Officers of a club (approved requests) post and change its meetings, post announcements and see
//   how many members who chose to share are free each hour. Never anyone's schedule or name.
// - Signed-in students RSVP, follow clubs, share their free time with a club, and read announcements
//   from followed clubs when club updates are on in their notification settings.
// Every personal row belongs to an account and is deleted with it (DELETE /me).
import { Router, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { VerifiedUser } from './auth';
import type { ScheduleImportState } from '../../../web/src/data/types';

/** Members' free time is withheld until at least this many have shared, so no one can be singled out. */
export const MIN_SHARED_MEMBERS = 3;
/** Free-time counts cover these Boston hours, each [h, h+1). */
export const AVAILABILITY_HOURS = { from: 8, to: 22 };
/** Announcements older than this are not shown as notifications. */
const NOTIFICATION_DAYS = 30;

export const ORG_TABLES = `
  CREATE TABLE IF NOT EXISTS dashboard_officer_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id uuid NOT NULL REFERENCES dashboard_accounts(id) ON DELETE CASCADE,
    club_id text NOT NULL, officer_name text NOT NULL, officer_email text NOT NULL, note text NOT NULL DEFAULT '',
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
    review_note text, reviewed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE UNIQUE INDEX IF NOT EXISTS dashboard_officer_requests_open ON dashboard_officer_requests(account_id, club_id) WHERE status = 'pending';
  CREATE TABLE IF NOT EXISTS dashboard_officers (
    account_id uuid NOT NULL REFERENCES dashboard_accounts(id) ON DELETE CASCADE,
    club_id text NOT NULL, granted_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, club_id)
  );
  CREATE TABLE IF NOT EXISTS dashboard_club_meetings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id text NOT NULL, title text NOT NULL, location_id text, room text NOT NULL DEFAULT '',
    starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL CHECK (ends_at > starts_at),
    notes text NOT NULL DEFAULT '', cancelled boolean NOT NULL DEFAULT false,
    created_by uuid REFERENCES dashboard_accounts(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS dashboard_club_meetings_start ON dashboard_club_meetings(starts_at);
  CREATE TABLE IF NOT EXISTS dashboard_rsvps (
    event_id text NOT NULL, account_id uuid NOT NULL REFERENCES dashboard_accounts(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (event_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS dashboard_announcements (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    club_id text NOT NULL, body text NOT NULL, meeting_id uuid REFERENCES dashboard_club_meetings(id) ON DELETE SET NULL,
    created_by uuid REFERENCES dashboard_accounts(id) ON DELETE SET NULL, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS dashboard_announcements_club ON dashboard_announcements(club_id, created_at);
  CREATE TABLE IF NOT EXISTS dashboard_availability_shares (
    account_id uuid NOT NULL REFERENCES dashboard_accounts(id) ON DELETE CASCADE,
    club_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (account_id, club_id)
  );
  ALTER TABLE dashboard_accounts ADD COLUMN IF NOT EXISTS notifications_read_at timestamptz;
`;
export const ORG_TABLE_NAMES = ['dashboard_officer_requests', 'dashboard_officers', 'dashboard_club_meetings', 'dashboard_rsvps', 'dashboard_announcements', 'dashboard_availability_shares'];

export class OrgError extends Error {
  constructor(public readonly status: 400 | 403 | 404 | 409, message: string) { super(message); }
}

/** Admins: the verified emails in ADMIN_EMAILS (comma-separated, case-insensitive). */
export function adminEmails(env: NodeJS.ProcessEnv = process.env): Set<string> {
  return new Set((env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
}

export interface OrgDeps {
  pool: pg.Pool;
  /** Ensures the account row exists and returns it. */
  account: (res: Response) => Promise<{ id: string; profile: { name: string }; preferences: { clubEvents?: boolean }; following: string[] }>;
  /** Published clubs (Terrier Central organizers) by id. */
  clubs: () => Promise<Map<string, { id: string; name: string }>>;
  /** Mapped campus places by id. */
  places: () => Promise<Map<string, { id: string; name: string }>>;
  admins?: Set<string>;
  now?: () => Date;
}

const uuid = z.string().uuid();
const iso = z.string().datetime({ offset: true });
const meetingBody = z.object({
  title: z.string().trim().min(1).max(120),
  locationId: z.string().min(1).max(160).nullable(),
  room: z.string().trim().max(40),
  start: iso, end: iso,
  notes: z.string().trim().max(500),
}).strict();
const meetingPatch = meetingBody.partial().extend({ cancelled: z.boolean() }).partial().strict();

export interface OfficerMeeting {
  id: string; eventId: string; clubId: string; title: string; locationId: string | null; room: string;
  start: string; end: string; notes: string; cancelled: boolean; updatedAt: string;
}
const meetingRow = (r: Record<string, any>): OfficerMeeting => ({
  id: r.id, eventId: `meeting:${r.id}`, clubId: r.club_id, title: r.title, locationId: r.location_id, room: r.room,
  start: new Date(r.starts_at).toISOString(), end: new Date(r.ends_at).toISOString(), notes: r.notes, cancelled: r.cancelled,
  updatedAt: new Date(r.updated_at).toISOString(),
});

const bostonParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
const WEEKDAY_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
/** The Boston date, weekday (0 = Monday) and seconds since midnight of an instant. */
export function bostonClock(at: Date) {
  const p = Object.fromEntries(bostonParts.formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, weekday: WEEKDAY_SHORT.indexOf(p.weekday), seconds: Number(p.hour) * 3600 + Number(p.minute) * 60 };
}
const timeFormat = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/**
 * How many sharing members are free in each hour of the next seven Boston days. A member is busy in an
 * hour when an imported class overlaps it. Only counts leave this function.
 */
export function freeCounts(schedules: ScheduleImportState['items'][], now: Date, days = 7) {
  const start = bostonClock(now).date;
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date(`${start}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
  // Each member's busy Boston date-hours.
  const busy = schedules.map((items) => {
    const set = new Set<string>();
    for (const item of items) {
      const s = Date.parse(item.start), e = Date.parse(item.end);
      if (!Number.isFinite(s) || !(e > s)) continue;
      for (let t = s - (s % 3_600_000); t < e; t += 3_600_000) {
        const c = bostonClock(new Date(t));
        set.add(`${c.date}|${Math.floor(c.seconds / 3600)}`);
      }
    }
    return set;
  });
  return dates.map((date) => ({
    date,
    weekday: (new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7,
    hours: Array.from({ length: AVAILABILITY_HOURS.to - AVAILABILITY_HOURS.from }, (_, i) => {
      const hour = AVAILABILITY_HOURS.from + i;
      return { hour, free: busy.filter((b) => !b.has(`${date}|${hour}`)).length };
    }),
  }));
}

const icsStamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const icsText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
export function clubCalendar(clubName: string, events: { uid: string; title: string; start: string; end: string | null; location: string; url?: string; cancelled?: boolean }[], now: Date): string {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Flowcast//Club meetings//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsText(`${clubName} (Flowcast)`)}`,
    ...events.flatMap((e) => {
      const start = new Date(e.start), end = e.end ? new Date(e.end) : new Date(start.getTime() + 2 * 3_600_000);
      return ['BEGIN:VEVENT', `UID:${icsText(e.uid)}@flowcast`, `DTSTAMP:${icsStamp(now)}`, `DTSTART:${icsStamp(start)}`, `DTEND:${icsStamp(end)}`,
        `SUMMARY:${icsText(e.title)}`, ...(e.location ? [`LOCATION:${icsText(e.location)}`] : []), ...(e.url ? [`URL:${e.url}`] : []),
        ...(e.cancelled ? ['STATUS:CANCELLED'] : []), 'END:VEVENT'];
    }),
    'END:VCALENDAR', '',
  ].join('\r\n');
}

/** Organization routes: mount after authentication on the dashboard router (public reads are listed in PUBLIC_ORG_PATHS). */
export const PUBLIC_ORG_PATHS = /^\/(club-meetings|clubs\/[^/]+\/calendar\.ics)\/?$/i;

export function orgRoutes(deps: OrgDeps) {
  const { pool } = deps;
  const admins = deps.admins ?? adminEmails();
  const now = deps.now ?? (() => new Date());
  const router = Router();
  const user = (res: Response) => res.locals.dashboardUser as VerifiedUser | undefined;
  const isAdmin = (res: Response) => !!user(res)?.email && admins.has(user(res)!.email.toLowerCase());

  async function club(id: string) {
    const c = (await deps.clubs()).get(id);
    if (!c) throw new OrgError(404, 'Unknown club.');
    return c;
  }
  async function officerOf(accountId: string): Promise<string[]> {
    const r = await pool.query('SELECT club_id FROM dashboard_officers WHERE account_id=$1 ORDER BY granted_at', [accountId]);
    return r.rows.map((row) => row.club_id);
  }
  async function requireOfficer(res: Response, clubId: string) {
    await club(clubId);
    const g = await deps.account(res);
    if (!(await officerOf(g.id)).includes(clubId) && !isAdmin(res)) throw new OrgError(403, 'Only verified officers of this club can do that.');
    return g;
  }
  async function upcomingMeetings(clubId?: string) {
    const r = await pool.query(`SELECT * FROM dashboard_club_meetings WHERE ends_at > $1::timestamptz - interval '7 days' ${clubId ? 'AND club_id=$2' : ''} ORDER BY starts_at`,
      clubId ? [now(), clubId] : [now()]);
    return r.rows.map(meetingRow);
  }
  async function rsvpCounts(): Promise<Record<string, number>> {
    const r = await pool.query('SELECT event_id, count(*)::int AS n FROM dashboard_rsvps GROUP BY event_id');
    return Object.fromEntries(r.rows.map((row) => [row.event_id, row.n]));
  }
  async function announce(clubId: string, body: string, createdBy: string | null, meetingId: string | null = null) {
    await pool.query('INSERT INTO dashboard_announcements(club_id, body, meeting_id, created_by) VALUES($1,$2,$3,$4)', [clubId, body, meetingId, createdBy]);
  }

  // ---------------------------------------------------------------- public reads
  router.get('/club-meetings', async (_req, res) => {
    res.json({ meetings: await upcomingMeetings(), rsvps: await rsvpCounts() });
  });
  router.get('/clubs/:id/calendar.ics', async (req, res) => {
    const c = await club(req.params.id);
    const places = await deps.places();
    const meetings = await upcomingMeetings(c.id);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${c.name.replace(/[^\w\- ]+/g, '').trim().slice(0, 60) || 'club'}.ics"`);
    res.send(clubCalendar(c.name, meetings.map((m) => ({
      uid: m.eventId, title: m.title, start: m.start, end: m.end, cancelled: m.cancelled,
      location: [m.room, m.locationId ? places.get(m.locationId)?.name : null].filter(Boolean).join(', '),
    })), now()));
  });

  // ---------------------------------------------------------------- the signed-in person
  router.get('/orgs/me', async (_req, res) => {
    const g = await deps.account(res);
    const [officer, shares, rsvps, requests] = await Promise.all([
      officerOf(g.id),
      pool.query('SELECT club_id FROM dashboard_availability_shares WHERE account_id=$1', [g.id]),
      pool.query('SELECT event_id FROM dashboard_rsvps WHERE account_id=$1', [g.id]),
      pool.query('SELECT id, club_id, status, created_at FROM dashboard_officer_requests WHERE account_id=$1 ORDER BY created_at DESC', [g.id]),
    ]);
    res.json({
      admin: isAdmin(res), officerOf: officer, sharing: shares.rows.map((r) => r.club_id), rsvps: rsvps.rows.map((r) => r.event_id),
      requests: requests.rows.map((r) => ({ id: r.id, clubId: r.club_id, status: r.status, submittedAt: new Date(r.created_at).toISOString() })),
    });
  });
  router.put('/rsvps/:eventId', async (req, res) => {
    const parsed = z.object({ going: z.boolean() }).strict().safeParse(req.body);
    const eventId = String(req.params.eventId);
    if (!parsed.success || eventId.length > 200) throw new OrgError(400, 'Send { going: true | false }.');
    const g = await deps.account(res);
    if (parsed.data.going) await pool.query('INSERT INTO dashboard_rsvps(event_id, account_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [eventId, g.id]);
    else await pool.query('DELETE FROM dashboard_rsvps WHERE event_id=$1 AND account_id=$2', [eventId, g.id]);
    const n = await pool.query('SELECT count(*)::int AS n FROM dashboard_rsvps WHERE event_id=$1', [eventId]);
    res.json({ eventId, going: parsed.data.going, count: n.rows[0].n });
  });
  router.put('/clubs/:id/share-availability', async (req, res) => {
    const parsed = z.object({ share: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Send { share: true | false }.');
    const c = await club(req.params.id);
    const g = await deps.account(res);
    if (parsed.data.share) await pool.query('INSERT INTO dashboard_availability_shares(account_id, club_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [g.id, c.id]);
    else await pool.query('DELETE FROM dashboard_availability_shares WHERE account_id=$1 AND club_id=$2', [g.id, c.id]);
    res.json({ clubId: c.id, share: parsed.data.share });
  });
  router.get('/notifications', async (_req, res) => {
    const g = await deps.account(res);
    const enabled = g.preferences.clubEvents === true;
    const read = await pool.query('SELECT notifications_read_at FROM dashboard_accounts WHERE id=$1', [g.id]);
    const readAt: Date | null = read.rows[0]?.notifications_read_at ?? null;
    const rows = enabled && g.following.length
      ? (await pool.query(`SELECT id, club_id, body, meeting_id, created_at FROM dashboard_announcements
          WHERE club_id = ANY($1::text[]) AND created_at > $2::timestamptz - make_interval(days => $3::int) ORDER BY created_at DESC LIMIT 50`, [g.following, now(), NOTIFICATION_DAYS])).rows
      : [];
    const clubs = await deps.clubs();
    res.json({
      enabled,
      items: rows.map((r) => ({ id: r.id, clubId: r.club_id, clubName: clubs.get(r.club_id)?.name ?? r.club_id, body: r.body,
        meetingEventId: r.meeting_id ? `meeting:${r.meeting_id}` : null, at: new Date(r.created_at).toISOString(), unread: !readAt || new Date(r.created_at) > readAt })),
    });
  });
  router.post('/notifications/read', async (_req, res) => {
    const g = await deps.account(res);
    await pool.query('UPDATE dashboard_accounts SET notifications_read_at=$1 WHERE id=$2', [now(), g.id]);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- officer requests and reviews
  router.post('/officer-requests', async (req, res) => {
    const parsed = z.object({ clubId: z.string().min(1).max(1000), officerName: z.string().trim().min(1).max(100), note: z.string().trim().max(1000) }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Send clubId, officerName and a note (up to 1,000 characters).');
    const c = await club(parsed.data.clubId);
    const g = await deps.account(res);
    if ((await officerOf(g.id)).includes(c.id)) throw new OrgError(409, 'You are already a verified officer of this club.');
    try {
      const r = await pool.query(`INSERT INTO dashboard_officer_requests(account_id, club_id, officer_name, officer_email, note) VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [g.id, c.id, parsed.data.officerName, user(res)!.email, parsed.data.note]);
      res.status(201).json(application(r.rows[0], c.name));
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw new OrgError(409, 'You already have a pending request for this club.');
      throw error;
    }
  });
  router.get('/admin/officer-requests', async (_req, res) => {
    if (!isAdmin(res)) throw new OrgError(403, 'Only administrators can review officer requests.');
    const clubs = await deps.clubs();
    const r = await pool.query('SELECT * FROM dashboard_officer_requests ORDER BY created_at');
    res.json(r.rows.map((row) => application(row, clubs.get(row.club_id)?.name ?? row.club_id)));
  });
  router.post('/admin/officer-requests/:id', async (req, res) => {
    if (!isAdmin(res)) throw new OrgError(403, 'Only administrators can review officer requests.');
    const parsed = z.object({ status: z.enum(['pending', 'approved', 'rejected']), note: z.string().trim().max(1000).optional() }).strict().safeParse(req.body);
    if (!uuid.safeParse(req.params.id).success || !parsed.success) throw new OrgError(400, 'Send status (pending, approved or rejected) and an optional note.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(`UPDATE dashboard_officer_requests SET status=$1, review_note=$2, reviewed_at=CASE WHEN $1='pending' THEN NULL ELSE now() END
        WHERE id=$3 RETURNING *`, [parsed.data.status, parsed.data.note || null, req.params.id]);
      if (!r.rows[0]) throw new OrgError(404, 'No such request.');
      const row = r.rows[0];
      if (parsed.data.status === 'approved') await client.query('INSERT INTO dashboard_officers(account_id, club_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [row.account_id, row.club_id]);
      else await client.query('DELETE FROM dashboard_officers WHERE account_id=$1 AND club_id=$2', [row.account_id, row.club_id]);
      await client.query('COMMIT');
      res.json(application(row, (await deps.clubs()).get(row.club_id)?.name ?? row.club_id));
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  });

  // ---------------------------------------------------------------- officers: meetings, announcements, free time
  router.post('/clubs/:id/meetings', async (req, res) => {
    const g = await requireOfficer(res, req.params.id);
    const m = await validMeeting(meetingBody.safeParse(req.body));
    const r = await pool.query(`INSERT INTO dashboard_club_meetings(club_id, title, location_id, room, starts_at, ends_at, notes, created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [req.params.id, m.title, m.locationId, m.room, m.start, m.end, m.notes, g.id]);
    const meeting = meetingRow(r.rows[0]);
    await announce(req.params.id, `New meeting: ${meeting.title}, ${timeFormat.format(new Date(meeting.start))}${await whereText(meeting)}.`, g.id, meeting.id);
    res.status(201).json(meeting);
  });
  router.patch('/clubs/:id/meetings/:meetingId', async (req, res) => {
    const g = await requireOfficer(res, req.params.id);
    if (!uuid.safeParse(req.params.meetingId).success) throw new OrgError(404, 'No such meeting.');
    const parsed = meetingPatch.safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Invalid meeting fields.');
    const before = await pool.query('SELECT * FROM dashboard_club_meetings WHERE id=$1 AND club_id=$2', [req.params.meetingId, req.params.id]);
    if (!before.rows[0]) throw new OrgError(404, 'No such meeting.');
    const old = meetingRow(before.rows[0]);
    const next = await validMeeting(meetingBody.safeParse({
      title: parsed.data.title ?? old.title, locationId: parsed.data.locationId !== undefined ? parsed.data.locationId : old.locationId,
      room: parsed.data.room ?? old.room, start: parsed.data.start ?? old.start, end: parsed.data.end ?? old.end, notes: parsed.data.notes ?? old.notes,
    }));
    const cancelled = parsed.data.cancelled ?? old.cancelled;
    const r = await pool.query(`UPDATE dashboard_club_meetings SET title=$1, location_id=$2, room=$3, starts_at=$4, ends_at=$5, notes=$6, cancelled=$7, updated_at=now()
      WHERE id=$8 RETURNING *`, [next.title, next.locationId, next.room, next.start, next.end, next.notes, cancelled, old.id]);
    const meeting = meetingRow(r.rows[0]);
    // Followers hear about what changed for them: cancellation, a new time, or a new place.
    const changes: string[] = [];
    if (cancelled && !old.cancelled) changes.push('cancelled');
    else if (!cancelled && old.cancelled) changes.push(`back on, ${timeFormat.format(new Date(meeting.start))}`);
    else {
      if (meeting.start !== old.start || meeting.end !== old.end) changes.push(`moved to ${timeFormat.format(new Date(meeting.start))}`);
      if (meeting.locationId !== old.locationId || meeting.room !== old.room) changes.push(`now${await whereText(meeting)}`);
    }
    if (changes.length) await announce(req.params.id, `${meeting.title}: ${changes.join('; ')}.`, g.id, meeting.id);
    res.json(meeting);
  });
  router.post('/clubs/:id/announcements', async (req, res) => {
    const g = await requireOfficer(res, req.params.id);
    const parsed = z.object({ body: z.string().trim().min(1).max(500) }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Write an announcement of up to 500 characters.');
    await announce(req.params.id, parsed.data.body, g.id);
    res.status(201).json({ ok: true });
  });
  router.get('/clubs/:id/announcements', async (req, res) => {
    const c = await club(req.params.id);
    const r = await pool.query('SELECT id, body, meeting_id, created_at FROM dashboard_announcements WHERE club_id=$1 ORDER BY created_at DESC LIMIT 20', [c.id]);
    res.json(r.rows.map((row) => ({ id: row.id, body: row.body, meetingEventId: row.meeting_id ? `meeting:${row.meeting_id}` : null, at: new Date(row.created_at).toISOString() })));
  });
  router.get('/clubs/:id/availability', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const r = await pool.query(`SELECT a.schedule FROM dashboard_availability_shares s JOIN dashboard_accounts a ON a.id = s.account_id WHERE s.club_id=$1`, [req.params.id]);
    const members = r.rows.length;
    // Counts only, and none at all below the minimum: an officer never sees whose time is whose.
    res.json(members < MIN_SHARED_MEMBERS
      ? { members, minimum: MIN_SHARED_MEMBERS, days: null }
      : { members, minimum: MIN_SHARED_MEMBERS, days: freeCounts(r.rows.map((row) => row.schedule ?? []), now()) });
  });

  router.use((error: unknown, _req: import('express').Request, res: Response, next: import('express').NextFunction) => {
    if (error instanceof OrgError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  });
  return router;

  async function validMeeting(parsed: ReturnType<typeof meetingBody.safeParse>) {
    if (!parsed.success) throw new OrgError(400, 'Send title, locationId (or null), room, start, end (ISO times) and notes.');
    const m = parsed.data;
    const start = Date.parse(m.start), end = Date.parse(m.end);
    if (!(end > start)) throw new OrgError(400, 'A meeting must end after it starts.');
    if (end - start > 12 * 3_600_000) throw new OrgError(400, 'Meetings can last at most 12 hours.');
    if (m.locationId && !(await deps.places()).has(m.locationId)) throw new OrgError(400, 'Unknown campus location.');
    return { ...m, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  }
  async function whereText(m: OfficerMeeting) {
    const place = m.locationId ? (await deps.places()).get(m.locationId)?.name : null;
    const where = [m.room ? `Room ${m.room}` : null, place].filter(Boolean).join(', ');
    return where ? ` in ${where}` : '';
  }
}

function application(row: Record<string, any>, clubName: string) {
  return {
    id: row.id, clubId: row.club_id, clubName, officerName: row.officer_name, officerEmail: row.officer_email, listingUrl: '', description: row.note,
    submittedAt: new Date(row.created_at).toISOString(), status: row.status,
    // The one check Flowcast can make: the club is a published organizer. Officer status itself is for the reviewer to confirm.
    checks: [{ id: 'listed', label: 'Club appears in BU’s public event listings', passed: true }, { id: 'officer', label: 'Applicant is an officer (confirm with the club or BU)', passed: null }],
    ...(row.review_note ? { reviewNote: row.review_note } : {}), ...(row.reviewed_at ? { reviewedAt: new Date(row.reviewed_at).toISOString() } : {}),
  };
}

/** What a person's export includes from organizations. */
export async function orgExport(pool: pg.Pool, accountId: string) {
  const [officer, requests, rsvps, shares] = await Promise.all([
    pool.query('SELECT club_id, granted_at FROM dashboard_officers WHERE account_id=$1', [accountId]),
    pool.query('SELECT club_id, officer_name, note, status, created_at, reviewed_at FROM dashboard_officer_requests WHERE account_id=$1', [accountId]),
    pool.query('SELECT event_id, created_at FROM dashboard_rsvps WHERE account_id=$1', [accountId]),
    pool.query('SELECT club_id, created_at FROM dashboard_availability_shares WHERE account_id=$1', [accountId]),
  ]);
  return { officerOf: officer.rows, officerRequests: requests.rows, rsvps: rsvps.rows, sharingFreeTimeWith: shares.rows };
}

/** Roles for a session: admin by email, club officer when any club approved them. */
export async function orgRoles(pool: pg.Pool, accountId: string, email: string, admins = adminEmails()) {
  const r = await pool.query('SELECT club_id FROM dashboard_officers WHERE account_id=$1 ORDER BY granted_at', [accountId]);
  const officerOf: string[] = r.rows.map((row) => row.club_id);
  return {
    roles: [...(officerOf.length ? ['clubOfficer'] : []), ...(email && admins.has(email.toLowerCase()) ? ['admin'] : [])],
    officerOfClubId: officerOf[0] ?? null,
  };
}
