// HTTP API for Ask. POST /api/ask runs one agent question against the simulation for the day and
// time the map is showing. The OpenAI key stays here; browsers only talk to this endpoint.

import { personalScheduleSchema } from './personalSchedule';
import type { PersonalSchedule } from '../../map-client/src/personalSchedule';
import type pg from 'pg';
import { dashboardRouter } from './dashboard/router';
import { isIP } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { WEEKDAYS } from '../../map-client/src/data/campusData';
import type { ChatResponse, ChatTurn, DataDomain } from '../../map-client/src/chatContract';
import type { CampusModel } from './campus';
import type { AskResult } from './agent';
import type { ServerAskContext } from './facts';
import type { ChatContext } from './chatTools';
import { buildDirectory } from './directory';
import type { AgentMessage } from '../../map-client/src/askClient';
import { MAX_HISTORY_PAIRS, MAX_USER_LENGTH, MAX_ASSISTANT_LENGTH, MAX_HISTORY_LENGTH } from '../../map-client/src/askConversation';

const historySchema = z.array(z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().max(MAX_USER_LENGTH) }),
  z.object({ role: z.literal('assistant'), content: z.string().max(MAX_ASSISTANT_LENGTH) }),
])).max(MAX_HISTORY_PAIRS * 2)
  .refine((history) => history.length % 2 === 0 && history.every((message, i) => message.role === (i % 2 === 0 ? 'user' : 'assistant')), 'History must contain complete user/assistant pairs')
  .refine((history) => history.reduce((total, message) => total + message.content.length, 0) <= MAX_HISTORY_LENGTH, 'History is too long');

export const AskRequest = z.object({
  personalSchedule: personalScheduleSchema.optional(),
  question: z.string().trim().min(1).max(300),
  history: historySchema.optional(),
  weekday: z.number().int().min(0).max(6),
  time: z.number().int().min(0).max(86399),
  campus: z.string().min(1).max(40),
});

const isDate = (d: string) => !Number.isNaN(Date.parse(`${d}T12:00:00Z`)) && new Date(`${d}T12:00:00Z`).toISOString().slice(0, 10) === d;

export const ChatRequest = z.object({
  personalSchedule: personalScheduleSchema.optional(),
  messages: z.array(z.discriminatedUnion('role', [
    z.object({ role: z.literal('user'), text: z.string().trim().min(1).max(300) }),
    z.object({ role: z.literal('assistant'), text: z.string().max(2000) }),
  ])).min(1).max(12).refine((m) => m.length > 0 && m[m.length - 1].role === 'user', 'The last turn must be the user’s question.'),
  weekday: z.number().int().min(0).max(6),
  time: z.number().int().min(0).max(86399),
  campus: z.string().min(1).max(40),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isDate).nullable().optional(),
});

export interface AppOptions {
  dashboardPool?: pg.Pool;
  campus: CampusModel;
  ask: (question: string, ctx: ServerAskContext, signal: AbortSignal, history?: AgentMessage[]) => Promise<AskResult>;
  /** One chat turn (chat.ts); without it /api/chat answers 503 and the directory says chat is unavailable. */
  chat?: (input: { messages: ChatTurn[] }, ctx: ChatContext, signal: AbortSignal) => Promise<ChatResponse>;
  /** The directory's domains; built from the campus model when not given. */
  directory?: () => DataDomain[];
  keyConfigured: boolean;
  model: string;
  /** Per client address, per minute. */
  perMinute?: number;
  /** Across all clients, per hour: a ceiling on spend if the endpoint is found. */
  perHour?: number;
  /** Most client addresses the per-client limiter tracks; new ones beyond it get 429. */
  maxClients?: number;
  /** Time allowed for the model run, after the simulated day is ready. */
  timeoutMs?: number;
  /** Seconds a client is told to wait while a day is being simulated. */
  retryAfterSec?: number;
  /** Proxy hops in front of this server (express 'trust proxy'); defaults to TRUST_PROXY_HOPS or 0. */
  trustProxyHops?: number;
}

