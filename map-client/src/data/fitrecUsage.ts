export interface FitrecUsage {
  sourceUrl: string;
  metric: 'visits';
  periodStart: string;
  periodEnd: string;
  modelRefreshedAt: string;
  observations: { date: string; hour: number; visits: number }[];
}

// These are entry counts, used only for relative arrival timing. Attendance and
// visit duration remain model assumptions; a missing hour is not a closure.
export function fitrecVisitStart(usage: FitrecUsage | undefined, date: string, draw: number, jitter: number): number | undefined {
  if (!usage || usage.metric !== 'visits') return undefined;
  const target = Date.parse(`${date}T12:00:00Z`);
  const dates = [...new Set(usage.observations.map(row => row.date))].filter(value => {
    const age = (target - Date.parse(`${value}T12:00:00Z`)) / 86400000;
    return age >= 0 && age <= 28 && age % 7 === 0;
  }).sort();
  const observedDate = dates.at(-1);
  if (!observedDate) return undefined;
  const rows = usage.observations.filter(row => row.date === observedDate
    && Number.isInteger(row.hour) && row.hour >= 0 && row.hour < 24
    && Number.isFinite(row.visits) && row.visits > 0).sort((a, b) => a.hour - b.hour);
  const total = rows.reduce((sum, row) => sum + row.visits, 0);
  let choice = draw * total;
  for (const row of rows) {
    choice -= row.visits;
    if (choice < 0) return (row.hour + jitter) * 3600;
  }
  return undefined;
}
