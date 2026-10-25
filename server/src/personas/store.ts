/*
 * Where joined characters live between the phone and the display.
 *
 * The phone and the display are two different devices, so the handoff cannot be localStorage: a
 * student scans the QR code, builds a character on their own phone, and a display across the room
 * has to draw it. That needs a server, and this is it -- the one place a persona is written down.
 *
 * Two backends behind one interface:
 *  - Postgres, when DATABASE_URL is set. Joins survive a restart and a deploy.
 *  - Memory, when it is not. A laptop running the demo with no database still carries a character
 *    from a phone to the display, which is the thing being demonstrated; the list is just lost on
 *    restart. A 503 here would make the feature look broken on exactly the setup most likely to be
 *    showing it.
 *
 * Ownership is a token, not a session cookie. The phone invents the persona id and the server mints
 * a secret on first write; only a request carrying that secret can change or delete that character.
 * Without it, anyone who can read a name off the display could rename or delete that person -- the
 * ids are short and the display shows them walking around all day. The token is hashed here exactly
 * like the dashboard's guest tokens, so a dump of this table does not let anyone edit anything.
 */

import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { Appearance, Persona } from '../../../map-client/src/persona/model';

/**
 * How many characters the display draws. The map adds layers per persona (persona/layers.ts), and
 * the labels become unreadable mush long before this -- it is a display, not a guest book.
 */
export const MAX_PERSONAS = 24;

/**
 * How long a join lasts. A public display should not still be showing yesterday's visitors, and
 * nobody comes back to delete their own character.
 */
export const PERSONA_TTL_HOURS = 24;

/** A stored persona, plus the bookkeeping the client never sees. */
export interface StoredPersona extends Persona {
  /** Epoch ms of the last write, so the revision changes when a character is edited in place. */
  updatedAt: number;
}

export interface PersonaList {
  /** Changes whenever the list does. The display polls with it and gets back "unchanged". */
  revision: string;
  personas: Persona[];
}

/** What a write asks for. `id` is the phone's; `joinedAt` is the server's to stamp. */
export interface PersonaDraft {
  id: string;
  name: string;
  bio: string;
  appearance: Appearance;
  homeLocationId: string;
}

export type WriteResult =
  | { ok: true; persona: Persona; token: string }
  /** The id is taken by someone else's character. The phone retries once with a new one. */
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'full' };

