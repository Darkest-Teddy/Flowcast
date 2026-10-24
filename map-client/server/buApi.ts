import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { Plugin } from 'vite';

const BASE = 'https://public.api-nonprod.bu.edu/api/v1/transit/bus';
const PREFIX = '/api/bu/transit/bus';

export function buApiMiddleware(key: string, privateBundle: string) {
  const cache = new Map<string, { expires: number; body: string }>();
  const pending = new Map<string, Promise<string>>();
  let requests: number[] = [];
  let dailyRequests = 0;
  let day = '';
  async function acquire(path: string): Promise<string> {
    const now = Date.now();
    const saved = cache.get(path);
    if (saved && saved.expires > now) return saved.body;
    const active = pending.get(path);
    if (active) return active;
    requests = requests.filter((time) => time > now - 60_000);
    const today = new Date(now).toISOString().slice(0, 10);
    if (today !== day) { day = today; dailyRequests = 0; }
    // Leave room for the acquisition pipeline sharing the same team key.
    if (requests.length >= 80 || dailyRequests >= 8_000) throw new Error('Local BU API quota reached');
    requests.push(now);
    dailyRequests++;
    const request = (async () => {
      const response = await fetch(`${BASE}${path}`, {
        headers: { 'X-API-Key': key }, redirect: 'error', signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new Error(`BU API returned ${response.status}`);
      const value = await response.json();
      if (value.stale) throw new Error('BU API returned stale data');
      const body = JSON.stringify(value);
      const ttl = path === '/routes' ? 300_000 : path === '/vehicles' ? 60_000 : 300_000;
      cache.set(path, { body, expires: Date.now() + ttl });
      return body;
    })();
    pending.set(path, request);
    try { return await request; } finally { pending.delete(path); }
  }
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/data/campus-data.json' && req.method === 'GET') {
      try {
        const body = await readFile(privateBundle);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(body);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          res.statusCode = 500; res.end('Cannot read private campus bundle'); return;
        }
      }
    }
    if (!url.pathname.startsWith(PREFIX)) { next(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    const path = url.pathname.slice(PREFIX.length);
    if (req.method !== 'GET' || url.search || !/^\/(routes|vehicles|stops\/[1-9]\d*\/arrivals)$/.test(path)) {
      res.statusCode = 404; res.end('{"error":"Unsupported BU API request"}'); return;
    }
    if (!key) { res.statusCode = 503; res.end('{"error":"BU API is not configured"}'); return; }
    try { res.end(await acquire(path)); }
    catch {
      res.statusCode = 502;
      res.end('{"error":"BU API unavailable, stale, or quota exhausted"}');
    }
  };
}

export function buApiPlugin(key: string, privateBundle: string): Plugin {
  const middleware = buApiMiddleware(key, privateBundle);
  return {
    name: 'bu-hackathon-api',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}
