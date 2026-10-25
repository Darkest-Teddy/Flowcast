/*
 * /api/personas -- the phone writes a character here, the display reads them all.
 *
 * The two ends never talk to each other and never swap roles. A phone that scanned the QR code only
 * ever POSTs (and DELETEs) its own character; it never asks for the list, because it has no map to
 * draw. The display only ever GETs. So the read path is deliberately open and cheap, and every
 * write is guarded.
 *
 * What a persona may contain is not written down twice: the style and colour ids are validated
 * against the catalog the characters are actually assembled from (map-client/src/persona/parts.ts)
 * and the home location against the list the phone offers (persona/model.ts). Adding a hat to the
 * catalog therefore cannot be rejected here as an unknown hat.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { CATEGORIES, PALETTE } from '../../../map-client/src/persona/parts';
import { LOCATIONS } from '../../../map-client/src/persona/model';
import { limiter } from '../app';
import type { PersonaStore } from './store';
import { MAX_PERSONAS, PERSONA_TTL_HOURS } from './store';

/** The phone's own limits, so a name cannot be a paragraph on a 13px map label. */
export const MAX_NAME = 40;
export const MAX_BIO = 140;

/** The id shape newPersonaId() produces: `p-<base36 time>-<5 chars>`. */
const personaId = z.string().regex(/^p-[a-z0-9]{1,12}-[a-z0-9]{1,8}$/);
const token = z.string().regex(/^[a-f0-9]{64}$/);

const colorIds = PALETTE.map((c) => c.id);
const locationIds = LOCATIONS.map((l) => l.id);

/**
 * The appearance schema, built from the catalog: one key per style field restricted to that
 * category's option ids, one key per colour field restricted to the palette.
 */
const appearance = z
  .object(
    Object.fromEntries([
      ...CATEGORIES.map((c) => [c.field, z.enum(c.options.map((o) => o.id) as [string, ...string[]])] as const),
      ...CATEGORIES.filter((c) => c.color).map((c) => [c.color!, z.enum(colorIds as [string, ...string[]])] as const),
    ]),
  )
  .strict();

const writeBody = z
  .object({
    id: personaId,
    /** Trimmed and length-capped here, not just on the phone: the phone is not the authority. */
    name: z.string().trim().min(1).max(MAX_NAME),
    bio: z.string().trim().max(MAX_BIO),
    appearance,
    homeLocationId: z.enum(locationIds as [string, ...string[]]),
    /** Absent on the first write; required to change a character that already exists. */
    token: token.optional(),
  })
  .strict();

/**
 * A write must come from a page this server served.
 *
 * The same check the dashboard router makes. A persona is written with no login, so without it any
 * page on the internet could post characters onto a campus display in the background.
 */
function sameOrigin(req: Request): boolean {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  // A same-origin fetch from a browser always sends Origin on POST/DELETE.
  if (!req.headers.origin) return false;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch {
    return false;
  }
}

export interface PersonaRouterOptions {
  /** Writes per client address per minute. A phone needs a handful; a script wants thousands. */
  writesPerMinute?: number;
  maxClients?: number;
}

export function personasRouter(store: PersonaStore, options: PersonaRouterOptions = {}) {
  const router = Router();
  const writes = limiter(options.writesPerMinute ?? 20, 60_000, options.maxClients ?? 10_000);

  /** The display polls this every few seconds; it must never be cached by anything in between. */
  router.get('/', async (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const list = await store.list();
    // The display sends back the revision it already has, and gets nothing when nothing moved.
    const since = typeof _req.query.since === 'string' ? _req.query.since : undefined;
    if (since && since === list.revision) {
      res.json({ revision: list.revision, unchanged: true, durable: store.durable });
      return;
    }
    res.json({ ...list, unchanged: false, durable: store.durable, max: MAX_PERSONAS, ttlHours: PERSONA_TTL_HOURS });
  });

  router.post('/', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) {
      res.status(403).json({ error: 'A same-origin request is required.' });
      return;
    }
    if (!writes(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'Too many changes. Try again in a minute.' });
      return;
    }
    const parsed = writeBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: `Send { id, name (1-${MAX_NAME} characters), bio, appearance, homeLocationId }.` });
      return;
    }
    const { token: supplied, ...draft } = parsed.data;
    const result = await store.write(draft as Parameters<PersonaStore['write']>[0], supplied);
    if (!result.ok) {
      if (result.reason === 'full') {
        res.status(409).json({ error: `The map is showing all ${MAX_PERSONAS} characters it can. Try again later.`, reason: 'full' });
        return;
      }
      // The phone holds no token for this id, or the wrong one: it must pick a new id and retry.
      res.status(409).json({ error: 'That character belongs to another device.', reason: 'conflict' });
      return;
    }
    res.status(201).json({ persona: result.persona, token: result.token });
  });

  router.delete('/:id', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!sameOrigin(req)) {
      res.status(403).json({ error: 'A same-origin request is required.' });
      return;
    }
    if (!writes(req.ip ?? 'unknown')) {
      res.status(429).json({ error: 'Too many changes. Try again in a minute.' });
      return;
    }
    const id = personaId.safeParse(req.params.id);
    const supplied = token.safeParse(req.headers['x-persona-token']);
    if (!id.success || !supplied.success) {
      res.status(400).json({ error: 'Send the persona id and its token.' });
      return;
    }
    // 204 either way: a phone deleting a character that already expired has got what it wanted,
    // and a wrong token must not be distinguishable from a missing row.
    await store.remove(id.data, supplied.data);
    res.status(204).end();
  });

  router.use((error: unknown, _req: Request, res: Response, _next: import('express').NextFunction) => {
    console.error(`persona request failed: ${error instanceof Error ? error.name : 'unknown'}`);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(503).json({ error: 'Characters are unavailable right now.' });
  });

  return router;
}
