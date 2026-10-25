import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ask, dayList, daysWithPublishedHours, rankTier, type AskContext, type CourseMeeting, type MapInsight, type RankedPlace, type Walk } from './insights';
import { crowdLevel, crowdLevelStyle } from './layers/crowd';
import type { AskRoute } from './layers/askRoute';
import { formatClock, type CampusLocation, type LocationKind } from './sim/playback';
import { dateForWeekday, WEEKDAYS } from './data/campusData';
import { agentConfigured, askAgentWithRetry, type AgentAnswer, type AgentError, type AskCampus } from './askClient';

export const EXAMPLE_QUESTIONS = [
  'Least crowded library right now',
  'Quietest dining hall at 6pm',
  'How far is CAS from Mugar?',
  'Where is CAS CS 132?',
  'How far is CS 132 from DS 340?',
  'When is GSU quiet?',
];

/** What the map should do with an answer: draw a walk, select a building, move the camera. */
export interface AskShow {
  route: AskRoute | null;
  select: CampusLocation | null;
  points: [number, number][];
}

interface Row {
  location: CampusLocation;
  primary: string;
  secondary: string;
  share: number | null;
}

interface Answer {
  text: string;
  rows: Row[];
  note?: string;
  show: AskShow | null;
  /** Set when the answer came from this device's own rules instead of the Ask server, with why. */
  device?: string;
}

const PLURAL: Record<LocationKind, string> = {
  library: 'libraries', dining: 'dining halls', gym: 'gyms', dorm: 'residence halls', classroom: 'academic buildings', outdoor: 'outdoor spaces', 'off-campus': 'places',
};
const SINGULAR: Record<LocationKind, string> = {
  library: 'library', dining: 'dining hall', gym: 'gym', dorm: 'residence hall', classroom: 'academic building', outdoor: 'outdoor space', 'off-campus': 'place',
};

const MODEL_NOTE = 'Simulated students over each place’s stated capacity, on the shown day’s modeled schedule. Not a live count.';

