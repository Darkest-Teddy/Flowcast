import { fileURLToPath, URL } from 'node:url';
import { defineConfig, loadEnv, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const themeDir = fileURLToPath(new URL('../theme', import.meta.url));
const mapDir = fileURLToPath(new URL('../map-client', import.meta.url));

/** /map and /map/?at=12:15 load map.html, the 3D map's own page, from this same server. */
/** Ask (server/): dashboard, Ask and chat paths go to the Ask server, so the key never reaches the browser. /api/chat also covers /api/chat/directory. */
const apiTarget = process.env.FLOWCAST_API_URL || 'http://127.0.0.1:8787';
const apiProxy = Object.fromEntries(['^/api/dashboard(?:/|[?]|$)', '^/api/ask(?:\\?|$)', '^/api/chat(?:/|[?]|$)', '^/api/health(?:\\?|$)'].map((path) => [path, { target: apiTarget, changeOrigin: false }]));

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
    plugins: [react(), mapPage()],
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
      fs: { allow: ['.', themeDir, mapDir] }, // theme and map live outside this app's folder
      proxy: apiProxy,
    },
    preview: { proxy: apiProxy },
  };
});
