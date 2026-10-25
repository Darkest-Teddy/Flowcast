// Which Ask Flowcast questions may leave the device. Questions that need the person's own schedule
// ("where is my next class?") are answered here from their calendar and never sent to the Ask
// server: personal schedules stay in the owner's session. A question that only names the person's
// home ("how far is Mugar from my dorm?") is sent with the home's place name in place of "my dorm",
// and nothing else from the profile. Everything else goes to the server's agent as asked, with this
// device's answer as the fallback. No imports, so node --test can run it directly.

const SCHEDULE_WORDS = '(class|classes|course|courses|lecture|lectures|section|sections|lab|labs|seminar|seminars|schedule|calendar|timetable|day|week|exam|exams)';

/** Questions that can only be answered from the person's own schedule. */
const NEEDS_SCHEDULE = [
  new RegExp(`\\bmy (next |first |last |morning |afternoon |evening |other )?${SCHEDULE_WORDS}\\b`), // my next class, my schedule, my day
  /\bnext (class|lecture|section|lab|seminar)\b/,
  /\bbetween (my )?classes\b/,
  /\bwhat('?s| is) next\b/,
  /\bwhen do i\b/, // when do I have class, when do I need to leave
  /\b(i|i'?m|me)\b.*\b(class|classes|schedule|calendar|lecture|timetable)\b/, // do I have class, am I late for class
];

/** "my dorm", "my room", "from home": the person's home, which the profile names. */
const HOME_REF = /\b(?:my|our) (?:dorm room|dorm|room|residence hall|residence|home|house|apartment|place|building)\b|\b(?<=(?:from|to|near|at|back) )home\b/g;

const normalize = (question: string) => question.replace(/[’‘]/g, "'");

/** True when a question needs the asker's own schedule, so it stays on this device. */
export function isPersonalQuestion(question: string): boolean {
  const q = ` ${normalize(question).toLowerCase()} `;
  return NEEDS_SCHEDULE.some((re) => re.test(q));
}

/** True when a question names the asker's home ("my dorm", "from home"). */
export function mentionsHome(question: string): boolean {
  HOME_REF.lastIndex = 0;
  return HOME_REF.test(normalize(question).toLowerCase());
}

export type AskPlan = { local: true } | { local: false; question: string };

/**
 * What to do with one question: keep it on the device when it needs the person's schedule, or when
 * it names their home and the profile has none; otherwise send it, with "my dorm" and the like
 * replaced by `homeName` (the profile's home place, never anything else from the profile).
 */
export function planQuestion(question: string, homeName: string | null): AskPlan {
  if (isPersonalQuestion(question)) return { local: true };
  if (!mentionsHome(question)) return { local: false, question };
  if (!homeName) return { local: true };
  return { local: false, question: normalize(question).replace(new RegExp(HOME_REF.source, 'gi'), () => homeName) };
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
  | { source: 'agent'; answer: A; question: string }
  | { source: 'device'; reason: 'personal' | 'privateFollowup' }
  | { source: 'device'; reason: 'failed'; error: E }
  | { source: 'cancelled' };

/**
 * Routes one question (see planQuestion): personal ones are answered on the device without calling
 * `agent`; the rest go to `agent` (with the home substituted), and a failure says so, so the page
 * can answer on the device and label it. `question` in an agent outcome is the text that was sent.
 */
export async function routeQuestion<A, E extends { kind: string }>(
  question: string,
  agent: (question: string) => Promise<{ ok: true; value: A } | { ok: false; error: E }>,
  homeName: string | null = null,
  context?: ConversationPrivacy,
): Promise<AskOutcome<A, E>> {
  const plan = planQuestion(question, homeName);
  if (plan.local) return { source: 'device', reason: 'personal' };
  if (needsPrivateClarification(question, context)) return { source: 'device', reason: 'privateFollowup' };
  const result = await agent(plan.question);
  if (result.ok) return { source: 'agent', answer: result.value, question: plan.question };
  if (result.error.kind === 'aborted') return { source: 'cancelled' };
  return { source: 'device', reason: 'failed', error: result.error };
}

export interface ConversationPrivacy {
  afterDevice: boolean;
  locationNames: string[];
}

/** After a device answer, only a self-contained named-place question may start a new remote context. */
export function needsPrivateClarification(question: string, context?: ConversationPrivacy): boolean {
  if (!context?.afterDevice) return false;
  const q = normalize(question).toLowerCase();
  const referencesPrior = /\b(it|there|that|those|them|they|this|these|same|instead|other|another|one|ones|next|previous|before|after|then|also|too|again)\b/.test(q);
  const namesPlace = context.locationNames.some((name) => {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return escaped.length > 1 && new RegExp(`\\b${escaped}\\b`, 'i').test(q);
  });
  return referencesPrior || !namesPlace;
}
