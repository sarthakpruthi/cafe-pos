import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The .env lives at the repo root, so the API and the web app share one file. Resolve it from this
// config's location rather than the working directory, which varies with how Vite is launched.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export default defineConfig({
  plugins: [react()],
  envDir: repoRoot,
  server: { port: 5173, proxy: { '/api': 'http://localhost:4000' } },
});
