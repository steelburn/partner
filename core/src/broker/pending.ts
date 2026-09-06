/**
 * Pending-approval queue manager (M2). A broker exec that finds NO grant
 * enqueues here; the user decides from the UI (approve/deny, approve+remember
 * persists a grant). Rows are closed in place (decided_at/decision/decided_by)
 * so the audit trail of "who decided what" survives.
 *
 * decide() optionally creates a grant through an injected callback — the
 * broker wires it to the grant manager so this module stays decoupled from
 * grants/roots (PLAN-M2 broker internals).
 */
import { randomUUID } from 'node:crypto';
import type { PendingToolCall, ToolDecisionInput, ToolRequestedBy, ToolRisk } from '@partner/shared/tools.js';
import { toolError } from './errors.js';
import type { PendingToolRow, PendingToolStore } from '../stores/types.js';

export interface PendingManagerOptions {
  store: PendingToolStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
  /**
   * Called when a row is approved with remember:true AND carries a
   * projectId. Return the new grant id (or null when nothing was created).
   */
  onCreateGrant?: (row: PendingToolRow, note?: string) => string | null;
}

export interface EnqueueInput {
  toolId: string;
  /** Project root id for broker (files.*) rows; '' for external tools (no root). */
  projectId: string;
  /** Raw tool params — stored verbatim so the UI can render + re-exec. */
  params: Record<string, unknown>;
  risk: ToolRisk;
  requestedBy: ToolRequestedBy;
  /** M12 external approvals: conversation to post the outcome note into. */
  conversationId?: string | null;
  /** M12 external approvals: persona behind the request (queue tagging). */
  personaId?: string | null;
}

export interface PendingDecision {
  /** Closed row fields (decision/decidedAt/decidedBy set). */
  row: PendingToolRow;
  /** Grant id when approve+remember created one. */
  grantId: string | null;
}

export interface PendingManager {
  /** Open a queue row; returns its id. */
  enqueue(input: EnqueueInput): string;
  /** Open rows oldest-first, params parsed. */
  list(): PendingToolCall[];
  /** Row lookup INCLUDING closed rows (for idempotence/audit checks). */
  get(id: string): PendingToolRow | undefined;
  /**
   * Close a row with a decision. Throws not_found for an unknown id and
   * not_pending for an already-decided row. Approve + remember creates the
   * grant via the injected callback.
   */
  decide(id: string, input: ToolDecisionInput, by: string): PendingDecision;
}

const REQUESTED_BY: ReadonlySet<string> = new Set(['web', 'persona', 'skill']);

function parseParams(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to an empty params map (row stays intact for the audit).
  }
  return {};
}

function toCall(row: PendingToolRow): PendingToolCall {
  return {
    id: row.id,
    toolId: row.toolId as PendingToolCall['toolId'],
    params: parseParams(row.params),
    risk: row.risk as ToolRisk,
    requestedBy: (REQUESTED_BY.has(row.requestedBy) ? row.requestedBy : 'web') as ToolRequestedBy,
    createdAt: row.createdAt,
    // Chat-requested rows carry the conversation they asked from so the
    // chat UI can surface approvals for the active conversation (M12.6).
    conversationId: row.conversationId ?? null,
  };
}

export function createPendingManager(options: PendingManagerOptions): PendingManager {
  const { store } = options;
  const now = options.now ?? Date.now;
  const onCreateGrant = options.onCreateGrant;

  function enqueue(input: EnqueueInput): string {
    const toolId = typeof input.toolId === 'string' ? input.toolId.trim() : '';
    // projectId is required for broker (files.*) rows — external tool rows
    // (M12 web-search approvals) have no project root and pass ''.
    const projectId = typeof input.projectId === 'string' ? input.projectId.trim() : '';
    if (toolId === '') {
      throw toolError('bad_params', 'toolId is required');
    }
    if (input.params === null || typeof input.params !== 'object' || Array.isArray(input.params)) {
      throw toolError('bad_params', 'params must be an object');
    }
    const id = randomUUID();
    const at = now();
    const conversationId =
      typeof input.conversationId === 'string' && input.conversationId.trim() !== ''
        ? input.conversationId.trim()
        : null;
    const personaId =
      typeof input.personaId === 'string' && input.personaId.trim() !== ''
        ? input.personaId.trim()
        : null;
    store.insert({
      id,
      toolId,
      projectId,
      params: JSON.stringify(input.params),
      risk: input.risk,
      requestedBy: REQUESTED_BY.has(input.requestedBy) ? input.requestedBy : 'web',
      createdAt: at,
      decidedAt: null,
      decision: null,
      decidedBy: null,
      conversationId,
      personaId,
    });
    return id;
  }

  function list(): PendingToolCall[] {
    return store.listOpen().map(toCall);
  }

  function get(id: string): PendingToolRow | undefined {
    return store.findById(id);
  }

  function decide(id: string, input: ToolDecisionInput, by: string): PendingDecision {
    const decision = input?.decision;
    if (decision !== 'approve' && decision !== 'deny') {
      throw toolError('bad_params', "decision must be 'approve' or 'deny'");
    }
    const row = store.findById(id);
    if (!row) throw toolError('not_found', 'pending call not found');
    if (row.decidedAt !== null) {
      throw toolError('not_pending', 'pending call was already decided');
    }
    const at = now();
    store.updateDecision(id, at, decision, by);
    const closed = { ...row, decidedAt: at, decision, decidedBy: by };

    let grantId: string | null = null;
    if (decision === 'approve' && input.remember === true && closed.projectId !== null && onCreateGrant) {
      grantId = onCreateGrant(closed, input.note);
    }
    return { row: closed, grantId };
  }

  return { enqueue, list, get, decide };
}
