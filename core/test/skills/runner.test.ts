/**
 * M8 runner tests (PLAN-M8.md). Each invocation spawns a real worker process
 * (plain node ESM fork of worker-runner.mjs) so these tests exercise the full
 * IPC protocol: ready handshake -> invoke -> result, {type:'log'} redaction,
 * broker-mediated {type:'tools.exec'} requests with manifest intersection,
 * budget kill (budget_exceeded), crash mapping (crashed), args/result caps
 * (caps_exceeded), AbortSignal kill (aborted) and the minimal-env guarantee
 * (a skill never inherits the core's environment). The sample catalog skills
 * prove the echo/pure/tool paths end-to-end via install -> invoke.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SkillDetail, SkillInvocationMeta } from '@partner/shared';
import type { ToolBroker } from '../../src/broker/broker.js';
import { createToolBroker } from '../../src/broker/broker.js';
import { createGrantManager } from '../../src/broker/grants.js';
import { createPendingManager } from '../../src/broker/pending.js';
import { createProjectRootManager } from '../../src/broker/roots.js';
import { createFileTools } from '../../src/files/tools.js';
import { createProposalManager } from '../../src/files/proposals.js';
import { createSkillManager } from '../../src/skills/manager.js';
import type { SkillManager } from '../../src/skills/manager.js';
import { createSkillRunner } from '../../src/skills/runner.js';
import type { SkillRunner } from '../../src/skills/runner.js';
import { auditLog } from '../../src/services/redaction.js';
import type { AuditService } from '../../src/services/redaction.js';
import {
  openDatabase,
  createAuditStore,
  createFileProposalStore,
  createGrantStore,
  createPendingToolStore,
  createProjectRootStore,
  createSkillInvocationStore,
  createSkillStore,
} from '../../src/stores/db.js';
import type { SkillInvocationStore } from '../../src/stores/types.js';
import { REPO_CATALOG, makeTempRoot, removeTempRoot } from '../helpers.js';

interface Env {
  audit: AuditService;
  broker: ToolBroker;
  manager: SkillManager;
  runner: SkillRunner;
  invocations: SkillInvocationStore;
  dataDir: string;
  lines: string[];
  close(): void;
}

const dirs: string[] = [];

function makeDir(): string {
  const dir = makeTempRoot();
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function buildEnv(options: { maxResultBytes?: number; maxArgsBytes?: number } = {}): Env {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const rootStore = createProjectRootStore(db);
  const grantStore = createGrantStore(db);
  const pendingStore = createPendingToolStore(db);
  const proposalStore = createFileProposalStore(db);
  const roots = createProjectRootManager({ store: rootStore });
  const grants = createGrantManager({ store: grantStore });
  const pending = createPendingManager({
    store: pendingStore,
    onCreateGrant: (row, note) =>
      grants.add(row.toolId, row.projectId ?? '', note === undefined ? {} : { note }).id,
  });
  const proposals = createProposalManager({ store: proposalStore });
  const broker = createToolBroker({
    roots,
    grants,
    pending,
    proposals,
    tools: createFileTools({ proposals: proposalStore }),
    audit,
  });
  const dataDir = makeDir();
  const invocations = createSkillInvocationStore(db);
  const lines: string[] = [];
  const manager = createSkillManager({
    store: createSkillStore(db),
    invocations,
    storeDir: dataDir,
    catalogDir: REPO_CATALOG,
    tools: new Set(broker.manifests.map((m) => m.id)),
    audit,
  });
  const runner = createSkillRunner({
    dataDir,
    broker,
    audit,
    invocations,
    log: (line) => {
      lines.push(line);
    },
    maxResultBytes: options.maxResultBytes,
    maxArgsBytes: options.maxArgsBytes,
  });
  return {
    audit,
    broker,
    manager,
    runner,
    invocations,
    dataDir,
    lines,
    close(): void {
      db.close();
    },
  };
}

/** Write a raw fixture skill (bypassing install) into the store dir. */
function fixtureSkill(env: Env, id: string, code: string, overrides: Partial<SkillDetail['manifest']> = {}): SkillDetail {
  const dir = join(env.dataDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'entry.mjs'), code);
  return detailOf(id, overrides);
}

function detailOf(id: string, overrides: Partial<SkillDetail['manifest']> = {}): SkillDetail {
  const manifest: SkillDetail['manifest'] = {
    id,
    name: id,
    description: 'fixture',
    author: 'tests',
    version: '0.0.1',
    entrypoint: 'entry.mjs',
    permissions: {
      tools: [] as SkillDetail['manifest']['permissions']['tools'],
      network: false,
      risk: 'low',
    },
    budget: { timeMs: 5000 },
    ...overrides,
  };
  return {
    id,
    name: id,
    description: 'fixture',
    author: 'tests',
    version: '0.0.1',
    source: 'local',
    status: 'installed',
    sha256: 'fixture',
    installedAt: 0,
    updatedAt: 0,
    manifest,
  };
}

