/**
 * M2 tool-broker API client (PLAN-M2.md).
 *
 * Follows the M0/M1 chokepoint rules exactly (see lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; the transport is
 * injectable for tests; non-2xx maps to ApiRequestError with a readable
 * message. Secrets discipline: nothing in this file logs, echoes or stores
 * tool parameters or results — params are sent to the core once, the core
 * redacts them before the audit row, and results returned to the UI never
 * carry key-shaped material by construction.
 *
 * The wire types (ProjectRoot, GrantRecord, PendingToolCall,
 * ToolExecResponse, FileProposal, …) live in shared/src/tools.ts, which is
 * not re-exported by the shared index; they are imported type-only from the
 * package subpath, so no runtime resolution ever happens.
 */

import {
  ApiRequestError,
  expectJson,
  expectNoContent,
  extractErrorMessage,
  type FetchLike,
} from './api.js';
import type {
  FileProposal,
  FilesApplyParams,
  GrantInput,
  GrantRecord,
  PendingToolCall,
  ProjectRoot,
  ProjectRootInput,
  ToolDecisionInput,
  ToolExecResponse,
  ToolId,
} from '@partner/shared/src/tools.js';

const ROOTS_PATH = '/v1/roots';
const BROWSE_PATH = '/v1/files/browse';
const GRANTS_PATH = '/v1/grants';
const TOOLS_EXEC_PATH = '/v1/tools/exec';
const TOOLS_PENDING_PATH = '/v1/tools/pending';
// PLAN-M2 core API: the proposal *detail* read lives under /v1/tools/… while
// apply/discard live under /v1/proposals/… — kept as separate constants so a
// core-side alignment is a one-line change per call.
const TOOLS_PROPOSALS_PATH = '/v1/tools/proposals';
const PROPOSALS_PATH = '/v1/proposals';

export type { FetchLike };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reject a response whose body is not a valid list (or {key: list}). */
async function expectList<T>(response: Response, key: string, noun: string): Promise<T[]> {
  const parsed = await expectJson<unknown>(response);
  if (Array.isArray(parsed)) return parsed as T[];
  if (isRecord(parsed) && Array.isArray(parsed[key])) return parsed[key] as T[];
  throw new ApiRequestError(response.status, `The ${noun} response had an unexpected shape.`);
}

// ---------------------------------------------------------------------------
// Roots (project roots are the only paths the broker can see)
// ---------------------------------------------------------------------------

