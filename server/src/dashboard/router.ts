import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { openAt } from '../../../map-client/src/insights';
import { weekBestTimes, weekFrom } from '../../../map-client/src/bestTimes';
import { SLOT_CAVEAT, SLOT_METHOD, type SlotQuery, type SlotResult } from '../eventSlots';
import { bostonDate, clubsFromBundle, forecastsFromBundle, locationsFromBundle, organizerId } from '../../../web/src/data/realData';
import type { Profile, NotificationPrefs } from '../../../web/src/data/types';
import type { Snapshot } from './import';
import { authConfig, createUserVerifier, DashboardAuthError, type AuthConfig, type VerifiedUser, type VerifyUser } from './auth';
import { emptySchedule, previewSchedule, ScheduleError, scheduleState, validateSchedule } from './schedule';
import type { ScheduleImportState } from '../../../web/src/data/types';
import { addCrowdReport, createCrowdThrottle, crowdReportBody, crowdReportQuery, readCrowdReports, reportBucket, type CrowdThrottle } from './crowdReports';

const time = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]);
const location = z.string().min(1).max(160).nullable();
const profilePatch = z.object({ name: z.string().trim().max(100), homeLocationId: location, studySpotId: location, lunchTime: time, dinnerTime: time, avatarSwatch: z.number().int().min(0).max(5) }).partial().strict();
const clock = z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/);
const toSeconds = (hhmm: string) => Number(hhmm.split(':')[0]) * 3600 + Number(hhmm.split(':')[1]) * 60;
/** GET /event-slots query: headcount, optional days ("0,2,4", 0 = Monday), window, duration, campus and limit. */
const slotQuery = z.object({
  headcount: z.coerce.number().int().min(1).max(2000),
  days: z.string().regex(/^[0-6](,[0-6]){0,6}$/).optional(),
  from: clock.optional(),
  to: z.union([clock, z.literal('24:00')]).optional(),
  duration: z.coerce.number().int().min(30).max(360).optional(),
  campus: z.enum(['charles-river', 'medical', 'fenway']).optional(),
  limit: z.coerce.number().int().min(1).max(20).optional(),
  /** Places attendees come from, comma-separated location ids (at most 12). */
  near: z.string().regex(/^[a-z0-9-]+(,[a-z0-9-]+){0,11}$/).optional(),
}).strict();
const preferencesPatch =z.object({ packedRoute: z.boolean(), clubEvents: z.boolean(), scheduleChanges: z.boolean() }).partial().strict();
interface Account { id: string; profile: Profile; preferences: NotificationPrefs; following: string[]; schedule: ScheduleImportState['items']; schedule_import: Omit<ScheduleImportState, 'items'> | null; created_at: Date; updated_at: Date }
const blankProfile: Profile = { name: '', homeLocationId: null, studySpotId: null, lunchTime: '', dinnerTime: '', avatarSwatch: 0 };
const blankPrefs: NotificationPrefs = { packedRoute: false, clubEvents: false, scheduleChanges: false };
function session(account: Account, user: VerifiedUser) {
  return { user: { id: account.id, name: account.profile.name || 'Account', email: user.email, homeLocationId: account.profile.homeLocationId }, roles: [], officerOfClubId: null, calendarConnected: false, calendarSyncedAt: null, onboarded: false };
}
/**
 * Best times this week for /public: the seven Boston days from `today`, for places with published
 * hours, each date's hours read from its own week (as the forecasts shift the reference Monday).
 * After-midnight hours from the previous day's listing are not modeled, so they are not ranked.
 */
export function publicBestTimes(impact: Snapshot['impact'], campus: Snapshot['campus'], today: string) {
  const week = weekFrom(today);
  const weekCampus = new Map(week.map((d) => {
    const monday = new Date(`${d.date}T12:00:00Z`); monday.setUTCDate(monday.getUTCDate() - d.weekday);
    return [d.date, { ...campus, referenceWeekStart: monday.toISOString().slice(0, 10) }];
  }));
  const withHours = impact.places.filter((p) => campus.locations[p.id]?.hoursStatus === 'published');
  return weekBestTimes(impact, withHours, week, (id, d, seconds) => {
    const s = openAt(id, d.weekday, seconds, weekCampus.get(d.date)!);
    return s.open === true && s.fromPreviousDay ? null : s.open;
  });
}

