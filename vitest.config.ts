import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@partner/shared': `${dir}shared/src/index.ts`,
      '@partner/core': `${dir}core/src/index.ts`,
    },
  },
  test: {
    environment: 'node',
    include: [
      'shared/test/**/*.test.ts',
      'core/test/**/*.test.ts',
      'tests/**/*.test.ts',
    ],
  },
});
