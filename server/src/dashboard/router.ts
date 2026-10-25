import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { openAt } from '../../../map-client/src/insights';
import { bostonDate, clubsFromBundle, forecastsFromBundle, locationsFromBundle, organizerId } from '../../../web/src/data/realData';
import type { Profile, NotificationPrefs } from '../../../web/src/data/types';
import type { Snapshot } from './import';
import { authConfig, createUserVerifier, DashboardAuthError, type AuthConfig, type VerifiedUser, type VerifyUser } from './auth';

const time = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]);
const location = z.string().min(1).max(160).nullable();
const profilePatch = z.object({ name: z.string().trim().max(100), homeLocationId: location, studySpotId: location, lunchTime: time, dinnerTime: time, avatarSwatch: z.number().int().min(0).max(5) }).partial().strict();
const preferencesPatch = z.object({ packedRoute: z.boolean(), clubEvents: z.boolean(), scheduleChanges: z.boolean() }).partial().strict();
interface Account { id: string; profile: Profile; preferences: NotificationPrefs; following: string[]; created_at: Date; updated_at: Date }
const blankProfile: Profile = { name: '', homeLocationId: null, studySpotId: null, lunchTime: '', dinnerTime: '', avatarSwatch: 0 };
const blankPrefs: NotificationPrefs = { packedRoute: false, clubEvents: false, scheduleChanges: false };
function session(account: Account, user: VerifiedUser) {
  return { user: { id: account.id, name: account.profile.name || 'Account', email: user.email, homeLocationId: account.profile.homeLocationId }, roles: [], officerOfClubId: null, calendarConnected: false, calendarSyncedAt: null, onboarded: false };
}
export function dashboardRouter(pool?: pg.Pool, options: { verifyUser?: VerifyUser; authConfig?: () => AuthConfig } = {}) {
  const config = options.authConfig ?? authConfig;
  const verifyUser = options.verifyUser ?? createUserVerifier(config);
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
    const result = await pool!.query('SELECT id,profile,preferences,following,created_at,updated_at FROM dashboard_accounts WHERE id=$1', [user.id]);
    return result.rows[0];
  }
  router.get('/auth/config', (_req, res) => { res.json(config()); });
  router.use(async (req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && /^\/public\/?$/i.test(req.path)) { next(); return; }
    const token = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '')?.[1];
    if (!token) throw new DashboardAuthError(401);
    res.locals.dashboardUser = await verifyUser(token);
    next();
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
    const events = impact.events.map((e) => ({ id: e.id, title: e.name, locationId: e.locationId, venue: e.locationName, start: e.start, end: e.end, organizer: e.organizer, clubId: e.organizer?.trim() ? organizerId(e.organizer.trim()) : null, source: 'terrier-central', sourceUrl: e.sourceUrl, mapStatus: e.status }));
    res.json({ locations: locationsFromBundle(impact), geo, events, impact, ...forecasts, clubs: clubsFromBundle(impact) });
  });
  router.get('/me', async (req, res) => {
    const g = await account(res);
    res.json({ session: session(g, res.locals.dashboardUser), profile: g.profile, notificationPrefs: g.preferences, following: g.following });
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
    res.json({ exportedAt: new Date().toISOString(), account: session(g, res.locals.dashboardUser).user, profile: g.profile, notificationPrefs: g.preferences, followedOrganizers: g.following, createdAt: g.created_at, updatedAt: g.updated_at, calendars: [], events: [] });
  });
  router.delete('/me', async (req, res) => {
    await pool!.query('DELETE FROM dashboard_accounts WHERE id=$1', [res.locals.dashboardUser.id]);
    res.status(204).end();
  });
  router.use((_error: unknown, _req: Request, res: Response, _next: import('express').NextFunction) => {
    if (_error instanceof DashboardAuthError) { res.status(_error.status).json({ error: _error.message }); return; }
    console.error('dashboard database request failed');
    res.status(503).json({ error: 'Dashboard data is unavailable. Please try again later.' });
  });
  return router;
}
