// Browser client for the Ask server (server/, POST /api/ask). The map's Ask tab and the dashboard's
// Ask mode both use it. The OpenAI key stays on the server; this only talks to /api/ask and /api/health,
// which the Vite dev and preview servers proxy (see vite.config.ts). Parsing is separate from fetching
// so it can be tested offline.

export type AskCampus = 'charles-river' | 'fenway' | 'medical';

export interface AgentMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentRequest {
  question: string;
  history?: AgentMessage[];
  /** 0 = Monday … 6 = Sunday. */
  weekday: number;
  /** Seconds since midnight. */
  time: number;
  campus: AskCampus;
}

export interface AgentRow {
  id: string;
  name: string;
  /** Simulated students over stated capacity, rounded; null when not comparable or closed. */
  percent: number | null;
  /** Quiet, Moderate, Busy or Packed; null when there is no percent. */
  level: string | null;
  students: number;
  modeled: boolean;
  /** Open by published hours; null when hours aren't published. */
  open: boolean | null;
  walkMinutes: number | null;
}

export interface AgentShow {
  route: { path: [number, number][]; estimate: boolean } | null;
  /** Map location id to select. */
  select: string | null;
  points: [number, number][];
}

export interface AgentAnswer {
  answer: string;
  model: string;
  show: AgentShow | null;
  rows: AgentRow[];
  calls: string[];
}

export type AgentErrorKind =
  | 'warming' | 'rateLimited' | 'unavailable' | 'notConfigured' | 'badRequest' | 'timeout' | 'network'
  /** The caller cancelled (a newer question replaced this one). Not shown to anyone. */
  | 'aborted';

export interface AgentError {
  kind: AgentErrorKind;
  message: string;
  /** Seconds to wait before asking again (warming, rate limits). */
  retryAfter?: number;
}

export type AgentResult = { ok: true; value: AgentAnswer } | { ok: false; error: AgentError };

/**
 * The server allows the model 25 s once the request is handled, and a request can first wait behind
 * a day build already running there (about 7 s; the server starts no new build while an answer
 * runs), so the browser waits longer than both.
 */
export const ASK_TIMEOUT_MS = 40_000;
const MAX_RETRY_AFTER_SEC = 30;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown) => (isNum(v) ? v : null);
const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]);
const points = (v: unknown): [number, number][] => (Array.isArray(v) ? v.filter(isPoint).map((p) => [p[0], p[1]]) : []);

function parseRow(v: unknown): AgentRow | null {
  if (!isObject(v) || typeof v.id !== 'string' || typeof v.name !== 'string') return null;
  return {
    id: v.id,
    name: v.name,
    percent: numOrNull(v.percent),
    level: typeof v.level === 'string' ? v.level : null,
    students: isNum(v.students) ? v.students : 0,
    modeled: v.modeled !== false,
    open: typeof v.open === 'boolean' ? v.open : null,
    walkMinutes: numOrNull(v.walkMinutes),
  };
}

function parseShow(v: unknown): AgentShow | null {
  if (!isObject(v)) return null;
  const route = isObject(v.route) && points(v.route.path).length >= 2
    ? { path: points(v.route.path), estimate: v.route.estimate === true }
    : null;
  return { route, select: typeof v.select === 'string' ? v.select : null, points: points(v.points) };
}

function retrySeconds(header: string | null, body: unknown): number | undefined {
  const fromBody = isObject(body) ? numOrNull(body.retryAfter) : null;
  const fromHeader = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : null;
  const sec = fromBody ?? fromHeader;
  return sec === null ? undefined : Math.min(MAX_RETRY_AFTER_SEC, Math.max(1, Math.round(sec)));
}

