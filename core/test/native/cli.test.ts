/**
 * M7 native-messaging CLI integration (PLAN-M7.md): spawn the REAL core with
 * `--native-messaging` (demo mode, in-memory db) and pipe Chrome-framed JSON
 * over its stdio — hello, unpaired gate, pair.code/pair, scope.get, denied
 * capture on ask + hard-blocked origins, analyze policy gate, unknown
 * command, one bad-frame recovery, then an oversized length prefix ends the
 * channel cleanly.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NmEnvelope } from '@partner/shared';
import { SCHEMA_VERSION } from '@partner/shared';
import { CORE_VERSION } from '../../src/config.js';

const ROOT = process.cwd();

function frameEnvelope(envelope: NmEnvelope): Buffer {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function rawFrame(body: Buffer): Buffer {
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/** Sequential frame reader over the child's stdout. */
class ChildFrames {
  private buffer = Buffer.alloc(0);
  private waiting: Array<(frame: Buffer | null) => void> = [];
  private exitInfo: string | null = null;

  constructor(private readonly child: ChildProcess) {
    child.stdout?.on('data', (c: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, c]);
      this.flush();
    });
    child.on('exit', (code, signal) => {
      this.exitInfo = `code=${code} signal=${signal}`;
      this.flush(); // unblock any pending wait with EOF
    });
  }

  private flush(): void {
    while (this.waiting.length > 0) {
      const frame = this.tryReadOne();
      if (frame === undefined) break; // need more bytes
      const waiter = this.waiting.shift() as (frame: Buffer | null) => void;
      waiter(frame);
    }
    // EOF: unblock any remaining waiters.
    if (this.exitInfo !== null && this.waiting.length > 0) {
      while (this.waiting.length > 0) {
        const waiter = this.waiting.shift() as (frame: Buffer | null) => void;
        waiter(null);
      }
    }
  }

  /** null = one frame ready but not yet; undefined handled in flush. */
  private tryReadOne(): Buffer | null | undefined {
    if (this.buffer.length < 4) return this.exitInfo !== null ? null : undefined;
    const length = this.buffer.readUInt32LE(0);
    if (length > 16 * 1024 * 1024) return null;
    if (this.buffer.length < 4 + length) return this.exitInfo !== null ? null : undefined;
    const body = this.buffer.subarray(4, 4 + length);
    this.buffer = this.buffer.subarray(4 + length);
    return body;
  }

  next(timeoutMs: number): Promise<Buffer | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiting.indexOf(waiter);
        if (idx >= 0) this.waiting.splice(idx, 1);
        resolve(null);
      }, timeoutMs);
      const waiter = (frame: Buffer | null): void => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.waiting.push(waiter);
      this.flush();
    });
  }

  exited(): boolean {
    return this.exitInfo !== null;
  }

  exitSummary(): string {
    return this.exitInfo ?? 'running';
  }
}

