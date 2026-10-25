// Reads what the Ask server's chat endpoints send back (POST /api/chat, GET /api/chat/directory;
// shapes in map-client/src/chatContract.ts) into values the /ask page can render without checks.
// Defensive like askClient's parsers: a malformed visual, citation or domain is dropped, never
// rendered half-formed, and nothing here throws.

import { mapLink } from './mapLink.ts';
import type {
  BarVisual,
  ChatResponse,
  Citation,
  DataDomain,
  DirectoryResponse,
  LineVisual,
  Provenance,
  StatsVisual,
  TableVisual,
  Visual,
} from '@map/chatContract';
import type { AgentShow } from '@map/askClient';

export type ChatErrorKind =
  | 'warming' | 'rateLimited' | 'unavailable' | 'notConfigured' | 'badRequest' | 'timeout' | 'network'
  /** The person pressed Stop or cleared the conversation. Not shown as an error. */
  | 'aborted';

export interface ChatError {
  kind: ChatErrorKind;
  message: string;
  /** Seconds to wait before asking again (warming, rate limits). */
  retryAfter?: number;
}

export type ChatResult = { ok: true; value: ChatResponse } | { ok: false; error: ChatError };

export type DirectoryResult =
  | { ok: true; value: DirectoryResponse }
  /** `unreachable`: no Ask server answered at all (not running, or no proxy). */
  | { ok: false; error: { kind: 'unreachable' | 'unavailable'; message: string } };

/** Contract limits (chatContract.ts). */
export const CHAT_LIMITS = {
  visuals: 4,
  followUps: 3,
  lineSeries: 4,
  bars: 12,
  tableRows: 25,
  statsItems: 6,
  answerChars: 2000,
  /** Not in the contract: generous caps so a runaway response can't flood the page. */
  sources: 12,
  lineX: 200,
  tableColumns: 8,
  text: 200,
} as const;

const MAX_RETRY_AFTER_SEC = 30;
const PROVENANCE: readonly Provenance[] = ['simulated', 'published', 'assumption', 'mixed'];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null => (isNum(v) ? v : null);
const str = (v: unknown, max: number = CHAT_LIMITS.text): string | null => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const strOrNull = (v: unknown, max?: number): string | null => str(v, max);
const provenance = (v: unknown): Provenance | null => (PROVENANCE.includes(v as Provenance) ? (v as Provenance) : null);

