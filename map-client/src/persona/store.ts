/*
 * Where joined personas live between the phone and the display.
 *
 * The two ends of this feature are two different devices and they have different jobs, so this file
 * has two halves that barely touch:
 *
 *  - The DISPLAY (map.html) reads. `readPersonas()` is the list it draws and `subscribePersonas()`
 *    keeps it current by polling /api/personas. It never writes.
 *  - The PHONE (/join) writes. `saveMyPersona()` posts one character and `readMyPersona()` recovers
 *    it on a revisit. The phone has no map to draw, so it never reads the list at all -- it holds
 *    only its own character, and the token that proves the character is its to edit.
 *
 * This used to be one localStorage key, which could only ever carry a join between two tabs of the
 * same browser -- a student's phone and a display across the room are not that. The server
 * (server/src/personas) is the handoff now. localStorage keeps two much smaller jobs: the phone's
 * own character and token, and a mirror of the last list the display saw, so a display that starts
 * up during a network blip still has people on it.
 */

import { DEFAULT_APPEARANCE, type Appearance } from './parts';
import { newPersonaId, type Persona } from './model';
import { deletePersona, fetchPersonas, pushPersona, type WriteOutcome } from './remote';

/** The display's mirror of the last list it fetched. Not the source of truth; the server is. */
const LIST_KEY = 'flowcast.personas.v1';
/** The phone's own character and its edit token. */
const MINE_KEY = 'flowcast.persona.mine.v2';
/** The pre-server key, read once so a character built before this change is not orphaned. */
const LEGACY_MINE_KEY = 'flowcast.persona.mine.v1';
/** Same-tab writes do not fire `storage`; this does. */
const EVENT = 'flowcast:personas';

/**
 * How many characters the display draws. Mirrors MAX_PERSONAS in server/src/personas/store.ts,
 * which is the one that actually enforces it; this copy only shapes the local mirror.
 */
export const MAX_PERSONAS = 24;

/** How often the display asks for the list. Fast enough that a join feels immediate from the room. */
const POLL_MS = 3000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Trust nothing in storage: it survives deploys, and a half-written record must not break the map. */
function coerce(raw: unknown): Persona | null {
  if (!isRecord(raw)) return null;
  const { id, name, bio, appearance, homeLocationId, joinedAt } = raw;
  if (typeof id !== 'string' || !id) return null;
  if (typeof name !== 'string' || !name.trim()) return null;
  return {
    id,
    name: name.trim(),
    bio: typeof bio === 'string' ? bio : '',
    // Merging over the default keeps an older record renderable when the catalog gains a field.
    appearance: { ...DEFAULT_APPEARANCE, ...(isRecord(appearance) ? (appearance as Partial<Appearance>) : {}) },
    homeLocationId: typeof homeLocationId === 'string' ? homeLocationId : 'warren',
    joinedAt: typeof joinedAt === 'number' ? joinedAt : 0,
  };
}

