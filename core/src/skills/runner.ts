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
 *   class (M27 S3): every brokered call also carries the ACTING SESSION's
 *   client class, so `broker.exec` applies the SAME envelope it applies to a
 *   direct `/v1/tools/exec` call. That is the point the class is forwarded at
 *   all: the envelope sits ABOVE the grant, so a mobile session's pre-existing
 *   grant must not become a file WRITE "on the phone's behalf" via a skill. The
 *   runner only FORWARDS `ctx.clientClass`, which the route reads off the
 *   session row - it never derives a class of its own (see SkillInvokeContext).
 *
 *   llm (M27 S5): {type:'llm.complete'} requests are MODEL REACH, and they are
 *   declared and bounded rather than ambient. Four gates, in this order: the
 *   manifest must declare `permissions.llm` (otherwise `llm_not_declared` -
 *   absent and false mean no model access at all), the session's class must be
 *   allowed `skill.llm` (desktop only, so a phone cannot reach a model THROUGH
 *   a skill), a provider/model must resolve (`no_provider`, matching chat), and
 *   the invocation's token ceiling must hold. The ceiling is the skill's own
 *   `budget.maxTokens` - declared and validated since M8 and never read until
 *   now - or {@link DEFAULT_SKILL_LLM_MAX_TOKENS} when the manifest declares
 *   none, and it is accumulated across EVERY call in the invocation. Passing it
 *   fails the INVOCATION (`budget_exceeded`): the worker is killed and no
 *   partial success is returned, because a skill that loops model calls could
 *   otherwise spend the user's provider budget a call at a time.
 *
 *   mcp (M27 S2): {type:'tools.exec'} with an `mcp:<server>/<tool>` id is MCP
 *   REACH, declared as `permissions.mcpServers` (server ids, never tool names -
 *   a server is configured and enabled later, so a manifest cannot name a tool
 *   that does not exist yet). It is dispatched to the injected `mcp` seam
 *   INSTEAD of the broker: an MCP id is not a broker tool, it is not in
 *   `permissions.tools`, and the access rules are its own (D5-D8). The seam
 *   applies them in one fixed order and answers with a CODED denial - the
 *   class envelope, the declaration, the medium ceiling, and whether the
 *   server is configured and enabled at all. NO pending row is ever created
 *   here: skills
 *   are non-interactive, so an MCP server must be enabled BEFORE the run,
 *   exactly as a root must be granted before it.
 *
 *   That seam is dependency-INJECTED, not imported: this file never imports
 *   `mcp/` (see `SkillMcpReach`). The composition root wires the two, which is
 *   the same shape `search/tool.ts` uses for the chat tool pass.
 *
 *   The reach never grows a content channel: each call writes ONE audit row
 *   (`skill.llm`) carrying the model id and token counts only, and the
 *   invocation's meta row keeps its counts/ids shape. The prompt and the
 *   completion never reach audit, the meta row, the worker's log lines or the
 *   core console.
 *
 *   logs: {type:'log'} lines are printed to the CORE console (console.error)
 *   with redactString applied. Skill logs/args/results NEVER reach audit:
 *   each run records one skill_invocations meta row (ok/toolCalls/ms/error
 *   code) + one skill.invoke audit row (ids/version/counts only), whose ACTOR
 *   is who asked - `persona` when the run carries a `ctx.personaId` (a chat
 *   turn with that persona, or its schedule), `web` otherwise.
 *
 *   dry-run (M26 D5): `ctx.dirOverride` runs a bundle the core materialized
 *   somewhere else, `ctx.logSink` sends the same redacted lines to the author's
 *   run response instead of the console, and `ctx.record:false` keeps the run
 *   out of skill_invocations (a dry-run is not history). The audit row and the
 *   sandbox are unchanged - a dry-run is exactly the real launcher.
 */
import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactString } from '@partner/shared';
import type { SkillDetail, SkillInvocationMeta, ToolRisk } from '@partner/shared';
import type { ToolBroker } from '../broker/broker.js';
import type { SpendLedgerManager } from '../gateway/spend.js';
import { centsForTokens } from '../gateway/pricing.js';
import { capabilityDenial } from '../http/capabilities.js';
import type { AuditService } from '../services/redaction.js';
import type { SkillInvocationStore } from '../stores/types.js';
import {
  DEFAULT_SKILL_LLM_MAX_TOKENS,
  MAX_SKILL_LLM_PROMPT_BYTES,
  MAX_SKILL_LLM_REPLY_BYTES,
} from './llm.js';
import type { SkillLlmResolver, SkillLlmTarget, SkillLlmUsage } from './llm.js';
import { MAX_SKILL_TIME_MS } from './manifest.js';

