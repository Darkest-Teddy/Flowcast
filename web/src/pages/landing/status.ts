// The landing page's status strip: the time in Boston and the model's own counts, read from the
// same data files the map uses (nothing typed in by hand).

/** How many students the model simulates (population.json, students.total). */
export async function loadStudentCount(): Promise<number | null> {
  const response = await fetch('/data/population.json');
  if (!response.ok) return null;
  const population: { students?: { total?: number } } = await response.json();
  return typeof population.students?.total === 'number' ? population.students.total : null;
}

const BOSTON = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** "SUN OCT 25 · 7:00 PM", Boston time. */
export function bostonStamp(now: Date): string {
  const part = (type: Intl.DateTimeFormatPartTypes) => BOSTON.formatToParts(now).find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('month')} ${part('day')} · ${part('hour')}:${part('minute')} ${part('dayPeriod')}`.toUpperCase();
}