export interface PersonaStore {
  list(): Promise<PersonaList>;
  /** Create, or replace the caller's own. `token` is undefined on the first write. */
  write(draft: PersonaDraft, token: string | undefined): Promise<WriteResult>;
  remove(id: string, token: string): Promise<boolean>;
  /** True when a restart will lose the list, which /api/personas reports so the UI can say so. */
  readonly durable: boolean;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
const newToken = () => randomBytes(32).toString('hex');

/**
 * A short digest of the list's identity: every id and when it last changed.
 *
 * Not a counter, because a counter has to be stored somewhere and kept in step between the two
 * backends; a digest is derived from the rows themselves and so is correct after an insert, an edit,
 * a delete and an expiry alike.
 */
export function revisionOf(rows: readonly { id: string; updatedAt: number }[]): string {
  if (rows.length === 0) return 'empty';
  const material = [...rows]
    .map((r) => `${r.id}:${r.updatedAt}`)
    .sort()
    .join('|');
  return createHash('sha1').update(material).digest('hex').slice(0, 16);
}

/**
 * What goes over the wire: exactly the Persona the map draws, and nothing else.
 *
 * Built field by field rather than by stripping the fields we happen to know about. The rows carry
 * a token hash and an expiry, and a backend is free to carry more; listing what is public is the
 * only version of this that stays safe when a row gains a column.
 */
function toPersona(row: StoredPersona): Persona {
  return {
    id: row.id,
    name: row.name,
    bio: row.bio,
    appearance: row.appearance,
    homeLocationId: row.homeLocationId,
    joinedAt: row.joinedAt,
  };
}

/** The newest MAX_PERSONAS, oldest first -- the order the map's own store used. */
function trim(rows: StoredPersona[]): StoredPersona[] {
  return [...rows].sort((a, b) => a.joinedAt - b.joinedAt).slice(-MAX_PERSONAS);
}

/* ---------------------------------------------------------------------------
 * Memory
 * ------------------------------------------------------------------------- */

export function memoryPersonaStore(now: () => number = Date.now): PersonaStore {
  const rows = new Map<string, StoredPersona & { tokenHash: string; expiresAt: number }>();

  const live = () => {
    const t = now();
    for (const [id, row] of rows) if (row.expiresAt <= t) rows.delete(id);
    return trim([...rows.values()]);
  };

  return {
    durable: false,
    async list() {
      const rowsNow = live();
      return { revision: revisionOf(rowsNow), personas: rowsNow.map(toPersona) };
    },
    async write(draft, token) {
      const t = now();
      live();
      const existing = rows.get(draft.id);
      if (existing && (!token || existing.tokenHash !== hashToken(token))) return { ok: false, reason: 'conflict' };
      // A full list still lets someone edit the character they already have.
      if (!existing && rows.size >= MAX_PERSONAS) return { ok: false, reason: 'full' };
      const issued = existing ? token! : newToken();
      const row = {
        ...draft,
        // An edit keeps its place in the queue; only a new character goes to the back.
        joinedAt: existing?.joinedAt ?? t,
        updatedAt: t,
        tokenHash: existing?.tokenHash ?? hashToken(issued),
        expiresAt: t + PERSONA_TTL_HOURS * 3_600_000,
      };
      rows.set(draft.id, row);
      return { ok: true, persona: toPersona(row), token: issued };
    },
    async remove(id, token) {
      const row = rows.get(id);
      if (!row || row.tokenHash !== hashToken(token)) return false;
      rows.delete(id);
      return true;
    },
  };
}

/* ---------------------------------------------------------------------------
 * Postgres
 * ------------------------------------------------------------------------- */

/** Rows whose expiry has passed are never read, and are swept on the next write. */
const SELECT_LIVE = `SELECT id, name, bio, appearance, home_location_id, joined_at, updated_at
  FROM map_personas WHERE expires_at > now() ORDER BY joined_at ASC LIMIT ${MAX_PERSONAS}`;

interface Row {
  id: string;
  name: string;
  bio: string;
  appearance: Appearance;
  home_location_id: string;
  joined_at: Date;
  updated_at: Date;
}

const fromRow = (r: Row): StoredPersona => ({
  id: r.id,
  name: r.name,
  bio: r.bio,
  appearance: r.appearance,
  homeLocationId: r.home_location_id,
  joinedAt: r.joined_at.getTime(),
  updatedAt: r.updated_at.getTime(),
});

export function pgPersonaStore(pool: pg.Pool): PersonaStore {
  return {
    durable: true,
    async list() {
      const result = await pool.query<Row>(SELECT_LIVE);
      const rows = result.rows.map(fromRow);
      return { revision: revisionOf(rows), personas: rows.map(toPersona) };
    },
    async write(draft, token) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Expired rows must not hold an id or count against the cap.
        await client.query('DELETE FROM map_personas WHERE expires_at <= now()');
        const existing = await client.query<{ token_hash: string }>('SELECT token_hash FROM map_personas WHERE id=$1 FOR UPDATE', [draft.id]);
        const held = existing.rows[0];
        if (held && (!token || held.token_hash !== hashToken(token))) {
          await client.query('ROLLBACK');
          return { ok: false, reason: 'conflict' };
        }
        if (!held) {
          const count = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM map_personas');
          if (Number(count.rows[0].n) >= MAX_PERSONAS) {
            await client.query('ROLLBACK');
            return { ok: false, reason: 'full' };
          }
        }
        const issued = held ? token! : newToken();
        const result = await client.query<Row>(
          `INSERT INTO map_personas (id, token_hash, name, bio, appearance, home_location_id, expires_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, now() + ($7 || ' hours')::interval)
           ON CONFLICT (id) DO UPDATE SET
             name = EXCLUDED.name, bio = EXCLUDED.bio, appearance = EXCLUDED.appearance,
             home_location_id = EXCLUDED.home_location_id, updated_at = now(), expires_at = EXCLUDED.expires_at
           RETURNING id, name, bio, appearance, home_location_id, joined_at, updated_at`,
          [draft.id, held ? held.token_hash : hashToken(issued), draft.name, draft.bio, JSON.stringify(draft.appearance), draft.homeLocationId, String(PERSONA_TTL_HOURS)],
        );
        await client.query('COMMIT');
        return { ok: true, persona: toPersona(fromRow(result.rows[0])), token: issued };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async remove(id, token) {
      const result = await pool.query('DELETE FROM map_personas WHERE id=$1 AND token_hash=$2', [id, hashToken(token)]);
      return (result.rowCount ?? 0) > 0;
    },
  };
}

/** The store this server should use: Postgres when there is one, memory otherwise. */
export function personaStore(pool?: pg.Pool): PersonaStore {
  return pool ? pgPersonaStore(pool) : memoryPersonaStore();
}
