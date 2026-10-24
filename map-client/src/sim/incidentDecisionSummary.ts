export interface DecisionSummaryInput {
  decision?: {
    activity: string;
    action: string;
    destinationId?: string;
    reason: string;
    at: number;
  };
}

export function incidentDecisionSummary(participants: DecisionSummaryInput[], time: number) {
  const groups = new Map<string, NonNullable<DecisionSummaryInput['decision']> & { count: number; key: string }>();
  for (const { decision } of participants) {
    if (!decision || decision.at > time) continue;
    const destinationId = decision.action === 'leave' || decision.action === 'cancel' ? undefined : decision.destinationId;
    const key = JSON.stringify([decision.activity, decision.action, destinationId, decision.reason]);
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { ...decision, destinationId, count: 1, key });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
}
