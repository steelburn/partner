/**
 * M8 skills helpers (PLAN-M8.md) — DOM-free logic for the Skills view.
 *
 * Kept out of the components so every chip/label/sort/validation decision is
 * unit-testable in the node vitest env (no jsdom). Redaction/privacy
 * discipline (unchanged from M0–M7): skill code and skill logs are developer
 * content that never reaches this client; args and results are USER data
 * shown to the owner only — helpers therefore never embed arg or result
 * VALUES into error text or labels. Validation errors name the shape/size of
 * the problem, never the content; invocation labels map codes to copy.
 */

import type { SkillInvocationMeta, SkillPermissions } from '@partner/shared';
import type { ToolId, ToolRisk } from '@partner/shared/src/tools.js';
import { TOOL_LABELS } from './roots.js';
import { timeAgo } from './persona-helpers.js';

// ---------------------------------------------------------------------------
// Permission summary chips (default-deny installs render in plain language)
// ---------------------------------------------------------------------------

/** Tone a permission chip may take (semantic TEXT tokens only, never a fill). */
export type ChipTone = 'neutral' | 'success' | 'danger';

export interface PermissionChip {
  /** Stable key for React lists. */
  id: string;
  /** Short plain-language chip ("read files", "High risk", "Network"). */
  label: string;
  tone: ChipTone;
  /** Longer context for the chip's title/tooltip (raw ids, never content). */
  title?: string;
}

/** A shape that carries a permissions block (manifest or catalog entry). */
export type PermissionsSource =
  | SkillPermissions
  | { permissions: SkillPermissions }
  | { permissions?: unknown };

function isPermissions(value: unknown): value is SkillPermissions {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    Array.isArray(record.tools) &&
    typeof record.risk === 'string' &&
    typeof record.network === 'boolean'
  );
}

/** Pull the permissions block out of either accepted wire shape. */
export function readPermissions(source: PermissionsSource): SkillPermissions | null {
  if (isPermissions(source)) return source;
  if (typeof source === 'object' && source !== null) {
    const nested = (source as { permissions?: unknown }).permissions;
    if (isPermissions(nested)) return nested;
  }
  return null;
}

/** Short risk label with its semantic tone ("High risk" -> danger). */
export function riskChip(risk: ToolRisk): { label: string; tone: ChipTone } {
  switch (risk) {
    case 'low':
      return { label: 'Low risk', tone: 'success' };
    case 'high':
      return { label: 'High risk', tone: 'danger' };
    case 'medium':
    default:
      // Medium stays neutral: the warning token cannot hold small-text APCA
      // on dark surfaces, so it reads as muted text, never amber.
      return { label: 'Medium risk', tone: 'neutral' };
  }
}

/**
 * The plain-language permission chips for an install surface (catalog rows
 * and installed rows both render from this). Order: declared tools (or a
 * single "No tools" chip when the skill declares none), the whole-skill risk
 * ceiling, then — only when declared — a red "Network" flag. Tool chips reuse
 * the M2 human labels ("read files", "search files", …) so permission copy
 * stays consistent across the app; the raw tool id rides along in `title`.
 * Never called with arg/result content.
 */
export function permissionSummary(source: PermissionsSource): PermissionChip[] {
  const permissions = readPermissions(source);
  if (permissions === null) {
    return [{ id: 'perm-unknown', label: 'Permissions unknown', tone: 'danger' }];
  }
  const chips: PermissionChip[] = [];
  const tools = permissions.tools as ToolId[];
  if (tools.length === 0) {
    chips.push({ id: 'tools-none', label: 'No tools', tone: 'neutral', title: 'No file tools declared' });
  } else {
    tools.forEach((toolId, index) => {
      chips.push({
        id: `tool-${index}`,
        label: TOOL_LABELS[toolId] ?? toolId,
        tone: 'neutral',
        title: `Tool: ${toolId}`,
      });
    });
  }
  const risk = riskChip(permissions.risk);
  chips.push({ id: 'risk', label: risk.label, tone: risk.tone });
  if (permissions.network === true) {
    chips.push({
      id: 'network',
      label: 'Network',
      tone: 'danger',
      title: 'This skill declares network access',
    });
  }
  return chips;
}

// ---------------------------------------------------------------------------
// List sorting
// ---------------------------------------------------------------------------

const STATUS_RANK: Record<string, number> = { installed: 0, disabled: 1 };

