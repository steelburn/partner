/**
 * M15 parent-watch e2e: when the desktop shell spawns the core with
 * PARTNER_PARENT_WATCH=1 (stdin piped), closing the parent's end of that
 * pipe must make the core exit itself — the shell can die by ANY path
 * (graceful quit, crash, force-kill) and an orphaned core must never keep
 * holding the port or the encrypted DB lock. Control: a core WITHOUT the
 * flag must ignore stdin EOF (plain terminal / docker demo runs have closed
 * or TTY stdin from the start — EOF there is not a signal).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;

interface Probe {
  child: ChildProcess;
  base: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  spawnError: string;
  stderr: string;
}

let watch: Probe;
let plain: Probe | null = null;

async function waitForHealth(base: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('core never became healthy');
}

function spawnCore(watchEnabled: boolean): Probe {
  const port = 30_000 + (process.pid % 20_000) + (watchEnabled ? 0 : 1);
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'core/src/index.ts'],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        PORT: String(port),
        DEMO_MODE: '1',
        DB_PATH: ':memory:',
        HOST: '127.0.0.1',
        ...(watchEnabled ? { PARTNER_PARENT_WATCH: '1' } : {}),
      },
      // stdin MUST be a live pipe (the shell keeps the write end open).
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let spawnError = '';
  let stderr = '';
  child.on('error', (err) => {
    spawnError = err.message;
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  return { child, base: `http://127.0.0.1:${port}`, exited, spawnError, stderr };
}

async function stop(probe: Probe): Promise<void> {
  if (probe.child.exitCode === null) probe.child.kill('SIGTERM');
  await probe.exited;
}

beforeAll(async () => {
  watch = spawnCore(true);
  await waitForHealth(watch.base);
}, 20_000);

afterAll(async () => {
  await stop(watch);
  if (plain !== null) await stop(plain);
});

describe('M15 parent-watch lifecycle', () => {
  it('exits itself when the parent closes the stdin pipe (PARTNER_PARENT_WATCH=1)', async () => {
    expect(watch.spawnError).toBe('');
    // The shell died: its end of the stdin pipe closes.
    watch.child.stdin?.end();
    const outcome = await Promise.race([
      watch.exited,
      new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        setTimeout(() => resolve({ code: 'timeout', signal: null }), 8_000),
      ),
    ]);
    expect(outcome).toEqual({ code: 0, signal: null });
    expect(watch.stderr).not.toContain('unhandled');
  }, 15_000);

  it('control: without the flag, stdin EOF is NOT a shutdown signal', async () => {
    plain = spawnCore(false);
    await waitForHealth(plain.base);
    plain.child.stdin?.end();
    // Give the watcher (if wrongly enabled) a chance to fire.
    await new Promise((r) => setTimeout(r, 1_500));
    expect(plain.child.exitCode).toBeNull();
  }, 20_000);
});