export function dashboardRouter(pool?: pg.Pool, options: { verifyUser?: VerifyUser; authConfig?: () => AuthConfig; eventSlots?: (query: SlotQuery) => SlotResult; crowdThrottle?: CrowdThrottle; now?: () => Date } = {}) {
  const config = options.authConfig ?? authConfig;
  const verifyUser = options.verifyUser ?? createUserVerifier(config);
  const crowdThrottle = options.crowdThrottle ?? createCrowdThrottle();
  const now = options.now ?? (() => new Date());
  const router = Router();
  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      let origin: URL | undefined;
      try { if (req.headers.origin) origin = new URL(req.headers.origin); } catch { /* Invalid origins are rejected below. */ }
      if (!origin || !['http:', 'https:'].includes(origin.protocol) || origin.host !== req.headers.host || req.headers['sec-fetch-site'] === 'cross-site') {
        res.status(403).json({ error: 'A same-origin request is required.' }); return;
      }
    }
    next();
  });
  async function snapshot(): Promise<Snapshot> {
    const result = await pool!.query('SELECT payload FROM dashboard_snapshots JOIN dashboard_current ON hash=snapshot_hash WHERE singleton=true');
    if (!result.rows.length) throw new Error('Snapshot unavailable');
    return result.rows[0].payload;
  }
  async function account(res: Response): Promise<Account> {
    const user = res.locals.dashboardUser as VerifiedUser;
    await pool!.query('INSERT INTO dashboard_accounts(id,profile,preferences) VALUES($1,$2,$3) ON CONFLICT (id) DO NOTHING', [user.id, { ...blankProfile, name: user.name }, blankPrefs]);
    const result = await pool!.query('SELECT id,profile,preferences,following,schedule,schedule_import,created_at,updated_at FROM dashboard_accounts WHERE id=$1', [user.id]);
    return result.rows[0];
  }
  router.get('/auth/config', (_req, res) => { res.json(config()); });
  router.use(async (req, res, next) => {
    // Public reads: the snapshot, event slots (published schedules and model figures, nothing personal)
    // and anonymous crowd-report counts.
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/(public|event-slots|crowd-reports)\/?$/i.test(req.path)) { next(); return; }
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new DashboardAuthError(401);
    res.locals.dashboardUser = await verifyUser(token);
    next();
  });
  // Answered from the Ask server's loaded campus model, so it needs no database. Never books anything.
  router.get('/event-slots', (req, res) => {
    if (!options.eventSlots) { res.status(503).json({ error: 'Event planning is unavailable on this server.' }); return; }
    const parsed = slotQuery.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'Send headcount (1–2000), and optionally days (0 = Monday, comma-separated), from and to (HH:MM), duration (30–360 minutes), campus, limit (1–20) and near (up to 12 place ids, comma-separated).' }); return; }
    const q = parsed.data;
    const fromSec = toSeconds(q.from ?? '18:00');
    const toSec = toSeconds(q.to ?? '22:00');
    const durationMin = q.duration ?? 90;
    if (toSec - fromSec < durationMin * 60) { res.status(400).json({ error: 'The event doesn’t fit in that window.' }); return; }
    const result = options.eventSlots({
      headcount: q.headcount, days: q.days ? [...new Set(q.days.split(',').map(Number))] : null, fromSec, toSec, durationMin,
      campus: q.campus ?? 'charles-river', limit: q.limit ?? 10, maxPerDay: 3,
      ...(q.near ? { near: q.near.split(',') } : {}),
    });
    res.json({ ...result, label: 'published schedule and model-derived', caveat: SLOT_CAVEAT, method: SLOT_METHOD });
  });
  router.use((_req, res, next) => {
    if (!pool) { res.status(503).json({ error: 'Dashboard database is unavailable.' }); return; }
    next();
  });
  router.get('/public', async (_req, res) => {
    const { impact, campus, geo } = await snapshot();
    const at = new Date();
    const { day, weekday } = bostonDate(at);
    // openAt uses a reference Monday. Shift it to the requested Boston week for dated hours.
    const monday = new Date(`${day}T12:00:00Z`); monday.setUTCDate(monday.getUTCDate() - weekday);
    const currentCampus = { ...campus, referenceWeekStart: monday.toISOString().slice(0, 10) };
    const forecasts = forecastsFromBundle(impact, at, (id, w, seconds) => openAt(id, w, seconds, currentCampus).open);
    const bestTimes = publicBestTimes(impact, campus, day);
    const events = impact.events.map((e) => ({ id: e.id, title: e.name, locationId: e.locationId, venue: e.locationName, start: e.start, end: e.end, organizer: e.organizer, clubId: e.organizer?.trim() ? organizerId(e.organizer.trim()) : null, source: 'terrier-central', sourceUrl: e.sourceUrl, mapStatus: e.status }));
    res.json({ locations: locationsFromBundle(impact), geo, events, impact, ...forecasts, bestTimes, clubs: clubsFromBundle(impact) });
  });
  // "Was it busy?": anonymous counts per place, Boston date and hour. Shown beside the model, never fed into it.
  router.get('/crowd-reports', async (req, res) => {
    const parsed = crowdReportQuery.safeParse(req.query);
    if (!parsed.success) { res.status(400).json({ error: 'days must be between 1 and 14.' }); return; }
    res.json(await readCrowdReports(pool!, now(), parsed.data.days));
  });
  router.post('/crowd-reports', async (req, res) => {
    const parsed = crowdReportBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Send locationId, answer (quiet, ok or packed) and optionally at (ISO time).' }); return; }
    const bucket = reportBucket(parsed.data.at ? new Date(parsed.data.at) : now(), now());
    if (!bucket) { res.status(400).json({ error: 'Reports must be about the last few hours.' }); return; }
    const { impact } = await snapshot();
    if (!locationsFromBundle(impact).some((l) => l.id === parsed.data.locationId)) { res.status(400).json({ error: 'Unknown campus location.' }); return; }
    // The account id is used only for the in-memory throttle, as a keyed hash; it is never stored with the count.
    if (!crowdThrottle.take((res.locals.dashboardUser as VerifiedUser).id, parsed.data.locationId)) { res.status(429).json({ error: 'You already reported this place recently.' }); return; }
    await addCrowdReport(pool!, parsed.data.locationId, bucket, parsed.data.answer);
    res.status(204).end();
  });
  router.get('/me', async (req, res) => {
    const g = await account(res);
    res.json({ session: session(g, res.locals.dashboardUser), profile: g.profile, notificationPrefs: g.preferences, following: g.following });
  });
  router.get('/schedule', async (_req, res) => { res.json(scheduleState(await account(res))); });
  router.post('/schedule/preview', async (req, res) => {
    const { impact, campus } = await snapshot();
    const locations = locationsFromBundle(impact).map((location) => ({ ...location, buildingCodes: campus.locations[location.id]?.buildingCodes }));
    res.json(await previewSchedule(req.body, locations));
  });
  router.put('/schedule', async (req, res) => {
    const { impact } = await snapshot();
    const { items, ...metadata } = validateSchedule(req.body, locationsFromBundle(impact));
    const g = await account(res);
    const result = await pool!.query('UPDATE dashboard_accounts SET schedule=$1::jsonb, schedule_import=$2::jsonb, updated_at=now() WHERE id=$3 RETURNING schedule,schedule_import',
      [JSON.stringify(items), JSON.stringify({ ...metadata, importedAt: new Date().toISOString() }), g.id]);
    if (!result.rows[0]) { res.status(409).json({ error: 'Account profile was deleted.' }); return; }
    res.json(scheduleState(result.rows[0]));
  });
  router.delete('/schedule', async (_req, res) => {
    const g = await account(res);
    const result = await pool!.query("UPDATE dashboard_accounts SET schedule='[]'::jsonb, schedule_import=NULL, updated_at=now() WHERE id=$1 RETURNING id", [g.id]);
    if (!result.rows[0]) { res.status(409).json({ error: 'Account profile was deleted.' }); return; }
    res.json(emptySchedule());
  });
  router.patch('/profile', async (req, res) => {
    const parsed = profilePatch.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid profile fields.' }); return; }
    const { impact } = await snapshot();
    const ids = new Set(locationsFromBundle(impact).map((l) => l.id));
    if ([parsed.data.homeLocationId, parsed.data.studySpotId].some((id) => id != null && !ids.has(id))) { res.status(400).json({ error: 'Unknown campus location.' }); return; }
    const g = await account(res);
    const result = await pool!.query('UPDATE dashboard_accounts SET profile=profile || $1::jsonb, updated_at=now() WHERE id=$2 RETURNING profile', [JSON.stringify(parsed.data), g.id]);
    if (!result.rows[0]) { res.status(409).json({ error: 'Account profile was deleted.' }); return; }
    res.json(result.rows[0].profile);
  });
  router.patch('/preferences', async (req, res) => {
    const parsed = preferencesPatch.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid notification preferences.' }); return; }
    const g = await account(res);
    const result = await pool!.query('UPDATE dashboard_accounts SET preferences=preferences || $1::jsonb, updated_at=now() WHERE id=$2 RETURNING preferences', [JSON.stringify(parsed.data), g.id]);
    if (!result.rows[0]) { res.status(409).json({ error: 'Account profile was deleted.' }); return; }
    res.json(result.rows[0].preferences);
  });
  router.put('/following/:id', async (req, res) => {
    const parsed = z.object({ following: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success || String(req.params.id).length > 1000) { res.status(400).json({ error: 'Invalid following request.' }); return; }
    const { impact } = await snapshot();
    if (!clubsFromBundle(impact).some((c) => c.id === req.params.id)) { res.status(400).json({ error: 'Unknown published organizer.' }); return; }
    const g = await account(res);
    const result = await pool!.query(`UPDATE dashboard_accounts SET following=CASE WHEN $1 THEN array_append(array_remove(following,$2),$2) ELSE array_remove(following,$2) END, updated_at=now() WHERE id=$3 RETURNING following`, [parsed.data.following, req.params.id, g.id]);
    if (!result.rows[0]) { res.status(409).json({ error: 'Account profile was deleted.' }); return; }
    res.json(result.rows[0].following);
  });
  router.get('/export', async (req, res) => {
    const g = await account(res);
    res.json({ exportedAt: new Date().toISOString(), account: session(g, res.locals.dashboardUser).user, profile: g.profile, notificationPrefs: g.preferences, followedOrganizers: g.following, createdAt: g.created_at, updatedAt: g.updated_at, calendars: g.schedule_import ? [g.schedule_import] : [], events: g.schedule, scheduleImport: scheduleState(g) });
  });
  router.delete('/me', async (req, res) => {
    await pool!.query('DELETE FROM dashboard_accounts WHERE id=$1', [res.locals.dashboardUser.id]);
    res.status(204).end();
  });
  router.use((_error: unknown, _req: Request, res: Response, _next: import('express').NextFunction) => {
    if (_error instanceof ScheduleError) { res.status(_error.status).json({ error: _error.message }); return; }
    if (_error instanceof DashboardAuthError) { res.status(_error.status).json({ error: _error.message }); return; }
    console.error('dashboard database request failed');
    res.status(503).json({ error: 'Dashboard data is unavailable. Please try again later.' });
  });
  return router;
}