/**
 * Sort installed skill summaries for display: enabled skills first (a
 * disabled skill is out of action and reads better at the bottom), then by
 * name (case-insensitive), then id for determinism. The input array is never
 * mutated.
 */
export function sortSkills<T extends { id: string; status: string; name: string }>(
  list: readonly T[],
): T[] {
  return [...list].sort(
    (a, b) =>
      (STATUS_RANK[a.status] ?? 2) - (STATUS_RANK[b.status] ?? 2) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Invocation error labels (codes only — the audit row never carries content)
// ---------------------------------------------------------------------------

export const INVOCATION_ERROR_LABELS: Record<string, string> = {
  not_found: 'Skill not found',
  disabled: 'Skill is disabled',
  budget_exceeded: 'Budget exceeded — run stopped',
  crashed: 'Skill crashed',
  denied: 'Invocation denied',
  tool_denied: 'A tool request was denied',
};

/** Human label for a coded invocation failure (unknown codes get a fallback). */
export function invocationErrorLabel(code: string): string {
  const label = INVOCATION_ERROR_LABELS[code];
  return label !== undefined ? label : 'Invocation failed';
}

// ---------------------------------------------------------------------------
// Args validation (JSON parse + 64 KB cap; content is user data, never echoed)
// ---------------------------------------------------------------------------

/** Client-side cap matching the core's max invocation args size (64 KB). */
export const MAX_ARGS_BYTES = 64 * 1024;

/** Short human byte-count label for the size hint ("312 B", "1.2 KB"). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  return `${kb >= 10 ? Math.round(kb) : Math.round(kb * 10) / 10} KB`;
}

/** UTF-8 byte length of a string (character count can under-report 64 KB). */
export function countBytes(text: string): number {
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(text).length;
  }
  return text.length;
}

export type ArgsValidation =
  | { ok: true; value: unknown; bytes: number }
  | { ok: false; error: string; bytes: number };

/**
 * Validate the raw args textarea before an invocation. Empty/whitespace text
 * parses as "no args" (value undefined). Text over the 64 KB cap is rejected
 * first (no point parsing an oversized payload); then the trimmed text must
 * be valid JSON. Errors name the problem, never the content.
 */
export function validateArgsJson(text: string): ArgsValidation {
  const trimmed = text.trim();
  const bytes = countBytes(trimmed);
  if (bytes > MAX_ARGS_BYTES) {
    return {
      ok: false,
      bytes,
      error: `Args are too large — the core accepts up to 64 KB (this is ${formatBytes(bytes)}).`,
    };
  }
  if (trimmed.length === 0) return { ok: true, value: undefined, bytes: 0 };
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown, bytes };
  } catch {
    return {
      ok: false,
      bytes,
      error: 'Args must be valid JSON — check commas, quotes and brackets.',
    };
  }
}

// ---------------------------------------------------------------------------
// Recent-invocation rows (metadata only: ids, versions, counts — never logs)
// ---------------------------------------------------------------------------

/** A display row for one recent invocation of a skill. */
export interface InvocationRow {
  id: string;
  skillId: string;
  /** True when the run finished successfully (ok dot). */
  ok: boolean;
  /** True while the worker is still running (finishedAt not yet set). */
  running: boolean;
  /** Relative-time label for when the run started. */
  startedLabel: string;
  toolCalls: number;
  ms: number | null;
  /** Human label for the failure (null on success / while running). */
  errorLabel: string | null;
  /** Raw error code (title/aria on the row); null when there is none. */
  errorCode: string | null;
}

/**
 * Turn raw invocation metadata into display rows: newest first by startedAt
 * (ties break on id for determinism). A row whose finishedAt is still null is
 * an in-flight run — shown as "running" with no error label. Only the coded
 * error (never content) reaches the row.
 */
export function formatInvocations(
  list: readonly SkillInvocationMeta[],
  now: number = Date.now(),
): InvocationRow[] {
  const sorted = [...list].sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));
  return sorted.map((meta) => {
    const running = meta.finishedAt === null;
    const errorCode = !running && !meta.ok && meta.error !== null ? meta.error : null;
    return {
      id: meta.id,
      skillId: meta.skillId,
      ok: meta.ok,
      running,
      startedLabel: timeAgo(meta.startedAt, now),
      toolCalls: meta.toolCalls,
      ms: meta.ms,
      errorLabel: errorCode === null ? null : invocationErrorLabel(errorCode),
      errorCode,
    };
  });
}

