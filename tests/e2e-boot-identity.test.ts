/**
 * M15 hardening e2e (boot identity): GET /v1/boot echoes the per-boot nonce the desktop
 * shell hands the sidecar it spawns (PARTNER_CORE_NONCE), so the shell can
 * refuse to treat a foreign listener on :4390 as its own core.
 *
 * Regression under test: a leftover `npm run dev:core` — which reports no
 * nonce — already holding the port used to satisfy the shell's bare TCP
 * probe, so the shell logged "core is up" and pointed the webview at the
 * stranger while its own sidecar never served a request — on POSIX it dies
 * with EADDRINUSE; on Windows BOTH listeners bind and the stray wins. The
 * user saw a window
 * backed by a different core (demo mode, in-memory DB) with no error at all.
 *
 * The default port IS the conflict: DEMO_MODE defaults to ON for a plain
 * `npm run dev:core`, while the packaged shell boots LIVE, so a stale dev core
 * squatting :4390 was also silently the wrong mode and the wrong database.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;

interface Probe {
  child: ChildProcess;
  base: string;
  exited: Promise<void>;
  stderr: string;
}

/** Ask the OS for a port nobody is using (each core needs its own). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('the OS handed back no port'));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(base: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${base}/v1/health`)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`core never became healthy at ${base}`);
}

/** Boots a core the way the shell (or a stray dev terminal) would. */
async function startCore(env: Record<string, string>): Promise<Probe> {
  const port = await freePort();
  const child = spawn(process.execPath, ['--import', 'tsx', 'core/src/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORT: String(port),
      HOST: '127.0.0.1',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const probe: Probe = {
    child,
    base: `http://127.0.0.1:${port}`,
    exited: new Promise<void>((resolve) => child.once('exit', () => resolve())),
    stderr: '',
  };
  child.stderr?.on('data', (chunk: Buffer) => {
    probe.stderr += chunk.toString();
  });
  await waitForHealth(probe.base);
  return probe;
}

async function stop(probe: Probe): Promise<void> {
  if (probe.child.exitCode === null) probe.child.kill('SIGTERM');
  await probe.exited;
}

interface Boot {
  bootNonce: string | null;
  version: string;
  demo: boolean;
}

/**
 * GET /v1/boot with NO credentials: the loopback Host guard is the boundary
 * here (same posture as /v1/health). The nonce is a boot correlation id that
 * unlocks nothing, so publishing it to a loopback caller grants no authority.
 */
async function boot(base: string): Promise<Boot> {
  const res = await fetch(`${base}/v1/boot`);
  expect(res.status).toBe(200);
  return (await res.json()) as Boot;
}

let sidecar: Probe; // spawned by a shell: demo boot + a nonce
let stray: Probe; // a leftover `npm run dev:core`: demo boot, no nonce
let blank: Probe; // PARTNER_CORE_NONCE set to whitespace
let live: Probe; // the packaged shell's real boot: DEMO_MODE=0 + a nonce

beforeAll(async () => {
  [sidecar, stray, blank, live] = await Promise.all([
    startCore({ DEMO_MODE: '1', DB_PATH: ':memory:', PARTNER_CORE_NONCE: 'nonce-from-the-shell' }),
    startCore({ DEMO_MODE: '1', DB_PATH: ':memory:' }),
    startCore({ DEMO_MODE: '1', DB_PATH: ':memory:', PARTNER_CORE_NONCE: '   ' }),
    // LIVE + in-memory is the only live combination the fake keychain may
    // protect (config.ts refuses a file DB without the OS keychain).
    startCore({
      DEMO_MODE: '0',
      KEYCHAIN_KIND: 'fake',
      DB_PATH: ':memory:',
      PARTNER_CORE_NONCE: 'nonce-from-the-shell',
    }),
  ]);
}, 90_000);

afterAll(async () => {
  await Promise.all([sidecar, stray, blank, live].map(stop));
});

describe('M15 hardening: boot identity', () => {
  it('echoes the nonce the shell minted for this sidecar', async () => {
    expect(await boot(sidecar.base)).toEqual({
      bootNonce: 'nonce-from-the-shell',
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      demo: true,
    });
  });

  it('reports null for a core started outside the shell (the stale-dev-core case)', async () => {
    expect((await boot(stray.base)).bootNonce).toBeNull();
  });

  it('treats a whitespace nonce as unset, never as an empty-string match', async () => {
    // config.ts trims, so a stray empty env var cannot be "echoed back" and
    // accidentally satisfy a shell that also somehow had an empty nonce.
    expect((await boot(blank.base)).bootNonce).toBeNull();
  });

  it('serves the route LIVE too — it is not demo-gated', async () => {
    // The packaged desktop boots DEMO_MODE=0; if the route only existed in
    // demo, the real shell could never verify its own sidecar.
    expect(await boot(live.base)).toEqual({
      bootNonce: 'nonce-from-the-shell',
      version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      demo: false,
    });
  });

  it('distinguishes the shell sidecar from the stray core on the SAME nonce expectation', async () => {
    // The shell compares against its own nonce, so two cores both holding
    // "the intended" role are still told apart by what they report.
    const [ours, theirs] = await Promise.all([boot(sidecar.base), boot(stray.base)]);
    expect(ours.bootNonce).toBe('nonce-from-the-shell');
    expect(theirs.bootNonce).not.toBe(ours.bootNonce);
    expect(theirs.bootNonce).toBeNull();
  });

  it('keeps the nonce off /v1/health (distinct surfaces, no accidental disclosure)', async () => {
    const health = (await (await fetch(`${sidecar.base}/v1/health`)).json()) as Record<
      string,
      unknown
    >;
    expect(health).not.toHaveProperty('bootNonce');
    expect(JSON.stringify(health)).not.toContain('nonce-from-the-shell');
  });
});