const DEFAULT_BUDGET_MS = 30_000;
const DEFAULT_MAX_ARGS_BYTES = 64 * 1024;
const DEFAULT_MAX_RESULT_BYTES = 1024 * 1024;
const MAX_ERROR_CODE = 200;

/** Worker harness path. In dev/tsx, import.meta.url is real; in a bundled
 *  CJS artifact it is empty, so fall back to a cwd-relative path (packaged
 *  runs ship the harness next to the bundle). */
/** Worker harness path. Real URL in dev/tsx; in a bundled CJS artifact
 *  esbuild emits an empty object for import.meta, so fall back to a
 *  cwd-relative path (packaged runs ship the harness next to the bundle). */
const WORKER_PATH = (() => {
  const url = (import.meta as { url?: string }).url;
  if (typeof url === 'string' && url !== '') {
    return fileURLToPath(new URL('./worker-runner.mjs', url));
  }
  return join(process.cwd(), 'worker-runner.mjs');
})();

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
  /**
   * M27 S2 (PLAN-M27 D5-D8): the MCP seam a skill's
   * `partner.tools.exec('mcp:<server>/<tool>')` call is dispatched to, INSTEAD
   * of the broker. Absent means this core has no MCP reach for skills and every
   * `mcp:` id is refused `tool_denied` - the honest state of a build with no
   * MCP manager, and of a test double that does not care.
   *
   * Injected rather than imported so this file never depends on `mcp/`.
   */
  mcp?: SkillMcpReach;
  /**
   * M27 S5: resolve the model `partner.llm.complete` rides, ONCE per
   * invocation, or null when nothing usable is configured (`no_provider`).
   * ABSENT means this core has no model reach at all for skills, which is the
   * honest state of a test double or a build without providers - every
   * `llm.complete` then answers `no_provider`. Injected so a test drives the
   * whole reach with a fake ProviderClient and never touches the network.
   */
  llm?: SkillLlmResolver;
  /**
   * M27 S5 (PLAN-M27 D13): the cumulative per-provider spend ledger a model
   * call is charged to. Optional: without one the call is still bounded and
   * still audited, only the rolling provider window goes unrecorded.
   */
  spendLedger?: SpendLedgerManager;
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
  /**
   * M27 S3 (PLAN-M27 D7): the acting session's client class, read by the ROUTE
   * from `res.locals.session` (SessionInfo) - never from a request body, header
   * or query, so a caller cannot name its own class and make the envelope
   * decorative. The runner forwards it verbatim to every `broker.exec` it
   * mediates, which means the SAME capability envelope (`http/capabilities.ts`)
   * that guards `/v1/tools/exec` sits above the skill's own grants: a granted
   * `files.edit` on a project root does not walk a mobile session into a write
   * (mobile's envelope hands out `file.read` but not `file.write`).
   *
   * Absent (or not a string) means "an internal caller with no session" - a
   * persona, scheduled or playbook run - and keeps the DESKTOP envelope, exactly
   * as `ExecContext.clientClass` documents. That is the pre-M27 behaviour, so
   * those paths are unchanged. Any other value is passed through unchanged and
   * refused by the broker's fail-closed envelope rather than guessed at here.
   */
  clientClass?: string;
  /** Abort kills the worker ('aborted' outcome). */
  signal?: AbortSignal;
  /**
   * M26 D5: the CORE-OWNED bundle dir for a draft dry-run
   * (config.skillRunsDir). It is NEVER caller-supplied - the draft route
   * materializes the bundle and passes the dir it made, so a request can never
   * point the runner at an arbitrary directory. Absent = the installed store
   * dir (dataDir/<id>).
   */
  dirOverride?: string;
  /**
   * M26 D5: per-invocation redacted log sink (default: the core console). Only
   * the destination changes - the lines still go through redactString, so a
   * dry-run can show the author why a skill failed without ever printing a
   * secret.
   */
  logSink?: (line: string) => void;
  /**
   * M26 D5: false writes NO skill_invocations row - a dry-run is not history.
   * Default true keeps every installed-skill behaviour identical. The audit row
   * still happens, because a run is an auditable event either way.
   */
  record?: boolean;
}

