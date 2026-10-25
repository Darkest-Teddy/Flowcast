// Writes to the exact localStorage key map-client/src/sim/personaStore.ts reads, since /join and
// the map are served from the same origin (this app mounts map-client at /map) and so genuinely
// share one browser's storage today. This is the one real limit worth repeating: a phone's own
// browser has its own separate localStorage from a laptop's big-screen tab, so this is same-device
// (or same-browser, multi-tab) joining, not true cross-device sync -- that needs the planned
// `/server`, where this same read/write shape becomes a real network call instead.
import type { Persona } from './personaShared';

const PERSONA_STORAGE_KEY = 'flowcast.personas.v1';
const MY_PERSONA_ID_KEY = 'flowcast.myPersonaId';
const SAME_TAB_EVENT = 'flowcast:personas-changed';

function readAll(): Persona[] {
  try {
    const raw = localStorage.getItem(PERSONA_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Persona[]) : [];
  } catch {
    return [];
  }
}

function writeAll(personas: Persona[]) {
  localStorage.setItem(PERSONA_STORAGE_KEY, JSON.stringify(personas));
  window.dispatchEvent(new Event(SAME_TAB_EVENT));
}

export function getPersonas(): Persona[] {
  return readAll();
}

export function upsertPersona(persona: Persona) {
  writeAll([...readAll().filter((p) => p.id !== persona.id), persona]);
}

export function removePersona(id: string) {
  writeAll(readAll().filter((p) => p.id !== id));
  if (getMyPersonaId() === id) clearMyPersonaId();
}

/** Which persona (if any) THIS browser created, so /join can show "you" after a page reload. */
export function getMyPersonaId(): string | null {
  try {
    return localStorage.getItem(MY_PERSONA_ID_KEY);
  } catch {
    return null;
  }
}
export function setMyPersonaId(id: string) {
  try {
    localStorage.setItem(MY_PERSONA_ID_KEY, id);
  } catch {
    // storage blocked: the student can still use this tab for the rest of the session
  }
}
export function clearMyPersonaId() {
  try {
    localStorage.removeItem(MY_PERSONA_ID_KEY);
  } catch {
    // ignore
  }
}

export function subscribePersonas(onChange: (personas: Persona[]) => void): () => void {
  const handler = () => onChange(readAll());
  window.addEventListener('storage', handler);
  window.addEventListener(SAME_TAB_EVENT, handler);
  return () => {
    window.removeEventListener('storage', handler);
    window.removeEventListener(SAME_TAB_EVENT, handler);
  };
}
