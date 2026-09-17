/**
 * The v1 tool manifest registry (PLAN-M2 "Tool manifests"). Every executable
 * capability declares itself; nothing runs without a grant (default-deny).
 *
 * `confirm` describes the UX shape (web reads this), `risk` drives the
 * approval queue and HTTP route status. All six file tools are local (network:
 * false) and scoped to a project root. Write tools (edit/apply/delete) also
 * refuse read-only roots at the tool layer.
 *
 * M27 S1 adds the three app-scoped `notes.*` read tools. They are `low` risk
 * (`confirm: 'once'`) for the same reason `files.read` is: they only READ the
 * user's own data, and the reach line the owner consents to says exactly that.
 */
import type { ToolId, ToolManifest } from '@partner/shared/tools.js';

export const FILE_TOOL_MANIFESTS: readonly ToolManifest[] = [
  {
    id: 'files.list',
    description: 'List one directory under a project root',
    risk: 'low',
    confirm: 'once',
    network: false,
    scope: { kind: 'project' },
  },
  {
    id: 'files.read',
    description: 'Read a file under a project root (size-capped)',
    risk: 'low',
    confirm: 'once',
    network: false,
    scope: { kind: 'project' },
  },
  {
    id: 'files.search',
    description: 'Plain-text content search under a project root (no binaries)',
    risk: 'low',
    confirm: 'once',
    network: false,
    scope: { kind: 'project' },
  },
  {
    id: 'files.edit',
    description: 'Propose an edit — returns a proposal id; never mutates the file',
    risk: 'medium',
    confirm: 'once',
    network: false,
    scope: { kind: 'project' },
  },
  {
    id: 'files.apply',
    description: 'Apply a proposal (atomic write + .bak)',
    risk: 'high',
    confirm: 'always',
    network: false,
    scope: { kind: 'project' },
  },
  {
    id: 'files.delete',
    description: 'Delete under a root (trash-first: rename into .partner-trash/)',
    risk: 'high',
    confirm: 'always',
    network: false,
    scope: { kind: 'project' },
  },
];

/**
 * M27 S1 — the app-scoped read reach. No `projectId` in params: the broker uses
 * `APP_SCOPE_ID` for the grant check and the pending row, so these never touch
 * the roots manager. Read-only, so no write tool can ever be app-scoped by
 * accident — adding one would need this list to say so.
 */
export const APP_TOOL_MANIFESTS: readonly ToolManifest[] = [
  {
    id: 'notes.list',
    description: "List the user's notes (summaries only, capped)",
    risk: 'low',
    confirm: 'once',
    network: false,
    scope: { kind: 'app' },
  },
  {
    id: 'notes.search',
    description: "Search the user's notes by text (capped hits)",
    risk: 'low',
    confirm: 'once',
    network: false,
    scope: { kind: 'app' },
  },
  {
    id: 'notes.read',
    description: "Read one of the user's notes by id",
    risk: 'low',
    confirm: 'once',
    network: false,
    scope: { kind: 'app' },
  },
];

/**
 * The whole v1 registry the broker dispatches: project-scoped files,
 * app-scoped notes. `defaultToolRegistry()` (skills/catalog.ts) is derived from
 * this so a manifest declaring a tool here is installable, and one declaring
 * anything else is refused.
 */
export const TOOL_MANIFESTS: readonly ToolManifest[] = [
  ...FILE_TOOL_MANIFESTS,
  ...APP_TOOL_MANIFESTS,
];

const MANIFEST_BY_ID: ReadonlyMap<ToolId, ToolManifest> = new Map(
  TOOL_MANIFESTS.map((m) => [m.id, m]),
);

/** Registry lookup — undefined for unknown tools. */
export function manifestFor(id: string): ToolManifest | undefined {
  return MANIFEST_BY_ID.get(id as ToolId);
}