/**
 * M27 S2 — the MCP reach contract the runner consumes (PLAN-M27 D5–D8).
 *
 * The implementation is `core/src/mcp/skillReach.ts` and the composition root
 * connects the two, so `skills/` never imports `mcp/` — the same shape
 * `search/tool.ts` uses for the chat tool pass. The seam owns EVERY access rule
 * for MCP-from-a-skill, so it takes the manifest facts it needs rather than
 * letting the runner re-derive them and drift.
 */
export interface SkillMcpRequest {
  /** The `mcp:<server>/<tool>` id the skill asked for. */
  toolId: string;
  args: Record<string, unknown>;
  /** `permissions.mcpServers` — the declaration that makes a server reachable. */
  declaredServers: readonly string[];
  /** The manifest's own risk tier; an MCP call needs >= medium (D6). */
  manifestRisk: ToolRisk;
  /**
   * The acting session's class, forwarded verbatim from the route (D7). Absent
   * means an internal caller with no session (persona/scheduled run), which
   * keeps the desktop envelope — see {@link SkillInvokeContext.clientClass}.
   */
  clientClass?: string;
}

/**
 * The closed set a skill MCP call may answer with (D8).
 *
 * `capability_denied` is the class envelope (the same code the broker answers,
 * so a client can tell "your device may not" apart from "the policy refused"),
 * `mcp_not_declared` is the manifest's fault, `mcp_disabled` means "that server
 * is not usable right now" — never configured in this core, or switched off —
 * because both are fixed by the same user act (configure it, then enable it),
 * `tool_denied` is the risk ceiling, and `upstream` is anything the server did.
 */
export type SkillMcpDenialCode =
  | 'capability_denied'
  | 'mcp_not_declared'
  | 'mcp_disabled'
  | 'tool_denied'
  | 'upstream';

export type SkillMcpOutcome =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: SkillMcpDenialCode };

export interface SkillMcpReach {
  /** True when this id is an MCP id at all, so the runner routes it here. */
  matches(toolId: string): boolean;
  /**
   * Apply every access rule and, when they all hold, make the call.
   *
   * Never throws: a failure is a CODE, because a thrown error would fail the
   * whole invocation instead of arriving at the skill as a refusal it can catch
   * and react to. No pending row is ever created — skills are non-interactive.
   */
  exec(request: SkillMcpRequest): Promise<SkillMcpOutcome>;
}

export interface SkillRunner {
  invoke(skill: SkillDetail, args: unknown, ctx?: SkillInvokeContext): Promise<SkillInvokeResult>;
}

const RISK_RANK: Record<ToolRisk, number> = { low: 0, medium: 1, high: 2 };

/**
 * The id shape a skill uses to reach an MCP server's tool. Duplicated from the
 * `mcp/` seam on purpose: this module must recognise the shape to ROUTE it,
 * and importing the seam's constant would be the `skills/` -> `mcp/` dependency
 * the seam exists to avoid. `mcpReach.test.ts` pins the two together.
 */
const MCP_TOOL_ID_RE = /^mcp:([^/]+)\/(.+)$/;

/**
 * The conservative byte/4 token estimate the chat route also falls back to
 * (M27 S5): a provider that reports NO usage event must not make a skill's
 * ceiling unbounded, so the call is settled with this instead. It is marked
 * `estimated` in the audit row, because a guess and a count are not the same
 * claim.
 */
function estimatedUsage(prompt: string, replyBytes: number): SkillLlmUsage {
  const promptTokens = Math.ceil(Buffer.byteLength(prompt, 'utf8') / 4);
  const completionTokens = Math.ceil(replyBytes / 4);
  return { promptTokens, completionTokens, totalTokens: Math.max(1, promptTokens + completionTokens) };
}

