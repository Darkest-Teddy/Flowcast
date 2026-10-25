import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { buApiPlugin } from '../map-client/server/buApi.ts';

const themeDir = fileURLToPath(new URL('../theme', import.meta.url));
const mapDir = fileURLToPath(new URL('../map-client', import.meta.url));
const repoDir = fileURLToPath(new URL('..', import.meta.url));

/** /map and /map/?at=12:15 load map.html, the 3D map's own page, from this same server. */
/** Ask (server/): dashboard, Ask and chat paths go to the Ask server, so the key never reaches the browser. /api/chat also covers /api/chat/directory. */
const apiTarget = process.env.FLOWCAST_API_URL || 'http://127.0.0.1:8787';
const apiProxy = Object.fromEntries(['^/api/dashboard(?:/|[?]|$)', '^/api/ask(?:\\?|$)', '^/api/chat(?:/|[?]|$)', '^/api/voice(?:/|[?]|$)', '^/api/health(?:\\?|$)'].map((path) => [path, { target: apiTarget, changeOrigin: false }]));

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
  // The map reads its keys (Mapbox, MBTA) from the repo's .env or map-client's own .env files
  // (map-client's win); expose them here too. loadEnv also picks up VITE_ variables set in the
  // process environment, which is how a host like Railway passes them to the build.
  const mapEnv = { ...loadEnv(mode, repoDir, 'VITE_'), ...loadEnv(mode, mapDir, 'VITE_') };
  // The DS+X hackathon BU API (live BU Shuttle) and the private campus bundle, as map-client's own
  // server serves them (map-client/server/buApi.ts). The key stays on this server, never VITE_.
  const buKey = process.env.CATALOG_API_KEY
    || { ...loadEnv(mode, repoDir, 'CATALOG_'), ...loadEnv(mode, mapDir, 'CATALOG_') }.CATALOG_API_KEY
    || '';
  const privateBundle = fileURLToPath(new URL('../data-pipeline/.cache/hackathon/campus-data.json', import.meta.url));
  return {
    plugins: [react(), buApiPlugin(buKey, privateBundle), mapPage(), captureSink()],
    // One server for everyone: the dashboard plus the map, its data and its models.
    publicDir: `${mapDir}/public`,
    resolve: {
      alias: { '@theme': themeDir, '@map': `${mapDir}/src` },
      dedupe: ['react', 'react-dom'], // map-client has its own node_modules; keep one React
    },
    define: {
      ...Object.fromEntries(Object.entries(mapEnv).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)])),
      'import.meta.env.VITE_BU_API_ENABLED': JSON.stringify(Boolean(buKey)),
    },
    build: {
      rollupOptions: { input: { main: 'index.html', map: 'map.html' } },
    },
    server: {
      port: 5174,
      fs: { allow: ['.', themeDir, mapDir] }, // theme and map live outside this app's folder
      proxy: apiProxy,
    },
    preview: { proxy: apiProxy },
  };
});
