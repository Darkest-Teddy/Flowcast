import type { Incident, IncidentParticipant } from './incidents';

export function incidentProgress(run: { incident: Incident; endsAt: number; participants: IncidentParticipant[] }, time: number) {
  const occupants = run.participants.filter(person => person.role === 'occupant');
  const started = time >= run.incident.start;
  const inside = occupants.filter(person => time < person.departAt).length;
  const evacuating = occupants.filter(person => person.assemblyAt !== null && person.departAt <= time && time < person.assemblyAt).length;
  const assembled = occupants.filter(person => person.assemblyAt !== null && person.assemblyAt <= time && time < person.releaseAt).length;
  const recovering = run.participants.filter(person => person.releaseAt <= time && time < person.resumedAt).length;
  const resumed = run.participants.filter(person => person.resumedAt <= time).length;
  const cancelled = run.participants.filter(person => person.outcome === 'cancelled' && person.departAt <= time).length;
  const relocated = run.participants.filter(person => person.decision?.action === 'relocate' && person.decision.at <= time).length;
  const interrupted = run.participants.filter(person => person.outcome === 'interrupted' && person.departAt <= time).length;
  const diverted = run.participants.filter(person => person.role === 'arrival' && person.departAt <= time).length;
  const clearedAt = occupants.reduce((latest, person) => Math.max(latest, person.departAt), run.incident.start);
  const completedAt = run.participants.reduce((latest, person) => Math.max(latest, person.resumedAt), run.endsAt);
  const phase = !started ? 'Scheduled'
    : inside > 0 ? (run.incident.kind !== 'building-closure' ? 'Evacuating' : 'Clearing building')
    : time < run.endsAt ? 'Access closed'
    : time < completedAt ? 'Resuming'
    : 'Complete';
  return { phase, inside: started ? inside : 0, evacuating, assembled, recovering, resumed, diverted, cancelled, interrupted, relocated,
    occupantCount: occupants.length, clearedAt, completedAt };
}
