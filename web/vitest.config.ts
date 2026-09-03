import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = fileURLToPath(new URL('.', import.meta.url));

// Local vitest config for the web package. The repo-root vitest.config.ts is
// shared-owned (do not edit); this file keeps web unit tests runnable from
// web/ without touching it. Tests are pure-logic (SSE parser, API client,
// storage) so they run under the plain 'node' environment — no DOM/jsdom.
export default defineConfig({
  resolve: {
    alias: {
      '@partner/shared': `${dir}../shared/src/index.ts`,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
