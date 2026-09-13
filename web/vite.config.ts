import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dir = fileURLToPath(new URL('.', import.meta.url));

// Web dev server (standalone). In the shipped product the core serves the
// built SPA on 127.0.0.1:<port> (PLAN.md §3) — this config is for development.
//
// VITE_CORE_URL lets a dev point the proxy at a different core (e.g. an
// isolated demo core on another port) so render inspection at phone/tablet
// widths never disturbs a live core already bound to the default port.
const coreUrl = process.env.VITE_CORE_URL ?? 'http://127.0.0.1:4390';
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@partner/shared': `${dir}../shared/src/index.ts`,
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Dev only: forward /v1 API calls to the core loopback server so the
    // SPA talks same-origin in the browser (production: core serves the
    // built SPA itself on 127.0.0.1:<port>). changeOrigin rewrites the Host
    // header to the core's Host allowlist passes (target overridable above).
    proxy: {
      '/v1': {
        target: coreUrl,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