/** Only http(s) links leave the page; anything else (javascript:, data:, relative) is dropped. */
export function safeUrl(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  try {
    const url = new URL(v);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * The map link must be a relative link into the 3D map ("/map?at=12:20&speed=1"). Anything else,
 * including "//elsewhere" and absolute URLs, is dropped. `mapUrl` replaces the "/map" prefix
 * when the map is served elsewhere (config.mapUrl).
 */
export function safeMapLink(v: unknown, mapUrl = '/map'): string | null {
  if (typeof v !== 'string') return null;
  const m = /^\/map\/?(\?[^\s#]*)?$/.exec(v.trim());
  if (!m) return null;
  return mapLink(mapUrl, new URLSearchParams(m[1] ?? ''));
}

function base(v: Record<string, unknown>): { id: string; title: string; source: Provenance; note: string | null } | null {
  const id = str(v.id, 80);
  const title = str(v.title);
  const source = provenance(v.source);
  if (!id || !title || !source) return null;
  return { id, title, source, note: strOrNull(v.note, 300) };
}

function parseLine(v: Record<string, unknown>): LineVisual | null {
  const b = base(v);
  if (!b || !Array.isArray(v.x) || !Array.isArray(v.series)) return null;
  const x = v.x.map((label) => (typeof label === 'string' ? label.slice(0, 40) : isNum(label) ? String(label) : null));
  if (!x.length || x.length > CHAT_LIMITS.lineX || x.some((label) => label === null)) return null;
  const series: LineVisual['series'] = [];
  for (const s of v.series.slice(0, CHAT_LIMITS.lineSeries)) {
    if (!isObject(s) || !Array.isArray(s.values) || s.values.length !== x.length) continue;
    const name = str(s.name, 60);
    if (!name) continue;
    series.push({ name, values: s.values.map(numOrNull) });
  }
  if (!series.length || series.every((s) => s.values.every((n) => n === null))) return null;
  const marker = isObject(v.marker) && Number.isInteger(v.marker.index) && (v.marker.index as number) >= 0 && (v.marker.index as number) < x.length
    ? { index: v.marker.index as number, label: str(v.marker.label, 40) ?? x[v.marker.index as number]! }
    : null;
  return { ...b, kind: 'line', unit: str(v.unit, 30) ?? '', x: x as string[], series, marker };
}

function parseBar(v: Record<string, unknown>): BarVisual | null {
  const b = base(v);
  if (!b || !Array.isArray(v.bars)) return null;
  const bars: BarVisual['bars'] = [];
  for (const bar of v.bars.slice(0, CHAT_LIMITS.bars)) {
    if (!isObject(bar)) continue;
    const label = str(bar.label, 80);
    if (!label) continue;
    bars.push({ label, value: numOrNull(bar.value), level: strOrNull(bar.level, 20), detail: strOrNull(bar.detail, 120) });
  }
  if (!bars.length) return null;
  return { ...b, kind: 'bar', unit: str(v.unit, 30) ?? '', bars };
}

function parseTable(v: Record<string, unknown>): TableVisual | null {
  const b = base(v);
  if (!b || !Array.isArray(v.columns) || !Array.isArray(v.rows)) return null;
  const columns: TableVisual['columns'] = [];
  const seen = new Set<string>();
  for (const c of v.columns.slice(0, CHAT_LIMITS.tableColumns)) {
    if (!isObject(c)) continue;
    const key = str(c.key, 60);
    const label = str(c.label, 60);
    if (!key || !label || seen.has(key)) continue;
    seen.add(key);
    columns.push({ key, label, align: c.align === 'right' ? 'right' : 'left' });
  }
  if (!columns.length) return null;
  const rows = v.rows.slice(0, CHAT_LIMITS.tableRows).filter(isObject).map((r) =>
    Object.fromEntries(columns.map((c) => {
      const cell = r[c.key];
      return [c.key, typeof cell === 'string' ? cell.slice(0, CHAT_LIMITS.text) : isNum(cell) ? cell : null];
    })),
  );
  if (!rows.length) return null;
  return { ...b, kind: 'table', columns, rows };
}

function parseStats(v: Record<string, unknown>): StatsVisual | null {
  const b = base(v);
  if (!b || !Array.isArray(v.items)) return null;
  const items: StatsVisual['items'] = [];
  for (const item of v.items.slice(0, CHAT_LIMITS.statsItems)) {
    if (!isObject(item)) continue;
    const label = str(item.label, 60);
    const value = typeof item.value === 'string' ? str(item.value, 40) : isNum(item.value) ? item.value.toLocaleString('en-US') : null;
    if (!label || !value) continue;
    items.push({ label, value, detail: strOrNull(item.detail, 120) });
  }
  if (!items.length) return null;
  return { ...b, kind: 'stats', items };
}

/** One visual, or null when it's malformed (then it's left out rather than drawn wrong). */
export function parseVisual(v: unknown): Visual | null {
  if (!isObject(v)) return null;
  switch (v.kind) {
    case 'line': return parseLine(v);
    case 'bar': return parseBar(v);
    case 'table': return parseTable(v);
    case 'stats': return parseStats(v);
    default: return null;
  }
}

function parseVisuals(v: unknown): Visual[] {
  if (!Array.isArray(v)) return [];
  const out: Visual[] = [];
  const ids = new Set<string>();
  for (const item of v) {
    const visual = parseVisual(item);
    if (!visual || ids.has(visual.id)) continue;
    ids.add(visual.id);
    out.push(visual);
    if (out.length === CHAT_LIMITS.visuals) break;
  }
  return out;
}

export function parseCitation(v: unknown): Citation | null {
  if (!isObject(v)) return null;
  const label = str(v.label, 120);
  const kind = provenance(v.kind);
  if (!label || !kind) return null;
  return { label, domain: str(v.domain, 40) ?? '', kind, url: safeUrl(v.url) };
}

const isPoint = (v: unknown): v is [number, number] => Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1]);
const points = (v: unknown): [number, number][] => (Array.isArray(v) ? v.filter(isPoint).map((p) => [p[0], p[1]]) : []);

function parseShow(v: unknown): AgentShow | null {
  if (!isObject(v)) return null;
  const route = isObject(v.route) && points(v.route.path).length >= 2 ? { path: points(v.route.path), estimate: v.route.estimate === true } : null;
  return { route, select: typeof v.select === 'string' ? v.select : null, points: points(v.points) };
}

function retrySeconds(header: string | null, body: unknown): number | undefined {
  const fromBody = isObject(body) ? numOrNull(body.retryAfter) : null;
  const fromHeader = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : null;
  const sec = fromBody ?? fromHeader;
  return sec === null ? undefined : Math.min(MAX_RETRY_AFTER_SEC, Math.max(1, Math.round(sec)));
}

/** A 200 body to a ChatResponse, or null when it has no readable answer. */
export function parseChatBody(body: unknown, mapUrl = '/map'): ChatResponse | null {
  if (!isObject(body) || typeof body.answer !== 'string' || !body.answer.trim()) return null;
  const sources: Citation[] = [];
  const seen = new Set<string>();
  for (const c of Array.isArray(body.sources) ? body.sources : []) {
    const citation = parseCitation(c);
    const key = citation && `${citation.label}|${citation.kind}`;
    if (!citation || seen.has(key!)) continue;
    seen.add(key!);
    sources.push(citation);
    if (sources.length === CHAT_LIMITS.sources) break;
  }
  return {
    answer: body.answer.trim().slice(0, CHAT_LIMITS.answerChars),
    visuals: parseVisuals(body.visuals),
    show: parseShow(body.show),
    mapLink: safeMapLink(body.mapLink, mapUrl),
    sources,
    followUps: Array.isArray(body.followUps)
      ? body.followUps.map((q) => str(q, 300)).filter((q): q is string => q !== null).slice(0, CHAT_LIMITS.followUps)
      : [],
    model: typeof body.model === 'string' ? body.model.slice(0, 80) : '',
    calls: Array.isArray(body.calls) ? body.calls.filter((c): c is string => typeof c === 'string').slice(0, 40) : [],
  };
}

/** One /api/chat response (status, parsed JSON body or null, Retry-After header) to a typed result. */
export function parseChatResponse(status: number, body: unknown, retryAfterHeader: string | null = null, mapUrl = '/map'): ChatResult {
  const serverMessage = isObject(body) && typeof body.error === 'string' ? body.error.slice(0, 300) : null;
  const fail = (kind: ChatErrorKind, fallback: string, retryAfter?: number): ChatResult =>
    ({ ok: false, error: { kind, message: serverMessage ?? fallback, ...(retryAfter === undefined ? {} : { retryAfter }) } });

  if (status === 200) {
    const value = parseChatBody(body, mapUrl);
    return value ? { ok: true, value } : { ok: false, error: { kind: 'unavailable', message: 'The Ask server sent an answer this page can’t read.' } };
  }
  // No JSON body on an error status: a dev proxy with nothing behind it, or a server without /api/chat.
  if (body === null && (status === 404 || status === 500 || status === 502 || status === 504)) {
    return { ok: false, error: { kind: 'network', message: 'Couldn’t reach the Ask server.' } };
  }
  if (status === 503) {
    if (serverMessage && /not configured|api key|openai/i.test(serverMessage)) return fail('notConfigured', 'Answers need the Ask server’s OpenAI key.');
    const wait = retrySeconds(retryAfterHeader, body);
    if (wait !== undefined) return fail('warming', 'The simulation for that day is still being built.', wait);
    return fail('unavailable', 'The Ask server is unavailable.');
  }
  if (status === 429) return fail('rateLimited', 'Too many questions. Try again in a minute.', retrySeconds(retryAfterHeader, body) ?? 60);
  if (status === 400 || status === 413) return fail('badRequest', 'The question couldn’t be sent.');
  if (status === 504) return fail('timeout', 'The answer took too long.');
  return fail('unavailable', 'The Ask server is unavailable.');
}

function parseDomain(v: unknown): DataDomain | null {
  if (!isObject(v)) return null;
  const id = str(v.id, 40);
  const title = str(v.title, 80);
  if (!id || !title) return null;
  const datasets: DataDomain['datasets'] = [];
  for (const d of Array.isArray(v.datasets) ? v.datasets.slice(0, 20) : []) {
    if (!isObject(d)) continue;
    const name = str(d.name, 120);
    const kind = provenance(d.kind);
    if (!name || !kind) continue;
    datasets.push({ name, kind, period: strOrNull(d.period, 60), url: safeUrl(d.url), coverage: strOrNull(d.coverage, 80) });
  }
  return {
    id,
    title,
    description: str(v.description, 400) ?? '',
    datasets,
    examples: Array.isArray(v.examples) ? v.examples.map((q) => str(q, 300)).filter((q): q is string => q !== null).slice(0, 6) : [],
  };
}

/** One /api/chat/directory response to a typed result. */
export function parseDirectoryResponse(status: number, body: unknown): DirectoryResult {
  if (status === 200 && isObject(body) && Array.isArray(body.domains)) {
    const ids = new Set<string>();
    const domains = body.domains.map(parseDomain).filter((d): d is DataDomain => {
      if (!d || ids.has(d.id)) return false;
      ids.add(d.id);
      return true;
    }).slice(0, 20);
    return { ok: true, value: { domains, chatAvailable: body.chatAvailable === true, model: typeof body.model === 'string' ? body.model.slice(0, 80) : '' } };
  }
  if (body === null || status === 404 || status === 502 || status === 504) {
    return { ok: false, error: { kind: 'unreachable', message: 'The Ask server isn’t running.' } };
  }
  const message = isObject(body) && typeof body.error === 'string' ? body.error.slice(0, 300) : 'The Ask server couldn’t list its data.';
  return { ok: false, error: { kind: 'unavailable', message } };
}

/** Display word for a provenance, as on every badge. */
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  simulated: 'Simulated',
  published: 'Published',
  assumption: 'Assumption',
  mixed: 'Mixed',
};
