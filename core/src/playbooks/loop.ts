/**
 * M9 persona tool loop engine (PLAN-M9.md).
 *
 * A persona reply may contain a [[partner:tool …]] directive (see
 * directives.ts). The loop:
 *
 *   1. calls the persona's resolved provider (chatStream; delta/done events
 *      pass through to the SSE surface untouched),
 *   2. when the reply carries a directive, authorizes it via the persona's
 *      independence level (gate.ts) and the broker:
 *        - executed   → tool result summarized (content excerpts capped) and
 *                       fed back as a system message; loop continues,
 *        - queued     → approval row tagged requestedBy 'persona'; the loop
 *                       STOPS and the run waits on the pendingId,
 *        - refused    → system note appended; loop continues,
 *   3. bounded at {@link LOOP_MAX_ROUNDS} model rounds total — more →
 *      loop_exhausted.
 *
 * Demo/no-provider fallback is NOT allowed for tool loops: a resolver that
 * returns no usable target yields a no_provider result (the caller 501s).
 *
 * Approvals execute through the M2 broker (broker.decide runs the queued
 * tool ONCE with its stored params — PLAN-M2 semantics). resume(runId,
 * pendingId) re-enters a stopped run with the decision outcome appended and
 * streams the remaining events.
 *
 * Every tool decision is audited as action `playbook.tool` with personaId/
 * playbookId/toolId/decision only — params/results never cross audit; fed-back
 * content is owner data in the conversation (UI) only.
 */
import { randomUUID } from 'node:crypto';
import type {
  ChatEvent,
  ChatMessage,
  ChatRequest,
  Persona,
  PersonaToolDirective,
  ProviderClient,
  TaskClass,
} from '@partner/shared';
import type { ToolManifest } from '@partner/shared/tools.js';
import type { ToolBroker } from '../broker/broker.js';
import type { AuditService } from '../services/redaction.js';
import { authorizeTool } from './gate.js';
import { lastDirective } from './directives.js';

export const LOOP_MAX_ROUNDS = 4;
/** files.read (and other content-bearing) results fed back capped here. */
export const TOOL_RESULT_EXCERPT_CHARS = 2000;
/** Total cap of the fed-back system message (4 rounds worst case). */
export const TOOL_RESULT_MESSAGE_CAP = 4000;

/** A resolved chat target the loop may call (REQUIRED — no demo fallback). */
export interface PlaybookChatTarget {
  client: ProviderClient;
  model: string;
}

/**
 * Resolves a persona's chat target (provider client + model). The engine
 * requires a non-null target for a tool loop — null means no_provider.
 */
export type LoopProviderResolver = (
  persona: Persona,
) => PlaybookChatTarget | null | Promise<PlaybookChatTarget | null>;

/** SSE-visible loop events: provider ChatEvents pass through unchanged. */
export type LoopEvent =
  | { type: 'loop_step'; round: number }
  | {
      type: 'persona_tool';
      toolId: string;
      decision: 'executed' | 'queued' | 'refused';
      pendingId?: string;
      reason?: string;
    }
  | ChatEvent;

export type LoopStatus =
  | 'done'
  | 'queued'
  | 'loop_exhausted'
  | 'no_provider'
  | 'not_decided'
  | 'error';

export interface ToolLoopResult {
  runId: string;
  status: LoopStatus;
  /** Final directive-free reply (done) or last text (loop_exhausted). */
  text: string;
  model: string | null;
  /** Model rounds consumed (bounded at maxRounds). */
  rounds: number;
  /** Broker tools executed (direct + approval-executed on resume). */
  toolCalls: number;
  /** Set when status === 'queued': the run waits on this approval. */
  pendingId?: string;
  /** Coded message for error/not_decided statuses. */
  error?: string;
}

