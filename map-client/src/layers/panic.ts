// Who looks frightened right now, for the panic clip (layers/gltf-panic.ts).
//
// Two kinds of people stand in fright during a disaster: a fire's evacuees for their first minute
// and a half in the crowd outside, once they have stopped running (sim/fireCrowd.ts), and anyone
// standing near an earthquake or a meteor just after it happens — riders waiting at a stop, people
// sitting by the river. Everyone still on the move either walks or sprints, so they are not here.
// Illustrative, like the rest of the disaster visuals; nobody's reaction is modeled.
import { isDisasterKind, type IncidentKind } from '../sim/incidents';

/** How long someone stands frightened after reaching the crowd, or after the ground shook. */
export const PANIC_SECONDS = 90;
/** People this much beyond the hazard radius saw it happen too and are frightened as well. */
const PANIC_REACH = 1.6;

const M_PER_DEG_LAT = 111_320;
const NOBODY: ReadonlySet<string> = new Set();

/** The fields of IncidentPanel's IncidentRun this reads. */
export interface PanicRun {
  incident: { kind: IncidentKind; start: number };
  hazard?: { radiusMetres: number; responseStartsAt: number } | null;
  location: { position: [number, number] };
  participants: readonly { agentId: string; assemblyAt: number | null }[];
  /** Set for a fire with an outdoor crowd: only then is anyone standing in one. */
  crowd?: unknown;
}

/** Ids of the people in `standing` (and of a fire's evacuees) who are frightened at `time`. */
export function panickingIds(run: PanicRun | null | undefined, time: number,
  standing: readonly { id: string; position: readonly number[] }[]): ReadonlySet<string> {
  if (!run || !isDisasterKind(run.incident.kind) || !standing.length) return NOBODY;
  const ids = new Set<string>();
  // Evacuees who have just reached their standing area outside the fire (assemblyAt is their
  // arrival there; it is null for everyone who never joins the crowd).
  if (run.crowd) {
    for (const person of run.participants) {
      if (person.assemblyAt !== null && time >= person.assemblyAt && time < person.assemblyAt + PANIC_SECONDS) ids.add(person.agentId);
    }
  }
  // Bystanders near an impact or an epicentre, from the moment it happens.
  const radius = run.hazard?.radiusMetres ?? 0;
  const from = run.hazard?.responseStartsAt ?? run.incident.start;
  if (radius > 0 && time >= from && time < from + PANIC_SECONDS) {
    const [lng, lat] = run.location.position;
    const kx = M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
    const reach = radius * PANIC_REACH;
    for (const person of standing) {
      if (Math.hypot((person.position[0] - lng) * kx, (person.position[1] - lat) * M_PER_DEG_LAT) <= reach) ids.add(person.id);
    }
  }
  return ids.size ? ids : NOBODY;
}
