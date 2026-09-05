/**
 * M2 tool-broker wire contracts (PLAN-M2.md).
 *
 * Default-deny machinery: every executable capability declares a manifest;
 * nothing runs without a grant scoped to a project root; high-risk actions
 * always ask; every execution is audited (redacted). These shapes cross the
 * loopback between core and web.
 */

export type ToolRisk = 'low' | 'medium' | 'high';

export type ToolConfirm = 'never' | 'once' | 'always';

export type ToolId =
  | 'files.list'
  | 'files.read'
  | 'files.search'
  | 'files.edit'
  | 'files.apply'
  | 'files.delete';

export interface ToolManifest {
  id: ToolId;
  description: string;
  risk: ToolRisk;
  confirm: ToolConfirm;
  network: boolean;
  /** Tools act within a project root; parameters carry {projectId, path}. */
  scope: { kind: 'project' };
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
