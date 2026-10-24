// One Ask question: a GPT-6 Luna agent that answers from the simulation through the tools in
// tools.ts. The model only chooses tools and words the reply; every number comes from a tool.

import { Agent, MaxTurnsExceededError, Runner, type Model } from '@openai/agents';
import type { ServerAskContext } from './facts';
import { formatClock } from '../../map-client/src/sim/playback';
import { WEEKDAYS } from '../../map-client/src/data/campusData';
import { createTools, mapOutput, newToolLog, type AnswerRow, type MapShow } from './tools';

export const ASK_MODEL = process.env.FLOWCAST_ASK_MODEL || 'gpt-6-luna';

/** Returned when the model gives no usable answer (empty output, turn limit, wording the project rules out). */
export const FALLBACK_ANSWER = 'I couldn’t put an answer together. Try asking about a specific place or course code.';

// Questions and tool results are not sent to OpenAI's trace dashboard.
const runner = new Runner({ tracingDisabled: true });

export interface AskResult {
  answer: string;
  model: string;
  show: MapShow | null;
  rows: AnswerRow[];
  calls: string[];
}

function instructions(ctx: ServerAskContext): string {
  return [
    'You answer students’ questions about the Boston University campus for Flowcast, a 3D campus map filled with simulated students.',
    `The map currently shows ${WEEKDAYS[ctx.weekday]} at ${formatClock(ctx.time)} on the ${ctx.campus} campus. "Now" means that time.`,
    '',
    'Tools: rank_places_by_crowd (rank places by simulated crowding), place_day (one place over a day: hours, now, hourly table, quietest/busiest open hours), ' +
      'place_info (published hours, open now and next change, capacity basis, estimated profiles, evidence), campus_overview (whole-map totals, walkers, busiest places), ' +
      'list_events (published events), free_rooms (rooms with no published class), model_basis (how the model works, for "why" questions), ' +
      'published_counts (observed FitRec entries and pedestrian counts), walking_route, find_course, find_places.',
    '',
    'Rules:',
    '- Get every number, place, time and course from a tool. Never estimate or recall one yourself. If no tool can answer, say what you can answer instead.',
    '- Closed is not quiet: a place with open=false is closed by its published hours; never call it quiet, empty or least crowded. Unknown hours (open=null) are not closed: say its hours aren’t published.',
    '- Published counts (published_counts, evidence items) are observed data from their own period. Call them published counts, give their period, and never mix them with simulated figures.',
    '- If a tool gives afterMidnightNote, say the place is open then but the simulation doesn’t model visits after midnight; never call it empty.',
    '- For another day, pass the weekday parameter (0 = Monday). If a tool returns available=false, say that day is still being simulated and to try again shortly.',
    '- For "why" questions about crowding or numbers, use model_basis or place_info and explain from what they return.',
    '- Crowd figures are simulated students over each place’s stated capacity. Call them "simulated" or "modeled". Never call them predictions, measurements or live counts.',
    '- If a tool says modeled=false, say the simulation doesn’t model that place on this day. If percent is null, give the student count and say the capacity isn’t comparable.',
    '- If a walk has isEstimate=true, say it is a straight-line estimate because no footpath is mapped.',
    '- If a tool says a course code is ambiguous, ask which of the listed courses the user means.',
    '- You don’t know anyone’s personal schedule; the map is also shown on shared screens. For "my next class" and similar, say so and suggest asking by course code (e.g. "where is CAS CS 132?") or on their Flowcast home page.',
    '- When a place name is ambiguous or unknown, call find_places before giving up.',
    '- Reply in plain text, one to three short sentences, no markdown or lists. Use the names the tools return.',
    '- Only answer questions about the campus, its places, crowds, walks and classes. Politely decline anything else.',
  ].join('\n');
}

// ---------------------------------------------------------------- answer checks

const RULED_OUT = /predict|accura|live count|real-time count/i;

/**
 * Rewords what the project rules out ("prediction" is a projection; there are no live counts) and
 * returns null when something is left that can't be reworded safely ("accuracy").
 */
