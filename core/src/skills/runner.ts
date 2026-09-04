/**
 * Skill runner (M8, PLAN-M8.md) — spawns one worker process per invocation
 * and brokers everything the skill may do.
 *
 *   spawn: `child_process.fork` of the plain-ESM worker harness
 *   (worker-runner.mjs) with execArgv [] and a MINIMAL env — the harness is
 *   pure node, no tsx needed, and the skill never sees the core's own env
 *   (no keys, no PATH surprises). The harness resolves via import.meta.url so
 *   it works whether the core runs under tsx or vitest.
 *
 *   budget: manifest.budget.timeMs (default 30s) from spawn; on expiry the
 *   process is killed and the invocation fails with budget_exceeded. A worker
 *   that dies without a result is 'crashed' (non-zero OR clean exit). An
 *   optional AbortSignal kills the worker ('aborted').
 *
 *   caps: args serialized size cap 64 KiB (before spawn), result cap 1 MiB
 *   (enforced on the worker AND re-checked here) -> caps_exceeded.
 *
 *   tools: {type:'tools.exec'} requests go through the BROKER with
 *   requestedBy 'skill', intersected with the manifest: the tool must be in
 *   permissions.tools, must exist in the broker registry, and the manifest
 *   risk ceiling must be >= the tool's own risk. No explicit user grant ->
 *   the broker enqueues; skills are non-interactive, so the pending call is
 *   closed as DENY and the worker gets tool_denied — a user grant must exist
 *   BEFORE the invocation (default-deny, PLAN-M8).
 *
 *   logs: {type:'log'} lines are printed to the CORE console (console.error)
 *   with redactString applied. Skill logs/args/results NEVER reach audit:
 *   each run records one skill_invocations meta row (ok/toolCalls/ms/error
 *   code) + one skill.invoke audit row (ids/version/counts only).
 */
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactString } from '@partner/shared';
import type { SkillDetail, SkillInvocationMeta, ToolRisk } from '@partner/shared';
import type { ToolBroker } from '../broker/broker.js';
import type { AuditService } from '../services/redaction.js';
import type { SkillInvocationStore } from '../stores/types.js';

const DEFAULT_BUDGET_MS = 30_000;
const DEFAULT_MAX_ARGS_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ERROR_CODE = 200;

const WORKER_PATH = fileURLToPath(new URL('./worker-runner.mjs', import.meta.url));

export interface SkillRunnerOptions {
  /** Per-core skill store root (config.skillsDir) — code lives at dataDir/<id>/. */
  dataDir: string;
  /** The M2 tool broker (default-deny; skill requests intersect its registry). */
  broker: ToolBroker;
  audit: AuditService;
  /** skill_invocations row store (meta rows are written after every run). */
  invocations: SkillInvocationStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /** Redacted-line sink (default console.error — the core console). */
  log?: (line: string) => void;
  /** Args JSON-size cap (default 64 KiB). */
  maxArgsBytes?: number;
  /** Result JSON-size cap (default 1 MiB). */
  maxResultBytes?: number;
}

export type SkillInvokeErrorCode =
  | 'budget_exceeded'
  | 'crashed'
  | 'tool_denied'
  | 'skill_error'
  | 'caps_exceeded'
  | 'no_worker'
  | 'aborted'
  | (string & {});

export interface SkillInvokeOk {
  ok: true;
  result: unknown;
  meta: SkillInvocationMeta;
}

export interface SkillInvokeFailure {
  ok: false;
  error: SkillInvokeErrorCode;
  meta: SkillInvocationMeta;
}

export type SkillInvokeResult = SkillInvokeOk | SkillInvokeFailure;

export interface SkillInvokeContext {
  personaId?: string;
  /** Abort kills the worker ('aborted' outcome). */
  signal?: AbortSignal;
}

export interface SkillRunner {
  invoke(skill: SkillDetail, args: unknown, ctx?: SkillInvokeContext): Promise<SkillInvokeResult>;
}

const RISK_RANK: Record<ToolRisk, number> = { low: 0, medium: 1, high: 2 };

