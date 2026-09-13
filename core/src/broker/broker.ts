/**
 * The M2 tool broker (PLAN-M2) — authorize -> execute | enqueue.
 *
 * Default-deny resolution for every exec:
 *   1. manifest registry lookup      -> denied `unknown_tool`
 *   2. client-class capability       -> denied `capability_denied`
 *      (M20-B S4; BEFORE the grant check on purpose)
 *   3. envelope + per-tool params    -> denied `bad_params`
 *   4. project root exists           -> denied `unknown_project`
 *   5. explicit user grant present   -> execute
 *      no grant (ANY risk)           -> enqueue + needs_approval (the UI can
 *                                       grant via decide(remember:true))
 *
 * Risk tiers do not change resolution — low/medium/high all run under an
 * explicit grant and all surface the approval queue without one; the tier
 * drives the UX (web) and the "always ask" affordance on high-risk tools.
 *
 * Every execution/decision writes an audit row (actor 'tool' for execs)
 * whose details NEVER contain file content or secrets — params/results are
 * summarized to structural fields + lengths/counts here, and the audit
 * service re-redacts at serialization (defense in depth).
 */
import type {
  ToolDecisionInput,
  ToolExecResponse,
  ToolManifest,
  ToolRequestedBy,
} from '@partner/shared/tools.js';
import type { ProjectRoot } from '@partner/shared/tools.js';
import { FILE_TOOL_MANIFESTS } from './toolManifests.js';
import { capabilityDenial } from '../http/capabilities.js';
import type { Capability } from '../http/capabilities.js';
import { toolError, ToolError } from './errors.js';
import type { GrantManager } from './grants.js';
import type { PendingManager } from './pending.js';
import type { ProjectRootManager } from './roots.js';
import type { AuditService } from '../services/redaction.js';
import type { ProposalManager, ProposalView } from '../files/proposals.js';
import type { FileTools } from '../files/tools.js';

export interface ToolBrokerOptions {
  roots: ProjectRootManager;
  grants: GrantManager;
  pending: PendingManager;
  proposals: ProposalManager;
  /** The six v1 file-tool executors. */
  tools: FileTools;
  audit: AuditService;
  /** Manifest registry; defaults to the v1 files.* set. */
  manifests?: readonly ToolManifest[];
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface ExecContext {
  requestedBy: ToolRequestedBy;
  /**
   * The acting session's client class (M20-B S4) — read from the SESSION ROW by
   * the route, never from a request field.
   *
   * Absent means "an internal caller with no client session" (the persona/skill
   * tool loops, the file-ref read back into a chat turn), which keeps the
   * desktop envelope so those pre-existing paths are unchanged.
   */
  clientClass?: string;
}

export interface DecideResult {
  ok: true;
  /** Grant id persisted when approve+remember AND the execution succeeded. */
  grantId: string | null;
  /** True when an approval executed the underlying tool once. */
  executed: boolean;
  /** Set when approval executed but the tool itself was denied/failed. */
  error?: string;
  /** Tool result when executed (e.g. a proposalId from files.edit). */
  result?: AnyParams;
}

export interface ToolBroker {
  /** Registered manifests (web renders risk/confirm from these). */
  readonly manifests: readonly ToolManifest[];
  readonly roots: ProjectRootManager;
  readonly grants: GrantManager;
  readonly pending: PendingManager;
  /** Authorize -> execute | enqueue (deny by default). */
  exec(toolId: string, params: unknown, ctx: ExecContext): ToolExecResponse;
  /** Close a pending call. An APPROVAL executes the tool ONCE (with the
   *  stored params); approve+remember additionally persists a grant for
   *  future direct execs. */
  decide(pendingId: string, input: ToolDecisionInput, by: string, clientClass?: string): DecideResult;
  /** Proposal read surface for the web (diff payload). */
  getProposal(id: string): ProposalView | null;
  /** Discard a proposal; throws ToolError when missing/already applied. */
  discardProposal(id: string): void;
}

type AnyParams = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Audit summarization — the ONLY place tool params/results become details.
// File content (proposedContent/originalContent/content/hit text/search
// queries) NEVER appears: structural fields + lengths only.
// ---------------------------------------------------------------------------

const CONTENT_KEYS: ReadonlySet<string> = new Set([
  'content',
  'originalContent',
  'proposedContent',
]);

function summaryParams(toolId: string, params: AnyParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof params.projectId === 'string') out.projectId = params.projectId;
  // files.search keeps only a char count of the query — a query is arbitrary
  // user text that could embed a secret.
  if (toolId === 'files.search' && typeof params.query === 'string') {
    out.queryChars = params.query.length;
    return out;
  }
  for (const key of ['path', 'proposalId'] as const) {
    if (typeof params[key] === 'string') out[key] = params[key];
  }
  return out;
}

