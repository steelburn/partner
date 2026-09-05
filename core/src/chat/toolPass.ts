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
    }): string;
  };
}

export interface ChatToolPassDeps {
  persona: Persona;
  broker: ChatToolBrokerLike;
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
export function runChatToolPass(text: string, deps: ChatToolPassDeps): ChatToolPassResult {
  const { persona, broker, audit, appendSystemNote } = deps;
  const now = deps.now ?? Date.now;
  const manifestById = new Map<string, ToolManifest>(broker.manifests.map((m) => [m.id, m]));
  const decisions: ChatToolDecision[] = [];

  for (const directive of parseReplyTools(text)) {
    const outcome = handleDirective(directive, manifestById, deps, now());
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
  void appendSystemNote;
  return { decisions };
}

function handleDirective(
  directive: PersonaToolDirective,
  manifestById: Map<string, ToolManifest>,
  deps: ChatToolPassDeps,
  at: number,
): ChatToolDecision | null {
  const { persona, broker, appendSystemNote } = deps;
  const toolId = directive.toolId;
  const manifest = manifestById.get(toolId);
  if (manifest === undefined) {
    appendSystemNote(`The tool "${toolId}" is not available — continue without it.`);
    return { toolId, decision: 'refused', reason: 'unknown_tool' };
  }

  const args = directive.args ?? {};
  const projectId = typeof args.projectId === 'string' ? args.projectId : '';
  const hasGrant = projectId !== '' ? broker.grants.hasGrant(toolId, projectId, at) : false;

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

  // gate: executed — run through the broker (a grant was present at gate
  // time; a mid-flight revocation surfaces as needs_approval).
  const response = broker.exec(toolId, args, { requestedBy: 'persona' });
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
