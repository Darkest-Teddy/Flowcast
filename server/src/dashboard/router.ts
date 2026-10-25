import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { openAt } from '../../../map-client/src/insights';
import { bostonDate, clubsFromBundle, forecastsFromBundle, locationsFromBundle, organizerId } from '../../../web/src/data/realData';
import type { Profile, NotificationPrefs } from '../../../web/src/data/types';
import type { Snapshot } from './import';

const cookieName = 'flowcast_guest';
const duration = 30 * 86400 * 1000;
const time = z.union([z.literal(''), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)]);
const location = z.string().min(1).max(160).nullable();
const profilePatch = z.object({ name: z.string().trim().max(100), homeLocationId: location, studySpotId: location, lunchTime: time, dinnerTime: time, avatarSwatch: z.number().int().min(0).max(5) }).partial().strict();
const preferencesPatch = z.object({ packedRoute: z.boolean(), clubEvents: z.boolean(), scheduleChanges: z.boolean() }).partial().strict();
interface Guest { id: string; profile: Profile; preferences: NotificationPrefs; following: string[]; created_at: Date; updated_at: Date }
const blankProfile: Profile = { name: '', homeLocationId: null, studySpotId: null, lunchTime: '', dinnerTime: '', avatarSwatch: 0 };
const blankPrefs: NotificationPrefs = { packedRoute: false, clubEvents: false, scheduleChanges: false };
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const cookieOptions = () => ({ httpOnly: true, sameSite: 'lax' as const, secure: process.env.NODE_ENV === 'production', path: '/api/dashboard' });
function tokenFrom(req: Request) {
  const token = req.headers.cookie?.split(';').map((v) => v.trim()).find((v) => v.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
  return token && /^[a-f0-9]{64}$/.test(token) ? token : undefined;
}
function session(guest: Guest) {
  return { user: { id: guest.id, name: guest.profile.name || 'Guest', email: '', homeLocationId: guest.profile.homeLocationId }, roles: [], officerOfClubId: null, calendarConnected: false, calendarSyncedAt: null, onboarded: false };
}
export function dashboardRouter(pool?: pg.Pool) {
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
    if (!pool) { res.status(503).json({ error: 'Dashboard database is unavailable.' }); return; }
    next();
  });
  async function snapshot(): Promise<Snapshot> {
    const result = await pool!.query('SELECT payload FROM dashboard_snapshots JOIN dashboard_current ON hash=snapshot_hash WHERE singleton=true');
    if (!result.rows.length) throw new Error('Snapshot unavailable');
    return result.rows[0].payload;
  }
  async function guest(req: Request, res: Response): Promise<Guest> {
    const token = tokenFrom(req);
    if (token) {
      const result = await pool!.query('SELECT id,profile,preferences,following,created_at,updated_at FROM dashboard_guests WHERE token_hash=$1 AND expires_at>now()', [tokenHash(token)]);
      if (result.rows[0]) return result.rows[0];
    }
    const fresh = randomBytes(32).toString('hex');
    const result = await pool!.query('INSERT INTO dashboard_guests(id,token_hash,profile,preferences) VALUES($1,$2,$3,$4) RETURNING id,profile,preferences,following,created_at,updated_at', [randomUUID(), tokenHash(fresh), blankProfile, blankPrefs]);
    res.cookie(cookieName, fresh, { ...cookieOptions(), maxAge: duration });
    return result.rows[0];
  }
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
    const g = await guest(req, res);
    res.json({ session: session(g), profile: g.profile, notificationPrefs: g.preferences, following: g.following });
  });
  router.patch('/profile', async (req, res) => {
    const parsed = profilePatch.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid profile fields.' }); return; }
    const { impact } = await snapshot();
    const ids = new Set(locationsFromBundle(impact).map((l) => l.id));
    if ([parsed.data.homeLocationId, parsed.data.studySpotId].some((id) => id != null && !ids.has(id))) { res.status(400).json({ error: 'Unknown campus location.' }); return; }
    const g = await guest(req, res);
    const result = await pool!.query('UPDATE dashboard_guests SET profile=profile || $1::jsonb, updated_at=now() WHERE id=$2 RETURNING profile', [JSON.stringify(parsed.data), g.id]);
    if (!result.rows[0]) { res.status(409).json({ error: 'Guest session was deleted.' }); return; }
    res.json(result.rows[0].profile);
  });
  router.patch('/preferences', async (req, res) => {
    const parsed = preferencesPatch.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid notification preferences.' }); return; }
    const g = await guest(req, res);
    const result = await pool!.query('UPDATE dashboard_guests SET preferences=preferences || $1::jsonb, updated_at=now() WHERE id=$2 RETURNING preferences', [JSON.stringify(parsed.data), g.id]);
    if (!result.rows[0]) { res.status(409).json({ error: 'Guest session was deleted.' }); return; }
    res.json(result.rows[0].preferences);
  });
  router.put('/following/:id', async (req, res) => {
    const parsed = z.object({ following: z.boolean() }).strict().safeParse(req.body);
    if (!parsed.success || String(req.params.id).length > 1000) { res.status(400).json({ error: 'Invalid following request.' }); return; }
    const { impact } = await snapshot();
    if (!clubsFromBundle(impact).some((c) => c.id === req.params.id)) { res.status(400).json({ error: 'Unknown published organizer.' }); return; }
    const g = await guest(req, res);
    const result = await pool!.query(`UPDATE dashboard_guests SET following=CASE WHEN $1 THEN array_append(array_remove(following,$2),$2) ELSE array_remove(following,$2) END, updated_at=now() WHERE id=$3 RETURNING following`, [parsed.data.following, req.params.id, g.id]);
    if (!result.rows[0]) { res.status(409).json({ error: 'Guest session was deleted.' }); return; }
    res.json(result.rows[0].following);
  });
  router.get('/export', async (req, res) => {
    const g = await guest(req, res);
    res.json({ exportedAt: new Date().toISOString(), account: session(g).user, profile: g.profile, notificationPrefs: g.preferences, followedOrganizers: g.following, createdAt: g.created_at, updatedAt: g.updated_at, calendars: [], events: [] });
  });
  router.delete('/me', async (req, res) => {
    const token = tokenFrom(req);
    if (token) await pool!.query('DELETE FROM dashboard_guests WHERE token_hash=$1', [tokenHash(token)]);
    res.clearCookie(cookieName, cookieOptions()); res.status(204).end();
  });
  router.use((_error: unknown, _req: Request, res: Response, _next: import('express').NextFunction) => {
    console.error('dashboard database request failed');
    res.status(503).json({ error: 'Dashboard data is unavailable. Please try again later.' });
  });
  return router;
}
