// Persona shape and wander/status logic -- intentionally duplicated from map-client/src/sim/persona.ts
// for the wander math only (the two apps don't share a package yet, and this is small and pure
// enough that keeping it in sync by hand is the pragmatic choice -- see the root README's target
// architecture, `packages/contracts`). The *appearance* catalog is NOT duplicated: it's imported
// straight from map-client via the `@map/*` Vite alias (already used by web/src/map-entry.ts), so
// "what a Hoodie looks like" is defined in exactly one place. See @map/sim/personaParts.
export type { PersonaAppearance, PartCategory, PartOption, PartLayer } from '@map/sim/personaParts';
export { PART_CATALOG, CATEGORY_ORDER, CATEGORY_LABEL, DEFAULT_APPEARANCE, findOption, resolveLayers, BASE_BODY_COLOR } from '@map/sim/personaParts';
import type { PersonaAppearance } from '@map/sim/personaParts';

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
  /** Real coordinates, when known -- web's own location list doesn't carry these (map-client's
   * does), so "nearest other location" falls back to a deterministic non-geographic pick here. */
  position?: [number, number];
}

export type WanderState =
  | { kind: 'idle'; locationId: string }
  | { kind: 'walking'; fromId: string; toId: string; progress: number };

const CYCLE_SECONDS = 150;
const WALK_SECONDS = 22;

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** True nearest-by-distance when both ends have coordinates; otherwise a deterministic pick by
 * list position, so the status text is still stable and repeatable without real geography. */
function nearestOther(from: LocationLite, locations: LocationLite[]): LocationLite | null {
  const others = locations.filter((l) => l.id !== from.id);
  if (!others.length) return null;
  if (from.position) {
    let best: LocationLite | null = null;
    let bestDist = Infinity;
    for (const loc of others) {
      if (!loc.position) continue;
      const d = (loc.position[0] - from.position[0]) ** 2 + (loc.position[1] - from.position[1]) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = loc;
      }
    }
    if (best) return best;
  }
  return others[hashId(from.id) % others.length];
}

/** Where a persona is right now, from wall-clock time and its own id alone -- see map-client's
 * copy of this function for the full rationale. */
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

/** Plain-words status for the persona's own "where am I" screen. */
export function statusText(persona: Persona, locations: LocationLite[], nowMs: number): string {
  const state = wanderStatus(persona, locations, nowMs);
  if (state.kind === 'idle') {
    const loc = locations.find((l) => l.id === state.locationId);
    return loc ? `At ${loc.name}` : 'Somewhere on campus';
  }
  const to = locations.find((l) => l.id === state.toId);
  return to ? `Walking to ${to.name}` : 'Walking across campus';
}
