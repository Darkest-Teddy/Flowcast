/*
 * Production static server for the built web app.
 *
 * A generic static host cannot serve this build correctly, for two reasons:
 *
 *   1. There are two HTML entry points. `/map` must serve map.html, which is what
 *      web/vite.config.ts's mapPage() plugin does in dev and preview. Nothing does
 *      it in production.
 *   2. The dashboard routes with react-router's createBrowserRouter, so any path it
 *      owns (/schedule, /events, /admin/...) has to fall back to index.html rather
 *      than 404.
 *
 * No dependencies: Node's own http and fs are enough, and adding a framework here
 * would mean a second lockfile to keep in sync for no gain.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
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
function resolveFile(urlPath) {
  const decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  const candidate = resolve(join(ROOT, normalize(decoded)));
  // Must stay inside ROOT. normalize() alone does not guarantee that.
  if (candidate !== ROOT && !candidate.startsWith(ROOT + sep)) return null;
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

const server = createServer((req, res) => {
  const url = req.url || '/';

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method Not Allowed');
    return;
  }

  // The 3D map is its own entry point. Matches web/vite.config.ts's dev rewrite.
  if (/^\/map\/?(\?|#|$)/.test(url)) {
    const mapHtml = join(ROOT, 'map.html');
    if (existsSync(mapHtml)) return send(res, 200, mapHtml);
  }

  const file = resolveFile(url);
  if (file) {
    return send(res, 200, file, { immutable: url.startsWith('/assets/') });
  }

  // A missing asset is a real 404; anything else is a client route.
  if (/\.[a-z0-9]+$/i.test(url.split('?')[0])) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not Found');
    return;
  }

  const index = join(ROOT, 'index.html');
  if (!existsSync(index)) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('web/dist is missing. Run the build before starting.');
    return;
  }
  send(res, 200, index);
});

server.listen(PORT, HOST, () => {
  console.log(`Flowcast listening on http://${HOST}:${PORT} (serving ${ROOT})`);
});
