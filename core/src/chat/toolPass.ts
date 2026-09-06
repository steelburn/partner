/**
 * M11 F2 chat-directive tool pass (PLAN-M11.md — F2 slice 1).
 *
 * Plain-chat tool execution: when a persona reply carries `[[partner:tool
 * id {…}]]` directives, this pass authorizes each one with the SAME gate as
 * the M9 playbook loop (independence level + persona policy bans) and then
 * routes it through the broker:
 *
 *   - gate refused            -> system note "refused (<reason>)", continue
 *   - gate queued             -> broker.pending.enqueue(requestedBy persona),
 *                                system note "awaiting your approval" with
 *                                the pending id
 *   - broker executed         -> result summary appended as a system note
 *   - needs_approval / denied -> pending note / refusal note
 *
 * Unlike the playbook loop there is NO auto-continuation model round: the
 * outcome notes are persisted as system messages, so the NEXT user turn's
 * history carries them (honest, minimal, stream-safe). MCP + native
 * function_calls + search backends are later F2 slices.
 */
import type {
  Persona,
  PersonaToolDirective,
  ToolExecResponse,
} from '@partner/shared';
import type { ToolManifest, ToolRisk } from '@partner/shared/tools.js';
import { parseReplyTools } from '../playbooks/directives.js';
import { authorizeTool } from '../playbooks/gate.js';
import { summarizeToolResult } from '../playbooks/loop.js';
import type { AuditService } from '../services/redaction.js';

/** The broker surface the pass needs (structural — easy to fake in tests). */
export interface ChatToolBrokerLike {
  manifests: ReadonlyArray<ToolManifest>;
  grants: { hasGrant(toolId: string, projectId: string, at: number): boolean };
  exec(
    toolId: string,
    params: Record<string, unknown>,
    opts: { requestedBy: 'persona' },
  ): ToolExecResponse;
  pending?: {
    enqueue(input: {
      toolId: string;
      projectId: string;
      params: Record<string, unknown>;
      risk: ToolRisk;
      requestedBy: 'persona';
      /** M12 external approvals: conversation + persona behind the ask. */
      conversationId?: string | null;
      personaId?: string | null;
    }): string;
  };
}

export interface ChatToolPassDeps {
  persona: Persona;
  broker: ChatToolBrokerLike;
  /** Conversation the outcome notes land in (persisted persona chat). */
  conversationId?: string | null;
  /**
   * M11 F2/F2-MCP external tools (network search, MCP servers…): each entry
   * contributes manifests, an allow() gate (default-deny) and an exec() that
   * may be async. A tool id may also be resolved dynamically via `match`
   * (used by MCP, whose tool ids only exist per server at run time). Only
   * EXTERNAL tools ever dispatch here — broker tools always stay on
   * broker.exec.
   */
  external?: ReadonlyArray<{
    manifests: ReadonlyArray<ToolManifest>;
    allow(toolId: string): boolean;
    exec(toolId: string, args: Record<string, unknown>): Promise<ToolExecResponse> | ToolExecResponse;
    /** Dynamic resolution for ids not in `manifests` (e.g. mcp:<server>/<t>). */
    match?(toolId: string): ToolManifest | undefined;
  }>;
  audit: AuditService;
  /** Persist a system note into the conversation transcript (no-op guard). */
  appendSystemNote: (content: string) => void;
  now?: () => number;
}

export type ChatToolDecision =
  | { toolId: string; decision: 'executed' }
  | { toolId: string; decision: 'queued'; pendingId: string }
  | { toolId: string; decision: 'refused'; reason: string };

export interface ChatToolPassResult {
  decisions: ChatToolDecision[];
}

/** Run every directive in the assistant reply text through gate + broker. */
export async function runChatToolPass(
  text: string,
  deps: ChatToolPassDeps,
): Promise<ChatToolPassResult> {
  return runToolDirectives(
    parseReplyTools(text).map((directive) => ({
      toolId: directive.toolId,
      args: directive.args,
    })),
    deps,
  );
}