export function createSkillRunner(options: SkillRunnerOptions): SkillRunner {
  const { dataDir, broker, audit, invocations } = options;
  const resolveLlm = options.llm;
  const spendLedger = options.spendLedger;
  /**
   * M27 S2: the MCP seam, or a closed one. A build with no MCP manager wired
   * still ROUTES `mcp:` ids here (so the refusal is a coded one the skill can
   * catch, and so the broker never sees an id it has no manifest for) — the
   * blank reach simply denies every call.
   */
  const mcpReach: SkillMcpReach = options.mcp ?? {
    matches: (toolId: string) => MCP_TOOL_ID_RE.test(toolId),
    exec: async (): Promise<SkillMcpOutcome> => ({ ok: false, code: 'tool_denied' }),
  };
  const now = options.now ?? Date.now;
  const logSink = options.log ?? ((line: string) => console.error(line));
  const maxArgsBytes = options.maxArgsBytes ?? DEFAULT_MAX_ARGS_BYTES;
  const maxResultBytes = options.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;

  function budgetMsOf(skill: SkillDetail): number {
    const timeMs = skill.manifest.budget?.timeMs;
    const raw =
      typeof timeMs === 'number' && Number.isFinite(timeMs) && timeMs > 0
        ? timeMs
        : DEFAULT_BUDGET_MS;
    // Ceiling so a bad/edited manifest cannot hold a worker forever.
    return Math.min(raw, MAX_SKILL_TIME_MS);
  }

  /**
   * The model-token ceiling ONE invocation may spend (M27 S5, D11). The
   * manifest's own `budget.maxTokens` wins when declared; absent, the
   * DOCUMENTED default applies rather than "unbounded", and `permissionSummary`
   * states whichever number applies to the owner before they install. The
   * declared value is not clamped: it is the figure the owner consented to, and
   * `budget.timeMs` remains the outer bound on the whole run.
   */
  function llmTokenCeiling(skill: SkillDetail): number {
    const declared = skill.manifest.budget?.maxTokens;
    if (typeof declared === 'number' && Number.isFinite(declared) && declared > 0) {
      return Math.floor(declared);
    }
    return DEFAULT_SKILL_LLM_MAX_TOKENS;
  }

  /**
   * Record the meta row + audit for a settled (or pre-spawn-failed) run.
   * `persist: false` (M26 D5 dry-run) keeps the meta in the RESPONSE - the
   * caller still needs ok/toolCalls/ms for its own audit row - while writing no
   * skill_invocations row.
   */
  function record(
    skill: SkillDetail,
    startedAt: number,
    finishedAt: number,
    personaId: string | null,
    toolCalls: number,
    outcome: { ok: true } | { ok: false; error: string },
    persist = true,
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
    if (persist) {
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
    }
    // Audit: ids/version/counts ONLY — never skill logs, args or results.
    const details: Record<string, unknown> = {
      version: skill.version,
      ok: meta.ok,
      toolCalls: meta.toolCalls,
      ms: meta.ms,
    };
    if (personaId !== null) details.personaId = personaId;
    if (error !== null) details.error = error;
    // `actor` is WHO ASKED, and the skill is the SUBJECT of the row (its id is
    // the target). A persona-driven or scheduled run has a `personaId`, so it is
    // a persona's ask; every other run reached the runner from a web session, so
    // that keeps the value it always had (services/redaction.ts: session / web /
    // persona / skill — `skill` is the actor of what a skill does ITSELF, e.g.
    // `skill.llm`).
    audit.log(personaId !== null ? 'persona' : 'web', 'skill.invoke', skill.id, details);
    return meta;
  }

  async function invoke(
    skill: SkillDetail,
    rawArgs: unknown,
    ctx: SkillInvokeContext = {},
  ): Promise<SkillInvokeResult> {
    const startedAt = now();
    const personaId = typeof ctx.personaId === 'string' && ctx.personaId.trim() !== '' ? ctx.personaId.trim() : null;
    // M27 S3: forwarded as-is. undefined keeps the desktop envelope (the
    // internal/session-less caller); anything else - including a typo'd class -
    // is the broker's fail-closed decision, not the runner's.
    const { clientClass } = ctx;
    // M26 D5 knobs: a dry-run redirects the log lines and keeps no history.
    const sink = ctx.logSink ?? logSink;
    const persist = ctx.record !== false;

    // Args JSON cap — pre-spawn (a giant/cyclic payload never reaches a worker).
    let argsText = '';
    try {
      argsText = JSON.stringify(rawArgs === undefined ? {} : rawArgs);
    } catch {
      const finished = now();
      const meta = record(
        skill,
        startedAt,
        finished,
        personaId,
        0,
        { ok: false, error: 'caps_exceeded' },
        persist,
      );
      return { ok: false, error: 'caps_exceeded', meta };
    }
    if (argsText === undefined || Buffer.byteLength(argsText, 'utf8') > maxArgsBytes) {
      const finished = now();
      const meta = record(
        skill,
        startedAt,
        finished,
        personaId,
        0,
        { ok: false, error: 'caps_exceeded' },
        persist,
      );
      return { ok: false, error: 'caps_exceeded', meta };
    }

    const budgetMs = budgetMsOf(skill);
    const tokenCeiling = llmTokenCeiling(skill);
    const workerPath = WORKER_PATH;
    // The override wins when the caller (the draft route) materialized the
    // bundle elsewhere - the store dir is only the installed-skill default.
    const skillDir =
      typeof ctx.dirOverride === 'string' && ctx.dirOverride !== ''
        ? ctx.dirOverride
        : join(dataDir, skill.id);
    mkdirSync(skillDir, { recursive: true });

    // Integrity pre-check (M8 review finding 5): refuse to run code whose
    // entry no longer matches the hash recorded at install. Skills without a
    // recorded baseline (inline test doubles) skip the check.
    if (skill.sha256 !== undefined && skill.sha256 !== '') {
      try {
        const entryAbs = join(skillDir, skill.manifest.entrypoint);
        const digest = createHash('sha256').update(readFileSync(entryAbs)).digest('hex');
        if (digest !== skill.sha256) {
          const meta = record(
            skill,
            startedAt,
            now(),
            personaId,
            0,
            { ok: false, error: 'integrity' },
            persist,
          );
          return { ok: false, error: 'integrity', meta };
        }
      } catch {
        const meta = record(
          skill,
          startedAt,
          now(),
          personaId,
          0,
          { ok: false, error: 'integrity' },
          persist,
        );
        return { ok: false, error: 'integrity', meta };
      }
    }

    const child: ChildProcess = fork(workerPath, [], {
      // Minimal env on purpose: the skill never inherits the core's
      // environment (keys/PATH) — only its own three knobs. On Windows,
      // child_process merges parent variables (PATH among them) into any
      // env that omits them, so pin PATH to empty there — the worker boots
      // via process.execPath and never needs the parent's PATH, and a skill
      // cannot reach host tooling through it.
      env: {
        PARTNER_SKILL_DIR: skillDir,
        PARTNER_SKILL_ENTRY: skill.manifest.entrypoint,
        PARTNER_SKILL_MAX_RESULT_BYTES: String(maxResultBytes),
        ...(process.platform === 'win32' ? { PATH: '' } : {}),
      },
      // Run from INSIDE the store dir so bare-specifier resolution cannot
      // walk up into the repo's node_modules (M8 review finding 2 — belt).
      cwd: skillDir,
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
        const meta = record(skill, startedAt, finishedAt, personaId, toolCalls, outcome, persist);
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
        // --- M27 S2: MCP reach ----------------------------------------------
        // An `mcp:<server>/<tool>` id is NOT a broker tool: it is declared in
        // `permissions.mcpServers` (not `permissions.tools`) and it is executed
        // through the MCP seam instead of the broker. Routed BEFORE the
        // declared-tools check below, which would otherwise refuse every MCP id
        // — no manifest lists `mcp:...` in `permissions.tools`.
        if (mcpReach.matches(toolId)) {
          const rawArgs = params;
          const args =
            typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
              ? (rawArgs as Record<string, unknown>)
              : {};
          void mcpReach
            .exec({
              toolId,
              args,
              declaredServers: skill.manifest.permissions.mcpServers ?? [],
              manifestRisk: skill.manifest.permissions.risk,
              ...(clientClass === undefined ? {} : { clientClass }),
            })
            .then((outcome) => {
              if (outcome.ok) {
                try {
                  child.send({ type: 'tools.result', nonce, ok: true, result: outcome.result });
                } catch {
                  // Channel gone.
                }
                return;
              }
              deny(outcome.code);
            })
            // The seam promises not to throw; this is the belt for that brace,
            // because an unhandled rejection would hang the worker instead of
            // answering it.
            .catch(() => deny('upstream'));
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
        const response = broker.exec(toolId, params, { requestedBy: 'skill', clientClass });
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

      // --- M27 S5: model reach ---------------------------------------------

      /** Reply to one `llm.complete` (the answer the worker resolves on). */
      const llmAnswer = (nonce: string, payload: Record<string, unknown>): void => {
        try {
          child.send({ type: 'llm.result', nonce, ...payload });
        } catch {
          // Channel gone (worker already killed).
        }
      };

      // Tokens charged across EVERY call in this invocation: the ceiling is a
      // per-INVOCATION bound, so a loop of small calls cannot slip past it.
      let llmTokens = 0;
      // The target is resolved once per invocation (as the chat path resolves
      // its provider once per turn) and cached, including a null answer, so a
      // provider that cannot serve is not re-resolved on every call.
      let llmTargetPromise: Promise<SkillLlmTarget | null> | null = null;
      const llmTarget = async (): Promise<SkillLlmTarget | null> => {
        if (resolveLlm === undefined) return null;
        if (llmTargetPromise === null) {
          llmTargetPromise = Promise.resolve()
            .then(() => resolveLlm())
            .then((target) =>
              target !== null &&
              target !== undefined &&
              typeof target.model === 'string' &&
              target.model !== ''
                ? target
                : null,
            )
            .catch(() => null);
        }
        return llmTargetPromise;
      };

      /**
       * ONE model call. Accounting is the provider's own `usage` event, with
       * the conservative byte/4 estimate the chat route also falls back to when
       * a stream reports none - so a silent provider cannot make the ceiling
       * unbounded. Every accounted call writes one `skill.llm` audit row and
       * charges the provider's rolling spend window (D13); counts and the model
       * id only, never the prompt or the completion.
       */
      const completeLlm = async (
        nonce: string,
        prompt: string,
        callCeiling: number,
      ): Promise<void> => {
        const target = await llmTarget();
        if (done) return;
        if (target === null) {
          // Nothing usable configured: the same answer the chat path gives.
          llmAnswer(nonce, { ok: false, error: 'no_provider' });
          return;
        }
        const callStartedAt = now();
        const controller = new AbortController();
        const parts: string[] = [];
        let replyBytes = 0;
        let reported: SkillLlmUsage | null = null;

        /** Accumulate + trace + charge one call; true when the ceiling broke. */
        const account = (counts: SkillLlmUsage, estimated: boolean): boolean => {
          llmTokens += Math.max(0, counts.totalTokens);
          const providerId = target.providerId;
          const cents =
            spendLedger !== undefined && providerId !== undefined
              ? centsForTokens(target.model, counts.totalTokens)
              : 0;
          if (spendLedger !== undefined && providerId !== undefined && cents > 0) {
            try {
              spendLedger.charge({ providerId, cents });
            } catch {
              // A ledger write must never break a skill run.
            }
          }
          // Counts + model id + ms ONLY (PLAN-M27 D13, brief rule 5).
          audit.log('skill', 'skill.llm', `${skill.id}/${target.model}`, {
            skillId: skill.id,
            model: target.model,
            promptTokens: counts.promptTokens,
            completionTokens: counts.completionTokens,
            totalTokens: counts.totalTokens,
            ms: Math.max(0, now() - callStartedAt),
            ...(estimated ? { estimated: true } : {}),
            ...(cents > 0 ? { cents } : {}),
            ...(personaId !== null ? { personaId } : {}),
          });
          return llmTokens > tokenCeiling || counts.totalTokens > callCeiling;
        };

        try {
          for await (const event of target.client.chatStream({
            model: target.model,
            messages: [{ role: 'user', content: prompt }],
            signal: controller.signal,
          })) {
            if (done) {
              controller.abort();
              return;
            }
            if (event.type === 'delta') {
              replyBytes += Buffer.byteLength(event.text, 'utf8');
              if (replyBytes > MAX_SKILL_LLM_REPLY_BYTES) {
                // A runaway reply is a bounded resource, not a partial answer -
                // and unlike an oversized PROMPT (a refusal the skill can act
                // on) it is fatal: the provider has already spent this call.
                controller.abort();
                fail('caps_exceeded');
                return;
              }
              parts.push(event.text);
              continue;
            }
            if (event.type === 'usage') {
              // One usage event per turn is the ChatEvent contract: a re-emitted
              // one must not charge the same call twice.
              if (reported === null) {
                reported = {
                  promptTokens: event.promptTokens,
                  completionTokens: event.completionTokens,
                  totalTokens: event.totalTokens,
                };
                if (account(reported, false)) {
                  // Past the ceiling: abort the call and fail the INVOCATION -
                  // a partial success here would be spend with no bound.
                  controller.abort();
                  fail('budget_exceeded');
                  return;
                }
              }
              continue;
            }
            if (event.type === 'error') {
              llmAnswer(nonce, { ok: false, error: 'upstream' });
              return;
            }
          }
        } catch {
          if (!done) llmAnswer(nonce, { ok: false, error: 'upstream' });
          return;
        }
        if (done) return;

        const counted: SkillLlmUsage =
          reported ?? estimatedUsage(prompt, replyBytes);
        if (reported === null && account(counted, true)) {
          fail('budget_exceeded');
          return;
        }
        llmAnswer(nonce, { ok: true, text: parts.join(''), usage: counted });
      };

      /**
       * Answer ONE `llm.complete` request. The gate ORDER is the decision order
       * (PLAN-M27 D11/D12): the DECLARATION first (a skill that never asked for
       * model reach cannot reach a provider at all), then the session CLASS (a
       * phone does not get model reach THROUGH a skill), then the request
       * SHAPE, then the provider, then the ceiling. Every gate but the ceiling
       * is a refusal the skill catches (the `tools.exec` shape); the ceiling is
       * fatal to the invocation.
       */
      const replyLlm = (message: {
        prompt?: unknown;
        maxTokens?: unknown;
        nonce?: unknown;
      }): void => {
        const nonce = typeof message.nonce === 'string' ? message.nonce : '';
        const refuse = (code: string): void => llmAnswer(nonce, { ok: false, error: code });
        if (nonce === '') {
          // Unanswerable - the worker drops a mismatch anyway.
          refuse('bad_params');
          return;
        }
        if (skill.manifest.permissions.llm !== true) {
          // Absent and false mean the same thing: no model access at all.
          refuse('llm_not_declared');
          return;
        }
        if (capabilityDenial(clientClass ?? 'desktop', 'skill.llm') !== null) {
          refuse('capability_denied');
          return;
        }
        const prompt = message.prompt;
        if (typeof prompt !== 'string' || prompt.trim() === '') {
          refuse('bad_params');
          return;
        }
        if (Buffer.byteLength(prompt, 'utf8') > MAX_SKILL_LLM_PROMPT_BYTES) {
          refuse('caps_exceeded');
          return;
        }
        const requestedMax = typeof message.maxTokens === 'number' ? message.maxTokens : undefined;
        if (
          message.maxTokens !== undefined &&
          (requestedMax === undefined || !Number.isFinite(requestedMax) || requestedMax <= 0)
        ) {
          refuse('bad_params');
          return;
        }
        // A per-call request can only TIGHTEN the invocation's ceiling.
        const callCeiling =
          requestedMax === undefined ? tokenCeiling : Math.min(tokenCeiling, Math.floor(requestedMax));
        void completeLlm(nonce, prompt, callCeiling);
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
          prompt?: unknown;
          maxTokens?: unknown;
          ok?: unknown;
          text?: unknown;
          error?: unknown;
        };
        if (msg.type === 'log') {
          const line = redactString(String(msg.line ?? ''));
          sink(`[skill ${skill.id}] ${line}`);
          return;
        }
        if (msg.type === 'tools.exec') {
          toolCalls += 1;
          replyTool(msg);
          return;
        }
        if (msg.type === 'llm.complete') {
          // Deliberately NOT counted as a tool call: `toolCalls` (the meta row
          // and the skill_invocations column) keeps its M8 meaning - brokered
          // TOOL calls - and the model call is traced by its own audit row.
          replyLlm(msg);
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
            // A result in flight when the budget/abort fired must NOT count
            // as success (M8 review finding 3).
            if (budgetKilled) {
              fail('budget_exceeded');
              return;
            }
            if (aborted) {
              fail('aborted');
              return;
            }
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