function summaryResult(toolId: string, result: AnyParams): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  switch (toolId) {
    case 'files.list':
      out.entries = Array.isArray(result.entries) ? result.entries.length : 0;
      return out;
    case 'files.read':
      out.bytes = typeof result.bytes === 'number' ? result.bytes : 0;
      return out;
    case 'files.search':
      out.hits = Array.isArray(result.hits) ? result.hits.length : 0;
      return out;
    case 'files.edit':
      out.proposalId = result.proposalId;
      out.path = result.path;
      out.originalChars = contentChars(result.originalContent);
      out.proposedChars = contentChars(result.proposedContent);
      return out;
    case 'files.apply':
    case 'files.delete':
      for (const key of ['path', 'trashPath', 'bytes'] as const) {
        const value = result[key];
        if (typeof value === 'string' || typeof value === 'number') out[key] = value;
      }
      return out;
    default:
      return {};
  }
}

function contentChars(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

/** Strip content keys defensively (never trust a future tool to summarize). */
function sanitizeForAudit(value: unknown, key: string): unknown {
  if (CONTENT_KEYS.has(key)) return '***[redacted]';
  return value;
}

/**
 * Broker tool -> capability (M20-B S4). The manifest type is frozen in shared/, so
 * the two vocabularies are joined here, next to the gate that consumes them.
 *
 * A manifest with NO entry resolves to '' — an unknown capability, which
 * `capabilityDenial` REFUSES for a session-class call rather than assuming
 * read-only. Widening the registry therefore fails closed until this table says
 * otherwise (the same rule the capability table documents for its own entries).
 */
/**
 * The capability an APPROVAL of `toolId` requires, or `''` when the vocabulary
 * has no name for it.
 *
 * Scoped by source for the same reason the tool pass is: `capabilityForTool`
 * maps broker tools only, and an unmapped id yields `''` which `capabilityDenial`
 * refuses for EVERY class — so applying it unconditionally would stop desktop
 * approving an MCP or search row. MCP's dynamic ids are prefixed `mcp:`, and an
 * enabled MCP server spawns a process, so approving one clears `mcp.call`.
 * Static externals such as web search stay on their existing consent (enabled
 * backend + the user's approval).
 */
function approvalCapability(toolId: string): string {
  const mapped = capabilityForTool(toolId);
  if (mapped !== '') return mapped;
  return toolId.startsWith('mcp:') ? 'mcp.call' : '';
}

const TOOL_CAPABILITIES: Readonly<Record<string, Capability>> = {
  'files.list': 'file.read',
  'files.read': 'file.read',
  'files.search': 'file.read',
  'files.edit': 'file.write',
  'files.apply': 'file.write',
  'files.delete': 'file.write',
};

/**
 * The capability a broker tool requires, or `''` for an unmapped one.
 *
 * Exported so callers that can reach the broker WITHOUT going through
 * `broker.exec` — the persona/skill/playbook tool loops, which decide
 * execute-vs-enqueue themselves and may call `pending.enqueue` directly — can
 * apply the same envelope before they queue anything. `broker.exec` still
 * checks independently: two gates on one decision is the point, because the
 * loops were the way a mobile session reached a desktop write.
 *
 * `''` is deliberately NOT a capability: `capabilityDenial` refuses an unknown
 * capability, so an unmapped tool fails closed for every class.
 */
export function capabilityForTool(toolId: string): Capability | '' {
  return TOOL_CAPABILITIES[toolId] ?? '';
}

export function createToolBroker(options: ToolBrokerOptions): ToolBroker {
  const { roots, grants, pending, proposals, tools, audit } = options;
  const manifests = options.manifests ?? FILE_TOOL_MANIFESTS;
  const now = options.now ?? Date.now;

  const manifestIndex = new Map<string, ToolManifest>(manifests.map((m) => [m.id, m]));

  function exec(toolId: string, rawParams: unknown, ctx: ExecContext): ToolExecResponse {
    const started = now();
    const tool = typeof toolId === 'string' ? toolId : '';

    const manifest = manifestIndex.get(tool);
    const impl = manifest ? (tools as unknown as Record<string, unknown>)[manifest.id] : undefined;
    if (!manifest || impl === undefined) {
      audit.log('tool', `${tool}.denied`, tool, {
        outcome: 'denied',
        reason: 'unknown_tool',
        ms: now() - started,
      });
      return { outcome: 'denied', reason: 'unknown_tool' };
    }

    // M20-B S4: the client-class envelope sits ABOVE the per-tool grant. The
    // ORDER is the control — an already-GRANTED mobile session must still be
    // refused, or its grant for files.edit would walk the phone straight into a
    // write. Checked before params/root so a class that may not ask for the
    // capability learns nothing about the project either.
    const capability = TOOL_CAPABILITIES[tool] ?? '';
    const denial = capabilityDenial(ctx.clientClass ?? 'desktop', capability);
    if (denial !== null) {
      // Class + capability ONLY: the requested params never reach this row.
      audit.log('tool', 'capability.denied', tool, {
        clientClass: denial.clientClass,
        capability: denial.capability,
      });
      return { outcome: 'denied', reason: denial.reason };
    }

    // Envelope + per-tool shape validation (typed bad_params before any grant
    // consideration — malformed calls never pollute the queue).
    let params: AnyParams;
    try {
      params = (impl as { validate(raw: unknown): AnyParams }).validate(rawParams);
    } catch (err) {
      if (err instanceof ToolError) {
        audit.log('tool', `${tool}.denied`, String(rawParamsParam(rawParams)), {
          outcome: 'denied',
          reason: err.code,
          ms: now() - started,
        });
        return { outcome: 'denied', reason: err.code };
      }
      throw err;
    }

    const projectId = typeof params.projectId === 'string' ? params.projectId : '';
    const root = roots.getById(projectId);
    if (!root) {
      audit.log('tool', `${tool}.denied`, projectId, {
        outcome: 'denied',
        reason: 'unknown_project',
        params: summaryParams(tool, params),
        ms: now() - started,
      });
      return { outcome: 'denied', reason: 'unknown_project' };
    }

    if (!grants.hasGrant(tool, projectId)) {
      const pendingId = pending.enqueue({
        toolId: tool,
        projectId,
        params,
        risk: manifest.risk,
        requestedBy: ctx.requestedBy,
      });
      audit.log('tool', `${tool}.needs_approval`, projectId, {
        outcome: 'needs_approval',
        risk: manifest.risk,
        pendingId,
        params: summaryParams(tool, params),
        ms: now() - started,
      });
      return { outcome: 'needs_approval', pendingId };
    }

    const outcome = runAuthorized(tool, manifest, impl, params, root, started);
    if (!outcome.ok) return { outcome: 'denied', reason: outcome.error ?? 'exec_failed' };
    return { outcome: 'executed', result: outcome.result };
  }

  /** Runs a tool that already passed authorization; audits + returns the
   *  redacted result (or the ToolError code). Shared by exec (granted path)
   *  and decide (approval executes once). */
  function runAuthorized(
    tool: string,
    manifest: ToolManifest,
    impl: unknown,
    params: AnyParams,
    root: ProjectRoot,
    started: number,
  ): { ok: true; result: AnyParams } | { ok: false; error: string } {
    try {
      const result = (impl as { run(root: ProjectRoot, p: AnyParams): AnyParams }).run(root, params);
      const details: Record<string, unknown> = {
        outcome: 'executed',
        risk: manifest.risk,
        grantId: grants.activeGrant(tool, projectIdOf(params))?.id,
        ms: now() - started,
      };
      for (const [key, value] of Object.entries(summaryParams(tool, params))) {
        details[`param.${key}`] = value;
      }
      for (const [key, value] of Object.entries(summaryResult(tool, result))) {
        details[`result.${key}`] = sanitizeForAudit(value, key);
      }
      audit.log('tool', `${tool}.executed`, projectIdOf(params), details);
      return { ok: true, result: result as AnyParams };
    } catch (err) {
      if (err instanceof ToolError) {
        const details: Record<string, unknown> = {
          outcome: 'denied',
          reason: err.code,
          ms: now() - started,
        };
        for (const [key, value] of Object.entries(summaryParams(tool, params))) {
          details[`param.${key}`] = value;
        }
        audit.log('tool', `${tool}.denied`, projectIdOf(params), details);
        return { ok: false, error: err.code };
      }
      throw err;
    }
  }

  function projectIdOf(params: AnyParams): string {
    return typeof params.projectId === 'string' ? params.projectId : '';
  }

  function decide(
    pendingId: string,
    input: ToolDecisionInput,
    by: string,
    clientClass?: string,
  ): DecideResult {
    const approved = input.decision === 'approve';
    const pre = pending.get(pendingId);
    if (!pre) throw toolError('not_found', 'pending call not found');
    if (pre.decidedAt !== null) throw toolError('not_pending', 'pending call was already decided');

    let executed = false;
    let error: string | undefined;
    let result: AnyParams | undefined;

    if (approved) {
      // M20-B S4 (blocker fix): approving EXECUTES the stored tool, so the
      // APPROVER's class must clear the same envelope the tool requires. The
      // verified gap: `decide` took only an actor LABEL, so a mobile session
      // could approve a queued write and have it run — the envelope was bypassed
      // through the approval queue, which is reachable without holding a grant.
      const needed = approvalCapability(pre.toolId);
      if (needed !== '') {
        const denied = capabilityDenial(clientClass ?? 'desktop', needed);
        if (denied !== null) {
          audit.log('tool', 'capability.denied', pre.toolId, {
            clientClass: denied.clientClass,
            capability: denied.capability,
          });
          throw toolError('capability_denied', 'this device may not approve that tool');
        }
      }
      // Approve-and-remember CREATES A GRANT, so it also needs the grant
      // authority — a device that may not grant must not acquire one this way.
      if (input.remember === true) {
        const grantDenied = capabilityDenial(clientClass ?? 'desktop', 'grants');
        if (grantDenied !== null) {
          audit.log('tool', 'capability.denied', pre.toolId, {
            clientClass: grantDenied.clientClass,
            capability: grantDenied.capability,
          });
          throw toolError(
            'capability_denied',
            'this device may not approve-and-remember (that creates a grant)',
          );
        }
      }
      // Execute ONCE with the stored params BEFORE closing the row. A grant
      // is only persisted when the execution actually succeeds (review fix:
      // never grant on a failed approval).
      const tool = pre.toolId;
      const manifest = manifestIndex.get(tool);
      const impl = manifest ? (tools as unknown as Record<string, unknown>)[manifest.id] : undefined;
      if (!manifest || impl === undefined) {
        error = 'unknown_tool';
      } else {
        let parsed: AnyParams | undefined;
        try {
          parsed =
            typeof pre.params === 'string'
              ? (JSON.parse(pre.params) as AnyParams)
              : ((pre.params ?? {}) as AnyParams);
        } catch {
          error = 'bad_params';
        }
        if (error === undefined && parsed !== undefined) {
          const params = parsed;
          const rootId = projectIdOf(params);
          const root = roots.getById(rootId);
          const started = now();
          if (!root) {
            error = 'unknown_project';
          } else {
            const outcome = runAuthorized(tool, manifest, impl, params, root, started);
            if (outcome.ok) {
              executed = true;
              result = outcome.result;
            } else {
              error = outcome.error;
            }
          }
        }
      }
    }

    // Close the row now (remember handled below, AFTER a successful run).
    const closed = pending.decide(pendingId, { decision: input.decision, remember: false }, by);
    const row = closed.row;

    let grantId: string | null = null;
    if (approved && executed && input.remember === true && row.projectId !== null) {
      const grant = grants.add(row.toolId, row.projectId, {
        ...(input.note !== undefined && input.note !== '' ? { note: input.note } : {}),
      });
      grantId = grant.id;
      audit.log(by, 'grant.add', row.projectId, {
        toolId: row.toolId,
        projectId: row.projectId,
        grantId,
        source: 'user',
      });
    }

    const details: Record<string, unknown> = {
      toolId: row.toolId,
      projectId: row.projectId ?? undefined,
      remember: input.remember === true,
      ...(input.note !== undefined && input.note !== '' ? { note: input.note } : {}),
      ...(grantId !== null ? { grantId } : {}),
      executed,
      ...(error !== undefined ? { error } : {}),
    };
    audit.log(by, approved ? 'tool.approve' : 'tool.deny', pendingId, details);
    return { ok: true, grantId, executed, ...(error !== undefined ? { error } : {}), ...(result !== undefined ? { result } : {}) };
  }

  function getProposal(id: string): ProposalView | null {
    return proposals.get(id);
  }

  function discardProposal(id: string): void {
    // Audit lives at the HTTP layer (actor = session kind); this method only
    // enforces the discard lifecycle.
    proposals.discard(id);
  }

  return {
    manifests,
    roots,
    grants,
    pending,
    exec,
    decide,
    getProposal,
    discardProposal,
  };
}

/** projectId hint for the bad_params audit target (never content). */
function rawParamsParam(raw: unknown): string {
  if (raw !== null && typeof raw === 'object') {
    const maybe = raw as { projectId?: unknown };
    return typeof maybe.projectId === 'string' ? maybe.projectId : 'tool';
  }
  return 'tool';
}
