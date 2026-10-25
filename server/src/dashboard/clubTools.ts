// Club tools on top of organizations (orgs.ts): check-in codes and attendance, an officer team with
// titles, an opt-in member list, co-hosted meetings, event checklists, club tags for discovery,
// follower history and stats, the activity fair, a weather forecast for outdoor meetings, and
// published venue events for the all-events page.
//
// Privacy rules match orgs.ts: officers see counts, and names only of members who chose to show
// theirs; check-ins and follows are counted, never listed by person to anyone but themselves.
import { randomBytes } from 'node:crypto';
import { Router, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import type { VerifiedUser } from './auth';
import { bostonClock, meetingRow, OrgError, type OfficerMeeting, type OrgDeps } from './orgs';
import type { VenueCalendar } from '../chatData';

export const CLUB_TOOL_TABLES = `
  ALTER TABLE dashboard_accounts ADD COLUMN IF NOT EXISTS email text;
  ALTER TABLE dashboard_officers ADD COLUMN IF NOT EXISTS title text NOT NULL DEFAULT 'Officer';
  ALTER TABLE dashboard_officers ADD COLUMN IF NOT EXISTS added_by uuid;
  ALTER TABLE dashboard_club_meetings ADD COLUMN IF NOT EXISTS checkin_code text;
  CREATE TABLE IF NOT EXISTS dashboard_checkins (
    meeting_id uuid NOT NULL REFERENCES dashboard_club_meetings(id) ON DELETE CASCADE,
    account_id uuid NOT NULL REFERENCES dashboard_accounts(id) ON DELETE CASCADE,
    at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (meeting_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS dashboard_member_visibility (
    account_id uuid NOT NULL REFERENCES dashboard_accounts(id) ON DELETE CASCADE,
    club_id text NOT NULL, PRIMARY KEY (account_id, club_id)
  );
  CREATE TABLE IF NOT EXISTS dashboard_cohost_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id uuid NOT NULL REFERENCES dashboard_club_meetings(id) ON DELETE CASCADE,
    club_id text NOT NULL, status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
    created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (meeting_id, club_id)
  );
  CREATE TABLE IF NOT EXISTS dashboard_meeting_tasks (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id uuid NOT NULL REFERENCES dashboard_club_meetings(id) ON DELETE CASCADE,
    label text NOT NULL, days_before integer NOT NULL CHECK (days_before BETWEEN 0 AND 120),
    done boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS dashboard_club_profiles (
    club_id text PRIMARY KEY, tags text[] NOT NULL DEFAULT '{}', blurb text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  -- Follower history: one row per follow or unfollow, with no account, so only totals over time can be read.
  CREATE TABLE IF NOT EXISTS dashboard_follow_events (
    club_id text NOT NULL, delta smallint NOT NULL CHECK (delta IN (-1, 1)), at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS dashboard_follow_events_club ON dashboard_follow_events(club_id, at);
  CREATE TABLE IF NOT EXISTS dashboard_fairs (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, date date NOT NULL,
    location_id text, starts text NOT NULL DEFAULT '11:00', ends text NOT NULL DEFAULT '15:00', created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS dashboard_fair_tables (
    fair_id uuid NOT NULL REFERENCES dashboard_fairs(id) ON DELETE CASCADE,
    club_id text NOT NULL, table_label text NOT NULL DEFAULT '', note text NOT NULL DEFAULT '',
    PRIMARY KEY (fair_id, club_id)
  );
`;
export const CLUB_TOOL_TABLE_NAMES = ['dashboard_checkins', 'dashboard_member_visibility', 'dashboard_cohost_invites', 'dashboard_meeting_tasks', 'dashboard_club_profiles', 'dashboard_follow_events', 'dashboard_fairs', 'dashboard_fair_tables'];

/** Tags clubs can choose for discovery. */
export const CLUB_TAGS = ['academic', 'arts', 'business', 'cultural', 'debate', 'faith', 'gaming', 'health', 'media', 'music', 'politics', 'service', 'social', 'sports', 'stem', 'theater'] as const;
/** Check-in opens this long before a meeting and closes this long after it ends. */
export const CHECKIN_EARLY_MS = 30 * 60_000;
export const CHECKIN_LATE_MS = 30 * 60_000;
/** A starting checklist for an event, counted back from its date. */
export const CHECKLIST_TEMPLATE: { label: string; daysBefore: number }[] = [
  { label: 'Book the room through BU', daysBefore: 21 },
  { label: 'Register the event on Terrier Central', daysBefore: 14 },
  { label: 'Order food (if any)', daysBefore: 7 },
  { label: 'Post flyers and announce to followers', daysBefore: 7 },
  { label: 'Confirm setup, AV and who’s opening up', daysBefore: 2 },
];

export interface WeatherForecast { available: boolean; reason?: string; periods: { name: string; start: string; end: string; temperatureF: number | null; rainChance: number | null; summary: string }[]; source: string }
/** The National Weather Service forecast for BU (gridpoint BOX 70,100), cached; null when unreachable. */
export function nwsForecast(fetcher: typeof fetch = fetch, ttlMs = 60 * 60_000) {
  let cached: { at: number; periods: WeatherForecast['periods'] } | null = null;
  return async function forecast(): Promise<WeatherForecast['periods'] | null> {
    if (cached && Date.now() - cached.at < ttlMs) return cached.periods;
    try {
      const r = await fetcher('https://api.weather.gov/gridpoints/BOX/70,100/forecast', { headers: { 'User-Agent': 'Flowcast campus planner', Accept: 'application/geo+json' }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return cached?.periods ?? null;
      const body = await r.json() as { properties?: { periods?: Record<string, any>[] } };
      const periods = (body.properties?.periods ?? []).map((p) => ({
        name: String(p.name ?? ''), start: String(p.startTime), end: String(p.endTime),
        temperatureF: typeof p.temperature === 'number' ? (p.temperatureUnit === 'C' ? Math.round(p.temperature * 9 / 5 + 32) : p.temperature) : null,
        rainChance: typeof p.probabilityOfPrecipitation?.value === 'number' ? p.probabilityOfPrecipitation.value : null,
        summary: String(p.shortForecast ?? ''),
      }));
      cached = { at: Date.now(), periods };
      return periods;
    } catch { return cached?.periods ?? null; }
  };
}

/** Forecast periods overlapping a meeting, or why there are none. */
export function weatherFor(periods: WeatherForecast['periods'] | null, start: string, end: string): WeatherForecast {
  const source = 'National Weather Service forecast for Boston University (api.weather.gov), checked hourly.';
  if (!periods) return { available: false, reason: 'The weather service couldn’t be reached.', periods: [], source };
  const s = Date.parse(start), e = Date.parse(end);
  const hits = periods.filter((p) => Date.parse(p.start) < e && Date.parse(p.end) > s);
  if (!hits.length) return { available: false, reason: periods.length && s > Date.parse(periods.at(-1)!.end) ? 'The forecast only covers the next seven days.' : 'No forecast for that time.', periods: [], source };
  return { available: true, periods: hits, source };
}

export interface ClubToolDeps extends OrgDeps {
  isAdmin: (res: Response) => boolean;
  officerOf: (accountId: string) => Promise<string[]>;
  venues?: () => VenueCalendar | null;
  forecast?: () => Promise<WeatherForecast['periods'] | null>;
}

export function clubToolRoutes(deps: ClubToolDeps) {
  const { pool } = deps;
  const now = deps.now ?? (() => new Date());
  const forecast = deps.forecast ?? nwsForecast();
  const router = Router();
  const user = (res: Response) => res.locals.dashboardUser as VerifiedUser;

  async function club(id: string) {
    const c = (await deps.clubs()).get(id);
    if (!c) throw new OrgError(404, 'Unknown club.');
    return c;
  }
  async function requireOfficer(res: Response, clubId: string) {
    await club(clubId);
    const g = await deps.account(res);
    if (!(await deps.officerOf(g.id)).includes(clubId) && !deps.isAdmin(res)) throw new OrgError(403, 'Only verified officers of this club can do that.');
    return g;
  }
  async function hostedMeeting(clubId: string, meetingId: string): Promise<OfficerMeeting> {
    if (!z.string().uuid().safeParse(meetingId).success) throw new OrgError(404, 'No such meeting.');
    const r = await pool.query('SELECT * FROM dashboard_club_meetings WHERE id=$1 AND (club_id=$2 OR $2 = ANY(cohosts))', [meetingId, clubId]);
    if (!r.rows[0]) throw new OrgError(404, 'No such meeting.');
    return meetingRow(r.rows[0]);
  }

  // ---------------------------------------------------------------- public reads
  router.get('/club-profiles', async (_req, res) => {
    const r = await pool.query('SELECT club_id, tags, blurb FROM dashboard_club_profiles');
    res.json(Object.fromEntries(r.rows.map((row) => [row.club_id, { tags: row.tags, blurb: row.blurb }])));
  });
  router.get('/venue-events', (req, res) => {
    const parsed = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict().safeParse(req.query);
    if (!parsed.success) throw new OrgError(400, 'Send from and to (YYYY-MM-DD).');
    const cal = deps.venues?.() ?? null;
    const venues = new Map((cal?.venues ?? []).map((v) => [v.id, v]));
    const events = (cal?.events ?? []).filter((e) => { const d = bostonClock(new Date(e.start)).date; return d >= parsed.data.from && d <= parsed.data.to; })
      .map((e) => ({ id: `venue:${e.venueId}:${e.start}`, title: e.name, kind: e.kind, venue: venues.get(e.venueId)?.name ?? e.venueId, locationId: venues.get(e.venueId)?.locationId ?? null, start: e.start, end: e.end }))
      .sort((a, b) => a.start.localeCompare(b.start));
    res.json({ events, window: cal?.window ?? null, source: 'Published venue schedules (BU Athletics, Agganis Arena, Fenway Park, MGM Music Hall).' });
  });
  router.get('/fairs', async (_req, res) => {
    const fairs = await pool.query(`SELECT * FROM dashboard_fairs WHERE date >= ($1::timestamptz AT TIME ZONE 'America/New_York')::date - 1 ORDER BY date`, [now()]);
    const tables = await pool.query('SELECT fair_id, club_id, table_label, note FROM dashboard_fair_tables WHERE fair_id = ANY($1::uuid[])', [fairs.rows.map((f) => f.id)]);
    res.json(fairs.rows.map((f) => ({ id: f.id, name: f.name, date: new Date(f.date).toISOString().slice(0, 10), locationId: f.location_id, starts: f.starts, ends: f.ends,
      tables: tables.rows.filter((t) => t.fair_id === f.id).map((t) => ({ clubId: t.club_id, table: t.table_label, note: t.note })) })));
  });
  router.get('/weather', async (req, res) => {
    const parsed = z.object({ start: z.string().datetime({ offset: true }), end: z.string().datetime({ offset: true }) }).strict().safeParse(req.query);
    if (!parsed.success) throw new OrgError(400, 'Send start and end (ISO times).');
    res.json(weatherFor(await forecast(), parsed.data.start, parsed.data.end));
  });

  // ---------------------------------------------------------------- members
  router.post('/checkins', async (req, res) => {
    const parsed = z.object({ meetingId: z.string().uuid(), code: z.string().min(6).max(64) }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Send meetingId and code.');
    const r = await pool.query('SELECT * FROM dashboard_club_meetings WHERE id=$1', [parsed.data.meetingId]);
    const m = r.rows[0];
    if (!m || !m.checkin_code || m.checkin_code !== parsed.data.code) throw new OrgError(404, 'This check-in code isn’t valid. Scan the code shown at the meeting.');
    if (m.cancelled) throw new OrgError(409, 'This meeting was cancelled.');
    const t = now().getTime();
    if (t < Date.parse(m.starts_at) - CHECKIN_EARLY_MS) throw new OrgError(409, 'Check-in opens 30 minutes before the meeting.');
    if (t > Date.parse(m.ends_at) + CHECKIN_LATE_MS) throw new OrgError(409, 'Check-in for this meeting has closed.');
    const g = await deps.account(res);
    await pool.query('INSERT INTO dashboard_checkins(meeting_id, account_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [m.id, g.id]);
    const clubName = (await deps.clubs()).get(m.club_id)?.name ?? m.club_id;
    res.status(201).json({ meetingId: m.id, title: m.title, clubId: m.club_id, clubName });
  });
  router.put('/clubs/:id/visibility', async (req, res) => {
    const parsed = z.object({ visible: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Send { visible: true | false }.');
    const c = await club(req.params.id);
    const g = await deps.account(res);
    if (parsed.data.visible) await pool.query('INSERT INTO dashboard_member_visibility(account_id, club_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [g.id, c.id]);
    else await pool.query('DELETE FROM dashboard_member_visibility WHERE account_id=$1 AND club_id=$2', [g.id, c.id]);
    res.json({ clubId: c.id, visible: parsed.data.visible });
  });
  router.get('/clubs-me', async (_req, res) => {
    const g = await deps.account(res);
    const [visible, checkins] = await Promise.all([
      pool.query('SELECT club_id FROM dashboard_member_visibility WHERE account_id=$1', [g.id]),
      pool.query('SELECT meeting_id FROM dashboard_checkins WHERE account_id=$1', [g.id]),
    ]);
    res.json({ visibleTo: visible.rows.map((r) => r.club_id), checkedIn: checkins.rows.map((r) => `meeting:${r.meeting_id}`) });
  });

  // ---------------------------------------------------------------- officers: check-in and attendance
  router.get('/clubs/:id/meetings/:meetingId/checkin', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const m = await hostedMeeting(req.params.id, req.params.meetingId);
    let code = (await pool.query('SELECT checkin_code FROM dashboard_club_meetings WHERE id=$1', [m.id])).rows[0].checkin_code as string | null;
    if (!code) {
      code = randomBytes(12).toString('base64url');
      await pool.query('UPDATE dashboard_club_meetings SET checkin_code=$1 WHERE id=$2 AND checkin_code IS NULL', [code, m.id]);
      code = (await pool.query('SELECT checkin_code FROM dashboard_club_meetings WHERE id=$1', [m.id])).rows[0].checkin_code;
    }
    const count = (await pool.query('SELECT count(*)::int AS n FROM dashboard_checkins WHERE meeting_id=$1', [m.id])).rows[0].n;
    res.json({ meetingId: m.id, code, path: `/checkin/${m.id}?code=${code}`, count,
      opensAt: new Date(Date.parse(m.start) - CHECKIN_EARLY_MS).toISOString(), closesAt: new Date(Date.parse(m.end) + CHECKIN_LATE_MS).toISOString() });
  });
  router.get('/clubs/:id/attendance', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const r = await pool.query(`SELECT m.*, (SELECT count(*)::int FROM dashboard_checkins c WHERE c.meeting_id=m.id) AS checkins,
        (SELECT count(*)::int FROM dashboard_rsvps v WHERE v.event_id = 'meeting:' || m.id) AS rsvps
      FROM dashboard_club_meetings m WHERE (m.club_id=$1 OR $1 = ANY(m.cohosts)) AND NOT m.cancelled AND m.starts_at < $2 ORDER BY m.starts_at DESC LIMIT 12`, [req.params.id, now()]);
    const meetings = r.rows.map((row) => ({ ...meetingRow(row), checkins: row.checkins as number, rsvps: row.rsvps as number, tracked: !!row.checkin_code }));
    // Only meetings that used check-in count toward the average: the rest have no attendance to report.
    const tracked = meetings.filter((m) => m.tracked).slice(0, 4);
    res.json({ meetings, recentAverage: tracked.length ? Math.round(tracked.reduce((s, m) => s + m.checkins, 0) / tracked.length) : null, basedOn: tracked.length });
  });

  // ---------------------------------------------------------------- officers: team
  router.get('/clubs/:id/officers', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const r = await pool.query(`SELECT o.account_id, o.title, o.granted_at, a.profile->>'name' AS name, a.email FROM dashboard_officers o
      JOIN dashboard_accounts a ON a.id = o.account_id WHERE o.club_id=$1 ORDER BY o.granted_at`, [req.params.id]);
    res.json(r.rows.map((row) => ({ accountId: row.account_id, name: row.name || 'Officer', email: row.email ?? null, title: row.title, since: new Date(row.granted_at).toISOString() })));
  });
  router.post('/clubs/:id/officers', async (req, res) => {
    const g = await requireOfficer(res, req.params.id);
    const parsed = z.object({ email: z.string().trim().email().max(200), title: z.string().trim().min(1).max(40) }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Send the person’s sign-in email and a title.');
    const a = await pool.query('SELECT id FROM dashboard_accounts WHERE lower(email) = lower($1)', [parsed.data.email]);
    if (!a.rows[0]) throw new OrgError(404, 'No Flowcast account with that email yet. They need to sign in to Flowcast once first.');
    await pool.query(`INSERT INTO dashboard_officers(account_id, club_id, title, added_by) VALUES($1,$2,$3,$4)
      ON CONFLICT (account_id, club_id) DO UPDATE SET title = EXCLUDED.title`, [a.rows[0].id, req.params.id, parsed.data.title, g.id]);
    res.status(201).json({ ok: true });
  });
  router.patch('/clubs/:id/officers/:accountId', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const parsed = z.object({ title: z.string().trim().min(1).max(40) }).strict().safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.accountId).success) throw new OrgError(400, 'Send a title.');
    const r = await pool.query('UPDATE dashboard_officers SET title=$1 WHERE club_id=$2 AND account_id=$3', [parsed.data.title, req.params.id, req.params.accountId]);
    if (!r.rowCount) throw new OrgError(404, 'Not an officer of this club.');
    res.json({ ok: true });
  });
  router.delete('/clubs/:id/officers/:accountId', async (req, res) => {
    await requireOfficer(res, req.params.id);
    if (!z.string().uuid().safeParse(req.params.accountId).success) throw new OrgError(404, 'Not an officer of this club.');
    const left = (await pool.query('SELECT count(*)::int AS n FROM dashboard_officers WHERE club_id=$1', [req.params.id])).rows[0].n;
    if (left <= 1) throw new OrgError(409, 'A club keeps at least one officer. Add another before removing the last.');
    await pool.query('DELETE FROM dashboard_officers WHERE club_id=$1 AND account_id=$2', [req.params.id, req.params.accountId]);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- officers: members and stats
  router.get('/clubs/:id/members', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const [followers, sharing, visible] = await Promise.all([
      pool.query('SELECT count(*)::int AS n FROM dashboard_accounts WHERE $1 = ANY(following)', [req.params.id]),
      pool.query('SELECT count(*)::int AS n FROM dashboard_availability_shares WHERE club_id=$1', [req.params.id]),
      pool.query(`SELECT a.profile->>'name' AS name FROM dashboard_member_visibility v JOIN dashboard_accounts a ON a.id = v.account_id
        WHERE v.club_id=$1 ORDER BY lower(a.profile->>'name')`, [req.params.id]),
    ]);
    res.json({ followers: followers.rows[0].n, sharingFreeTime: sharing.rows[0].n, visible: visible.rows.map((r) => ({ name: r.name || 'Member' })) });
  });
  router.get('/clubs/:id/stats', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const followers = (await pool.query('SELECT count(*)::int AS n FROM dashboard_accounts WHERE $1 = ANY(following)', [req.params.id])).rows[0].n as number;
    // Followers over the last 60 days, walked back from today's count by the recorded follows and unfollows.
    const ev = await pool.query(`SELECT (at AT TIME ZONE 'America/New_York')::date AS day, sum(delta)::int AS net FROM dashboard_follow_events
      WHERE club_id=$1 AND at > $2::timestamptz - interval '60 days' GROUP BY 1 ORDER BY 1`, [req.params.id, now()]);
    const net = new Map(ev.rows.map((r) => [new Date(r.day).toISOString().slice(0, 10), r.net as number]));
    const today = bostonClock(now()).date;
    const series: { date: string; followers: number }[] = [];
    let count = followers;
    for (let i = 0; i < 60; i++) {
      const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - i);
      const date = d.toISOString().slice(0, 10);
      series.unshift({ date, followers: Math.max(0, count) });
      count -= net.get(date) ?? 0;
    }
    const tracking = await pool.query('SELECT min(at) AS first FROM dashboard_follow_events WHERE club_id=$1', [req.params.id]);
    const ann = await pool.query(`SELECT a.body, a.created_at, a.meeting_id,
        (SELECT count(*)::int FROM dashboard_rsvps v WHERE a.meeting_id IS NOT NULL AND v.event_id = 'meeting:' || a.meeting_id
          AND v.created_at BETWEEN a.created_at AND a.created_at + interval '48 hours') AS rsvps
      FROM dashboard_announcements a WHERE a.club_id=$1 ORDER BY a.created_at DESC LIMIT 10`, [req.params.id]);
    res.json({
      followers, followerSeries: series, trackingSince: tracking.rows[0]?.first ? new Date(tracking.rows[0].first).toISOString() : null,
      announcements: ann.rows.map((r) => ({ body: r.body, at: new Date(r.created_at).toISOString(), aboutMeeting: !!r.meeting_id, rsvpsWithin48h: r.meeting_id ? r.rsvps : null })),
    });
  });
  router.put('/clubs/:id/profile', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const parsed = z.object({ tags: z.array(z.enum(CLUB_TAGS)).max(4), blurb: z.string().trim().max(280) }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, `Choose up to 4 tags (${CLUB_TAGS.join(', ')}) and a blurb of up to 280 characters.`);
    await pool.query(`INSERT INTO dashboard_club_profiles(club_id, tags, blurb) VALUES($1,$2,$3)
      ON CONFLICT (club_id) DO UPDATE SET tags=EXCLUDED.tags, blurb=EXCLUDED.blurb, updated_at=now()`, [req.params.id, [...new Set(parsed.data.tags)], parsed.data.blurb]);
    res.json({ tags: [...new Set(parsed.data.tags)], blurb: parsed.data.blurb });
  });

  // ---------------------------------------------------------------- officers: co-hosts and checklists
  router.post('/clubs/:id/meetings/:meetingId/cohosts', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const m = await hostedMeeting(req.params.id, req.params.meetingId);
    if (m.clubId !== req.params.id) throw new OrgError(403, 'Only the host club invites co-hosts.');
    const parsed = z.object({ clubId: z.string().min(1).max(1000) }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Send the co-host clubId.');
    const other = await club(parsed.data.clubId);
    if (other.id === m.clubId) throw new OrgError(400, 'A club can’t co-host with itself.');
    await pool.query(`INSERT INTO dashboard_cohost_invites(meeting_id, club_id) VALUES($1,$2) ON CONFLICT (meeting_id, club_id) DO NOTHING`, [m.id, other.id]);
    res.status(201).json({ ok: true });
  });
  router.get('/clubs/:id/cohost-invites', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const clubs = await deps.clubs();
    // Invite columns are aliased: both tables have id (and the meeting's columns are spread after).
    const r = await pool.query(`SELECT m.*, i.id AS invite_id, i.status AS invite_status, i.club_id AS invited_club FROM dashboard_cohost_invites i
      JOIN dashboard_club_meetings m ON m.id = i.meeting_id WHERE (i.club_id=$1 OR m.club_id=$1) AND m.ends_at > $2 ORDER BY m.starts_at`, [req.params.id, now()]);
    res.json(r.rows.map((row) => ({ id: row.invite_id, status: row.invite_status, invited: row.invited_club === req.params.id,
      hostClub: clubs.get(row.club_id)?.name ?? row.club_id, invitedClub: clubs.get(row.invited_club)?.name ?? row.invited_club, meeting: meetingRow(row) })));
  });
  router.post('/cohost-invites/:inviteId', async (req, res) => {
    const parsed = z.object({ accept: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.inviteId).success) throw new OrgError(400, 'Send { accept: true | false }.');
    const inv = (await pool.query('SELECT * FROM dashboard_cohost_invites WHERE id=$1', [req.params.inviteId])).rows[0];
    if (!inv) throw new OrgError(404, 'No such invitation.');
    const g = await requireOfficer(res, inv.club_id);
    await pool.query('UPDATE dashboard_cohost_invites SET status=$1 WHERE id=$2', [parsed.data.accept ? 'accepted' : 'declined', inv.id]);
    const m = meetingRow((await pool.query(`UPDATE dashboard_club_meetings SET cohosts = CASE WHEN $1 THEN array_append(array_remove(cohosts, $2), $2) ELSE array_remove(cohosts, $2) END
      WHERE id=$3 RETURNING *`, [parsed.data.accept, inv.club_id, inv.meeting_id])).rows[0]);
    if (parsed.data.accept) {
      const host = (await deps.clubs()).get(m.clubId)?.name ?? m.clubId;
      await pool.query('INSERT INTO dashboard_announcements(club_id, body, meeting_id, created_by) VALUES($1,$2,$3,$4)',
        [inv.club_id, `Co-hosting with ${host.replace(/\s+-\s+\d+$/, '')}: ${m.title}, ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(m.start))}.`, m.id, g.id]);
    }
    res.json(m);
  });
  router.get('/clubs/:id/meetings/:meetingId/tasks', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const m = await hostedMeeting(req.params.id, req.params.meetingId);
    res.json(await tasksOf(m));
  });
  router.post('/clubs/:id/meetings/:meetingId/tasks', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const m = await hostedMeeting(req.params.id, req.params.meetingId);
    const parsed = z.union([z.object({ template: z.literal(true) }).strict(), z.object({ label: z.string().trim().min(1).max(120), daysBefore: z.number().int().min(0).max(120) }).strict()]).safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Send { template: true } or a label and daysBefore.');
    const items = 'template' in parsed.data ? CHECKLIST_TEMPLATE : [parsed.data];
    for (const t of items) await pool.query('INSERT INTO dashboard_meeting_tasks(meeting_id, label, days_before) VALUES($1,$2,$3)', [m.id, t.label, t.daysBefore]);
    res.status(201).json(await tasksOf(m));
  });
  router.patch('/clubs/:id/tasks/:taskId', async (req, res) => {
    await requireOfficer(res, req.params.id);
    const parsed = z.object({ done: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.taskId).success) throw new OrgError(400, 'Send { done: true | false }.');
    const r = await pool.query(`UPDATE dashboard_meeting_tasks t SET done=$1 FROM dashboard_club_meetings m
      WHERE t.id=$2 AND m.id=t.meeting_id AND (m.club_id=$3 OR $3 = ANY(m.cohosts)) RETURNING t.meeting_id`, [parsed.data.done, req.params.taskId, req.params.id]);
    if (!r.rowCount) throw new OrgError(404, 'No such task.');
    res.json({ ok: true });
  });
  router.delete('/clubs/:id/tasks/:taskId', async (req, res) => {
    await requireOfficer(res, req.params.id);
    if (!z.string().uuid().safeParse(req.params.taskId).success) throw new OrgError(404, 'No such task.');
    await pool.query(`DELETE FROM dashboard_meeting_tasks t USING dashboard_club_meetings m WHERE t.id=$1 AND m.id=t.meeting_id AND (m.club_id=$2 OR $2 = ANY(m.cohosts))`, [req.params.taskId, req.params.id]);
    res.status(204).end();
  });

  // ---------------------------------------------------------------- the activity fair
  router.post('/fairs', async (req, res) => {
    if (!deps.isAdmin(res)) throw new OrgError(403, 'Only administrators can set up a fair.');
    const parsed = z.object({ name: z.string().trim().min(1).max(80), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), locationId: z.string().max(160).nullable(),
      starts: z.string().regex(/^\d{2}:\d{2}$/), ends: z.string().regex(/^\d{2}:\d{2}$/) }).strict().safeParse(req.body);
    if (!parsed.success) throw new OrgError(400, 'Send name, date, locationId (or null), starts and ends (HH:MM).');
    if (parsed.data.locationId && !(await deps.places()).has(parsed.data.locationId)) throw new OrgError(400, 'Unknown campus location.');
    const r = await pool.query('INSERT INTO dashboard_fairs(name, date, location_id, starts, ends) VALUES($1,$2,$3,$4,$5) RETURNING id',
      [parsed.data.name, parsed.data.date, parsed.data.locationId, parsed.data.starts, parsed.data.ends]);
    res.status(201).json({ id: r.rows[0].id });
  });
  router.put('/fairs/:fairId/tables/:clubId', async (req, res) => {
    await requireOfficer(res, req.params.clubId);
    const parsed = z.object({ table: z.string().trim().max(20), note: z.string().trim().max(140) }).strict().safeParse(req.body);
    if (!parsed.success || !z.string().uuid().safeParse(req.params.fairId).success) throw new OrgError(400, 'Send a table label and a note.');
    if (!(await pool.query('SELECT 1 FROM dashboard_fairs WHERE id=$1', [req.params.fairId])).rowCount) throw new OrgError(404, 'No such fair.');
    await pool.query(`INSERT INTO dashboard_fair_tables(fair_id, club_id, table_label, note) VALUES($1,$2,$3,$4)
      ON CONFLICT (fair_id, club_id) DO UPDATE SET table_label=EXCLUDED.table_label, note=EXCLUDED.note`, [req.params.fairId, req.params.clubId, parsed.data.table, parsed.data.note]);
    res.json({ ok: true });
  });
  router.delete('/fairs/:fairId/tables/:clubId', async (req, res) => {
    await requireOfficer(res, req.params.clubId);
    if (!z.string().uuid().safeParse(req.params.fairId).success) throw new OrgError(404, 'No such fair.');
    await pool.query('DELETE FROM dashboard_fair_tables WHERE fair_id=$1 AND club_id=$2', [req.params.fairId, req.params.clubId]);
    res.status(204).end();
  });

  router.use((error: unknown, _req: import('express').Request, res: Response, next: import('express').NextFunction) => {
    if (error instanceof OrgError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  });
  return router;

  async function tasksOf(m: OfficerMeeting) {
    const r = await pool.query('SELECT id, label, days_before, done FROM dashboard_meeting_tasks WHERE meeting_id=$1 ORDER BY days_before DESC, created_at', [m.id]);
    const startDate = bostonClock(new Date(m.start)).date;
    return r.rows.map((t) => {
      const due = new Date(`${startDate}T12:00:00Z`); due.setUTCDate(due.getUTCDate() - t.days_before);
      return { id: t.id, label: t.label, daysBefore: t.days_before, due: due.toISOString().slice(0, 10), done: t.done };
    });
  }
}

/** Organization rows a person's export includes from these tools. */
export async function clubToolExport(pool: pg.Pool, accountId: string) {
  const [checkins, visible] = await Promise.all([
    pool.query('SELECT meeting_id, at FROM dashboard_checkins WHERE account_id=$1', [accountId]),
    pool.query('SELECT club_id FROM dashboard_member_visibility WHERE account_id=$1', [accountId]),
  ]);
  return { checkIns: checkins.rows, nameVisibleTo: visible.rows.map((r) => r.club_id) };
}
