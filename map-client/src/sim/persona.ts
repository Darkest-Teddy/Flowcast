// A real person's own customizable avatar, joined by scanning the QR code on the live map
// (see ../JoinQr.tsx) and created on /join in the web app. Personas are NOT part of the
// simulated population in demo-day.json -- they carry no class schedule, so instead of faking
// one, each persona just idles at a chosen campus location and periodically wanders to a
// neighbor and back. That wander is deterministic from the persona's id and the clock, so the
// map and the student's own "where am I" phone screen always agree without any server round
// trip. This file's wander/status logic and web/src/lib/personaShared.ts's copy of it
// intentionally duplicate the same small pure function: the two apps don't share a package yet
// (see the root README's target architecture). The *appearance* catalog is different -- see
// sim/personaParts.ts, which web/ imports directly via its `@map/*` alias (genuinely shared,
// not duplicated; no reason to repeat the old pattern now that the alias is proven to work).

import type { PersonaAppearance } from './personaParts';
export type { PersonaAppearance } from './personaParts';
export { DEFAULT_APPEARANCE } from './personaParts';

export interface Persona {
  id: string;
  name: string;
  bio: string;
  appearance: PersonaAppearance;
  homeLocationId: string;
  createdAt: string; // ISO
}

export interface LocationLite {
  id: string;
  name: string;
  short: string;
  position: [number, number];
}

export type WanderState =
  | { kind: 'idle'; locationId: string }
  | { kind: 'walking'; fromId: string; toId: string; progress: number }; // progress 0..1

const CYCLE_SECONDS = 150; // one full idle-then-wander-and-back loop
const WALK_SECONDS = 22; // time spent on each leg of the wander

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** The nearest other location to `from`, so a persona's wander target is always a short, plausible walk. */
function nearestOther(from: LocationLite, locations: LocationLite[]): LocationLite | null {
  let best: LocationLite | null = null;
  let bestDist = Infinity;
  for (const loc of locations) {
    if (loc.id === from.id) continue;
    const d = (loc.position[0] - from.position[0]) ** 2 + (loc.position[1] - from.position[1]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = loc;
    }
  }
  return best;
}

/**
 * Where a persona is right now: mostly idling at its home location, with a short deterministic
 * wander to the nearest other location and back once per cycle. Pure function of wall-clock time
 * and the persona's own id, so every reader (map, phone) computes the identical answer.
 */
export function wanderStatus(persona: Persona, locations: LocationLite[], nowMs: number): WanderState {
  const home = locations.find((l) => l.id === persona.homeLocationId) ?? locations[0];
  if (!home) return { kind: 'idle', locationId: persona.homeLocationId };
  const target = nearestOther(home, locations);
  if (!target) return { kind: 'idle', locationId: home.id };

  const phase = hashId(persona.id) % CYCLE_SECONDS;
  const t = (((nowMs / 1000 + phase) % CYCLE_SECONDS) + CYCLE_SECONDS) % CYCLE_SECONDS;
  const outStart = (CYCLE_SECONDS - WALK_SECONDS * 2) / 2;
  const backStart = outStart + WALK_SECONDS;
  const idleAgainAt = backStart + WALK_SECONDS;

  if (t < outStart || t >= idleAgainAt) return { kind: 'idle', locationId: home.id };
  if (t < backStart) return { kind: 'walking', fromId: home.id, toId: target.id, progress: (t - outStart) / WALK_SECONDS };
  return { kind: 'walking', fromId: target.id, toId: home.id, progress: (t - backStart) / WALK_SECONDS };
}

function bearingBetween(a: [number, number], b: [number, number]): number {
  const toRad = Math.PI / 180;
  const dLon = (b[0] - a[0]) * toRad;
  const lat1 = a[1] * toRad;
  const lat2 = b[1] * toRad;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / toRad + 360) % 360;
}

export interface PersonaAgent {
  persona: Persona;
  position: [number, number, number];
  bearing: number;
  clip: 'walk' | 'idle';
  /** Plain-words status for the persona's own "where am I" screen, e.g. "Walking to Mugar Memorial Library". */
  statusText: string;
}

/** Turns a persona + the wander state into something the layers (and the phone) can read directly. */
export function personaAgentAt(persona: Persona, locations: LocationLite[], nowMs: number): PersonaAgent | null {
  const state = wanderStatus(persona, locations, nowMs);
  if (state.kind === 'idle') {
    const loc = locations.find((l) => l.id === state.locationId);
    if (!loc) return null;
    return { persona, position: [loc.position[0], loc.position[1], 0], bearing: 0, clip: 'idle', statusText: `At ${loc.name}` };
  }
  const from = locations.find((l) => l.id === state.fromId);
  const to = locations.find((l) => l.id === state.toId);
  if (!from || !to) return null;
  const f = state.progress;
  return {
    persona,
    position: [from.position[0] + (to.position[0] - from.position[0]) * f, from.position[1] + (to.position[1] - from.position[1]) * f, 0],
    bearing: bearingBetween(from.position, to.position),
    clip: 'walk',
    statusText: `Walking to ${to.name}`,
  };
}