async function invoke(
  env: Env,
  skill: SkillDetail,
  args?: unknown,
): Promise<{ ok: boolean; result?: unknown; error?: string; meta: SkillInvocationMeta }> {
  const res = await env.runner.invoke(skill, args);
  if (res.ok) return { ok: true, result: res.result, meta: res.meta };
  return { ok: false, error: res.error, meta: res.meta };
}

describe('skill runner — sample catalog skills', () => {
  it('hello-skill echoes the name argument (installed via manager)', async () => {
    const env = buildEnv();
    try {
      env.manager.install('hello-skill');
      const detail = env.manager.get('hello-skill') as SkillDetail;
      const out = await invoke(env, detail, { name: 'Ada' });
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({ hello: 'from Ada' });
      expect(out.meta).toMatchObject({ skillId: 'hello-skill', ok: true, toolCalls: 0, error: null });
    } finally {
      env.close();
    }
  });

  it('hello-skill falls back to world when no name is given', async () => {
    const env = buildEnv();
    try {
      env.manager.install('hello-skill');
      const detail = env.manager.get('hello-skill') as SkillDetail;
      const out = await invoke(env, detail);
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({ hello: 'from world' });
    } finally {
      env.close();
    }
  });

  it('note-echo is a pure skill — canned summary of its args, no tools', async () => {
    const env = buildEnv();
    try {
      env.manager.install('note-echo');
      const detail = env.manager.get('note-echo') as SkillDetail;
      const out = await invoke(env, detail, { topic: 'quarterly review', n: 3 });
      expect(out.ok).toBe(true);
      const note = (out.result as { note: string }).note;
      expect(note).toContain('topic="quarterly review"');
      expect(note).toContain('n=3');
      expect((out.result as { argumentCount: number }).argumentCount).toBe(2);
    } finally {
      env.close();
    }
  });
});