/**
 * A fixed-window counter: at most `limit` hits per key per window. Expired windows are swept once
 * per window, and when `maxKeys` keys are live a new key is refused (an address flood can't grow
 * memory without bound).
 */
export function limiter(limit: number, windowMs: number, maxKeys = Infinity) {
  const hits = new Map<string, { start: number; count: number }>();
  let lastSweep = 0;
  const sweep = (now: number) => {
    for (const [key, h] of hits) if (now - h.start >= windowMs) hits.delete(key);
    lastSweep = now;
  };
  const hit = (key: string, now = Date.now()) => {
    if (now - lastSweep >= windowMs) sweep(now);
    const h = hits.get(key);
    if (!h || now - h.start >= windowMs) {
      if (!h && hits.size >= maxKeys) {
        sweep(now);
        if (hits.size >= maxKeys) return false;
      }
      hits.set(key, { start: now, count: 1 });
      return 1 <= limit;
    }
    h.count++;
    return h.count <= limit;
  };
  return Object.assign(hit, { size: () => hits.size });
}

/** The 8 hextets of an IPv6 address without an embedded IPv4 part. */
function hextets(ip: string): string[] {
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((h) => h.toLowerCase().replace(/^0+(?=.)/, ''));
}

/** The rate-limit key for a client address: IPv4 as is, IPv6 by its /64 prefix (one subscriber). */
export function clientKey(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return mapped[1];
  const bare = ip.split('%')[0];
  if (isIP(bare) !== 6 || bare.includes('.')) return ip;
  return `${hextets(bare).slice(0, 4).join(':')}::/64`;
}

