// One chat turn (POST /api/chat): the conversation so far goes to the agent as history, the agent
// answers with the Ask tools plus the chat tools (chatTools.ts), and the server attaches what the
// model never writes: visuals, citations, follow-ups and the map link, all from tool outputs.
// Same honesty checks as /api/ask: wording the project rules out is reworded or refused, and an
// answer with a number no tool returned is counted.

import { Agent, MaxTurnsExceededError, Runner, assistant, user, type AgentInputItem, type Model } from '@openai/agents';
import type { ChatResponse, ChatTurn } from '../../map-client/src/chatContract';
import { formatClock } from '../../map-client/src/sim/playback';
import { WEEKDAYS } from '../../map-client/src/data/campusData';
import { ASK_MODEL, FALLBACK_ANSWER, rewordAnswer, unsupportedNumbers } from './agent';
import { createChatTools, type ChatContext } from './chatTools';
import { citationsFor, type Dataset, type DatasetId } from './directory';
import { mapOutput, newToolLog } from './tools';
import { buildVisuals, followUpsFor, mapLinkFor } from './visuals';

// Conversations and tool results are not sent to OpenAI's trace dashboard.
const runner = new Runner({ tracingDisabled: true });

/** The longest answer the client can send back as an assistant turn (ChatTurn). */
export const MAX_ANSWER_CHARS = 2000;

function instructions(ctx: ChatContext): string {
  return [
    'You answer questions about the Boston University campus for Flowcast, a 3D campus model filled with simulated students, in a chat that can follow up on earlier turns.',
    `The page shows ${WEEKDAYS[ctx.weekday]} at ${formatClock(ctx.time)} on the ${ctx.campus} campus${ctx.date ? `, for the event date ${ctx.date}` : ' of the representative reference week'}. "Now" means that time.`,
    '',
    'Tools cover: crowding (rank_places_by_crowd, place_day, campus_overview, model_basis), places and hours (place_info, find_places), classes (find_course, free_rooms), walking (walking_route), ' +
      'events (list_events, event_impact), transit (transit_near), Bluebikes (bluebikes), housing (housing), population (population_summary), published counts (published_counts, library_gate_counts), ' +
      'validation against published counts (model_validation), weather and what-ifs (weather_effects, what_if_scenarios), emergencies (emergency_info), the academic calendar (academic_calendar) and parking (parking_lots).',
    '',
    'Rules:',
    '- Get every number, place, time, date and course from a tool in this turn. Never estimate or recall one yourself, and don’t reuse a number from an earlier turn without calling the tool again. If no tool can answer, say what you can answer instead.',
    '- Label every figure: simulated or modeled (crowding, event impact, fire response), published (hours, counts, schedules, enrollment, beds) or an assumption (scenarios, weather effects). Never mix published counts with simulated figures, and give a published count’s period.',
    '- Registrations, seats, beds and capacities are never attendance or occupancy.',
    '- Closed is not quiet: open=false means closed by published hours; never call it quiet or empty. open=null means hours aren’t published: not closed.',
    '- If a tool gives afterMidnightNote, say the place is open then but the simulation doesn’t model visits after midnight.',
    '- For another day, pass the weekday parameter (0 = Monday). If a tool returns available=false, say that day is still being simulated and to try again shortly.',
    '- For "why is X busy/full/quiet": use place_day and model_basis (meals_study_gym for libraries, dining and gyms; enrollment for classrooms; housing for dorms; capacity for percentages).',
    '- Call simulation outputs "simulated", "modeled" or "projected". Never call them predictions, measurements or live counts, and never describe the model’s quality as accuracy; say how it compares with published counts (model_validation).',
    '- If modeled=false, say the simulation doesn’t model that place that day. If percent is null, give the student count and say the capacity isn’t comparable. If isEstimate=true, the walk is a straight-line estimate.',
    '- If a course code is ambiguous, ask which of the listed courses the user means. If a place name is unknown, call find_places before giving up.',
    '- You know nobody’s personal schedule, fatigue or other personal data, and the map is shown on shared screens. For "my next class" and similar, say so and suggest asking by course code or on their Flowcast home page.',
    '- Transit times are scheduled, not live. Bluebikes figures are typical-day averages from the published trip history. Fire response times are modeled from uncalibrated assumptions, not Boston Fire Department data.',
    '- Charts and tables are attached to your reply automatically from your tool calls, so mention only the few figures that answer the question.',
    '- Format: one to three short paragraphs, or a short list with lines starting "- ". You may use **bold** for a key name or figure. No headings, links, tables, images or code. Aim for at most 120 words. Use the names the tools return.',
    '- Only answer questions about the campus, its places, crowds, walks, classes, events, transit, housing and the data behind them. Politely decline anything else.',
  ].join('\n');
}

