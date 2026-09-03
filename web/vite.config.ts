import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const dir = fileURLToPath(new URL('.', import.meta.url));

// Web dev server (standalone). In the shipped product the core serves the
// built SPA on 127.0.0.1:<port> (PLAN.md §3) — this config is for development.
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
    // header to 127.0.0.1:4390 so the core's Host allowlist passes.
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:4390',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
