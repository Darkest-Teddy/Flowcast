// Production host for the dashboard, map, and same-origin API.

import { createReadStream, existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlib, gzip } from 'node:zlib';

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
    '.webmanifest': 'application/manifest+json; charset=utf-8',
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
    '.mp3': 'audio/mpeg',
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

// Stable names that change rarely: models, images, audio, video, fonts and the web manifest.
const MEDIA = new Set(['.glb', '.gltf', '.bin', '.png', '.jpg', '.jpeg', '.webp', '.svg', '.ico', '.mp3', '.webm', '.mp4', '.woff', '.woff2', '.webmanifest']);
// Text worth compressing. Images, models and media are already compressed or barely shrink.
const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.geojson', '.gltf', '.svg', '.webmanifest', '.txt']);
// Below this the encoding header costs about as much as it saves.
const MIN_COMPRESS_BYTES = 1024;

function cacheControl(urlPath, ext) {
  // Vite fingerprints everything under /assets, so a changed file gets a new URL and these are safe to pin.
  if (urlPath.startsWith('/assets/')) return 'public, max-age=31536000, immutable';
  // Media keeps its name across deploys. An hour fresh lets a reload skip the network entirely; after
  // that a load uses the cached copy and revalidates behind it, so a changed model shows on the load after.
  if (MEDIA.has(ext)) return 'public, max-age=3600, stale-while-revalidate=604800';
  // HTML and data/*.json are revalidated every time or a deploy never reaches anyone.
  // The ETag makes that check a body-less 304 when nothing changed.
  return 'no-cache';
}

/** Weak validator from size and mtime. Each encoding is a different body, so it gets its own tag. */
function etagFor(stat, encoding) {
  const suffix = encoding === 'br' ? '-br' : encoding === 'gzip' ? '-gz' : '';
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${suffix}"`;
}

function notModified(req, etag, mtimeMs) {
  const tags = req.headers['if-none-match'];
  // If-None-Match wins over If-Modified-Since when both are sent. Weak comparison: ignore W/.
  if (tags) return tags.trim() === '*' || tags.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag.slice(2));
  const since = Date.parse(req.headers['if-modified-since'] || '');
  return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
}

/** Brotli if the client takes it, then gzip, honouring q=0. */
function pickEncoding(header = '') {
  const weights = new Map();
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map((piece) => piece.trim());
    const q = params.find((param) => param.startsWith('q='));
    if (name) weights.set(name, q ? Number(q.slice(2)) : 1);
  }
  const accepts = (name) => (weights.get(name) ?? weights.get('*') ?? 0) > 0;
  return accepts('br') ? 'br' : accepts('gzip') ? 'gzip' : null;
}

// Compressing ~36 MB of map data on every request would burn CPU, so each file's compressed bytes are
// kept per encoding until its mtime or size changes. Only compressed bytes stay (a few MB for the whole
// build); the uncompressed read is dropped once compressed.
const compressed = new Map();
const brotliAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);
function compressedBody(file, stat, encoding) {
  const key = `${encoding}:${file}`;
  const hit = compressed.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.body;
  // Brotli 5 takes the map data from ~38 MB to ~2 MB in a fraction of quality 11's time, once per file per deploy.
  const body = readFile(file).then((raw) => (encoding === 'br'
    ? brotliAsync(raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 5, [zlib.BROTLI_PARAM_SIZE_HINT]: raw.length } })
    : gzipAsync(raw, { level: 6 })));
  compressed.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, body });
  body.catch(() => { if (compressed.get(key)?.body === body) compressed.delete(key); });
  return body;
}

async function send(req, res, file, urlPath) {
  const stat = statSync(file);
  const ext = extname(file).toLowerCase();
  const compressible = COMPRESSIBLE.has(ext);
  const encoding = compressible && stat.size >= MIN_COMPRESS_BYTES ? pickEncoding(req.headers['accept-encoding']) : null;
  const headers = {
    'Cache-Control': cacheControl(urlPath, ext),
    ETag: etagFor(stat, encoding),
    'Last-Modified': new Date(stat.mtimeMs).toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };
  if (compressible) headers.Vary = 'Accept-Encoding';
  if (notModified(req, headers.ETag, stat.mtimeMs)) return res.writeHead(304, headers).end();
  headers['Content-Type'] = TYPES.get(ext) || 'application/octet-stream';

  let body = null;
  if (encoding) {
    try {
      body = await compressedBody(file, stat, encoding);
      headers['Content-Encoding'] = encoding;
    } catch {
      // Fall back to the plain file rather than failing the request.
      headers.ETag = etagFor(stat, null);
    }
  }
  headers['Content-Length'] = body ? body.length : stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  if (body) return res.end(body);
  createReadStream(file).on('error', () => res.destroy()).pipe(res);
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
    if (/^\/api\/(dashboard(?:\/|$)|chat(?:\/|$)|ask$|health$)/.test(pathname) || (req.method === 'POST' && pathname === '/api/voice/session')) {
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
      if (existsSync(mapHtml)) return send(req, res, mapHtml, pathname).catch(() => jsonError(res, 500, 'Read failed'));
    }

    let file;
    try { file = resolveFile(url, root); } catch { return jsonError(res, 400, 'Invalid path'); }
    if (file) return send(req, res, file, pathname).catch(() => jsonError(res, 500, 'Read failed'));

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
    send(req, res, index, pathname).catch(() => jsonError(res, 500, 'Read failed'));
  });
}

export function backendConfig(env = process.env) {
  if (env.FLOWCAST_API_URL) return { apiUrl: env.FLOWCAST_API_URL };
  if (!env.DATABASE_URL) return { apiUrl: '' };
  const port = Number(env.FLOWCAST_API_PORT) || (Number(env.PORT) === 8787 ? 8788 : 8787);
  return { apiUrl: `http://127.0.0.1:${port}`, env: { ...env, HOST: '127.0.0.1', PORT: String(port) } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = backendConfig();
  let backend;
  if (config.env) {
    const require = createRequire(new URL('./server/package.json', import.meta.url));
    // The API keeps ~100 MB of compact days; a heap cap makes V8 collect each day build's garbage
    // instead of growing toward its default ~2 GB limit (server/src/compactDay.ts).
    backend = spawn(process.execPath, ['--max-old-space-size=512', '--import', require.resolve('tsx'), 'src/index.ts'], {
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