export function rewordAnswer(answer: string): string | null {
  const keepCase = (word: string, like: string) => (like[0] === like[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word);
  const out = answer
    .replace(/\bpredict(ed|s|ing|ion|ions)?\b/gi, (m, end = '') => keepCase(`project${end.toLowerCase()}`, m))
    .replace(/\b(?:live|real-time|realtime) counts?\b/gi, (m) => keepCase(m.toLowerCase().endsWith('s') ? 'simulated counts' : 'simulated count', m));
  return RULED_OUT.test(out) ? null : out;
}

const numbers = (text: string) => text.replace(/(\d),(?=\d{3}\b)/g, '$1').match(/\d+(?:\.\d+)?/g) ?? [];

/** Table columns whose cells are figures an answer may quote; hour and open-flag columns are not. */
const FIGURE_COLUMNS = new Set(['percent', 'students', 'visits', 'pedestrians']);

/**
 * Numbers a tool output supports: scalar fields and strings anywhere, but in hourly tables
 * ({ columns, rows }) only the figure columns, so hour numbers 0–23 and open flags don't make
 * every small number look supported.
 */
export function supportedNumbers(output: string): string[] {
  let value: unknown;
  try { value = JSON.parse(output); } catch { return numbers(output); }
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === 'number') out.push(...numbers(String(v)));
    else if (typeof v === 'string') out.push(...numbers(v));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (Array.isArray(o.columns) && Array.isArray(o.rows)) {
        const keep = o.columns.map((c) => FIGURE_COLUMNS.has(String(c)));
        for (const row of o.rows) if (Array.isArray(row)) row.forEach((cell, i) => { if (keep[i]) walk(cell); });
        for (const [k, x] of Object.entries(o)) if (k !== 'rows' && k !== 'columns') walk(x);
      } else Object.values(o).forEach(walk);
    }
  };
  walk(value);
  return out;
}

/** Numbers in the answer that appear in no tool output, the question or the shown day and time. */
export function unsupportedNumbers(answer: string, sources: string[]): string[] {
  const known = new Set(sources.flatMap(supportedNumbers));
  return numbers(answer).filter((n) => !known.has(n));
}

let answersWithUnsupportedNumbers = 0;
/** How many answers so far had a number no tool returned (counted, not blocked). */
export const unsupportedNumberCount = () => answersWithUnsupportedNumbers;

// ---------------------------------------------------------------- the run

export async function askAgent(question: string, ctx: ServerAskContext, signal?: AbortSignal, model: string | Model = ASK_MODEL): Promise<AskResult> {
  const log = newToolLog();
  const modelName = typeof model === 'string' ? model : ASK_MODEL;
  const agent = new Agent({
    name: 'Flowcast campus guide',
    model,
    instructions: instructions(ctx),
    tools: createTools(ctx, log),
    // maxTokens includes reasoning tokens.
    modelSettings: { reasoning: { effort: 'low' }, parallelToolCalls: true, maxTokens: 2000, store: false },
  });
  const reply = (answer: string): AskResult => ({ answer, model: modelName, ...mapOutput(log), calls: log.calls });

  let raw: string;
  try {
    const result = await runner.run(agent, question, { maxTurns: 6, signal });
    raw = typeof result.finalOutput === 'string' ? result.finalOutput.trim() : '';
  } catch (error) {
    if (error instanceof MaxTurnsExceededError && !signal?.aborted) {
      console.warn('ask: turn limit reached, sent the fallback answer');
      return reply(FALLBACK_ANSWER);
    }
    throw error;
  }
  if (!raw) {
    console.warn('ask: empty model output, sent the fallback answer');
    return reply(FALLBACK_ANSWER);
  }
  const answer = rewordAnswer(raw);
  if (answer === null) {
    console.warn('ask: answer used wording the project rules out, sent the fallback answer');
    return reply(FALLBACK_ANSWER);
  }
  const shown = `${ctx.weekday} ${ctx.time} ${formatClock(ctx.time)}`;
  if (unsupportedNumbers(answer, [...log.outputs, question, shown]).length) {
    answersWithUnsupportedNumbers++;
    console.warn(`ask: answer had a number no tool returned (${answersWithUnsupportedNumbers} so far)`);
  }
  return reply(answer);
}
