/*
 * Where joined personas live between the phone and the display.
 *
 * The /join flow runs in the dashboard (port 5174 in dev) and the map page is served by that same
 * origin (web/vite.config.ts serves map.html and map-client/public), so one localStorage key is
 * enough to get a character from the builder onto the display: the phone writes, the map listens.
 *
 * Scope, stated plainly: localStorage is per-origin *and per-browser*. This carries a join from one
 * tab to another on the same machine, which is what the demo needs and what the prototype did in
 * component state. It does NOT carry a join from a student's phone to a separate display machine --
 * that needs a server endpoint, and the handoff does not specify one. The read/write surface here is
 * deliberately small so swapping localStorage for `fetch` later touches only this file.
 */

import { DEFAULT_APPEARANCE, type Appearance } from './parts';
import { newPersonaId, type Persona } from './model';

const KEY = 'flowcast.personas.v1';
/** Which persona belongs to this device, so /join can show "You're on the map" on a revisit. */
const MINE_KEY = 'flowcast.persona.mine.v1';
/** Same-tab writes do not fire `storage`; this does. */
const EVENT = 'flowcast:personas';

/** The display draws one extra ScenegraphLayer per persona, so the list is capped. */
export const MAX_PERSONAS = 24;

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

export function readPersonas(): Persona[] {
  const s = storage();
  if (!s) return [];
  try {
    const parsed: unknown = JSON.parse(s.getItem(KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(coerce)
      .filter((p): p is Persona => p !== null)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .slice(-MAX_PERSONAS);
  } catch {
    return [];
  }
}

function write(list: Persona[]): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(list.slice(-MAX_PERSONAS)));
  } catch {
    // A full quota is not worth breaking the flow over.
  }
  window.dispatchEvent(new Event(EVENT));
}

/** Add or replace one persona. Returns the stored record. */
export function savePersona(input: Omit<Persona, 'id' | 'joinedAt'> & { id?: string }): Persona {
  const persona: Persona = { ...input, id: input.id ?? newPersonaId(), joinedAt: Date.now() };
  const rest = readPersonas().filter((p) => p.id !== persona.id);
  write([...rest, persona]);
  return persona;
}

export function removePersona(id: string): void {
  write(readPersonas().filter((p) => p.id !== id));
}

/** The id of the persona built on this device, if it is still in the list. */
export function myPersonaId(): string | null {
  const s = storage();
  if (!s) return null;
  try {
    return s.getItem(MINE_KEY);
  } catch {
    return null;
  }
}

export function setMyPersonaId(id: string | null): void {
  const s = storage();
  if (!s) return;
  try {
    if (id === null) s.removeItem(MINE_KEY);
    else s.setItem(MINE_KEY, id);
  } catch {
    // See write().
  }
}

/**
 * Watch the list. Fires on this tab's own writes (the custom event) and on another tab's
 * (the `storage` event), so the display updates the moment a phone finishes the flow.
 */
export function subscribePersonas(onChange: (list: Persona[]) => void): () => void {
  const fire = () => onChange(readPersonas());
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === KEY) fire();
  };
  window.addEventListener(EVENT, fire);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(EVENT, fire);
    window.removeEventListener('storage', onStorage);
  };
}
