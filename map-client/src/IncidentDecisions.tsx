import type { CampusLocation } from './sim/playback';
import { incidentDecisionSummary, type DecisionSummaryInput } from './sim/incidentDecisionSummary';

const activities: Record<string, string> = {
  class: 'Class', library: 'Studying', study: 'Studying', dining: 'Eating', gym: 'Exercise',
  home: 'Time at home', wait: 'Waiting', estimated: 'Modeled activity', unknown: 'Unspecified activity',
};
const actions: Record<string, string> = {
  relocate: 'Move elsewhere', wait: 'Wait', leave: 'Move on', resume: 'Resume', cancel: 'Skip visit',
};

export function IncidentDecisions({ participants, time, locations, onLocate }: {
  participants: DecisionSummaryInput[];
  time: number;
  locations: CampusLocation[];
  onLocate: (location: CampusLocation) => void;
}) {
  const groups = incidentDecisionSummary(participants, time);
  if (!groups.length) return null;
  return <details className="incident-decisions">
    <summary>Why students moved · {groups.reduce((sum, group) => sum + group.count, 0).toLocaleString()} decisions</summary>
    <p className="model-note">Choices made so far, based on the planned activity and available time. Rewinding hides later choices.</p>
    <ul>
      {groups.map(group => {
        const destination = locations.find(location => location.id === group.destinationId);
        return <li key={group.key}>
          <strong>{group.count.toLocaleString()} · {activities[group.activity] ?? 'Other activity'} · {actions[group.action] ?? group.action}</strong>
          <p>{group.reason}</p>
          {destination && <button type="button" onClick={() => onLocate(destination)}>Show {destination.short || destination.name}</button>}
        </li>;
      })}
    </ul>
  </details>;
}
