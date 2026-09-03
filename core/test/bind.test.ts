/**
 * PLAN-M0 "binds 127.0.0.1 (assert listen address)" — the loopback-only
 * guarantee is a bind property, so prove it on a real listen (port 0 lets
 * the OS choose), not just on the config allowlist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { loadConfig, startServer } from '../src/index.js';

describe('loopback bind (PLAN-M0)', () => {
  let server: Server | undefined;

  afterEach(() => {
    server?.close();
  });

  it('binds 127.0.0.1, not a wildcard address', async () => {
    const { bundle, server: s } = await startServer({
      ...loadConfig({ DEMO_MODE: '1' }),
      port: 0,
    });
    server = s;

    const addr = s.address();
    expect(typeof addr).not.toBe('string');
    const parsed = addr as { address: string; port: number };
    expect(parsed.address).toBe('127.0.0.1');
    expect(parsed.port).toBeGreaterThan(0);

    bundle.close();
  });
});