export interface ToolLoopRunRequest {
  /** Unique run id (the playbook_runs row id when persisted). */
  runId: string;
  persona: Persona;
  /** Starting messages: persona system prompt + user turn already composed. */
  messages: ChatMessage[];
  taskClass?: TaskClass;
  /** Playbook's allowed tool ids (level-gate envelope). */
  allowedTools?: readonly string[];
  /** Playbook id (audit + result only — never content). */
  playbookId?: string;
  maxRounds?: number;
  /** Pre-resolved target (the caller preflighted provider); when absent the
   *  resolver is called — null there still means no_provider. */
  target?: PlaybookChatTarget;
}

export interface ToolLoopDeps {
  broker: ToolBroker;
  resolver: LoopProviderResolver;
  audit: AuditService;
  now?: () => number;
}

interface RunMemory {
  runId: string;
  persona: Persona;
  playbookId?: string;
  messages: ChatMessage[];
  taskClass?: TaskClass;
  allowedTools?: readonly string[];
  maxRounds: number;
  target: PlaybookChatTarget;
  round: number;
  toolCalls: number;
  model: string | null;
  finalText: string;
  waitingOn?: { pendingId: string; toolId: string };
}

export interface ToolLoop {
  /** Run one bounded loop. Resolves the provider first (no_provider when
   *  none); yields events; the generator's return value is the result. */
  run(req: ToolLoopRunRequest): AsyncGenerator<LoopEvent, ToolLoopResult, unknown>;
  /**
   * Continue a run that stopped queued. The approval/denial was already
   * decided through broker.decide (M2 semantics) — this only re-enters the
   * loop with the decision appended. Unknown run -> error not_found; run not
   * waiting on this pendingId -> error not_pending; queue row still open ->
   * not_decided.
   */
  resume(runId: string, pendingId: string): AsyncGenerator<LoopEvent, ToolLoopResult, unknown>;
  /** Drop in-memory run state (done/error runs are dropped automatically). */
  drop(runId: string): void;
  /** True while the engine still holds state (e.g. queued runs). */
  has(runId: string): boolean;
  /**
   * Persona identity of the queued run waiting on an approval row, or null.
   * Lets the tools/pending surface tag a persona-requested row with the
   * persona's display name (PLAN-M9 "Builder · files.read").
   */
  waitingPersona(pendingId: string): { id: string; name: string } | null;
}

const DIRECTIVE_MARKER = '[[partner:tool';

function auditToolDecision(
  audit: AuditService,
  state: Pick<RunMemory, 'persona' | 'playbookId'>,
  toolId: string,
  details: Record<string, unknown>,
): void {
  audit.log('persona', 'playbook.tool', toolId, {
    personaId: state.persona.id,
    ...(state.playbookId !== undefined ? { playbookId: state.playbookId } : {}),
    ...details,
  });
}

/**
 * Redaction-safe summary of a broker tool result for the model: content-like
 * strings are capped to short excerpts with their total length, arrays become
 * item counts, nested objects become shallow scalar summaries. Any embedded
 * directive marker is neutralized so fed-back content can never look like a
 * live directive on the next round.
 */