export function createApp(options: AppOptions) {
  const { campus, ask } = options;
  const perClient = limiter(options.perMinute ?? 12, 60_000, options.maxClients ?? 10_000);
  const overall = limiter(options.perHour ?? 600, 3_600_000);
  const campuses = new Set(campus.locations.map((l) => l.campus ?? 'charles-river'));
  const retryAfter = options.retryAfterSec ?? 10;
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustProxyHops ?? Number(process.env.TRUST_PROXY_HOPS ?? 0));
  // Ask and chat requests, including optional personal context, are limited to 128 KB.
  // The first parser to run wins.
  app.use('/api/chat', express.json({ limit: '128kb' }));
  // JSON escaping can expand a 1 MiB calendar to six times its UTF-8 size.
  app.use(/^\/api\/dashboard\/schedule(?:\/preview)?\/?$/i, express.json({ limit: 6 * 1024 * 1024 + 4096 }));
  app.use(express.json({ limit: '128kb' }));
  app.use('/api/dashboard', dashboardRouter(options.dashboardPool));
  let domains: DataDomain[] | undefined;
  const directory = () => (domains ??= options.directory?.() ?? buildDirectory(campus));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, model: options.model, keyConfigured: options.keyConfigured, privateBundle: campus.privateBundle });
  });

  app.post('/api/ask', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = AskRequest.safeParse(req.body);
    if (!parsed.success || !campuses.has(parsed.data.campus)) {
      res.status(400).json({ error: `Send { question, weekday (0 = Monday), time (seconds since midnight), campus (${[...campuses].join(', ')}) }.` });
      return;
    }
    if (!options.keyConfigured) {
      res.status(503).json({ error: 'Ask is not configured on this server (no OpenAI key).' });
      return;
    }
    const { question, weekday, time, campus: campusId, history, personalSchedule } = parsed.data;
    const playback = ready(weekday, req, res);
    if (!playback) return;
    await run(res, 'ask', (signal) => ask(question, contextFor(playback, weekday, time, campusId, personalSchedule), signal, history));
  });

  /**
   * The simulated day when it's built and the client is within its limits; otherwise answers 503
   * warming up (and starts the build) or 429, and returns undefined. A chat turn counts like a question.
   */
  function ready(weekday: number, req: Request, res: Response) {
    const playback = campus.ready(weekday);
    if (!playback) {
      // Start (or keep) building the day in the background; the client asks again shortly.
      campus.playback(weekday).catch((error: Error) => console.error(`couldn't simulate ${WEEKDAYS[weekday]}: ${error.name}`));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(503).json({ error: `Warming up the simulation for ${WEEKDAYS[weekday]}, try again in a few seconds.`, retryAfter });
      return undefined;
    }
    if (!perClient(clientKey(req.ip)) || !overall('all')) {
      res.status(429).json({ error: 'Too many questions. Try again in a minute.' });
      return undefined;
    }
    return playback;
  }

  function contextFor(playback: NonNullable<ReturnType<CampusModel['ready']>>, weekday: number, time: number, campusId: string, personalSchedule?: PersonalSchedule): ServerAskContext {
    return {
      locations: campus.locations,
      walkRoutes: campus.walkRoutes,
      meetings: campus.meetings,
      occupancyAt: (t) => playback.occupancyAt(t),
      time,
      weekday,
      campus: campusId,
      data: campus.facts.data,
      facts: campus.facts,
      ...(personalSchedule === undefined ? {} : { personalSchedule }),
    };
  }

  /** Runs the paid model call with the timeout and disconnect handling both endpoints share. */
  async function run(res: Response, what: 'ask' | 'chat', answer: (signal: AbortSignal) => Promise<object>) {
    // The timeout covers only the paid model run; a client that leaves cancels it.
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 25_000);
    const disconnect = new AbortController();
    res.on('close', () => { if (!res.writableFinished) disconnect.abort(); });
    const signal = AbortSignal.any([timeout, disconnect.signal]);
    // Day builds block the event loop, so none starts while this answer runs (campus.ts InFlight).
    const done = campus.asks?.begin();
    try {
      const result = await answer(signal);
      if (!disconnect.signal.aborted) res.json(result);
    } catch (error) {
      if (disconnect.signal.aborted) {
        console.error(`${what} cancelled: client disconnected`);
        return;
      }
      const timedOut = timeout.aborted;
      // Log the failure kind, not the question: questions can carry personal details.
      console.error(`${what} failed: ${timedOut ? 'timeout' : error instanceof Error ? error.name : 'unknown'}`);
      res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'The answer took too long. Try again.' : 'Couldn’t get an answer right now.' });
    } finally {
      done?.();
    }
  }

  app.get('/api/chat/directory', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.json({ domains: directory(), chatAvailable: options.keyConfigured && Boolean(options.chat), model: options.model });
  });

  app.post('/api/chat', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const parsed = ChatRequest.safeParse(req.body);
    if (!parsed.success || !campuses.has(parsed.data.campus)) {
      res.status(400).json({ error: `Send { messages (1–12 turns, the last from the user, 1–300 characters), weekday (0 = Monday), time (seconds since midnight), campus (${[...campuses].join(', ')}), date (YYYY-MM-DD or null) }.` });
      return;
    }
    const chat = options.chat;
    if (!options.keyConfigured || !chat) {
      res.status(503).json({ error: 'Chat is not configured on this server (no OpenAI key).' });
      return;
    }
    const { messages, weekday, time, campus: campusId, date, personalSchedule } = parsed.data;
    const playback = ready(weekday, req, res);
    if (!playback) return;
    const ctx: ChatContext = { ...contextFor(playback, weekday, time, campusId, personalSchedule), date: date ?? null };
    await run(res, 'chat', (signal) => chat({ messages }, ctx, signal));
  });

  // Last: malformed or oversized bodies and anything unexpected become a short JSON error. Only the
  // error type is logged, never the body or the stack (they can carry questions and local paths).
  app.use((error: { status?: unknown; statusCode?: unknown; type?: unknown }, _req: Request, res: Response, _next: NextFunction) => {
    const code = Number(error?.status ?? error?.statusCode);
    const status = code >= 400 && code < 600 ? code : 500;
    console.error(`request failed: ${typeof error?.type === 'string' ? error.type : status}`);
    if (res.headersSent) { res.end(); return; }
    const message = status === 413 ? 'The request is too large.'
      : error?.type === 'entity.parse.failed' ? 'The request body isn’t valid JSON.'
      : status < 500 ? 'The request couldn’t be read.' : 'Something went wrong.';
    res.status(status).json({ error: message });
  });

  return app;
}