const pct = (share: number) => `${Math.round(share * 100)}%`;
const level = (share: number) => crowdLevel(share).label.toLowerCase();
const meters = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m` : `${(m / 1000).toFixed(1)} km`);
const walkText = (w: Walk) =>
  w.meters === 0 ? 'the same building'
  : w.basis === 'route' ? `a ${w.minutes}-minute walk (${meters(w.meters)})`
  : `about a ${w.minutes}-minute walk (roughly ${meters(w.meters)}; no mapped footpath, so this is straight-line distance × 1.3)`;

function meetingWhen(m: CourseMeeting, weekday: number): string {
  const day = Math.floor(m.startSec / 86400) % 7;
  const name = day === weekday ? 'today' : day === (weekday + 1) % 7 ? 'tomorrow' : WEEKDAYS[day];
  return `${name} at ${formatClock(m.startSec % 86400)}`;
}

function describe(insight: MapInsight, ctx: AskContext, byId: Map<string, CampusLocation>): Answer {
  const when = (t: number) => (t === ctx.time ? 'right now' : `at ${formatClock(t)}`);
  switch (insight.kind) {
    case 'leastCrowded': {
      const { placeKind, ranked, from, time } = insight;
      if (!ranked.length) return { text: `There are no ${PLURAL[placeKind]} on this campus in the model.`, rows: [], show: null };
      const rows = ranked.map((r: RankedPlace) => ({
        location: r.location,
        primary: !r.modeled ? 'Not modeled' : r.open === false ? 'Closed' : r.share === null ? `${r.count.toLocaleString()} students` : `${pct(r.share)} ${crowdLevel(r.share).label}`,
        secondary: [r.modeled && r.open === null ? 'Hours not published' : '', r.walk ? (r.walk.meters === 0 ? 'here' : `${r.walk.basis === 'estimate' ? '~' : ''}${r.walk.minutes} min walk`) : ''].filter(Boolean).join(' · '),
        share: r.open === false ? null : r.share,
      }));
      const best = ranked[0];
      const fromLoc = from ? byId.get(from.locationId) ?? null : null;
      const show: AskShow = {
        route: best.walk && best.walk.meters > 0 ? { path: best.walk.path, estimate: best.walk.basis === 'estimate' } : null,
        select: best.location,
        points: [best.location.position, ...(fromLoc ? [fromLoc.position] : [])],
      };
      if (!best.modeled) {
        return { text: `The simulation doesn't model the ${PLURAL[placeKind]} on ${WEEKDAYS[ctx.weekday]}, so the map can't say which is least crowded. Try another day in the day picker.`, rows, show: { ...show, route: null, select: null } };
      }
      if (best.open === false) {
        return { text: `By their published hours, all the ${PLURAL[placeKind]} here are closed ${when(time)}.`, rows, show: { ...show, route: null, select: null } };
      }
      if (rankTier(best) === 2) {
        // Nothing open by published hours, and these places have no hours in the data for the shown
        // date (the dining halls' dated hours end before the reference weekend): no ranking.
        const days = ctx.data ? dayList(daysWithPublishedHours(ranked.filter((r) => rankTier(r) === 2).map((r) => r.location.id), ctx.data), WEEKDAYS) : '';
        const date = ctx.data ? ` (${dateForWeekday(ctx.data, ctx.weekday)})` : '';
        return {
          text: `Opening hours for the ${PLURAL[placeKind]} here aren't in the data for ${WEEKDAYS[ctx.weekday]}${date}, so the map can't say which is least crowded.${days ? ` Published hours cover ${days}: pick one of those days in the day picker.` : ''}`,
          rows: [],
          show: null,
        };
      }
      const hoursNote = best.open === null ? ` Its opening hours aren't published for ${WEEKDAYS[ctx.weekday]}, so check before going.` : '';
      if (best.share === null) {
        return { text: `None of the ${PLURAL[placeKind]} here has a capacity the model can compare, so they're listed by simulated headcount ${when(time)}. ${best.location.short} has the fewest: ${best.count.toLocaleString()}.${hoursNote}`, rows, note: MODEL_NOTE, show };
      }
      const walk = from && best.walk && best.walk.meters > 0 ? `, ${walkText(best.walk)} from ${from.label}` : '';
      return {
        text: `${best.location.name} is the least crowded ${SINGULAR[placeKind]} ${when(time)}: ${pct(best.share)} of capacity (${level(best.share)})${walk}.${hoursNote}`,
        rows,
        note: MODEL_NOTE,
        show,
      };
    }
    case 'distance': {
      const { from, to, walk } = insight;
      const a = byId.get(from.locationId)!;
      const b = byId.get(to.locationId)!;
      return {
        text: walk.meters === 0 ? `${from.label} and ${to.label} are in the same building.` : `${from.label} to ${to.label} is ${walkText(walk)}.`,
        rows: [],
        note: walk.basis === 'route' ? 'Walking time: the bundled OpenStreetMap footpath at 1.4 m/s, the model’s walking speed.' : undefined,
        show: { route: walk.meters > 0 ? { path: walk.path, estimate: walk.basis === 'estimate' } : null, select: walk.meters > 0 ? null : a, points: [a.position, b.position] },
      };
    }
    case 'course': {
      const { courseCode, title, next, buildings } = insight;
      const where = byId.get(next.locationId)!;
      const others = buildings.filter((b) => b.locationId !== next.locationId);
      const elsewhere = others.length
        ? ` Other sections meet in ${others.map((b) => `${byId.get(b.locationId)?.short ?? b.locationId} (${b.sections.length})`).join(', ')}.`
        : '';
      return {
        text: `${courseCode} ${title} next meets ${meetingWhen(next, ctx.weekday)} in ${where.name}, room ${next.roomCode} (section ${next.section}).${elsewhere}`,
        rows: [],
        note: 'From the published Fall 2026 class schedule.',
        show: { route: null, select: where, points: [where.position] },
      };
    }
    case 'busy': {
      const { location, modeled, now, quiet, busy, time, openNow } = insight;
      const show = { route: null, select: location, points: [location.position] };
      if (!modeled) {
        return { text: `The simulation doesn't model ${location.name} on ${WEEKDAYS[ctx.weekday]}, so the map has no crowd level for it.`, rows: [], show };
      }
      if (openNow?.open === false) {
        const later = quiet && busy && quiet.time !== busy.time
          ? ` Later while it's open, it's quietest at ${formatClock(quiet.time)} (${pct(quiet.share)}) and busiest at ${formatClock(busy.time)} (${pct(busy.share)}).`
          : '';
        return { text: `${location.name} is closed ${when(time)}${openNow.hoursText ? ` (published hours: ${openNow.hoursText})` : ''}.${later}`, rows: [], note: MODEL_NOTE, show };
      }
      if (openNow?.open && openNow.fromPreviousDay) {
        return { text: `${location.name} is open ${when(time)} (published hours: ${openNow.hoursText}), but the simulation doesn't model visits after midnight.`, rows: [], show };
      }
      const otherDays = openNow?.open === null && ctx.data?.locations[location.id]?.hoursStatus === 'published'
        ? dayList(daysWithPublishedHours([location.id], ctx.data), WEEKDAYS) : '';
      const hoursNote = openNow?.open === null
        ? otherDays
          ? ` Its opening hours aren’t in the data for ${WEEKDAYS[ctx.weekday]}, so it may be closed; published hours cover ${otherDays}.`
          : ' Its opening hours for this day aren’t published.'
        : '';
      if (now === null) {
        const count = ctx.occupancyAt(time).find((o) => o.location.id === location.id)?.count ?? 0;
        return { text: `${location.name} has ${count.toLocaleString()} simulated students ${when(time)}. Its capacity isn't comparable, so the map shows a headcount rather than a percentage.${hoursNote}`, rows: [], note: MODEL_NOTE, show };
      }
      const later = quiet && busy && quiet.time !== busy.time
        ? ` For the rest of ${WEEKDAYS[ctx.weekday]}, it's quietest at ${formatClock(quiet.time)} (${pct(quiet.share)}) and busiest at ${formatClock(busy.time)} (${pct(busy.share)}).`
        : '';
      return { text: `${location.name} is ${pct(now)} full ${when(time)} (${level(now)}).${later}${hoursNote}`, rows: [], note: MODEL_NOTE, show };
    }
    case 'personal':
      return {
        text: 'The map doesn’t hold your schedule: it’s also shown on shared screens. Ask by course instead, like “where is CAS CS 132?”, or ask “where is my next class?” on your Flowcast home page.',
        rows: [],
        show: null,
      };
    case 'needTwoPlaces':
      return { text: 'Name two places or courses, for example “how far is CAS from Mugar?” or “CS 132 to DS 340”.', rows: [], show: null };
    case 'noCourse':
      return { text: `No published meeting of ${insight.code} is on the map. It may meet in a building the map doesn't cover yet.`, rows: [], show: null };
    case 'unknown':
      return { text: 'Try a place (“when is GSU quiet?”), a kind of place (“least crowded library”), a walk (“how far is CAS from Mugar?”) or a course (“where is CAS CS 132?”).', rows: [], show: null };
  }
}

