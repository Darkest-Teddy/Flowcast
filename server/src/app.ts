// HTTP API for Ask. POST /api/ask runs one agent question against the simulation for the day and
// time the map is showing. The OpenAI key stays here; browsers only talk to this endpoint.

import type pg from 'pg';
import { dashboardRouter } from './dashboard/router';
import { isIP } from 'node:net';
import express, { type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { WEEKDAYS } from '../../map-client/src/data/campusData';
import type { CampusModel } from './campus';
import type { AskResult } from './agent';
import type { ServerAskContext } from './facts';
import type { AgentMessage } from '../../map-client/src/askClient';
import { MAX_HISTORY_PAIRS, MAX_USER_LENGTH, MAX_ASSISTANT_LENGTH, MAX_HISTORY_LENGTH } from '../../map-client/src/askConversation';

const historySchema = z.array(z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().max(MAX_USER_LENGTH) }),
  z.object({ role: z.literal('assistant'), content: z.string().max(MAX_ASSISTANT_LENGTH) }),
])).max(MAX_HISTORY_PAIRS * 2)
  .refine((history) => history.length % 2 === 0 && history.every((message, i) => message.role === (i % 2 === 0 ? 'user' : 'assistant')), 'History must contain complete user/assistant pairs')
  .refine((history) => history.reduce((total, message) => total + message.content.length, 0) <= MAX_HISTORY_LENGTH, 'History is too long');

export const AskRequest = z.object({
  question: z.string().trim().min(1).max(300),
  history: historySchema.optional(),
  weekday: z.number().int().min(0).max(6),
  time: z.number().int().min(0).max(86399),
  campus: z.string().min(1).max(40),
});

export interface AppOptions {
  dashboardPool?: pg.Pool;
  campus: CampusModel;
  ask: (question: string, ctx: ServerAskContext, signal: AbortSignal, history?: AgentMessage[]) => Promise<AskResult>;
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
  app.use(express.json({ limit: '128kb' }));
  app.use('/api/dashboard', dashboardRouter(options.dashboardPool));

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
    const { question, weekday, time, campus: campusId, history } = parsed.data;
    const playback = campus.ready(weekday);
    if (!playback) {
      // Start (or keep) building the day in the background; the client asks again shortly.
      campus.playback(weekday).catch((error: Error) => console.error(`couldn't simulate ${WEEKDAYS[weekday]}: ${error.name}`));
      res.setHeader('Retry-After', String(retryAfter));
      res.status(503).json({ error: `Warming up the simulation for ${WEEKDAYS[weekday]}, try again in a few seconds.`, retryAfter });
      return;
    }
    if (!perClient(clientKey(req.ip)) || !overall('all')) {
      res.status(429).json({ error: 'Too many questions. Try again in a minute.' });
      return;
    }

    // The timeout covers only the paid model run; a client that leaves cancels it.
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 25_000);
    const disconnect = new AbortController();
    res.on('close', () => { if (!res.writableFinished) disconnect.abort(); });
    const signal = AbortSignal.any([timeout, disconnect.signal]);
    const ctx: ServerAskContext = {
      locations: campus.locations,
      walkRoutes: campus.walkRoutes,
      meetings: campus.meetings,
      occupancyAt: (t) => playback.occupancyAt(t),
      time,
      weekday,
      campus: campusId,
      data: campus.facts.data,
      facts: campus.facts,
    };
    // Day builds block the event loop, so none starts while this answer runs (campus.ts InFlight).
    const done = campus.asks?.begin();
    try {
      const result = await ask(question, ctx, signal, history);
      if (!disconnect.signal.aborted) res.json(result);
    } catch (error) {
      if (disconnect.signal.aborted) {
        console.error('ask cancelled: client disconnected');
        return;
      }
      const timedOut = timeout.aborted;
      // Log the failure kind, not the question: questions can carry personal details.
      console.error(`ask failed: ${timedOut ? 'timeout' : error instanceof Error ? error.name : 'unknown'}`);
      res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'The answer took too long. Try again.' : 'Couldn’t get an answer right now.' });
    } finally {
      done?.();
    }
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