/** GET /v1/roots -> all registered project roots. */
export async function listRoots(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProjectRoot[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(ROOTS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return expectList<ProjectRoot>(response, 'roots', 'roots');
}

/** POST /v1/roots {label, path, readOnly?} -> the created root. */
export async function addRoot(
  token: string,
  input: ProjectRootInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProjectRoot> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(ROOTS_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return expectJson<ProjectRoot>(response);
}

/** DELETE /v1/roots/:id -> 204. */
export async function removeRoot(
  token: string,
  rootId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${ROOTS_PATH}/${encodeURIComponent(rootId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Removing the root');
}

// ---------------------------------------------------------------------------
// Grants (the UI-visible "always allow" list)
// ---------------------------------------------------------------------------

/** GET /v1/grants -> every stored grant (tool x project root). */
export async function listGrants(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<GrantRecord[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(GRANTS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return expectList<GrantRecord>(response, 'grants', 'grants');
}

/** POST /v1/grants {toolId, projectId, note?} -> the created grant. */
export async function addGrant(
  token: string,
  input: GrantInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<GrantRecord> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(GRANTS_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return expectJson<GrantRecord>(response);
}

/** DELETE /v1/grants/:id -> 204. */
export async function removeGrant(
  token: string,
  grantId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${GRANTS_PATH}/${encodeURIComponent(grantId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Revoking the grant');
}

// ---------------------------------------------------------------------------
// Tool execution + approval queue
// ---------------------------------------------------------------------------

/**
 * Parse a broker response body into the shared ToolExecResponse union, or
 * null when the body is not broker-shaped.
 */
function parseExecBody(parsed: unknown): ToolExecResponse | null {
  if (!isRecord(parsed)) return null;
  switch (parsed.outcome) {
    case 'executed':
      return isRecord(parsed.result)
        ? { outcome: 'executed', result: parsed.result }
        : null;
    case 'needs_approval':
      return typeof parsed.pendingId === 'string' && parsed.pendingId.length > 0
        ? { outcome: 'needs_approval', pendingId: parsed.pendingId }
        : null;
    case 'denied':
      return typeof parsed.reason === 'string'
        ? { outcome: 'denied', reason: parsed.reason }
        : null;
    default:
      return null;
  }
}

/**
 * POST /v1/tools/exec {tool, params} -> the broker's decision. `executed`
 * carries the tool result; `needs_approval` surfaces the pending row id
 * distinctly so the UI can wait on the queue; `denied` is a hard refusal.
 * A 403 whose body is still broker-shaped maps to `denied` instead of an
 * exception so callers see one uniform result union.
 */
export async function execTool(
  token: string,
  toolId: ToolId,
  params: Record<string, unknown>,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ToolExecResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(TOOLS_EXEC_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ tool: toolId, params }),
  });

  if (!response.ok) {
    // Buffer the body once: it may carry a broker `denied` decision, and it
    // is also the only source for the fallback error text.
    const bodyText = await response.text();
    let parsed: unknown = null;
    try {
      parsed = bodyText.length > 0 ? (JSON.parse(bodyText) as unknown) : null;
    } catch {
      // Non-JSON failure — fall through to the generic error mapping.
    }
    const decision = parseExecBody(parsed);
    if (decision) return decision;
    throw new ApiRequestError(response.status, extractErrorMessage(bodyText, response.status));
  }
  const parsed = await expectJson<unknown>(response);
  const decision = parseExecBody(parsed);
  if (decision === null) {
    throw new ApiRequestError(response.status, 'The exec response had an unexpected shape.');
  }
  return decision;
}

/** GET /v1/tools/pending -> rows waiting in the approval queue. */
export async function listPending(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<PendingToolCall[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(TOOLS_PENDING_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return expectList<PendingToolCall>(response, 'pending', 'pending');
}

/**
 * POST /v1/tools/pending/:id {decision, remember?, note?} -> 204.
 * `remember: true` (approve only) persists a grant for (tool, project).
 */
/** Outcome of deciding a pending tool call (the approval executes the tool
 *  once server-side; remember persists a grant). */
export interface ToolDecisionOutcome {
  grantId: string | null;
  /** True when the approval executed the underlying tool. */
  executed: boolean;
  /** Set when the tool refused the run (e.g. not_pending). */
  error?: string;
  /** Tool result when executed (e.g. a proposalId from files.edit). */
  result?: Record<string, unknown>;
}

export async function decidePending(
  token: string,
  pendingId: string,
  input: ToolDecisionInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ToolDecisionOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { decision: input.decision };
  if (input.remember === true) body.remember = true;
  if (typeof input.note === 'string' && input.note.length > 0) body.note = input.note;
  const response = await fetchImpl(`${TOOLS_PENDING_PATH}/${encodeURIComponent(pendingId)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (response.status === 204) return { grantId: null, executed: false };
  const parsed = (await expectJson<Record<string, unknown>>(response)) as Record<string, unknown>;
  return {
    grantId: typeof parsed.grantId === 'string' ? parsed.grantId : null,
    executed: parsed.executed === true,
    ...(typeof parsed.error === 'string' && parsed.error.length > 0 ? { error: parsed.error } : {}),
    ...(parsed.result !== null && typeof parsed.result === 'object'
      ? { result: parsed.result as Record<string, unknown> }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Edit proposals (preview never mutates; apply is a second brokered call)
// ---------------------------------------------------------------------------

/** GET /v1/tools/proposals/:id -> the full diff payload. */
export async function getProposal(
  token: string,
  proposalId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<FileProposal> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${TOOLS_PROPOSALS_PATH}/${encodeURIComponent(proposalId)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  if (
    isRecord(parsed) &&
    typeof parsed.id === 'string' &&
    typeof parsed.projectId === 'string' &&
    typeof parsed.path === 'string' &&
    typeof parsed.originalContent === 'string' &&
    typeof parsed.proposedContent === 'string' &&
    typeof parsed.createdAt === 'number'
  ) {
    return parsed as unknown as FileProposal;
  }
  throw new ApiRequestError(response.status, 'The proposal response had an unexpected shape.');
}

/**
 * POST /v1/proposals/:id/apply {projectId, proposalId} -> the broker runs
 * `files.apply` (risk high — always asks) and answers with an exec-shaped
 * response. A 204/empty 2xx is treated as executed for robustness.
 */
export async function applyProposal(
  token: string,
  input: FilesApplyParams,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ToolExecResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${PROPOSALS_PATH}/${encodeURIComponent(input.proposalId)}/apply`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ projectId: input.projectId, proposalId: input.proposalId }),
    },
  );
  if (!response.ok) {
    const bodyText = await response.text();
    let parsed: unknown = null;
    try {
      parsed = bodyText.length > 0 ? (JSON.parse(bodyText) as unknown) : null;
    } catch {
      // Fall through to the generic error mapping below.
    }
    const decision = parseExecBody(parsed);
    if (decision) return decision;
    throw new ApiRequestError(response.status, extractErrorMessage(bodyText, response.status));
  }
  if (response.status === 204) return { outcome: 'executed', result: {} };
  const parsed = await expectJson<unknown>(response);
  const decision = parseExecBody(parsed);
  if (decision !== null) return decision;
  // Non-broker 2xx body (e.g. {applied:true}) still means the write landed.
  return { outcome: 'executed', result: isRecord(parsed) ? parsed : {} };
}

/** DELETE /v1/proposals/:id -> 204 (discard the preview; nothing is written). */
export async function discardProposal(
  token: string,
  proposalId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${PROPOSALS_PATH}/${encodeURIComponent(proposalId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Discarding the proposal');
}

// ---------------------------------------------------------------------------
// M16 F7: filesystem folder browser for the add-root "Absolute path" picker
// (GET /v1/files/browse). Lists DIRECTORY names only — never file content.
// ---------------------------------------------------------------------------

export interface BrowseEntry {
  name: string;
  isDir: boolean;
}

export interface BrowseResult {
  path: string;
  parent: string | null;
  entries: BrowseEntry[];
  truncated: boolean;
}

/** Normalize a /v1/files/browse response (rejects wrong shapes loudly). */
export function parseBrowseResult(value: unknown, status = 200): BrowseResult {
  if (
    isRecord(value) &&
    typeof value.path === 'string' &&
    (value.parent === null || typeof value.parent === 'string') &&
    Array.isArray(value.entries)
  ) {
    const entries: BrowseEntry[] = [];
    for (const entry of value.entries) {
      if (!isRecord(entry) || typeof entry.name !== 'string') {
        throw new ApiRequestError(status, 'The browse response had an unexpected shape.');
      }
      entries.push({ name: entry.name, isDir: entry.isDir !== false });
    }
    return { path: value.path, parent: value.parent, entries, truncated: value.truncated === true };
  }
  throw new ApiRequestError(status, 'The browse response had an unexpected shape.');
}

/** GET /v1/files/browse?path=… — folders under an absolute path ('' = start). */
export async function browseDirectories(
  token: string,
  path = '',
  options: { fetchImpl?: FetchLike } = {},
): Promise<BrowseResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = path === '' ? '' : `?path=${encodeURIComponent(path)}`;
  const response = await fetchImpl(`${BROWSE_PATH}${query}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseBrowseResult(await expectJson<unknown>(response), response.status);
}

/** M22: the roots surface state — the list plus who owns it. */
export interface RootsState {
  roots: ProjectRoot[];
  /**
   * True when the DEPLOYMENT owns the roots (`FIXED_ROOTS`): the core refuses
   * add/remove, so the UI must render the list read-only instead of offering
   * buttons that will 403.
   */
  rootsFixed: boolean;
}

/** GET /v1/roots -> { roots, rootsFixed } (M22). */
export async function listRootsState(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<RootsState> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(ROOTS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  if (!isRecord(parsed) || !Array.isArray(parsed.roots)) {
    throw new ApiRequestError(response.status, 'The roots response had an unexpected shape.');
  }
  return {
    roots: parsed.roots as ProjectRoot[],
    // Absent means "the client owns them" (older cores, and the default).
    rootsFixed: parsed.rootsFixed === true,
  };
}