const ASK_CAMPUSES: readonly string[] = ['charles-river', 'fenway', 'medical'];

/** The Ask server's answer in the panel's terms; row and selection ids become this map's locations. */
function fromAgent(result: AgentAnswer, byId: Map<string, CampusLocation>): Answer {
  const rows: Row[] = result.rows.flatMap((r) => {
    const location = byId.get(r.id);
    if (!location) return [];
    const share = r.open === false || r.percent === null ? null : r.percent / 100;
    return [{
      location,
      primary: !r.modeled ? 'Not modeled' : r.open === false ? 'Closed' : r.percent === null ? `${r.students.toLocaleString()} students` : `${r.percent}% ${r.level ?? crowdLevel(r.percent / 100).label}`,
      secondary: [r.modeled && r.open === null ? 'Hours not published' : '', r.walkMinutes === null ? '' : r.walkMinutes === 0 ? 'here' : `${r.walkMinutes} min walk`].filter(Boolean).join(' · '),
      share,
    }];
  });
  const show: AskShow | null = result.show
    ? { route: result.show.route, select: result.show.select ? byId.get(result.show.select) ?? null : null, points: result.show.points }
    : null;
  return { text: result.answer, rows, note: rows.some((r) => r.share !== null) ? MODEL_NOTE : undefined, show };
}

/** Why the answer below came from this device, in plain words. */
function deviceReason(error: AgentError | null): string {
  if (!error || error.kind === 'notConfigured') return 'Answered on this device: the Ask server isn’t set up.';
  if (error.kind === 'rateLimited') return 'Answered on this device: too many questions to the Ask server just now.';
  if (error.kind === 'timeout') return 'Answered on this device: the Ask server took too long.';
  if (error.kind === 'warming') return 'Answered on this device: the Ask server is still simulating that day.';
  return 'Answered on this device: the Ask server isn’t reachable.';
}

