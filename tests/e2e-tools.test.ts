/**
 * M2 cross-cutting e2e over a spawned demo core (PLAN-M2.md exit): add a real
 * temp project root -> files.edit produces a proposal -> approve (medium,
 * remembered) -> files.apply is high-risk (always asks) -> approve -> the file
 * actually changes on disk with a .bak, and no audit row leaks params/content.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = `${here}..`;
const corePort = 40_000 + (process.pid % 10_000);

let core: ChildProcess;
let base: string;
let token = '';
let workDir: string;
let coreOut = '';

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/health`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('core never became healthy');
}

function authed(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'partner-m2-e2e-'));
  writeFileSync(join(workDir, 'hello.txt'), 'hello world\n');
  writeFileSync(join(workDir, 'secret.env'), 'API_KEY=sk-abcdef1234567890\n');

  core = spawn(process.execPath, ['--import', 'tsx', 'core/src/index.ts'], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      PORT: String(corePort),
      DEMO_MODE: '1',
      DB_PATH: ':memory:',
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  core.stdout?.on('data', (d: Buffer) => {
    coreOut += d.toString();
  });
  core.stderr?.on('data', (d: Buffer) => {
    coreOut += d.toString();
  });
  base = `http://127.0.0.1:${corePort}`;
  try {
    await waitForHealth();
    const code = ((await (await fetch(`${base}/v1/dev/pair-code`)).json()) as { code: string }).code;
    const pair = await fetch(`${base}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    expect(pair.status).toBe(200);
    token = ((await pair.json()) as { token: string }).token;
  } catch (err) {
    core.kill('SIGTERM');
    throw new Error(`core setup failed:\n${coreOut}\n${String(err)}`);
  }
}, 25_000);

afterAll(async () => {
  core?.kill('SIGTERM');
  rmSync(workDir, { recursive: true, force: true });
});

describe('M2 e2e: roots, edit proposal, approve, apply', () => {
  it('rejects a non-absolute root path', async () => {
    const res = await authed('/v1/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'bad', path: 'relative/path' }),
    });
    expect(res.status).toBe(400);
  });

  it('adds a root, proposes an edit, approves, and applies it to disk', async () => {
    const add = await authed('/v1/roots', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'e2e-root', path: workDir }),
    });
    expect(add.status).toBe(201);
    const { id: projectId } = (await add.json()) as { id: string };

    // files.edit -> needs approval (medium, no grant yet)
    const edit = await authed('/v1/tools/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'files.edit',
        params: { projectId, path: 'hello.txt', proposedContent: 'hello partner\n' },
      }),
    });
    expect(edit.status).toBeLessThan(300);
    const editBody = (await edit.json()) as { outcome: string; pendingId?: string };
    expect(editBody.outcome).toBe('needs_approval');

    // Approve + remember -> the grant persists.
    const approve1 = await authed(`/v1/tools/pending/${editBody.pendingId as string}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve', remember: true }),
    });
    expect(approve1.status).toBeLessThan(300);

    // Re-exec edit -> executed now (grant remembered) -> returns a proposal.
    const edit2 = await authed('/v1/tools/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'files.edit',
        params: { projectId, path: 'hello.txt', proposedContent: 'hello partner\n' },
      }),
    });
    expect(edit2.status).toBeLessThan(300);
    const edit2Body = (await edit2.json()) as {
      outcome: string;
      result?: { proposalId: string; path: string };
    };
    expect(edit2Body.outcome).toBe('executed');
    const proposalId = (edit2Body.result as { proposalId: string }).proposalId;

    const proposal = await authed(`/v1/tools/proposals/${proposalId}`);
    expect(proposal.status).toBeLessThan(300);
    const proposalBody = (await proposal.json()) as {
      originalContent: string;
      proposedContent: string;
    };
    expect(proposalBody.originalContent).toBe('hello world\n');
    expect(proposalBody.proposedContent).toBe('hello partner\n');

    // files.apply is high risk -> always asks, even with a grant.
    const apply = await authed('/v1/tools/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tool: 'files.apply',
        params: { projectId, proposalId },
      }),
    });
    expect(apply.status).toBeLessThan(300);
    const applyBody = (await apply.json()) as { outcome: string; pendingId?: string };
    expect(applyBody.outcome).toBe('needs_approval');

    const approve2 = await authed(`/v1/tools/pending/${applyBody.pendingId as string}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(approve2.status).toBeLessThan(300);

    // The file actually changed on disk, with a .bak left behind.
    expect(readFileSync(join(workDir, 'hello.txt'), 'utf8')).toBe('hello partner\n');
    const baks = join(workDir, 'hello.txt.bak');
    expect(existsSync(baks)).toBe(true);

    // Delete goes to a trash dir, not straight out.
    const del = await authed('/v1/tools/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'files.delete', params: { projectId, path: 'secret.env' } }),
    });
    expect(del.status).toBeLessThan(300);
    const delBody = (await del.json()) as { outcome: string; pendingId?: string };
    if (delBody.outcome === 'needs_approval') {
      await authed(`/v1/tools/pending/${delBody.pendingId as string}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve', remember: true }),
      });
    }
    expect(existsSync(join(workDir, 'secret.env'))).toBe(false);
    expect(existsSync(join(workDir, '.partner-trash'))).toBe(true);

    // Audit never contains file content, key material, or param dumps.
    const audit = await authed('/v1/audit');
    const text = await audit.text();
    expect(text).not.toContain('hello partner');
    expect(text).not.toContain('hello world');
    expect(text).not.toContain('sk-abcdef1234567890');
    expect(text).not.toContain('API_KEY');
  });
});
