// Where personas actually live today: localStorage, shared by every tab of one browser on one
// device. Real cross-device sync (a phone's join reaching a separate laptop's map) needs the
// planned `/server` -- this intentionally doesn't fake that. Written to the exact key and shape
// web/src/lib/personaStore.ts uses, since /join and the map are served from the same origin
// (web's dev/prod server, which mounts map-client at /map) and so do genuinely share this
// browser's localStorage today.
import type { Persona } from './persona';

export const PERSONA_STORAGE_KEY = 'flowcast.personas.v1';

function readAll(): Persona[] {
  try {
    const raw = localStorage.getItem(PERSONA_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persona[]) : [];
  } catch {
    return [];
  }
}

/** Current personas, read fresh each call (cheap: this is a handful of small JSON records). */
export function getPersonas(): Persona[] {
  return readAll();
}

/** Notifies subscribers in THIS tab; the native `storage` event only fires in other tabs. */
const SAME_TAB_EVENT = 'flowcast:personas-changed';

/** Fires whenever the persona list changes, in this tab or another one sharing this browser. */
export function subscribePersonas(onChange: (personas: Persona[]) => void): () => void {
  const handler = () => onChange(readAll());
  window.addEventListener('storage', handler);
  window.addEventListener(SAME_TAB_EVENT, handler);
  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener(SAME_TAB_EVENT, handler);
  };
}

function writeAll(personas: Persona[]) {
  localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(personas));
  window.dispatchEvent(new Event(SAME_TAB_EVENT));
}

export function upsertPersona(persona: Persona) {
  const all = readAll().filter((p) => p.id !== persona.id);
  all.push(persona);
  writeAll(all);
}

export function removePersona(id: string) {
  writeAll(readAll().filter((p) => p.id !== id));
}