describe('M7 core CLI --native-messaging (spawned)', () => {
  let child: ChildProcess;
  let frames: ChildFrames;
  let stderrBuf = '';

  beforeAll(async () => {
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'core/src/index.ts', '--native-messaging'],
      {
        cwd: ROOT,
        // Deliberately minimal env (mirrors the M0 e2e spawn): vitest's
        // NODE_OPTIONS/loader hooks would break the child.
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          DEMO_MODE: '1',
          DB_PATH: ':memory:',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    frames = new ChildFrames(child);
    child.stderr?.on('data', (c: Buffer) => {
      stderrBuf += c.toString();
    });
    child.stdin!.on('error', () => {
      /* EPIPE once the child exits — surfaced by the exit waiters. */
    });
    child.on('error', (err) => {
      throw err;
    });
    // The child must boot and answer hello within a generous window. Write
    // the hello frame BEFORE waiting for the response (one frame per
    // request, in order).
    child.stdin!.write(frameEnvelope({ type: 'request', id: 'boot', command: 'hello' }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('core never answered hello')), 20_000);
      const onExit = (): void => {
        clearTimeout(timer);
        reject(new Error(`core exited during boot: ${frames.exitSummary()}\n--- stderr ---\n${stderrBuf}`));
      };
      child.once('exit', onExit);
      frames
        .next(20_000)
        .then((body) => {
          clearTimeout(timer);
          child.removeListener('exit', onExit);
          const envelope = JSON.parse((body as Buffer).toString('utf8')) as NmEnvelope;
          expect(envelope).toMatchObject({ ok: true });
          resolve();
        })
        .catch(reject);
    });
  }, 30_000);

  afterAll(async () => {
    if (!child || child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(resolve, 5000).unref();
    });
    child.kill('SIGTERM');
    await exited;
  });

  /** Write one request and return the decoded response (same id). */
  async function request(envelope: NmEnvelope): Promise<NmEnvelope> {
    child.stdin!.write(frameEnvelope(envelope));
    const body = await frames.next(20_000);
    expect(body, `no response to ${envelope.command} (${frames.exitSummary()})`).not.toBeNull();
    return JSON.parse((body as Buffer).toString('utf8')) as NmEnvelope;
  }

  it('drives the full demo pair + scope flow over stdio frames', async () => {
    // 1. Unpaired: every command but hello/pair.code/pair is refused.
    const hello = await request({ type: 'request', id: '1', command: 'hello' });
    expect(hello).toMatchObject({ id: '1', ok: true });
    expect(hello.payload).toEqual({
      version: CORE_VERSION,
      demo: true,
      schemaVersion: SCHEMA_VERSION,
    });

    const earlyCapture = await request({
      type: 'request',
      id: '2',
      command: 'page.capture',
      payload: { url: 'https://news.example/a', title: 'T', origin: 'news.example', text: 'x' },
    });
    expect(earlyCapture).toMatchObject({ id: '2', ok: false, error: 'not_paired' });

    // 2. pair.code -> pair.
    const codeEnvelope = await request({ type: 'request', id: '3', command: 'pair.code' });
    expect(codeEnvelope).toMatchObject({ id: '3', ok: true });
    const code = (codeEnvelope.payload as { code: string }).code;
    expect(code).toMatch(/^\d{6}$/);

    const paired = await request({
      type: 'request',
      id: '4',
      command: 'pair',
      payload: { code },
    });
    expect(paired).toMatchObject({ id: '4', ok: true, payload: { paired: true } });

    // 3. scope.get resolves the default ask policy for a normal origin.
    const scope = await request({
      type: 'request',
      id: '5',
      command: 'scope.get',
      payload: { origin: 'https://news.example/article' },
    });
    expect(scope).toMatchObject({ id: '5', ok: true });
    expect(scope.payload).toEqual({
      origin: 'news.example',
      scope: 'ask',
      blocked: false,
      reason: null,
    });

    // 4. ask denies capture (policy in the payload).
    const deniedAsk = await request({
      type: 'request',
      id: '6',
      command: 'page.capture',
      payload: { url: 'https://news.example/a', title: 'T', origin: 'news.example', text: 'x' },
    });
    expect(deniedAsk).toMatchObject({ id: '6', ok: false, error: 'denied_scope' });
    expect((deniedAsk.payload as { policy: { scope: string } }).policy.scope).toBe('ask');

    // 5. A hard-blocked banking origin is denied regardless of anything.
    const deniedBlocked = await request({
      type: 'request',
      id: '7',
      command: 'page.capture',
      payload: {
        url: 'https://www.wellsfargo.com/account',
        title: 'T',
        origin: 'https://www.wellsfargo.com',
        text: 'account data',
      },
    });
    expect(deniedBlocked).toMatchObject({ id: '7', ok: false, error: 'denied_scope' });
    expect(deniedBlocked.payload).toMatchObject({
      policy: { origin: 'www.wellsfargo.com', blocked: true, reason: 'blocked_origin' },
    });

    // 6. analyze goes through the SAME capture policy gate (denied at ask).
    const deniedAnalyze = await request({
      type: 'request',
      id: '8',
      command: 'page.analyze',
      payload: { url: 'https://news.example/a', title: 'T', origin: 'news.example', text: 'x' },
    });
    expect(deniedAnalyze).toMatchObject({ id: '8', ok: false, error: 'denied_scope' });

    // 7. Unknown command -> unknown_command (channel alive).
    const unknown = await request({ type: 'request', id: '9', command: 'frobnicate' });
    expect(unknown).toMatchObject({ id: '9', ok: false, error: 'unknown_command' });

    // 8. One bad frame (valid length, invalid JSON) -> bad_frame + recovery.
    child.stdin!.write(rawFrame(Buffer.from('not json at all', 'utf8')));
    const bad = await frames.next(20_000);
    expect(bad).not.toBeNull();
    const badEnvelope = JSON.parse((bad as Buffer).toString('utf8')) as NmEnvelope;
    expect(badEnvelope).toMatchObject({ ok: false, error: 'bad_frame' });

    const after = await request({ type: 'request', id: '10', command: 'hello' });
    expect(after).toMatchObject({ id: '10', ok: true });

    // 9. An oversized length prefix is unrecoverable: one bad_frame answer,
    //    then the core ends the channel cleanly (exit 0, no HTTP server).
    const huge = Buffer.alloc(4);
    huge.writeUInt32LE(0xffffffff, 0);
    child.stdin!.write(huge);
    const fatal = await frames.next(20_000);
    expect(fatal).not.toBeNull();
    const fatalEnvelope = JSON.parse((fatal as Buffer).toString('utf8')) as NmEnvelope;
    expect(fatalEnvelope).toMatchObject({ ok: false, error: 'bad_frame' });

    // The session ends; the CLI exits without hanging (no HTTP server up).
    const exit = await new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => resolve(null), 15_000);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
      });
    });
    expect(exit, `stderr:\n${stderrBuf}`).toBe(0);
  }, 60_000);
});
