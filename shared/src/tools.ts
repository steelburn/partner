/**
 * M2 tool-broker wire contracts (PLAN-M2.md).
 *
 * Default-deny machinery: every executable capability declares a manifest;
 * nothing runs without a grant; high-risk actions always ask; every execution
 * is audited (redacted). These shapes cross the loopback between core and web.
 *
 * M27 S1 added the second SCOPE: a `files.*` tool acts inside a registered
 * project root, while a `notes.*` tool acts on the user's own notes, which are
 * not a filesystem root. The scope is a property of the MANIFEST, so the broker
 * can branch on it before it ever asks for a root.
 */

export type ToolRisk = 'low' | 'medium' | 'high';

export type ToolConfirm = 'never' | 'once' | 'always';

/**
 * The reserved `projectId` an app-scoped grant and pending row carry.
 *
 * It is not a root id and MUST never be looked up in the roots manager; it
 * exists so the (tool, projectId) grant key and the pending row keep one shape
 * across both scopes. `files.*` with this id is refused — see the grants route.
 */
export const APP_SCOPE_ID = 'app';

/**
 * Where a tool acts. `project` tools resolve a registered root from their
 * params; `app` tools act on a core-owned store and take no `projectId`.
 */
export type ToolScope = { kind: 'project' } | { kind: 'app' };

export type ToolId =
  | 'files.list'
  | 'files.read'
  | 'files.search'
  | 'files.edit'
  | 'files.apply'
  | 'files.delete'
  | 'notes.list'
  | 'notes.search'
  | 'notes.read';

export interface ToolManifest {
  id: ToolId;
  description: string;
  risk: ToolRisk;
  confirm: ToolConfirm;
  network: boolean;
  /**
   * `project` tools act within a project root (params carry {projectId, path});
   * `app` tools act on a core-owned store (no projectId — the scope id is
   * supplied by the broker and the manifest declares the reach instead).
   */
  scope: ToolScope;
}

export interface ProjectRoot {
  id: string;
  label: string;
  /** Canonical absolute path (symlinks resolved). */
  path: string;
  readOnly: boolean;
  addedAt: number;
}

export interface ProjectRootInput {
  label: string;
  path: string;
  readOnly?: boolean;
}

export interface GrantRecord {
  id: string;
  toolId: ToolId;
  projectId: string;
  source: 'user';
  createdAt: number;
  expiresAt: number | null;
  note?: string;
}

export interface GrantInput {
  toolId: ToolId;
  projectId: string;
  note?: string;
}

export type ToolRequestedBy = 'web' | 'persona' | 'skill';

export interface PendingToolCall {
  id: string;
  toolId: ToolId;
  params: Record<string, unknown>;
  risk: ToolRisk;
  requestedBy: ToolRequestedBy;
  createdAt: number;
  /**
   * Display name of the persona behind a `requestedBy: 'persona'` row
   * (route-enriched at GET /v1/tools/pending; absent/undefined otherwise).
   */
  personaName?: string | null;
  /**
   * Conversation a chat-requested approval belongs to ('' for queue rows
   * outside a chat — web/try-a-tool asks and playbook runs). Set on the
   * row when a persona turn asked from a persisted conversation; lets the
   * chat UI surface approvals for the ACTIVE conversation and continue the
   * turn once they are decided.
   */
  conversationId?: string | null;
  /**
   * M26 (v21): the queue carries two kinds of ask. 'tool' (default) is a broker
   * call awaiting a grant; 'skill_install' is a persona asking to promote an
   * authored skill draft. The decide route branches on this — `broker.decide`
   * refuses anything but 'tool'.
   */
  kind?: 'tool' | 'skill_install';
  /** M26: the draft an install ask refers to (kind 'skill_install' only). */
  draftId?: string | null;
}

export type ToolExecResponse =
  | { outcome: 'executed'; result: Record<string, unknown> }
  | { outcome: 'needs_approval'; pendingId: string }
  | { outcome: 'denied'; reason: string };

export interface ToolDecisionInput {
  decision: 'approve' | 'deny';
  /** Approve + persist a grant for (tool, project) when true. */
  remember?: boolean;
  note?: string;
}

export interface FileProposal {
  id: string;
  projectId: string;
  path: string;
  originalContent: string;
  proposedContent: string;
  createdAt: number;
}

export interface FileListEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number | null;
  mtime: number | null;
}

export interface FileSearchHit {
  path: string;
  line: number | null;
  text: string;
}

/** params for tools.exec */
export interface FilesPathParams {
  projectId: string;
  /** Relative path inside the project root (or '.' for list). */
  path: string;
}

export interface FilesReadParams extends FilesPathParams {
  /** Optional byte cap override (server enforces a hard cap regardless). */
  maxBytes?: number;
}

export interface FilesSearchParams {
  projectId: string;
  query: string;
  path?: string;
}

export interface FilesEditParams extends FilesPathParams {
  /** The file's full proposed content (server diffs against disk). */
  proposedContent: string;
}

export interface FilesApplyParams {
  projectId: string;
  proposalId: string;
}

// ---------------------------------------------------------------------------
// M27 S1 — app-scoped notes reach. These params carry NO projectId: the broker
// supplies APP_SCOPE_ID for the grant check, so a skill cannot point notes
// reach at a root (and a root cannot be used to widen it).
// ---------------------------------------------------------------------------

/**
 * params for `notes.list` — no required fields; `limit` is advisory and the
 * executor clamps it to its own cap regardless.
 */
export interface NotesListParams {
  limit?: number;
}

/** params for `notes.search` — the query is the content-bearing field. */
export interface NotesSearchParams {
  query: string;
  limit?: number;
}

/** params for `notes.read` — one note by id. */
export interface NotesReadParams {
  id: string;
}