export function createSkillRunner(options: SkillRunnerOptions): SkillRunner {
  const { dataDir, broker, audit, invocations } = options;
  const now = options.now ?? Date.now;
  const logSink = options.log ?? ((line: string) => console.error(line));
  const maxArgsBytes = options.maxArgsBytes ?? DEFAULT_MAX_ARGS_BYTES;
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;

  function budgetMsOf(skill: SkillDetail): number {
    const timeMs = skill.manifest.budget?.timeMs;
    return typeof timeMs === 'number' && Number.isFinite(timeMs) && timeMs > 0
      ? timeMs
      : DEFAULT_BUDGET_MS;
  }

  /** Record the meta row + audit for a settled (or pre-spawn-failed) run. */
  function record(
    skill: SkillDetail,
    startedAt: number,
    finishedAt: number,
    personaId: string | null,
    toolCalls: number,
    outcome: { ok: true } | { ok: false; error: string },
  ): SkillInvocationMeta {
    const error = outcome.ok ? null : outcome.error;
    const meta: SkillInvocationMeta = {
      id: randomUUID(),
      skillId: skill.id,
      personaId,
      startedAt,
      finishedAt,
      ok: outcome.ok,
      toolCalls,
      error,
      ms: finishedAt - startedAt,
    };
    invocations.insert({
      id: meta.id,
      skillId: meta.skillId,
      personaId: meta.personaId,
      startedAt: meta.startedAt,
      finishedAt: meta.finishedAt,
      ok: meta.ok ? 1 : 0,
      toolCalls: meta.toolCalls,
      error: meta.error,
      ms: meta.ms,
    });
    // Audit: ids/version/counts ONLY — never skill logs, args or results.
    const details: Record<string, unknown> = {
      version: skill.version,
      ok: meta.ok,
      toolCalls: meta.toolCalls,
      ms: meta.ms,
    };
    if (personaId !== null) details.personaId = personaId;
    if (error !== null) details.error = error;
    audit.log('web', 'skill.invoke', skill.id, details);
    return meta;
  }

  async function invoke(
    skill: SkillDetail,
    rawArgs: unknown,
    ctx: SkillInvokeContext = {},
  ): Promise<SkillInvokeResult> {
    const startedAt = now();
    const personaId = typeof ctx.personaId === 'string' && ctx.personaId.trim() !== '' ? ctx.personaId.trim() : null;

    // Args JSON cap — pre-spawn (a giant/cyclic payload never reaches a worker).
    let argsText = '';
    try {
      argsText = JSON.stringify(rawArgs === undefined ? {} : rawArgs);
    } catch {
      const finished = now();
      const meta = record(skill, startedAt, finished, personaId, 0, {
        ok: false,
        error: 'caps_exceeded',
      });
      return { ok: false, error: 'caps_exceeded', meta };
    }
    if (argsText === undefined || Buffer.byteLength(argsText, 'utf8') > maxArgsBytes) {
      const finished = now();
      const meta = record(skill, startedAt, finished, personaId, 0, {
        ok: false,
        error: 'caps_exceeded',
      });
      return { ok: false, error: 'caps_exceeded', meta };
    }

    const budgetMs = budgetMsOf(skill);
    const workerPath = WORKER_PATH;
    const skillDir = join(dataDir, skill.id);

    const child: ChildProcess = fork(workerPath, [], {
      // Minimal env on purpose: the skill never inherits the core's
      // environment (keys/PATH) — only its own three knobs.
      env: {
        PARTNER_SKILL_DIR: skillDir,
        PARTNER_SKILL_ENTRY: skill.manifest.entrypoint,
        PARTNER_SKILL_MAX_RESULT_BYTES: String(maxResultBytes),
      },
      execArgv: [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });

    return new Promise<SkillInvokeResult>((resolve) => {
      let done = false;
      let sentInvoke = false;
      let budgetKilled = false;
      let aborted = false;
      let toolCalls = 0;

      const finish = (outcome: { ok: true; result: unknown } | { ok: false; error: string }): void => {
        if (done) return;
        done = true;
        cleanup();
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
        const finishedAt = now();
        const meta = record(skill, startedAt, finishedAt, personaId, toolCalls, outcome);
        if (outcome.ok) {
          resolve({ ok: true, result: outcome.result, meta });
        } else {
          resolve({ ok: false, error: outcome.error, meta });
        }
      };
      const fail = (error: string): void => finish({ ok: false, error });

      const cleanup = (): void => {
        clearTimeout(timer);
        if (ctx.signal !== undefined) {
          ctx.signal.removeEventListener('abort', onAbort);
        }
        child.removeAllListeners('message');
        child.removeAllListeners('exit');
        child.removeAllListeners('error');
      };

      const timer = setTimeout(() => {
        budgetKilled = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      }, budgetMs);
      timer.unref();

      const onAbort = (): void => {
        aborted = true;
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone.
        }
      };
      if (ctx.signal !== undefined) {
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
      }

      /** Reply to one worker tool request through the broker. */
      const replyTool = (message: { toolId?: unknown; params?: unknown; nonce?: unknown }): void => {
        const toolId = typeof message.toolId === 'string' ? message.toolId : '';
        const nonce = typeof message.nonce === 'string' ? message.nonce : '';
        const params = message.params;
        const deny = (code: string): void => {
          try {
            child.send({ type: 'tools.result', nonce, ok: false, error: code });
          } catch {
            // Channel gone.
          }
        };
        if (nonce === '' || toolId === '') {
          deny('tool_denied');
          return;
        }
        // Intersect: declared in manifest AND exists in the broker registry
        // AND within the skill's risk ceiling.
        const declared = skill.manifest.permissions.tools as readonly string[];
        if (!declared.includes(toolId)) {
          deny('tool_denied');
          return;
        }
        const toolManifest = broker.manifests.find((m) => m.id === toolId);
        if (!toolManifest) {
          deny('tool_denied');
          return;
        }
        if (RISK_RANK[toolManifest.risk] > RISK_RANK[skill.manifest.permissions.risk]) {
          deny('tool_denied');
          return;
        }
        const response = broker.exec(toolId, params, { requestedBy: 'skill' });
        if (response.outcome === 'executed') {
          try {
            child.send({ type: 'tools.result', nonce, ok: true, result: response.result });
          } catch {
            // Channel gone.
          }
          return;
        }
        if (response.outcome === 'needs_approval') {
          // Skills are non-interactive: a missing grant is a hard deny. Close
          // the just-enqueued pending row so the queue never fills with skill
          // requests (the user grants BEFORE invoking, default-deny).
          try {
            broker.decide(response.pendingId, { decision: 'deny' }, 'skill');
          } catch {
            // Row already closed — nothing to do.
          }
          deny('tool_denied');
          return;
        }
        deny(response.reason);
      };

      child.on('message', (message: unknown) => {
        if (done) return;
        const msg = message as {
          type?: unknown;
          line?: unknown;
          argsText?: unknown;
          toolId?: unknown;
          params?: unknown;
          nonce?: unknown;
          ok?: unknown;
          text?: unknown;
          error?: unknown;
        };
        if (msg.type === 'log') {
          const line = redactString(String(msg.line ?? ''));
          logSink(`[skill ${skill.id}] ${line}`);
          return;
        }
        if (msg.type === 'tools.exec') {
          toolCalls += 1;
          replyTool(msg);
          return;
        }
        if (msg.type === 'ready') {
          if (sentInvoke) return;
          sentInvoke = true;
          try {
            child.send({ type: 'invoke', argsText });
          } catch {
            fail('crashed');
          }
          return;
        }
        if (msg.type === 'result') {
          if (msg.ok === true) {
            const text = typeof msg.text === 'string' ? msg.text : '';
            if (Buffer.byteLength(text, 'utf8') > maxResultBytes) {
              fail('caps_exceeded');
              return;
            }
            try {
              finish({ ok: true, result: JSON.parse(text) as unknown });
            } catch {
              fail('skill_error');
            }
            return;
          }
          const error =
            typeof msg.error === 'string' && msg.error !== ''
              ? msg.error.slice(0, MAX_ERROR_CODE)
              : 'skill_error';
          fail(error);
        }
      });

      child.on('error', () => {
        // fork failed (e.g. missing node) — no worker ever ran.
        fail('no_worker');
      });

      child.on('exit', (code) => {
        if (done) return;
        if (budgetKilled) {
          fail('budget_exceeded');
          return;
        }
        if (aborted) {
          fail('aborted');
          return;
        }
        // Exit without a result: crashed — whatever the code (a clean exit(0)
        // with no result is equally a broken worker).
        void code;
        fail('crashed');
      });
    });
  }

  return { invoke };
}
