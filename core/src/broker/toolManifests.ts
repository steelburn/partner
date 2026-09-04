/**
 * The v1 tool manifest registry (PLAN-M2 "Tool manifests"). Every executable
 * capability declares itself; nothing runs without a grant (default-deny).
 *
 * `confirm` describes the UX shape (web reads this), `risk` drives the
 * approval queue and HTTP route status. All six tools are local (network:
 * false) and scoped to a project root. Write tools (edit/apply/delete) also
 * refuse read-only roots at the tool layer.
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

const MANIFEST_BY_ID: ReadonlyMap<ToolId, ToolManifest> = new Map(
  FILE_TOOL_MANIFESTS.map((m) => [m.id, m]),
);

/** Registry lookup — undefined for unknown tools. */
export function manifestFor(id: string): ToolManifest | undefined {
  return MANIFEST_BY_ID.get(id as ToolId);
}
