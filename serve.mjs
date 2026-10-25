// Production host for the dashboard, map, and same-origin API.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('./web/dist', import.meta.url)));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const TYPES = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.geojson': 'application/geo+json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ico': 'image/x-icon',
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.bin': 'application/octet-stream',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.wasm': 'application/wasm',
    '.txt': 'text/plain; charset=utf-8',
    '.pbf': 'application/x-protobuf',
  }),
);

/** Resolves a URL path to a real file inside ROOT, or null. Rejects traversal. */
function resolveFile(urlPath, root) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const candidate = resolve(join(root, normalize(decoded)));
  // Must stay inside ROOT. normalize() alone does not guarantee that.
  if (candidate !== root && !candidate.startsWith(root + sep)) return null;
  if (!existsSync(candidate)) return null;
  const stat = statSync(candidate);
  if (stat.isDirectory()) {
    const index = join(candidate, 'index.html');
    return existsSync(index) ? index : null;
  }
  return candidate;
}

function send(res, status, file, { immutable = false } = {}) {
  const type = TYPES.get(extname(file).toLowerCase()) || 'application/octet-stream';
  res.writeHead(status, {
    'Content-Type': type,
    // Vite fingerprints everything under /assets, so those are safe to pin.
    // HTML and data must stay revalidated or a deploy never reaches anyone.
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  createReadStream(file).pipe(res);
}

const hopHeaders = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardedHeaders(headers) {
  const excluded = new Set([...hopHeaders, ...(headers.connection || '').split(',').map((name) => name.trim().toLowerCase())]);
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !excluded.has(name)));
}

function jsonError(res, status, error) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error }));
}

function proxy(req, res, target, timeoutMs) {
  if (!target) return jsonError(res, 503, 'API unavailable');
  let upstream;
  let timer;
  const unavailable = () => {
    clearTimeout(timer);
    jsonError(res, 503, 'API unavailable');
    upstream?.destroy();
  };
  try {
    const base = new URL(target);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return unavailable();
    // Use only the configured origin: request paths cannot select an upstream host.
    upstream = (base.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: base.protocol, hostname: base.hostname, port: base.port,
      method: req.method, path: req.url, headers: { ...forwardedHeaders(req.headers), host: req.headers.host },
    }, (response) => {
      res.writeHead(response.statusCode, forwardedHeaders(response.headers));
      response.on('error', unavailable);
      response.on('end', () => clearTimeout(timer));
      response.pipe(res);
    });
    timer = setTimeout(unavailable, timeoutMs);
    upstream.on('error', unavailable);
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { clearTimeout(timer); upstream.destroy(); });
    req.pipe(upstream);
  } catch {
    unavailable();
  }
}

export function createHostServer({ root = ROOT, apiUrl = '', timeoutMs = 30_000 } = {}) {
  return createServer((req, res) => {
    const url = req.url || '/';

    const pathname = url.split('?')[0];
    // /api/personas is how a character built on a phone reaches the display, so it is proxied like
    // the rest of the API -- and, unlike the dashboard, it is useful even with no DATABASE_URL.
    if (/^\/api\/(dashboard(?:\/|$)|personas(?:\/|$)|ask$|health$)/.test(pathname)) {
      return proxy(req, res, apiUrl, timeoutMs);
    }
    if (pathname === '/api' || pathname.startsWith('/api/')) return jsonError(res, 404, 'API route not found');

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
      return;
    }

    // The 3D map is its own entry point. Matches web/vite.config.ts's dev rewrite.
    if (/^\/map\/?(\?|#|$)/.test(url)) {
      const mapHtml = join(root, 'map.html');
      if (existsSync(mapHtml)) return send(res, 200, mapHtml);
    }

    let file;
    try { file = resolveFile(url, root); } catch { return jsonError(res, 400, 'Invalid path'); }
    if (file) {
      return send(res, 200, file, { immutable: url.startsWith('/assets/') });
    }

    // A missing asset is a real 404; anything else is a client route.
    if (/\.[a-z0-9]+$/i.test(url.split('?')[0])) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }

    const index = join(root, 'index.html');
    if (!existsSync(index)) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
        .end('web/dist is missing. Run the build before starting.');
      return;
    }
    send(res, 200, index);
  });
}

/*
 * Whether to run the API next to the static host, and where to send /api/* .
 *
 * An explicit FLOWCAST_API_URL always wins. Otherwise the API is started locally, with or without a
 * DATABASE_URL: it used to be skipped without one, on the grounds that there was nothing for it to
 * serve, and that is no longer true. /api/personas carries a character built on a phone at /join to
 * the display at /map, and it holds those characters in memory when there is no database
 * (server/src/personas/store.ts). Skipping the API would make the join flow -- the one feature
 * aimed at the room rather than the operator -- fail on exactly the simplest deploy.
 */
export function backendConfig(env = process.env) {
  if (env.FLOWCAST_API_URL) return { apiUrl: env.FLOWCAST_API_URL };
  const port = Number(env.FLOWCAST_API_PORT) || (Number(env.PORT) === 8787 ? 8788 : 8787);
  return { apiUrl: `http://127.0.0.1:${port}`, env: { ...env, HOST: '127.0.0.1', PORT: String(port) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = backendConfig();
  let backend;
  if (config.env) {
    const require = createRequire(new URL('./server/package.json', import.meta.url));
    backend = spawn(process.execPath, ['--import', require.resolve('tsx'), 'src/index.ts'], {
      cwd: fileURLToPath(new URL('./server', import.meta.url)), env: config.env, stdio: 'ignore',
    });
    backend.on('error', () => console.error('Flowcast API could not start'));
    backend.on('exit', () => console.error('Flowcast API stopped'));
  }
  const server = createHostServer({ apiUrl: config.apiUrl });
  const shutdown = () => {
    backend?.kill('SIGTERM');
    server.close(() => process.exit(0));
    setTimeout(() => { backend?.kill('SIGKILL'); process.exit(0); }, 5_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  server.listen(PORT, HOST, () => console.log(`Flowcast listening on http://${HOST}:${PORT}`));
}
