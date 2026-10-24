import type { Incident, IncidentParticipant, IncidentResult } from './incidents';
import type { CasualtyEvent } from './casualties';

const DISASTERS = new Set(['fire', 'earthquake', 'meteor']);

/** Casualty events that have happened by `time`. Future events are never returned; drills and closures have none. */
export function casualtiesAt(run: { incident: Incident; casualties?: readonly CasualtyEvent[] }, time: number): CasualtyEvent[] {
  if (!DISASTERS.has(run.incident.kind) || !run.casualties) return [];
  return run.casualties.filter(event => event.at <= time);
}

export interface InjuryCluster {
  /** Mean of the member event positions. */
  position: [number, number];
  count: number;
  /** Marker radius in pixels; grows with the square root of the count. */
  radiusPixels: number;
}

/** Grid cell size used to merge nearby injured events into one marker. */
export const INJURY_CLUSTER_METRES = 40;
const MAX_CLUSTERS = 60;

/**
 * Aggregates injured events (not fatalities) that happened by `time` into grid cells.
 * Deterministic: cells are fixed metric squares around a constant reference latitude, and output
 * is sorted by count (descending) then cell key. Positions come only from the events themselves.
 */
export function injuryClusters(events: readonly CasualtyEvent[], time: number, cellMetres = INJURY_CLUSTER_METRES): InjuryCluster[] {
  const ky = 111320, kx = ky * Math.cos(42.35 * Math.PI / 180);
  const cells = new Map<string, { lon: number; lat: number; count: number }>();
  for (const event of events) {
    if (event.outcome !== 'injured' || event.at > time) continue;
    const key = `${Math.floor(event.position[0] * kx / cellMetres)}:${Math.floor(event.position[1] * ky / cellMetres)}`;
    const cell = cells.get(key) ?? { lon: 0, lat: 0, count: 0 };
    cell.lon += event.position[0]; cell.lat += event.position[1]; cell.count += 1;
    cells.set(key, cell);
  }
  return [...cells.entries()]
    .sort(([ka, a], [kb, b]) => b.count - a.count || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .slice(0, MAX_CLUSTERS)
    .map(([, cell]) => ({ position: [cell.lon / cell.count, cell.lat / cell.count] as [number, number], count: cell.count,
      radiusPixels: Math.min(18, 5 + 2.5 * Math.sqrt(cell.count)) }));
}

export function incidentProgress(run: { incident: Incident; endsAt: number; participants: IncidentParticipant[]; hazard?: IncidentResult['hazard']; casualties?: readonly CasualtyEvent[] }, time: number) {
  // Each agent has at most one terminal event. `stoppedAt` uses every event so clearance is stable,
  // but the per-time counts below only use events at or before `time`.
  const stoppedAt = new Map<string, number>();
  if (DISASTERS.has(run.incident.kind)) for (const event of run.casualties ?? []) stoppedAt.set(event.agentId, event.at);
  const happened = casualtiesAt(run, time);
  const casualty = new Set(happened.map(event => event.agentId));
  const active = (person: IncidentParticipant) => !casualty.has(person.agentId);
  const leftAt = (person: IncidentParticipant) => Math.min(person.departAt, stoppedAt.get(person.agentId) ?? Infinity);

  const occupants = run.participants.filter(person => person.role === 'occupant');
  const started = time >= run.incident.start;
  const inside = occupants.filter(person => active(person) && time < person.departAt).length;
  const evacuating = occupants.filter(person => active(person) && person.assemblyAt !== null && person.departAt <= time && time < person.assemblyAt).length;
  const assembled = occupants.filter(person => active(person) && person.assemblyAt !== null && person.assemblyAt <= time && time < person.releaseAt).length;
  const recovering = run.participants.filter(person => active(person) && person.releaseAt <= time && time < person.resumedAt).length;
  const resumed = run.participants.filter(person => active(person) && person.resumedAt <= time).length;
  const happenedBeforeHarm = (person: IncidentParticipant, at: number) => at <= time && at < (stoppedAt.get(person.agentId) ?? Infinity);
  const cancelled = run.participants.filter(person => person.outcome === 'cancelled' && happenedBeforeHarm(person, person.departAt)).length;
  const relocated = run.participants.filter(person => person.decision?.action === 'relocate' && happenedBeforeHarm(person, person.decision.at)).length;
  const interrupted = run.participants.filter(person => person.outcome === 'interrupted' && happenedBeforeHarm(person, person.departAt)).length;
  const diverted = run.participants.filter(person => person.role === 'arrival' && happenedBeforeHarm(person, person.departAt)).length;
  const injured = happened.filter(event => event.outcome === 'injured').length;
  const fatalities = happened.length - injured;
  // An occupant incapacitated before exiting stops counting as inside at the event time.
  const clearedAt = occupants.reduce((latest, person) => Math.max(latest, leftAt(person)), run.incident.start);
  const completedAt = run.participants.reduce((latest, person) =>
    Math.max(latest, Math.min(person.resumedAt, stoppedAt.get(person.agentId) ?? Infinity)), run.endsAt);
  const phase = !started ? 'Scheduled'
    : run.incident.kind === 'earthquake' && run.hazard && time < run.hazard.responseStartsAt ? 'Sheltering during shaking'
    : inside > 0 ? (run.incident.kind === 'fire-drill' ? 'Evacuating' : 'Clearing building')
    : run.hazard && time >= run.hazard.activeUntil && time < run.endsAt ? 'Buildings damaged'
    : time < run.endsAt ? 'Access closed'
    : time < completedAt ? 'Resuming'
    : 'Complete';
  return { phase, inside: started ? inside : 0, evacuating, assembled, recovering, resumed, diverted, cancelled, interrupted, relocated,
    injured, fatalities, occupantCount: occupants.length, clearedAt, completedAt };
}
