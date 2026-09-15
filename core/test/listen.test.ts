/**
 * The listener must never claim to be up when it is not.
 *
 * The bug this file exists for, found on Windows: `app.listen(port, host, cb)`
 * invokes `cb` EVEN WHEN THE BIND FAILED, and the old `listen()` helper resolved
 * from that callback. So a core whose port was already taken resolved
 * `startServer` with a server that was not listening: the banner printed a URL,
 * nothing served it, `server.address()` was `null` for any caller that looked (a
 * core test crashed reading `.port` three frames later), and the real
 * `EADDRINUSE` was swallowed because its `reject` arrived after the promise had
 * already settled. Fixing `PORT=0` alone would have hidden the symptom; the
 * defect is that a failed bind was reported as success.
 *
 * Readiness now comes from the `listening` EVENT and failure from `error`, so:
 *  - a taken port REJECTS the boot, naming the port;
 *  - a successful boot has an address the moment `startServer` resolves.
 *
 * The second assertion is what the false-success path broke; the first is what an
 * operator needs (the alternative was a restart loop with no explanation, or worse,
 * a quiet process that serves nobody).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:net';
import type { Server } from 'node:net';
import { loadConfig, startServer } from '../src/index.js';
import type { StartedServer } from '../src/index.js';
import { closeServer, freePort } from './helpers.js';

let held: Server | undefined;
let started: StartedServer | undefined;

afterEach(async () => {
  if (started !== undefined) {
    await closeServer(started.server);
    started.bundle.close();
    started = undefined;
  }
  if (held !== undefined) {
    await new Promise<void>((resolve) => {
      held?.close(() => resolve());
      held = undefined;
    });
  }
});

/** Occupy a port and hand it back, so the core's bind is guaranteed to fail. */
function occupy(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('listen() reports readiness truthfully', () => {
  it('a boot that cannot bind REJECTS instead of resolving a phantom core', async () => {
    const port = await freePort();
    held = await occupy(port);

    // Demo mode: nothing is written to disk, so a failed boot leaves no handles
    // behind (a live boot would open the encrypted DB before it listens).
    await expect(
      startServer({ ...loadConfig({ DEMO_MODE: '1' }), port }),
    ).rejects.toThrow(/EADDRINUSE|address already in use/i);
  });

  it('a boot that succeeds has a listening address when it resolves', async () => {
    const port = await freePort();
    started = await startServer({ ...loadConfig({ DEMO_MODE: '1' }), port });

    expect(started.server.listening).toBe(true);
    const address = started.server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe('string');
    if (address === null || typeof address === 'string') return; // narrowing
    expect(address.port).toBe(port);
    expect(address.address).toBe('127.0.0.1');
  });
});