/** One /api/ask response (status, parsed JSON body or null, Retry-After header) to a typed result. */
export function parseAskResponse(status: number, body: unknown, retryAfterHeader: string | null = null): AgentResult {
  const serverMessage = isObject(body) && typeof body.error === 'string' ? body.error : null;
  const fail = (kind: AgentErrorKind, fallback: string, retryAfter?: number): AgentResult =>
    ({ ok: false, error: { kind, message: serverMessage ?? fallback, ...(retryAfter === undefined ? {} : { retryAfter }) } });

  if (status === 200) {
    if (!isObject(body) || typeof body.answer !== 'string' || !body.answer.trim()) {
      return { ok: false, error: { kind: 'unavailable', message: 'The Ask server sent an answer this page can’t read.' } };
    }
    return {
      ok: true,
      value: {
        answer: body.answer.trim(),
        model: typeof body.model === 'string' ? body.model : '',
        show: parseShow(body.show),
        rows: Array.isArray(body.rows) ? body.rows.map(parseRow).filter((r): r is AgentRow => r !== null) : [],
        calls: Array.isArray(body.calls) ? body.calls.filter((c): c is string => typeof c === 'string') : [],
      },
    };
  }
  if (status === 503) {
    if (serverMessage && /not configured/i.test(serverMessage)) return fail('notConfigured', 'Ask is not configured on the server.');
    const wait = retrySeconds(retryAfterHeader, body);
    if (wait !== undefined) return fail('warming', 'The simulation for that day is still being built.', wait);
    return fail('unavailable', 'The Ask server is unavailable.');
  }
  if (status === 429) return fail('rateLimited', 'Too many questions. Try again in a minute.', retrySeconds(retryAfterHeader, body) ?? 60);
  if (status === 400 || status === 413) return fail('badRequest', 'The question couldn’t be sent.');
  if (status === 504) return fail('timeout', 'The answer took too long.');
  return fail('unavailable', 'The Ask server is unavailable.');
}

/** /api/health body to whether the server can answer; null when it isn't the Ask server. */
export function parseHealth(body: unknown): { keyConfigured: boolean; model: string } | null {
  if (!isObject(body) || body.ok !== true) return null;
  return { keyConfigured: body.keyConfigured === true, model: typeof body.model === 'string' ? body.model : '' };
}

type Fetch = typeof fetch;

/** Ask the agent one question. Never throws: failures come back as typed errors. */
export async function askAgent(
  request: AgentRequest,
  signal?: AbortSignal,
  { fetchImpl = fetch, timeoutMs = ASK_TIMEOUT_MS }: { fetchImpl?: Fetch; timeoutMs?: number } = {},
): Promise<AgentResult> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchImpl('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(request),
      signal: combined,
    });
    // A body that can't be read because the request was cancelled or timed out is reported as
    // that (below), not as an unreadable answer.
    const body: unknown = await response.json().catch((error: unknown) => {
      if (combined.aborted) throw error;
      return null;
    });
    return parseAskResponse(response.status, body, response.headers.get('Retry-After'));
  } catch {
    if (signal?.aborted) return { ok: false, error: { kind: 'aborted', message: 'Cancelled.' } };
    if (timeout.aborted) return { ok: false, error: { kind: 'timeout', message: 'The answer took too long.' } };
    return { ok: false, error: { kind: 'network', message: 'Couldn’t reach the Ask server.' } };
  }
}

/** Waits `ms`, or resolves false early when `signal` aborts. */
function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const id = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(true); }, ms);
    const stop = () => { clearTimeout(id); resolve(false); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

/**
 * askAgent, asking once more after the server's Retry-After when the day is still being simulated.
 * `onWarming` is called before the wait, so the page can say what it's waiting for.
 */
export async function askAgentWithRetry(
  request: AgentRequest,
  signal?: AbortSignal,
  options: { fetchImpl?: Fetch; timeoutMs?: number; onWarming?: (retryAfterSec: number) => void; sleep?: typeof pause } = {},
): Promise<AgentResult> {
  const first = await askAgent(request, signal, options);
  if (first.ok || first.error.kind !== 'warming') return first;
  const wait = first.error.retryAfter ?? 10;
  options.onWarming?.(wait);
  if (!(await (options.sleep ?? pause)(wait * 1000, signal))) return { ok: false, error: { kind: 'aborted', message: 'Cancelled.' } };
  return askAgent(request, signal, options);
}

const HEALTH_TTL_MS = 60_000;
let health: { at: number; configured: Promise<boolean> } | null = null;

/**
 * False only when /api/health says the server has no key: then pages answer on the device without
 * trying. Unreachable health is treated as "try" (the ask itself then fails fast and falls back).
 * Cached for a minute.
 */
export function agentConfigured(fetchImpl: Fetch = fetch, now = Date.now()): Promise<boolean> {
  if (health && now - health.at < HEALTH_TTL_MS) return health.configured;
  const configured = fetchImpl('/api/health', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(5_000) })
    .then(async (r) => (r.ok ? parseHealth(await r.json().catch(() => null)) : null))
    .then((h) => h?.keyConfigured !== false)
    .catch(() => true);
  health = { at: now, configured };
  return configured;
}