describe('skill runner — broker enforcement (files-preview)', () => {
  function rootWithFile(env: Env): { id: string; path: string } {
    const rootPath = makeDir();
    writeFileSync(join(rootPath, 'doc.txt'), 'hello');
    const root = env.broker.roots.add({ label: 'fixture', path: rootPath });
    return { id: root.id, path: rootPath };
  }

  it('files-preview without a user grant -> ok:false error tool_denied', async () => {
    const env = buildEnv();
    try {
      env.manager.install('files-preview');
      const root = rootWithFile(env);
      const out = await invoke(env, env.manager.get('files-preview') as SkillDetail, {
        projectId: root.id,
        path: 'doc.txt',
      });
      expect(out.ok).toBe(false);
      expect(out.error).toBe('tool_denied');
      // The attempted tool call is counted, and no dangling approval row stays.
      expect(out.meta).toMatchObject({ ok: false, error: 'tool_denied', toolCalls: 1 });
      expect(env.broker.pending.list()).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('files-preview WITH a user grant for files.read on the root executes', async () => {
    const env = buildEnv();
    try {
      env.manager.install('files-preview');
      const root = rootWithFile(env);
      // The USER grant covers files.read for that root (broker grant manager).
      env.broker.grants.add('files.read', root.id);
      const out = await invoke(env, env.manager.get('files-preview') as SkillDetail, {
        projectId: root.id,
        path: 'doc.txt',
      });
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({ bytes: 5, chars: 5 });
      expect(out.meta.toolCalls).toBe(1);
    } finally {
      env.close();
    }
  });

  it('a low-risk skill cannot use a medium tool even with a grant (ceiling)', async () => {
    const env = buildEnv();
    try {
      const skill = fixtureSkill(env, 'ceiling-skill', `export async function run(args) {
        try {
          await globalThis.partner.tools.exec('files.edit', { projectId: args.projectId, path: 'a.txt', proposedContent: 'x' });
          return { hit: true };
        } catch (err) {
          return { error: err.code };
        }
      }`);
      const rootPath = makeDir();
      writeFileSync(join(rootPath, 'a.txt'), 'old');
      const root = env.broker.roots.add({ label: 'r', path: rootPath });
      env.broker.grants.add('files.edit', root.id); // grant exists — ceiling still denies
      const out = await invoke(env, skill, { projectId: root.id });
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({ error: 'tool_denied' });
      expect(out.meta.toolCalls).toBe(1);
    } finally {
      env.close();
    }
  });
});

describe('skill runner — budgets, crashes, caps, env', () => {
  it('kills a skill that never returns (budget_exceeded)', async () => {
    const env = buildEnv();
    try {
      const skill = fixtureSkill(env, 'loop-skill', 'export function run(){ while(true){} }', {
        budget: { timeMs: 600 },
      });
      const out = await invoke(env, skill);
      expect(out.ok).toBe(false);
      expect(out.error).toBe('budget_exceeded');
      expect(out.meta).toMatchObject({ ok: false, error: 'budget_exceeded' });
      expect(typeof out.meta.ms).toBe('number');
    } finally {
      env.close();
    }
  });

  it('an AbortSignal kills the worker (aborted)', async () => {
    const env = buildEnv();
    try {
      const skill = fixtureSkill(env, 'abort-skill', 'export function run(){ while(true){} }', {
        budget: { timeMs: 10_000 },
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 250).unref();
      const out = await env.runner.invoke(skill, {}, { signal: controller.signal });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.error).toBe('aborted');
    } finally {
      env.close();
    }
  });

  it('a crashing entry -> crashed (non-zero exit)', async () => {
    const env = buildEnv();
    try {
      const skill = fixtureSkill(env, 'crash-skill', 'export function run(){ process.exit(7); }');
      const out = await invoke(env, skill);
      expect(out.ok).toBe(false);
      expect(out.error).toBe('crashed');
    } finally {
      env.close();
    }
  });

  it('an entry that fails to import -> crashed', async () => {
    const env = buildEnv();
    try {
      const skill = fixtureSkill(env, 'syntax-skill', 'this is {{{ not valid javascript');
      const out = await invoke(env, skill);
      expect(out.ok).toBe(false);
      expect(out.error).toBe('crashed');
    } finally {
      env.close();
    }
  });

  it('skill logs reach the sink REDACTED (never the raw secret)', async () => {
    const env = buildEnv();
    try {
      const skill = fixtureSkill(env, 'log-skill', `export function run(){
        globalThis.partner.log('started reading');
        globalThis.partner.log('token=sk-abcdefgh12345678');
        return { ok: true };
      }`);
      const out = await invoke(env, skill);
      expect(out.ok).toBe(true);
      const all = env.lines.join('\n');
      expect(all).toContain('[skill log-skill] started reading');
      expect(all).toContain('sk-***[redacted]');
      expect(all).not.toContain('sk-abcdefgh12345678');
      // Skill logs NEVER reach audit (rows carry ids/counts only).
      for (const row of env.audit.list(100)) {
        expect(row.details).not.toContain('sk-abcdefgh12345678');
        expect(row.details).not.toContain('started reading');
      }
    } finally {
      env.close();
    }
  });

  it('result over the 1 MiB cap -> caps_exceeded', async () => {
    const env = buildEnv();
    try {
      const skill = fixtureSkill(env, 'big-skill', `export function run(){
        return { blob: 'x'.repeat(${2 * 1024 * 1024}) };
      }`);
      const out = await invoke(env, skill);
      expect(out.ok).toBe(false);
      expect(out.error).toBe('caps_exceeded');
    } finally {
      env.close();
    }
  });

  it('args over the 64 KiB cap -> caps_exceeded without a worker run', async () => {
    const env = buildEnv();
    try {
      env.manager.install('hello-skill');
      const detail = env.manager.get('hello-skill') as SkillDetail;
      const out = await invoke(env, detail, { name: 'x'.repeat(70_000) });
      expect(out.ok).toBe(false);
      expect(out.error).toBe('caps_exceeded');
      expect(out.meta.toolCalls).toBe(0);
    } finally {
      env.close();
    }
  });

  it('skills never inherit the core environment (minimal env)', async () => {
    const env = buildEnv();
    try {
      const skill = fixtureSkill(env, 'env-skill', `export function run(){
        return {
          hasHome: 'HOME' in process.env,
          hasPath: 'PATH' in process.env,
          skillDirSet: process.env.PARTNER_SKILL_DIR !== undefined,
        };
      }`);
      const out = await invoke(env, skill);
      expect(out.ok).toBe(true);
      expect(out.result).toEqual({ hasHome: false, hasPath: false, skillDirSet: true });
    } finally {
      env.close();
    }
  });

  it('invocation meta rows are recorded (ok/toolCalls/ms/error) and hold no content', async () => {
    const env = buildEnv();
    try {
      env.manager.install('hello-skill');
      const hello = env.manager.get('hello-skill') as SkillDetail;
      await invoke(env, hello, { name: 'a' });
      await invoke(env, hello, { name: 'b' });
      const rows = env.invocations.listBySkill('hello-skill', 10);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ skillId: 'hello-skill', ok: 1, toolCalls: 0, error: null });
      expect(typeof rows[0]?.ms).toBe('number');
      const keys = Object.keys(rows[0] ?? {}).sort();
      expect(keys).toEqual([
        'error',
        'finishedAt',
        'id',
        'ms',
        'ok',
        'personaId',
        'skillId',
        'startedAt',
        'toolCalls',
      ]);
      // Skill logs never reach audit; audit rows for invokes carry counts only.
      const auditRows = env.audit.list(50).filter((a) => a.action === 'skill.invoke');
      expect(auditRows).toHaveLength(2);
      for (const row of auditRows) {
        const details = JSON.parse(row.details) as Record<string, unknown>;
        expect(details.version).toBe('0.1.0');
        expect(typeof details.ms).toBe('number');
        expect(JSON.stringify(details)).not.toContain('hello-skill code');
      }
    } finally {
      env.close();
    }
  });
});
