/**
 * M9 pure helpers for the Playbooks view (PLAN-M9.md) — kept out of the
 * components so they are unit-testable in the node vitest env.
 *
 * Token discipline: every label/tone decision below maps onto the design
 * system's semantic tokens via a class suffix; no colour lives here.
 * Redaction discipline: labels only ever name a tool id or summarize a
 * schema *shape* (input names/hints) — never pasted content, never tool
 * results, never anything key-shaped.
 */

import { TOOL_LABELS } from './roots.js';
import type { DeployProfile, PlaybookArea, PlaybookSummary } from '@partner/shared';
import type { PlaybookRunStatus } from './playbooks.js';

// ---------------------------------------------------------------------------
// Areas (registry chips)
// ---------------------------------------------------------------------------

const AREA_LABELS: Record<PlaybookArea, string> = {
  research: 'Research',
  'vibe-code': 'Vibe code',
  docgen: 'Docgen',
  email: 'Email',
  presentation: 'Presentation',
  analysis: 'Analysis',
  'design-prototype': 'Design prototype',
  ship: 'Ship',
};

/** Chip text for a playbook area (unknown areas fall back to the raw id). */
export function areaLabel(area: PlaybookArea | string): string {
  return AREA_LABELS[area as PlaybookArea] ?? area;
}

/**
 * Chip tone for an area, restricted to semantic text tokens. Text playbooks
 * run in the chat/notes surface (neutral); vibe-code involves broker
 * proposals (accent); ship targets real infrastructure (success). The CSS
 * classes derived from these tones color *text only* (--bg chip fills keep
 * the small-text contrast in both themes — the M4 memory-view discipline).
 */
export type AreaTone = 'neutral' | 'accent' | 'success';

export function areaTone(area: PlaybookArea | string): AreaTone {
  switch (area) {
    case 'vibe-code':
    case 'design-prototype':
      return 'accent';
    case 'ship':
      return 'success';
    default:
      return 'neutral';
  }
}

// ---------------------------------------------------------------------------
// Input schema (Run panel rendering)
// ---------------------------------------------------------------------------

/** Human, ordered summary of a playbook's declared inputs. */
export function describeInputs(inputs: PlaybookSummary['inputs']): string {
  if (inputs.length === 0) return 'No inputs';
  const summary = inputs.map((input) =>
    input.optional ? `${input.name} (optional)` : input.name,
  );
  return `${inputs.length} input${inputs.length === 1 ? '' : 's'} · ${summary.join(', ')}`;
}

/** How the Run panel renders one schema input (hint-driven). */
export type PlaybookInputKind = 'text' | 'textarea' | 'json' | 'note';

/**
 * Rendering kind for a schema input:
 *  - 'note' when the hint asks for an existing note (render a note picker),
 *  - 'json' when the hint asks for structured JSON (validate + textarea),
 *  - 'textarea' for long freeform hints (csv/prompt/spec/sources/…),
 *  - 'text' otherwise.
 */
export function inputKind(
  input: PlaybookSummary['inputs'][number],
): PlaybookInputKind {
  const hint = input.hint.toLowerCase();
  if (/\bnote\b/.test(hint)) return 'note';
  if (/\bjson\b/.test(hint)) return 'json';
  if (
    /\b(csv|prompt|spec|sources|source|outline|topic|draft|brief|content)\b/.test(hint) ||
    /\b(text|textarea)\b/.test(hint)
  ) {
    return 'textarea';
  }
  return 'text';
}

/** Names of schema inputs that want an existing note picked. */
export function noteInputNames(inputs: PlaybookSummary['inputs']): string[] {
  return inputs.filter((input) => inputKind(input) === 'note').map((input) => input.name);
}

/** Validate a JSON-typed input field before sending (returns error or null). */
export function validateJsonText(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Required.';
  try {
    JSON.parse(trimmed);
    return null;
  } catch {
    return 'Enter valid JSON.';
  }
}

// ---------------------------------------------------------------------------
// Run status labels
// ---------------------------------------------------------------------------

