// Which Ask Flowcast questions may leave the device. Questions about the person's own schedule
// ("where is my next class?") are answered here from their calendar and never sent to the Ask
// server: personal schedules stay in the owner's session. Everything else goes to the server's
// agent, with this device's answer as the fallback. No imports, so node --test can run it directly.

const PERSONAL = [
  /\b(my|mine|myself)\b/, // my class, my dorm, my day
  /\bnext (class|lecture|section|lab|seminar)\b/,
  /\bbetween (my )?classes\b/,
  /\bwhat('?s| is) next\b/,
  /\b(i|i'?m|me)\b.*\b(class|classes|schedule|calendar|lecture|timetable)\b/,
];

/** True when a question is about the asker's own schedule or places, so it stays on this device. */
export function isPersonalQuestion(question: string): boolean {
  const q = ` ${question.toLowerCase().replace(/[’‘]/g, "'")} `;
  return PERSONAL.some((re) => re.test(q));
}

/** Day of the week (0 = Monday) and seconds since midnight in Boston, for the Ask server. */
export function bostonClock(at: Date): { weekday: number; time: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday);
  const time = (Number(parts.hour) % 24) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return { weekday, time };
}

export type AskOutcome<A, E> =
  | { source: 'agent'; answer: A }
  | { source: 'device'; reason: 'personal' }
  | { source: 'device'; reason: 'failed'; error: E }
  | { source: 'cancelled' };

/**
 * Routes one question: personal ones are answered on the device without calling `agent`; the rest
 * go to `agent`, and a failure says so, so the page can answer on the device and label it.
 */
export async function routeQuestion<A, E extends { kind: string }>(
  question: string,
  agent: (question: string) => Promise<{ ok: true; value: A } | { ok: false; error: E }>,
): Promise<AskOutcome<A, E>> {
  if (isPersonalQuestion(question)) return { source: 'device', reason: 'personal' };
  const result = await agent(question);
  if (result.ok) return { source: 'agent', answer: result.value };
  if (result.error.kind === 'aborted') return { source: 'cancelled' };
  return { source: 'device', reason: 'failed', error: result.error };
}
