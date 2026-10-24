import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { buApiPlugin } from './server/buApi';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'CATALOG_');
  const key = process.env.CATALOG_API_KEY || env.CATALOG_API_KEY || '';
  const privateBundle = fileURLToPath(new URL('../data-pipeline/.cache/hackathon/campus-data.json', import.meta.url));
  return {
    plugins: [react(), buApiPlugin(key, privateBundle)],
    define: { 'import.meta.env.VITE_BU_API_ENABLED': JSON.stringify(Boolean(key)) },
    server: { port: 5173 },
  };
});
