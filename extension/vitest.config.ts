import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = fileURLToPath(new URL('.', import.meta.url));

// Extension tests are pure (protocol framing, scope resolution, snapshot
// builder, act guard) and run under node. The extension is deliberately NOT
// in the root vitest include list (root vitest.config.ts is shared-owned);
// run these with: npx vitest run --config extension/vitest.config.ts
export default defineConfig({
  test: {
    environment: 'node',
    root: dir,
    include: ['test/**/*.test.ts'],
  },
});