function storage(): Storage | null {
  // Private browsing and SSR both make this throw rather than return null.
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function readJson(key: string): unknown {
  const s = storage();
  if (!s) return null;
  try {
    const raw = s.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(key, JSON.stringify(value));
  } catch {
    // A full quota is not worth breaking the flow over.
  }
}

/* ---------------------------------------------------------------------------
 * The display: read the list, keep it current
 * ------------------------------------------------------------------------- */

function readMirror(): Persona[] {
  const parsed = readJson(LIST_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(coerce)
    .filter((p): p is Persona => p !== null)
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .slice(-MAX_PERSONAS);
}

/** Seeded from the mirror so the first frame has people on it, then replaced by the server's list. */
let cache: Persona[] = readMirror();
/** The revision `cache` came from, sent back on the next poll so an idle server answers cheaply. */
let revision: string | null = null;
/** False once the server says it is holding characters in memory. */
let durable = true;
/** True once a fetch has come back, so "no characters" can be told apart from "not asked yet". */
let loaded = false;

const listeners = new Set<(list: Persona[]) => void>();

function emit(): void {
  for (const listener of listeners) listener(cache);
  try {
    window.dispatchEvent(new Event(EVENT));
  } catch {
    // Not a browser; nothing is listening anyway.
  }
}

/** The characters the display should be drawing right now. Synchronous: it is read every frame. */
export function readPersonas(): Persona[] {
  return cache;
}

/** False when the server is keeping characters in memory, so a restart will lose them. */
export function personasAreDurable(): boolean {
  return durable;
}

/** True once the first fetch has answered, whatever it said. */
export function personasLoaded(): boolean {
  return loaded;
}

/** One poll. Exported for the tests; the display goes through subscribePersonas(). */
export async function refreshPersonas(): Promise<void> {
  const result = await fetchPersonas(revision ?? undefined);
  loaded = loaded || result !== null;
  // null is a failed request and 'unchanged' is a quiet one: in both cases keep what we have.
  if (result === null || result === 'unchanged') return;
  durable = result.durable;
  revision = result.revision;
  cache = [...result.personas].sort((a, b) => a.joinedAt - b.joinedAt);
  writeJson(LIST_KEY, cache);
  emit();
}

let pollTimer: ReturnType<typeof setInterval> | undefined;
let onVisible: (() => void) | undefined;

function startPolling(): void {
  if (pollTimer !== undefined) return;
  void refreshPersonas();
  pollTimer = setInterval(() => {
    // A display in a background tab is nobody's display; stop asking until it is looked at again.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    void refreshPersonas();
  }, POLL_MS);
  if (typeof document !== 'undefined') {
    onVisible = () => {
      if (document.visibilityState === 'visible') void refreshPersonas();
    };
    document.addEventListener('visibilitychange', onVisible);
  }
}

function stopPolling(): void {
  if (pollTimer !== undefined) clearInterval(pollTimer);
  pollTimer = undefined;
  if (onVisible && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
  onVisible = undefined;
}

/**
 * Watch the list, and keep it current while anyone is watching.
 *
 * The first subscriber starts the poll and the last one to leave stops it, so the map page does not
 * keep asking after it is torn down.
 */
export function subscribePersonas(onChange: (list: Persona[]) => void): () => void {
  listeners.add(onChange);
  startPolling();
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0) stopPolling();
  };
}

/* ---------------------------------------------------------------------------
 * The phone: one character, and the token that owns it
 * ------------------------------------------------------------------------- */

/** The phone's own character, plus the secret that lets it edit or delete it. */
export interface MyPersona {
  persona: Persona;
  /** Absent only for a character saved before the server existed, or saved while offline. */
  token?: string;
}

export function readMyPersona(): MyPersona | null {
  const parsed = readJson(MINE_KEY);
  if (isRecord(parsed)) {
    const persona = coerce(parsed.persona);
    if (persona) return { persona, token: typeof parsed.token === 'string' ? parsed.token : undefined };
  }
  // A character built before the handoff moved to the server: the old key held only an id, and the
  // record itself was in the list. There is no token for it, so it is re-posted on the next save.
  const legacyId = readJson(LEGACY_MINE_KEY);
  if (typeof legacyId === 'string' && legacyId) {
    const found = readMirror().find((p) => p.id === legacyId);
    if (found) return { persona: found };
  }
  return null;
}

function writeMine(value: MyPersona | null): void {
  const s = storage();
  if (!s) return;
  try {
    if (value === null) {
      s.removeItem(MINE_KEY);
      s.removeItem(LEGACY_MINE_KEY);
    } else {
      s.setItem(MINE_KEY, JSON.stringify(value));
    }
  } catch {
    // See writeJson().
  }
}

/** The id of the character built on this device, if there is one. */
export function myPersonaId(): string | null {
  return readMyPersona()?.persona.id ?? null;
}

/** What the phone collects on the form. The id and joinedAt are not its to choose. */
export interface PersonaDraft {
  name: string;
  bio: string;
  appearance: Appearance;
  homeLocationId: string;
}

export type SaveResult =
  | { ok: true; persona: Persona }
  | { ok: false; reason: Exclude<Extract<WriteOutcome, { ok: false }>['reason'], 'conflict'> };

/**
 * Put this device's character on the map, creating it or replacing the one already there.
 *
 * Asynchronous and honest about failing: the phone's whole purpose is to get a character onto a
 * display somewhere else, so a save that did not reach the server is not a save, and the caller
 * must be able to say so instead of showing "You're on the map".
 *
 * A `conflict` means the generated id is already somebody else's character. That is a collision
 * between two random ids rather than anything the student did, so it is retried once with a new id
 * and never surfaces.
 */
export async function saveMyPersona(draft: PersonaDraft): Promise<SaveResult> {
  const mine = readMyPersona();
  // Editing keeps the id, so the character on the display changes rather than a second one appearing.
  const first = await pushPersona({ id: mine?.persona.id ?? newPersonaId(), ...draft }, mine?.token);
  const outcome = first.ok || first.reason !== 'conflict' ? first : await pushPersona({ id: newPersonaId(), ...draft });
  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason === 'conflict' ? 'offline' : outcome.reason };
  }
  writeMine({ persona: outcome.persona, token: outcome.token });
  // The display will see it on its next poll; this is for a phone that somehow also has the list.
  cache = [...cache.filter((p) => p.id !== outcome.persona.id), outcome.persona].sort((a, b) => a.joinedAt - b.joinedAt);
  emit();
  return { ok: true, persona: outcome.persona };
}

/**
 * Take this device's character off the map.
 *
 * Returns false when the server could not be reached, in which case the character is still on the
 * display and the phone keeps its token so the student can try again. The local record is cleared
 * only once the server has actually let go of it.
 */
export async function removeMyPersona(): Promise<boolean> {
  const mine = readMyPersona();
  if (!mine) return true;
  // No token: a pre-server character, which the server never had. Forgetting it locally is all
  // there is to do -- and it has long since expired from any list.
  if (!mine.token) {
    writeMine(null);
    return true;
  }
  const gone = await deletePersona(mine.persona.id, mine.token);
  if (!gone) return false;
  writeMine(null);
  cache = cache.filter((p) => p.id !== mine.persona.id);
  emit();
  return true;
}

/** Forget this device's character without touching the server. Used when the record is unusable. */
export function forgetMyPersona(): void {
  writeMine(null);
}
