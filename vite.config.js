import { defineConfig } from 'vite';

// The backend (server/). The front end calls /api and /files on its own
// origin (src/api/client.js); in dev and `vite preview` these forward there,
// in production the backend serves the page itself.
const BACKEND = process.env.DIGITWIN_BACKEND ?? 'http://localhost:8787';
const backendProxy = { '/api': BACKEND, '/files': BACKEND };

export default defineConfig({
  // Module workers (new Worker(url, { type: 'module' })) need this to build
  // as real ES modules instead of Vite's default IIFE worker bundle — the
  // building worker uses top-level `import * as THREE from 'three'`.
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    sourcemap: true,
  },
  server: {
    // Vite 5 checks the incoming Host header against an allowlist by
    // default (DNS-rebinding protection) -- a tunnel domain (e.g.
    // *.trycloudflare.com) fails that check and gets a 403 otherwise.
    // Fine to leave wide open for local dev behind a temporary tunnel;
    // tighten to a specific host if this config ever serves anything
    // that isn't just a local preview.
    allowedHosts: true,
    proxy: backendProxy,
  },
  preview: { proxy: backendProxy },
});
