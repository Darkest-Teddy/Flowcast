import { networkInterfaces } from 'node:os';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const themeDir = fileURLToPath(new URL('../theme', import.meta.url));
const mapDir = fileURLToPath(new URL('../map-client', import.meta.url));

/** /map and /map/?at=12:15 load map.html, the 3D map's own page, from this same server. */
/** Ask (server/): dashboard, Ask and chat paths go to the Ask server, so the key never reaches the browser. /api/chat also covers /api/chat/directory. /api/personas carries a character from a phone at /join to the display at /map. */
const apiTarget = process.env.FLOWCAST_API_URL || 'http://127.0.0.1:8787';
const apiProxy = Object.fromEntries(['^/api/dashboard(?:/|[?]|$)', '^/api/personas(?:/|[?]|$)', '^/api/ask(?:\\?|$)', '^/api/chat(?:/|[?]|$)', '^/api/health(?:\\?|$)'].map((path) => [path, { target: apiTarget, changeOrigin: false }]));

/*
 * Dev-only sink for captures taken from the running app.
 *
 * The title screen's background is a recording of the real renderer, made by
 * MediaRecorder in the browser. This lets the page hand the finished file straight
 * back into the repo instead of routing it through the Downloads folder.
 *
 * Dev server only: it is never registered for preview or production.
 */
function captureSink(): Plugin {
  return {
    name: 'flowcast-capture-sink',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__capture', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('POST only');
          return;
        }
        const name = new URL(req.url ?? '', 'http://x').searchParams.get('name') ?? '';
        // Only a plain filename, only into the video directory.
        if (!/^[a-z0-9-]+\.(webm|mp4)$/i.test(name)) {
          res.statusCode = 400;
          res.end('bad name');
          return;
        }
        const dir = `${mapDir}/public/video`;
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', async () => {
          const { mkdir, writeFile } = await import('node:fs/promises');
          await mkdir(dir, { recursive: true });
          const body = Buffer.concat(chunks);
          await writeFile(`${dir}/${name}`, body);
          server.config.logger.info(`[capture] wrote video/${name} (${(body.length / 1024 / 1024).toFixed(1)} MB)`);
          res.statusCode = 200;
          res.end(`${(body.length / 1024 / 1024).toFixed(1)} MB`);
        });
      });
    },
  };
}

/**
 * This machine's address on the local network, for the QR code to point at in development.
 *
 * The join card builds its QR code from the page's own origin, which on a dev machine is
 * `localhost:5174` -- an address that means "this phone" to a phone, so the code scans and goes
 * nowhere. The display and the phone are different devices, which is the whole premise of the
 * feature, so in development the code has to carry a LAN address instead. Nothing to do in
 * production: there the display is on a real hostname and its own origin is already right.
 *
 * Internal IPv4 only, skipping virtual adapters that would resolve to nothing from a phone.
 */
function lanAddress(): string | undefined {
  const candidates: string[] = [];
  for (const [name, addresses] of Object.entries(networkInterfaces())) {
    if (/^(lo|docker|br-|veth|vEthernet|VirtualBox|vmnet|utun|tun|tap|Loopback)/i.test(name)) continue;
    for (const address of addresses ?? []) {
      if (address.family !== 'IPv4' || address.internal) continue;
      // Private ranges only: a public address here is a misconfiguration, not a demo network.
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address.address)) candidates.push(address.address);
    }
  }
  // 192.168.* first: the ordinary home or venue router, and the one a phone is most likely on.
  return candidates.sort((a, b) => Number(b.startsWith('192.168.')) - Number(a.startsWith('192.168.')))[0];
}

/**
 * Tells the join card which host a phone can actually reach this dev server on.
 *
 * The host only, never a full origin: the port is whatever this dev server ended up listening on
 * (`--port` overrides the default), and the display page is served from that same port, so the
 * client reads it off its own location rather than having a guess compiled in.
 *
 * Dev only, and only as a fallback: an explicit VITE_JOIN_URL still wins in the client (see
 * persona/JoinQrCard.tsx), and a non-loopback origin is used as it is.
 */
function joinHost(): Plugin {
  return {
    name: 'flowcast-join-host',
    apply: (_config, env) => env.command === 'serve',
    config: () => ({ define: { 'import.meta.env.VITE_JOIN_HOST': JSON.stringify(lanAddress() ?? '') } }),
    configureServer(server) {
      const host = lanAddress();
      server.httpServer?.once('listening', () => {
        const port = (server.httpServer?.address() as { port?: number } | null)?.port ?? server.config.server.port;
        if (host) server.config.logger.info(`\n  ➜  Join (scan from a phone): http://${host}:${port}/join\n`);
        else server.config.logger.warn('\n  ➜  No LAN address found: the join QR code will not work from a phone.\n');
      });
    },
  };
}

function mapPage(): Plugin {
  const rewrite: Connect.NextHandleFunction = (req, _res, next) => {
    if (req.url && /^\/map\/?(\?|$)/.test(req.url)) req.url = req.url.replace(/^\/map\/?/, '/map.html');
    next();
  };
  return {
    name: 'flowcast-map-page',
    configureServer: (server) => void server.middlewares.use(rewrite),
    configurePreviewServer: (server) => void server.middlewares.use(rewrite),
  };
}

export default defineConfig(({ mode }) => {
  // The map reads its keys (Mapbox, MBTA) from map-client's .env files; expose them here too.
  const mapEnv = loadEnv(mode, mapDir, 'VITE_');
  return {
    plugins: [react(), mapPage(), captureSink(), joinHost()],
    // One server for everyone: the dashboard plus the map, its data and its models.
    publicDir: `${mapDir}/public`,
    resolve: {
      alias: { '@theme': themeDir, '@map': `${mapDir}/src` },
      dedupe: ['react', 'react-dom'], // map-client has its own node_modules; keep one React
    },
    define: Object.fromEntries(Object.entries(mapEnv).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])),
    build: {
      rollupOptions: { input: { main: 'index.html', map: 'map.html' } },
    },
    server: {
      port: 5174,
      // Listen on the LAN, not just loopback: /join is reached by scanning a QR code off a display
      // with a phone, and a server bound to localhost cannot be reached by one.
      host: true,
      fs: { allow: ['.', themeDir, mapDir] }, // theme and map live outside this app's folder
      proxy: apiProxy,
    },
    preview: { proxy: apiProxy },
  };
});