/**
 * The reply in the contract's markdown subset: paragraphs, **bold** and "- " bullets. Headings,
 * links, images, code and tables are turned into plain text; the result fits an assistant turn.
 */
export function toChatMarkdown(text: string): string {
  let out = text.replace(/\r\n?/g, '\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/<?https?:\/\/[^\s>)]+>?/g, '') // bare URLs
    .replace(/```[^\n]*\n?/g, '').replace(/`([^`]*)`/g, '$1') // code
    .replace(/__([^_\n]+)__/g, '**$1**') // __bold__ → **bold**
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2') // *italic* → plain
    .split('\n').map((line) => {
      const l = line.replace(/^\s{0,3}#{1,6}\s+/, '') // headings
        .replace(/^\s*(?:[*•+]|\d+[.)])\s+/, '- ') // other bullets and numbered lists
        .replace(/^\s+-\s+/, '- ');
      if (/^\s*\|?\s*:?-{3,}/.test(l) && /\|/.test(l)) return null; // table rule
      if (/^\s*\|.*\|\s*$/.test(l)) return `- ${l.split('|').map((c) => c.trim()).filter(Boolean).join(', ')}`; // table row
      return l.trimEnd();
    }).filter((l): l is string => l !== null).join('\n')
    .replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > MAX_ANSWER_CHARS) {
    const cut = out.slice(0, MAX_ANSWER_CHARS - 1);
    const end = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '));
    out = `${(end > MAX_ANSWER_CHARS / 2 ? cut.slice(0, end + 1) : cut).trimEnd()}…`;
  }
  return out;
}

let chatAnswersWithUnsupportedNumbers = 0;
/** How many chat answers so far had a number no tool returned (counted, not blocked). */
export const chatUnsupportedNumberCount = () => chatAnswersWithUnsupportedNumbers;

export interface ChatInput { messages: ChatTurn[] }

/** Earlier turns as model input items, then the new question. */
export function historyItems(messages: ChatTurn[]): AgentInputItem[] {
  return messages.map((m) => (m.role === 'user' ? user(m.text) : assistant(m.text)));
}

export async function chatAgent(
  input: ChatInput,
  ctx: ChatContext,
  catalog: Record<DatasetId, Dataset>,
  signal?: AbortSignal,
  model: string | Model = ASK_MODEL,
): Promise<ChatResponse> {
  const log = newToolLog();
  const modelName = typeof model === 'string' ? model : ASK_MODEL;
  const agent = new Agent({
    name: 'Flowcast campus chat',
    model,
    instructions: instructions(ctx),
    tools: createChatTools(ctx, log),
    modelSettings: { reasoning: { effort: 'low' }, parallelToolCalls: true, maxTokens: 3000, store: false },
  });
  const kindOf = (name: string) => ctx.locations.find((l) => l.name === name)?.kind;
  const question = input.messages[input.messages.length - 1]?.text ?? '';
  const reply = (answer: string): ChatResponse => ({
    answer,
    visuals: buildVisuals(log.results),
    show: mapOutput(log).show,
    mapLink: mapLinkFor(log.results, ctx),
    sources: citationsFor(log.results, catalog, kindOf),
    followUps: followUpsFor(log.results, input.messages.filter((m) => m.role === 'user').map((m) => m.text)),
    model: modelName,
    calls: log.calls,
  });

  let raw: string;
  try {
    const result = await runner.run(agent, historyItems(input.messages), { maxTurns: 8, signal });
    raw = typeof result.finalOutput === 'string' ? result.finalOutput.trim() : '';
  } catch (error) {
    if (error instanceof MaxTurnsExceededError && !signal?.aborted) {
      console.warn('chat: turn limit reached, sent the fallback answer');
      return reply(FALLBACK_ANSWER);
    }
    throw error;
  }
  if (!raw) {
    console.warn('chat: empty model output, sent the fallback answer');
    return reply(FALLBACK_ANSWER);
  }
  const reworded = rewordAnswer(raw);
  if (reworded === null) {
    console.warn('chat: answer used wording the project rules out, sent the fallback answer');
    return reply(FALLBACK_ANSWER);
  }
  const answer = toChatMarkdown(reworded) || FALLBACK_ANSWER;
  // Earlier turns count as support: a follow-up may repeat a figure an earlier answer gave.
  const shown = `${ctx.weekday} ${ctx.time} ${formatClock(ctx.time)} ${ctx.date ?? ''}`;
  if (unsupportedNumbers(answer, [...log.outputs, ...input.messages.map((m) => m.text), question, shown]).length) {
    chatAnswersWithUnsupportedNumbers++;
    console.warn(`chat: answer had a number no tool returned (${chatAnswersWithUnsupportedNumbers} so far)`);
  }
  return reply(answer);
}
