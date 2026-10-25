/*
 * Talking to /api/personas.
 *
 * This is the whole network surface for joined characters, and it is deliberately the only file that
 * knows a server exists: store.ts calls these four functions and otherwise behaves exactly as it did
 * when the list lived in localStorage.
 *
 * Nothing here throws. A display with no network must keep drawing the map, and a phone that cannot
 * reach the server must be told plainly rather than shown a stack trace -- so a read failure is
 * `null` ("no news") and a write failure is a tagged result the phone can put on screen.
 *
 * Both apps are served from the same origin as the API (web/vite.config.ts proxies /api/personas in
 * dev, serve.mjs in production), so these are same-origin relative URLs and no CORS is involved.
 */

import { DEFAULT_APPEARANCE, type Appearance } from './parts';
import { DEFAULT_LOCATION_ID, type Persona } from './model';

const BASE = '/api/personas';

/** Give up rather than hang: the display polls on a timer and a stuck request must not stack up. */
const TIMEOUT_MS = 8000;

export interface RemoteSnapshot {
  revision: string;
  personas: Persona[];
  /** False when the server is holding characters in memory, so a restart loses them. */
  durable: boolean;
}

export type WriteOutcome =
  | { ok: true; persona: Persona; token: string }
  /** The id is someone else's. The caller should retry once with a fresh id. */
  | { ok: false; reason: 'conflict' }
  /** The display is already showing all the characters it can. */
  | { ok: false; reason: 'full' }
  /** No network, a 500, a timeout: worth retrying later, unchanged. */
  | { ok: false; reason: 'offline' }
  /** The server refused the character itself; retrying will not help. */
  | { ok: false; reason: 'rejected' };

function signal(): AbortSignal | undefined {
  try {
    return AbortSignal.timeout(TIMEOUT_MS);
  } catch {
    // Older browsers: no timeout rather than no request.
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Trust nothing on the wire, for the same reason store.ts trusted nothing in localStorage: one
 * half-written record must not stop the display drawing the other twenty-three.
 */
function coerce(raw: unknown): Persona | null {
  if (!isRecord(raw)) return null;
  const { id, name, bio, appearance, homeLocationId, joinedAt } = raw;
  if (typeof id !== 'string' || !id) return null;
  if (typeof name !== 'string' || !name.trim()) return null;
  return {
    id,
    name: name.trim(),
    bio: typeof bio === 'string' ? bio : '',
    // Merging over the default keeps a record renderable when the catalog gains a field.
    appearance: { ...DEFAULT_APPEARANCE, ...(isRecord(appearance) ? (appearance as Partial<Appearance>) : {}) },
    homeLocationId: typeof homeLocationId === 'string' ? homeLocationId : DEFAULT_LOCATION_ID,
    joinedAt: typeof joinedAt === 'number' ? joinedAt : 0,
  };
}

/**
 * The list the display draws.
 *
 * Pass the revision already held and the server answers `'unchanged'` without sending the list
 * again, which is what makes polling every few seconds cheap. `null` means the request failed and
 * the caller should keep what it has.
 */
export async function fetchPersonas(since?: string): Promise<RemoteSnapshot | 'unchanged' | null> {
  try {
    const url = since ? `${BASE}?since=${encodeURIComponent(since)}` : BASE;
    const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: signal() });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.revision !== 'string') return null;
    if (body.unchanged === true) return 'unchanged';
    if (!Array.isArray(body.personas)) return null;
    return {
      revision: body.revision,
      personas: body.personas.map(coerce).filter((p): p is Persona => p !== null),
      durable: body.durable !== false,
    };
  } catch {
    return null;
  }
}

/** What the phone sends: the character, and the token proving it owns an id it has written before. */
export interface PersonaWrite {
  id: string;
  name: string;
  bio: string;
  appearance: Appearance;
  homeLocationId: string;
}

export async function pushPersona(draft: PersonaWrite, token?: string): Promise<WriteOutcome> {
  try {
    const response = await fetch(BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token ? { ...draft, token } : draft),
      signal: signal(),
    });
    if (response.status === 409) {
      const body: unknown = await response.json().catch(() => null);
      return { ok: false, reason: isRecord(body) && body.reason === 'full' ? 'full' : 'conflict' };
    }
    // 400 is the character itself being refused; 403 means this page is not allowed to write.
    if (response.status === 400 || response.status === 403) return { ok: false, reason: 'rejected' };
    if (!response.ok) return { ok: false, reason: 'offline' };
    const body: unknown = await response.json();
    if (!isRecord(body) || typeof body.token !== 'string') return { ok: false, reason: 'offline' };
    const persona = coerce(body.persona);
    if (!persona) return { ok: false, reason: 'offline' };
    return { ok: true, persona, token: body.token };
  } catch {
    return { ok: false, reason: 'offline' };
  }
}

/** True when the server has it gone. False means "try again"; the caller keeps the token. */
export async function deletePersona(id: string, token: string): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'X-Persona-Token': token },
      signal: signal(),
    });
    return response.ok;
  } catch {
    return false;
  }
}