/**
 * M11 F2 native function calls: authorize + broker each aggregated tool call
 * the model made. Same gate/broker semantics as the directive pass — the
 * outcome notes persist for the NEXT turn's history (no hidden replay).
 *
 * @param calls native calls (name + raw JSON-string arguments)
 */
export async function runNativeToolCalls(
  calls: Array<{ id?: string | null; name?: string | null; arguments?: string | null }>,
  deps: ChatToolPassDeps,
): Promise<ChatToolPassResult> {
  const directives: Array<{ toolId: string; args: Record<string, unknown> }> = [];
  for (const call of calls) {
    const toolId = typeof call.name === 'string' && call.name.trim() !== '' ? call.name.trim() : '';
    if (toolId === '') continue;
    let args: Record<string, unknown> = {};
    if (typeof call.arguments === 'string' && call.arguments.trim() !== '') {
      try {
        const parsed = JSON.parse(call.arguments) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          args = parsed as Record<string, unknown>;
        }
      } catch {
        args = { _parseError: call.arguments.slice(0, 200) };
      }
    }
    directives.push({ toolId, args });
  }
  return runToolDirectives(directives, deps);
}

async function runToolDirectives(
  directives: Array<{ toolId: string; args: Record<string, unknown> }>,
  deps: ChatToolPassDeps,
): Promise<ChatToolPassResult> {
  const { persona, broker, audit } = deps;
  const now = deps.now ?? Date.now;
  const manifestById = new Map<string, ToolManifest>(broker.manifests.map((m) => [m.id, m]));
  const external = deps.external ?? [];
  const externalById = new Map<string, ToolManifest>(
    external.flatMap((provider) => provider.manifests.map((m) => [m.id, m] as const)),
  );
  const decisions: ChatToolDecision[] = [];

  for (const directive of directives) {
    const outcome = await handleDirective(
      { toolId: directive.toolId, args: directive.args },
      manifestById,
      externalById,
      external,
      deps,
      now(),
    );
    if (outcome !== null) decisions.push(outcome);
  }

  // Audit one row per handled tool — ids/reasons only, never params/results.
  for (const decision of decisions) {
    audit.log('persona', 'chat.tool', decision.toolId, {
      personaId: persona.id,
      decision: decision.decision,
      ...(decision.decision === 'queued'
        ? { pendingId: decision.pendingId }
        : decision.decision === 'refused'
          ? { reason: decision.reason }
          : {}),
    });
  }
  return { decisions };
}