export function summarizeToolResult(
  result: Record<string, unknown>,
  cap = TOOL_RESULT_EXCERPT_CHARS,
): string {
  const lines: string[] = [];
  const pushScalar = (prefix: string, value: unknown): void => {
    if (typeof value === 'string') {
      const safe = value.replaceAll(DIRECTIVE_MARKER, 'partner:tool');
      lines.push(
        safe.length > cap
          ? `${prefix}: ${safe.slice(0, cap)}… (${safe.length} chars total)`
          : `${prefix}: ${safe}`,
      );
    } else if (
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null ||
      value === undefined
    ) {
      lines.push(`${prefix}: ${String(value)}`);
    }
  };
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.length} items]`);
    } else if (value !== null && typeof value === 'object') {
      const inner: string[] = [];
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (typeof v === 'string') {
          const safe = v.replaceAll(DIRECTIVE_MARKER, 'partner:tool');
          inner.push(
            safe.length > cap
              ? `${k}: ${safe.slice(0, cap)}… (${safe.length} chars)`
              : `${k}: ${safe}`,
          );
        } else if (
          typeof v === 'number' ||
          typeof v === 'boolean' ||
          v === null ||
          v === undefined
        ) {
          inner.push(`${k}: ${String(v)}`);
        } else if (Array.isArray(v)) {
          inner.push(`${k}: [${v.length} items]`);
        }
      }
      lines.push(`${key}: { ${inner.join('; ')} }`);
    } else {
      pushScalar(key, value);
    }
  }
  const text = lines.join('\n');
  return text.length > TOOL_RESULT_MESSAGE_CAP
    ? `${text.slice(0, TOOL_RESULT_MESSAGE_CAP)}… (${text.length} chars total)`
    : text;
}

function resultFor(state: RunMemory, extra: Partial<ToolLoopResult> = {}): ToolLoopResult {
  return {
    runId: state.runId,
    status: 'done',
    text: state.finalText,
    model: state.model,
    rounds: state.round,
    toolCalls: state.toolCalls,
    ...extra,
  };
}

function appendSystemNote(state: RunMemory, content: string): void {
  state.messages.push({ role: 'system', content });
}

export function createToolLoop(deps: ToolLoopDeps): ToolLoop {
  const { broker, resolver, audit } = deps;
  const now = deps.now ?? Date.now;
  const states = new Map<string, RunMemory>();
  const manifestById = new Map<string, ToolManifest>(broker.manifests.map((m) => [m.id, m]));

  async function* drive(state: RunMemory): AsyncGenerator<LoopEvent, ToolLoopResult, unknown> {
    for (;;) {
      if (state.round >= state.maxRounds) {
        return resultFor(state, { status: 'loop_exhausted', error: 'loop_exhausted' });
      }
      const roundOutcome = yield* runRound(state);
      if (roundOutcome === 'done') return resultFor(state, { status: 'done' });
      if (roundOutcome === 'failed') {
        return resultFor(state, { status: 'error', error: 'provider_stream_failed' });
      }
      if (roundOutcome === 'queued') {
        return resultFor(state, {
          status: 'queued',
          pendingId: state.waitingOn?.pendingId,
        });
      }
      // 'continue' — a tool was handled; loop again (bound checked above).
    }
  }

  /** One model round: stream a reply; on a directive authorize + run the
   *  tool. Returns 'done' | 'failed' | 'queued' | 'continue'. */
  async function* runRound(
    state: RunMemory,
  ): AsyncGenerator<LoopEvent, 'done' | 'failed' | 'queued' | 'continue', unknown> {
    state.round += 1;
    yield { type: 'loop_step', round: state.round };

    const request: ChatRequest = {
      model: state.target.model,
      messages: state.messages,
      stream: true,
    };
    let text = '';
    let failed = false;
    try {
      for await (const event of state.target.client.chatStream(request)) {
        if (event.type === 'error') {
          failed = true;
          yield event;
          break;
        }
        if (event.type === 'delta') text += event.text;
        if (event.type === 'done') state.model = event.model;
        yield event;
      }
    } catch {
      failed = true;
      yield { type: 'error', message: 'provider_stream_failed' };
    }
    if (failed) return 'failed';
    state.messages.push({ role: 'assistant', content: text });

    const directive = lastDirective(text);
    if (directive === null) {
      state.finalText = text;
      return 'done';
    }
    return yield* authorizeAndRunTool(state, directive);
  }

  /** Gate + broker one directive (events yielded as they resolve). */
  async function* authorizeAndRunTool(
    state: RunMemory,
    directive: PersonaToolDirective,
  ): AsyncGenerator<LoopEvent, 'done' | 'failed' | 'queued' | 'continue', unknown> {
    const toolId = directive.toolId;
    const manifest = manifestById.get(toolId);
    if (manifest === undefined) {
      auditToolDecision(audit, state, toolId, {
        decision: 'refused',
        reason: 'unknown_tool',
        round: state.round,
      });
      yield { type: 'persona_tool', toolId, decision: 'refused', reason: 'unknown_tool' };
      appendSystemNote(state, `The tool "${toolId}" is not available — continue without it.`);
      return 'continue';
    }

    const args = directive.args ?? {};
    const projectId = typeof args.projectId === 'string' ? args.projectId : '';
    const hasGrant = projectId !== '' ? broker.grants.hasGrant(toolId, projectId, now()) : false;

    const gate = authorizeTool(state.persona.independence.level, manifest, {
      toolId,
      declaredTools: state.allowedTools,
      autoScopes: state.persona.independence.autoScopes,
      hasGrant,
    });

    if (gate.decision === 'refused') {
      auditToolDecision(audit, state, toolId, {
        decision: 'refused',
        reason: gate.reason,
        round: state.round,
      });
      yield { type: 'persona_tool', toolId, decision: 'refused', reason: gate.reason };
      appendSystemNote(
        state,
        `The tool "${toolId}" was refused (${gate.reason}) — continue without it.`,
      );
      return 'continue';
    }

    if (gate.decision === 'queued') {
      // Queue a human approval (requestedBy persona) and STOP the loop.
      if (projectId === '') {
        auditToolDecision(audit, state, toolId, {
          decision: 'refused',
          reason: 'missing_project',
          round: state.round,
        });
        yield {
          type: 'persona_tool',
          toolId,
          decision: 'refused',
          reason: 'missing_project',
        };
        appendSystemNote(
          state,
          `The tool "${toolId}" needs a projectId argument — continue without it.`,
        );
        return 'continue';
      }
      const pendingId = broker.pending.enqueue({
        toolId,
        projectId,
        params: args,
        risk: manifest.risk,
        requestedBy: 'persona',
      });
      state.waitingOn = { pendingId, toolId };
      auditToolDecision(audit, state, toolId, {
        decision: 'queued',
        pendingId,
        risk: manifest.risk,
        reason: gate.reason,
        round: state.round,
      });
      yield { type: 'persona_tool', toolId, decision: 'queued', pendingId };
      return 'queued';
    }

    // gate: executed — the broker runs it (a user grant was present at gate
    // time; one revoked mid-flight surfaces as needs_approval -> queued).
    const response = broker.exec(toolId, args, { requestedBy: 'persona' });
    if (response.outcome === 'executed') {
      state.toolCalls += 1;
      auditToolDecision(audit, state, toolId, {
        decision: 'executed',
        risk: manifest.risk,
        round: state.round,
      });
      yield { type: 'persona_tool', toolId, decision: 'executed' };
      const summary = summarizeToolResult(response.result ?? {});
      appendSystemNote(
        state,
        `[tool ${toolId} result]\n${summary}\n[end tool ${toolId} result]`,
      );
      return 'continue';
    }
    if (response.outcome === 'needs_approval') {
      const pendingId = response.pendingId;
      state.waitingOn = { pendingId, toolId };
      auditToolDecision(audit, state, toolId, {
        decision: 'queued',
        pendingId,
        risk: manifest.risk,
        reason: 'grant_revoked_mid_flight',
        round: state.round,
      });
      yield { type: 'persona_tool', toolId, decision: 'queued', pendingId };
      return 'queued';
    }
    // denied (unknown_project/bad_params/...): note + continue.
    auditToolDecision(audit, state, toolId, {
      decision: 'refused',
      reason: response.reason,
      round: state.round,
    });
    yield { type: 'persona_tool', toolId, decision: 'refused', reason: response.reason };
    appendSystemNote(
      state,
      `The tool "${toolId}" could not run (${response.reason}) — continue without it.`,
    );
    return 'continue';
  }

  async function* run(req: ToolLoopRunRequest): AsyncGenerator<LoopEvent, ToolLoopResult, unknown> {
    const runId = typeof req.runId === 'string' && req.runId !== '' ? req.runId : randomUUID();
    if (states.has(runId)) {
      return {
        runId,
        status: 'error',
        text: '',
        model: null,
        rounds: 0,
        toolCalls: 0,
        error: 'run_exists',
      };
    }
    const target =
      req.target !== undefined && req.target !== null
        ? req.target
        : await resolver(req.persona);
    if (target === null || target === undefined) {
      return {
        runId,
        status: 'no_provider',
        text: '',
        model: null,
        rounds: 0,
        toolCalls: 0,
        error: 'no_provider',
      };
    }
    const state: RunMemory = {
      runId,
      persona: req.persona,
      playbookId: req.playbookId,
      messages: Array.isArray(req.messages) ? [...req.messages] : [],
      taskClass: req.taskClass,
      allowedTools: req.allowedTools,
      maxRounds: req.maxRounds ?? LOOP_MAX_ROUNDS,
      target,
      round: 0,
      toolCalls: 0,
      model: null,
      finalText: '',
    };
    states.set(runId, state);
    try {
      const outcome = yield* drive(state);
      if (outcome.status !== 'queued') states.delete(runId);
      return outcome;
    } catch {
      states.delete(runId);
      return resultFor(state, { status: 'error', error: 'loop_crashed' });
    }
  }

  async function* resume(
    runId: string,
    pendingId: string,
  ): AsyncGenerator<LoopEvent, ToolLoopResult, unknown> {
    const state = states.get(runId);
    if (state === undefined) {
      return {
        runId,
        status: 'error',
        text: '',
        model: null,
        rounds: 0,
        toolCalls: 0,
        error: 'not_found',
      };
    }
    if (state.waitingOn === undefined || state.waitingOn.pendingId !== pendingId) {
      return resultFor(state, { status: 'error', error: 'not_pending' });
    }
    const row = broker.pending.get(pendingId);
    if (row === undefined) {
      return resultFor(state, { status: 'error', error: 'not_found' });
    }
    if (row.decidedAt === null) {
      return resultFor(state, { status: 'not_decided', error: 'not_decided', pendingId });
    }
    const toolId = row.toolId;
    state.waitingOn = undefined;
    if (row.decision === 'approve') {
      // The approval already executed the tool once via broker.decide (M2).
      state.toolCalls += 1;
      auditToolDecision(audit, state, toolId, {
        decision: 'executed',
        reason: 'approved_via_queue',
      });
      yield { type: 'persona_tool', toolId, decision: 'executed' };
      appendSystemNote(
        state,
        `[tool ${toolId}] was approved by the user and executed. Continue your work.`,
      );
    } else {
      auditToolDecision(audit, state, toolId, {
        decision: 'refused',
        reason: 'user_denied',
      });
      yield { type: 'persona_tool', toolId, decision: 'refused', reason: 'user_denied' };
      appendSystemNote(
        state,
        `[tool ${toolId}] was denied by the user — do not retry it; continue with what you have.`,
      );
    }
    try {
      const outcome = yield* drive(state);
      if (outcome.status !== 'queued') states.delete(runId);
      return outcome;
    } catch {
      states.delete(runId);
      return resultFor(state, { status: 'error', error: 'loop_crashed' });
    }
  }

  return {
    run,
    resume,
    drop(runId: string): void {
      states.delete(runId);
    },
    has(runId: string): boolean {
      return states.has(runId);
    },
    waitingPersona(pendingId: string): { id: string; name: string } | null {
      for (const state of states.values()) {
        if (state.waitingOn !== undefined && state.waitingOn.pendingId === pendingId) {
          return { id: state.persona.id, name: state.persona.name };
        }
      }
      return null;
    },
  };
}