const RUN_STATUS_LABELS: Record<PlaybookRunStatus, string> = {
  running: 'Running',
  done: 'Complete',
  error: 'Failed',
  loop_exhausted: 'Loop limit reached',
};

/** Human label for a playbook_runs.status value. */
export function runStatusLabel(status: PlaybookRunStatus | string | null): string {
  if (status === null) return 'Running';
  return RUN_STATUS_LABELS[status as PlaybookRunStatus] ?? status;
}

/** Terminal-state tone for a run status (semantic text tokens only). */
export function runStatusTone(
  status: PlaybookRunStatus | string | null,
): 'running' | 'ok' | 'danger' | 'warn' {
  switch (status) {
    case 'done':
      return 'ok';
    case 'error':
      return 'danger';
    case 'loop_exhausted':
      return 'warn';
    default:
      return 'running';
  }
}

// ---------------------------------------------------------------------------
// Persona tool markers (transcript)
// ---------------------------------------------------------------------------

/** Friendly label for a persona tool id (known ids only; raw id otherwise). */
export function personaToolLabel(toolId: string): string {
  return TOOL_LABELS[toolId as keyof typeof TOOL_LABELS] ?? toolId;
}

/**
 * Marker text for a persona_tool event in the run transcript. Names the
 * acting persona + the tool label; queued rows get the queue hint so the
 * user knows where to approve. Tool args/results are never part of the
 * marker — owner data renders in the chat surface only.
 */
export function personaToolMarkerText(
  toolId: string,
  decision: 'executed' | 'queued' | 'refused',
  options: { personaName?: string; reason?: string } = {},
): string {
  const actor = options.personaName && options.personaName.length > 0 ? options.personaName : 'The persona';
  const label = personaToolLabel(toolId);
  switch (decision) {
    case 'executed':
      return `${actor} ran ${label}.`;
    case 'queued':
      return `${actor} asked to ${label} — approve it in the queue to continue.`;
    case 'refused': {
      const reason = options.reason && options.reason.length > 0 ? ` (${options.reason})` : '';
      return `${actor} was not allowed to run ${label}${reason}.`;
    }
  }
}

// ---------------------------------------------------------------------------
// Deploy profiles
// ---------------------------------------------------------------------------

/** One-line profile summary for a list row (never includes env/secrets). */
export function deployProfileLabel(profile: DeployProfile): string {
  const userHost =
    profile.username && profile.username.length > 0
      ? `${profile.username}@${profile.host}`
      : profile.host;
  const where = `${userHost}:${profile.port}`;
  return profile.remoteBaseDir && profile.remoteBaseDir.length > 0
    ? `${where} → ${profile.remoteBaseDir}`
    : where;
}

/** Validate the deploy-profile name (inline hint; duplicates come from core). */
export function validateProfileName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Name is required.';
  if (/\s/.test(trimmed)) return 'Name must not contain spaces.';
  return null;
}

/** Validate the target host client-side: non-empty, no spaces (M9 contract). */
export function validateHostInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Host is required.';
  if (/\s/.test(trimmed)) {
    return 'Host must not contain spaces — a hostname or IP address, e.g. enter.ne1.dev.';
  }
  return null;
}

/** Validate an optional port field (integer 1–65535; empty means default 22). */
export function validatePortInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return 'Port must be a whole number.';
  const port = Number(trimmed);
  if (port < 1 || port > 65535) return 'Port must be between 1 and 65535.';
  return null;
}

/** Validate an absolute directory path (package project/out dirs). */
export function validateAbsoluteDir(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Path is required.';
  // POSIX '/…' or Windows drive form 'C:\…' / 'C:/…' — a granted root on the
  // documented Windows dev host is drive-letter absolute.
  if (!/^(\/|[A-Za-z]:[\\/])/.test(trimmed)) {
    return 'Enter an absolute path (e.g. C:\\Projects\\app or /home/me/app) — packaging only runs under granted project roots.';
  }
  return null;
}