async function handleDirective(
  directive: PersonaToolDirective,
  manifestById: Map<string, ToolManifest>,
  externalById: Map<string, ToolManifest>,
  external: ReadonlyArray<{
    manifests: ReadonlyArray<ToolManifest>;
    allow(toolId: string): boolean;
    exec(toolId: string, args: Record<string, unknown>): Promise<ToolExecResponse> | ToolExecResponse;
    match?(toolId: string): ToolManifest | undefined;
  }>,
  deps: ChatToolPassDeps,
  at: number,
): Promise<ChatToolDecision | null> {
  const { persona, broker, appendSystemNote } = deps;
  const toolId = directive.toolId;
  // The owning external provider: ALLOWED providers win (a provider whose
  // allow() is false never owns its tool id — that reads as disabled).
  const owner = external.find((provider) => provider.allow(toolId));
  const dynamicManifest = owner?.match?.(toolId);
  const staticExternal = externalById.get(toolId);
  const manifest = manifestById.get(toolId) ?? staticExternal ?? dynamicManifest;
  if (manifest === undefined) {
    appendSystemNote(`The tool "${toolId}" is not available — continue without it.`);
    return { toolId, decision: 'refused', reason: 'unknown_tool' };
  }

  // A static external tool whose provider is not allowed = disabled.
  const externalTool = staticExternal !== undefined || dynamicManifest !== undefined;
  if (externalTool && owner === undefined) {
    appendSystemNote(
      `The tool "${toolId}" is disabled — enable it (and configure it) before asking for it.`,
    );
    return { toolId, decision: 'refused', reason: 'external_disabled' };
  }

  const args = directive.args ?? {};
  const projectId = typeof args.projectId === 'string' ? args.projectId : '';
  // External tools have no project grant; "enabled backend" IS the consent.
  const hasGrant = projectId !== '' ? broker.grants.hasGrant(toolId, projectId, at) : owner !== undefined;

  const gate = authorizeTool(persona.independence.level, manifest, {
    toolId,
    autoScopes: persona.independence.autoScopes,
    hasGrant,
    // M11 F3: persona policy tool bans refuse at the gate.
    bannedTools: persona.policy?.tools?.banned,
  });

  if (gate.decision === 'refused') {
    appendSystemNote(`The tool "${toolId}" was refused (${gate.reason}) — continue without it.`);
    return { toolId, decision: 'refused', reason: gate.reason };
  }

  if (gate.decision === 'queued') {
    if (owner !== undefined) {
      // External tool whose gate wants approval (suggest proposing a medium-
      // risk external like web search). Queue a persona-requested approval
      // row: the user decides it from the Files queue and an approval
      // executes the tool ONCE (see the /v1/tools/pending/:id route). There
      // is no project grant for external tools — the enabled backend + the
      // user's approval IS the consent.
      if (!broker.pending) {
        appendSystemNote(
          `The tool "${toolId}" needs your approval, but approvals are unavailable — nothing ran.`,
        );
        return { toolId, decision: 'refused', reason: 'no_approval_channel' };
      }
      if (deps.conversationId === undefined || deps.conversationId === null || deps.conversationId === '') {
        appendSystemNote(
          `The tool "${toolId}" needs a conversation to approve into — nothing ran.`,
        );
        return { toolId, decision: 'refused', reason: 'missing_conversation' };
      }
      const pendingId = broker.pending.enqueue({
        toolId,
        projectId: '',
        params: args,
        risk: manifest.risk,
        requestedBy: 'persona',
        conversationId: deps.conversationId,
        personaId: persona.id,
      });
      appendSystemNote(
        `The persona requested tool "${toolId}" — it is awaiting your approval ` +
          `(pending ${pendingId}). Approve or deny it in this chat or from the Files queue.`,
      );
      return { toolId, decision: 'queued', pendingId };
    }
    if (projectId === '') {
      appendSystemNote(
        `The tool "${toolId}" needs a projectId argument — nothing was executed.`,
      );
      return { toolId, decision: 'refused', reason: 'missing_project' };
    }
    if (!broker.pending) {
      appendSystemNote(
        `The tool "${toolId}" needs your approval, but approvals are unavailable — nothing ran.`,
      );
      return { toolId, decision: 'refused', reason: 'no_approval_channel' };
    }
    const pendingId = broker.pending.enqueue({
      toolId,
      projectId,
      params: args,
      risk: manifest.risk,
      requestedBy: 'persona',
    });
    appendSystemNote(
      `The persona requested tool "${toolId}" — it is awaiting your approval ` +
        `(pending ${pendingId}).`,
    );
    return { toolId, decision: 'queued', pendingId };
  }

  // gate: executed. Broker tools run on the broker; EXTERNAL tools run on
  // their owning external executor (never the broker, and broker tools never
  // reach an external executor).
  let response: ToolExecResponse;
  if (owner !== undefined) {
    response = await owner.exec(toolId, args);
  } else {
    response = broker.exec(toolId, args, { requestedBy: 'persona' });
  }
  if (response.outcome === 'executed') {
    const summary = summarizeToolResult(response.result ?? {});
    appendSystemNote(`[tool ${toolId} result]\n${summary}\n[end tool ${toolId} result]`);
    return { toolId, decision: 'executed' };
  }
  if (response.outcome === 'needs_approval') {
    const pendingId = response.pendingId;
    appendSystemNote(
      `The tool "${toolId}" is awaiting your approval (pending ${pendingId}).`,
    );
    return { toolId, decision: 'queued', pendingId };
  }
  appendSystemNote(`The tool "${toolId}" could not run (${response.reason}) — continue without it.`);
  return { toolId, decision: 'refused', reason: response.reason };
}