/** The Ask tab: a question box, example questions, and an answer that the map draws. */
export function AskPanel({
  context,
  initialQuestion,
  onShow,
  onSelect,
}: {
  context: AskContext;
  initialQuestion: string | null;
  onShow: (show: AskShow | null) => void;
  onSelect: (location: CampusLocation) => void;
}) {
  const [question, setQuestion] = useState(initialQuestion ?? '');
  const [answer, setAnswer] = useState<{ question: string; answer: Answer } | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;

  const [busy, setBusy] = useState<string | null>(null); // what the panel is waiting for, or null
  const answerRef = useRef(answer);
  answerRef.current = answer;
  const inFlight = useRef<AbortController | null>(null);

  const answerLocally = (q: string, reason: string) => {
    const ctx = contextRef.current;
    const byId = new Map(ctx.locations.map((l) => [l.id, l]));
    const result = { ...describe(ask(q, ctx), ctx, byId), device: reason };
    setAnswer({ question: q, answer: result });
    onShow(result.show);
  };

  // Each question goes to the Ask server for the map's shown day, time and campus. A newer question
  // cancels the one in flight; any failure falls back to this device's own answer, labelled as such.
  const run = async (q: string) => {
    const trimmed = q.trim().slice(0, 300);
    if (!trimmed) return;
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setQuestion(trimmed);
    const ctx = contextRef.current;
    const campus = ASK_CAMPUSES.includes(ctx.campus) ? (ctx.campus as AskCampus) : 'charles-river';
    setBusy('Asking…');
    try {
      if (!(await agentConfigured())) {
        if (!controller.signal.aborted) answerLocally(trimmed, deviceReason(null));
        return;
      }
      const result = await askAgentWithRetry(
        { question: trimmed, weekday: ctx.weekday, time: ctx.time, campus },
        controller.signal,
        { onWarming: () => { if (!controller.signal.aborted) setBusy(`Simulating ${WEEKDAYS[ctx.weekday]}…`); } },
      );
      if (controller.signal.aborted) return;
      if (result.ok) {
        const now = contextRef.current;
        const answered = fromAgent(result.value, new Map(now.locations.map((l) => [l.id, l])));
        setAnswer({ question: trimmed, answer: answered });
        onShow(answered.show);
      } else if (result.error.kind !== 'aborted') {
        answerLocally(trimmed, deviceReason(result.error));
      }
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setBusy(null);
      }
    }
  };

  // A question passed in the URL (?ask=...) is asked once, as soon as the simulation is ready. It
  // starts a tick later, so a mount that is immediately undone (React dev mode) sends nothing; if
  // the panel closes before it's answered, it is asked again when the panel comes back.
  const askedInitial = useRef(false);
  useEffect(() => {
    let start: ReturnType<typeof setTimeout> | undefined;
    if (initialQuestion && !askedInitial.current) {
      askedInitial.current = true;
      start = setTimeout(() => void run(initialQuestion), 0);
    }
    return () => {
      clearTimeout(start);
      if (askedInitial.current && !answerRef.current) askedInitial.current = false;
      inFlight.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuestion]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(question);
  };
  const clear = () => {
    inFlight.current?.abort();
    setAnswer(null);
    setQuestion('');
    onShow(null);
  };

  return (
    <div className="ask">
      <form className="ask-form" onSubmit={submit} role="search">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Least crowded library, how far is CAS from Mugar…"
          aria-label="Ask about campus"
        />
        <button type="submit" disabled={busy !== null}>{busy ? 'Asking…' : 'Ask'}</button>
      </form>
      <div className="ask-answer" aria-live="polite" aria-busy={busy !== null}>
        {busy && <p className="muted ask-status">{busy}</p>}
        {answer && !busy ? (
          <>
            <p className="ask-text">{answer.answer.text}</p>
            {answer.answer.rows.length > 0 && (
              <ol className="rows">
                {answer.answer.rows.map((r) => (
                  <li key={r.location.id}>
                    <button className="row" onClick={() => onSelect(r.location)} style={r.share === null ? undefined : crowdLevelStyle(r.share)}>
                      <span className="name">{r.location.name}</span>
                      {r.share !== null && <span className="bar" aria-hidden="true"><span style={{ width: `${Math.min(100, r.share * 100)}%` }} /></span>}
                      <span className="value"><b>{r.primary}</b>{r.secondary && ` · ${r.secondary}`}</span>
                    </button>
                  </li>
                ))}
              </ol>
            )}
            {answer.answer.note && <p className="muted ask-note">{answer.answer.note}</p>}
            {answer.answer.device && <p className="muted ask-note">{answer.answer.device}</p>}
            <button type="button" className="ask-clear" onClick={clear}>Clear</button>
          </>
        ) : null}
      </div>
      <div className="ask-examples" aria-label="Example questions">
        {EXAMPLE_QUESTIONS.map((q) => (
          <button key={q} type="button" onClick={() => void run(q)}>{q}</button>
        ))}
      </div>
    </div>
  );
}
