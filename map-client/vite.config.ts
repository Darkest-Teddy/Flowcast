import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { buApiPlugin } from './server/buApi';

/** Ask (server/): dashboard, Ask and chat paths (/api/chat also covers /api/chat/directory) go to the Ask server; /api/bu/* stays with buApiPlugin. */
const apiTarget = process.env.FLOWCAST_API_URL || 'http://127.0.0.1:8787';
const apiProxy = Object.fromEntries(['^/api/dashboard(?:/|[?]|$)', '^/api/ask(?:\\?|$)', '^/api/chat(?:/|[?]|$)', '^/api/voice(?:/|[?]|$)', '^/api/health(?:\\?|$)'].map((path) => [path, { target: apiTarget, changeOrigin: false }]));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'CATALOG_');
  const key = process.env.CATALOG_API_KEY || env.CATALOG_API_KEY || '';
  const privateBundle = fileURLToPath(new URL('../data-pipeline/.cache/hackathon/campus-data.json', import.meta.url));
  return {
    plugins: [react(), buApiPlugin(key, privateBundle)],
    define: { 'import.meta.env.VITE_BU_API_ENABLED': JSON.stringify(Boolean(key)) },
    // The crowd scale lives in ../theme (shared with the dashboard and the server).
    server: { port: 5173, fs: { allow: ['.', fileURLToPath(new URL('../theme', import.meta.url))] }, proxy: apiProxy },
    preview: { proxy: apiProxy },
  };
});
