/**
 * DOM-free logic for the Files view (M2). Kept out of the components so it is
 * unit-testable in the node vitest env. Rendering is presentational only;
 * every rule that decides labels, risk chips, param summaries, outcome copy
 * and diff math lives here.
 *
 * Secret discipline: pendingLabel only ever summarizes *where* a tool acts
 * (project label / relative path / proposal id) — never file content, never
 * search terms, never anything key-shaped. Result-parsing helpers only read
 * what the core tool results declare.
 */

import type {
  FileListEntry,
  FileSearchHit,
  ToolExecResponse,
  ToolId,
  ToolRisk,
} from '@partner/shared/src/tools.js';

/** Human short labels for the six M2 tools. */
export const TOOL_LABELS: Record<ToolId, string> = {
  'files.list': 'List directory',
  'files.read': 'Read file',
  'files.search': 'Search files',
  'files.edit': 'Propose edit',
  'files.apply': 'Apply edit',
  'files.delete': 'Delete file',
};

export const RISK_LABELS: Record<ToolRisk, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/** Semantic text-token class per risk tier (never a background). */
export const RISK_TONE_CLASS: Record<ToolRisk, string> = {
  low: 'risk-low',
  medium: 'risk-medium',
  high: 'risk-high',
};

/** Short label + risk tier for a tool id (drives queue rows and chips). */
export function summarizeTool(toolId: ToolId): { label: string; risk: ToolRisk } {
  // External (non-broker) tools can appear in the queue (M12 web search).
  const external = EXTERNAL_TOOL_LABELS[toolId as string];
  if (external) return external;
  return { label: TOOL_LABELS[toolId] ?? toolId, risk: riskOf(toolId) };
}

/** External-tool queue overrides (label + risk per the core manifest). */
const EXTERNAL_TOOL_LABELS: Record<string, { label: string; risk: ToolRisk }> = {
  search: { label: 'Web search', risk: 'medium' },
};

/** Tool risk per manifest (PLAN-M2): list/read/search low, edit medium, apply/delete high. */
export function riskOf(toolId: ToolId): ToolRisk {
  switch (toolId) {
    case 'files.list':
    case 'files.read':
    case 'files.search':
      return 'low';
    case 'files.edit':
      return 'medium';
    case 'files.apply':
    case 'files.delete':
      return 'high';
  }
}

/** Relative path carried by params ('.' means the root itself). */
function paramPath(params: Record<string, unknown>): string | null {
  const value = params.path;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return trimmed === '.' ? 'project root' : trimmed;
}

/**
 * One-line summary of a pending tool call for the approval queue.
 *
 * Shows only where the tool acts: relative path (or "project root"), an
 * optional project label, and — for search — a marker that a content query is
 * involved. Never includes `proposedContent`, search query text, or any
 * unknown/key-shaped parameter.
 */
export function pendingLabel(
  toolId: ToolId,
  params: Record<string, unknown>,
  options?: { projectLabel?: string },
): string {
  let summary: string;
  if ((toolId as string) === 'search') {
    // Web-search approval: the query IS the consent subject (and already
    // owner data in the chat transcript the ask came from), so it is shown
    // truncated — unlike files.search, whose content pattern stays hidden.
    const raw = params.query;
    const query = typeof raw === 'string' && raw.trim() !== '' ? shorten(raw.trim(), 80) : '';
    summary = query === '' ? 'the web' : `the web · “${query}”`;
  } else if (toolId === 'files.search') {
    const where = paramPath(params) ?? 'project root';
    summary = `${where} · content search`;
  } else if (toolId === 'files.apply') {
    const proposalId = params.proposalId;
    summary =
      typeof proposalId === 'string' && proposalId.length > 0
        ? `proposal ${shorten(proposalId, 12)}`
        : 'apply pending proposal';
  } else {
    summary = paramPath(params) ?? 'project root';
  }
  if (options?.projectLabel && options.projectLabel.length > 0) {
    summary = `${options.projectLabel} · ${summary}`;
  }
  return shorten(summary, 140);
}

function shorten(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export type OutcomeTone = 'executed' | 'waiting' | 'denied';

/**
 * Turn a broker decision into the copy the UI shows. `waiting` is the
 * needs_approval message; `denied` surfaces the broker's reason (already
 * redacted core-side).
 */
export function resolveOutcome(response: ToolExecResponse): { tone: OutcomeTone; message: string } {
  switch (response.outcome) {
    case 'executed':
      return { tone: 'executed', message: 'Executed.' };
    case 'needs_approval':
      return { tone: 'waiting', message: 'Waiting for approval…' };
    case 'denied':
      return { tone: 'denied', message: `Denied: ${response.reason}` };
  }
}

// ---------------------------------------------------------------------------
// Root form validation (inline hints; existence/duplicates come from core)
// ---------------------------------------------------------------------------

/** Validate the add-root label. Returns an inline error message or null. */
export function validateRootLabel(raw: string): string | null {
  return raw.trim().length === 0 ? 'Label is required.' : null;
}

/**
 * Validate the add-root path client-side: must be absolute. Real checks
 * (exists, is a directory, canonicalization) happen core-side and surface as
 * an inline ApiRequestError message.
 */
export function validateRootPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return 'Path is required.';
  if (!trimmed.startsWith('/')) {
    return 'Enter an absolute path starting with / — Partner can only see registered roots.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Tool-result rendering (provisional: tolerant of the result envelope)
// ---------------------------------------------------------------------------

/**
 * Parse a files.list result into rows. Tolerates {entries|files|list:[…]}
 * envelopes of FileListEntry-shaped or plain-name entries.
 */
export function parseListResult(result: Record<string, unknown>): FileListEntry[] | null {
  const raw = firstArray(result, 'entries', 'files', 'list');
  if (raw === null) return null;
  const rows: FileListEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      rows.push({ name: item, path: item, kind: 'file', size: null, mtime: null });
    } else if (isRecord(item)) {
      const name = typeof item.name === 'string' ? item.name : null;
      if (name === null || name.length === 0) continue;
      const path = typeof item.path === 'string' && item.path.length > 0 ? item.path : name;
      const kind = item.kind === 'dir' ? 'dir' : 'file';
      const size = typeof item.size === 'number' ? item.size : null;
      const mtime = typeof item.mtime === 'number' ? item.mtime : null;
      rows.push({ name, path, kind, size, mtime });
    }
  }
  return rows.length > 0 ? rows : null;
}

/** Parse a files.read result into content (+ server truncation flag). */
export function parseReadResult(
  result: Record<string, unknown>,
): { content: string; truncated: boolean } | null {
  const content = result.content ?? result.text ?? result.body;
  if (typeof content !== 'string') return null;
  const truncated = result.truncated === true;
  return { content, truncated };
}

/**
 * Parse a files.search result into hits. Tolerates
 * {hits|matches|results:[…]} envelopes of FileSearchHit-shaped entries.
 */
export function parseSearchResult(result: Record<string, unknown>): FileSearchHit[] | null {
  const raw = firstArray(result, 'hits', 'matches', 'results');
  if (raw === null) return null;
  const hits: FileSearchHit[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      hits.push({ path: '', line: null, text: item });
    } else if (isRecord(item)) {
      const path = typeof item.path === 'string' ? item.path : '';
      const line = typeof item.line === 'number' ? item.line : null;
      const text = typeof item.text === 'string' ? item.text : '';
      hits.push({ path, line, text });
    }
  }
  return hits.length > 0 ? hits : null;
}

/** Read the proposalId out of a files.edit executed result (tolerant). */
export function parseProposalId(result: Record<string, unknown>): string | null {
  const direct = result.proposalId;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  if (isRecord(result.proposal)) {
    const nested = result.proposal.id;
    if (typeof nested === 'string' && nested.length > 0) return nested;
  }
  if (typeof result.id === 'string' && result.id.length > 0) return result.id;
  return null;
}

function firstArray(
  record: Record<string, unknown>,
  ...keys: string[]
): unknown[] | null {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// ---------------------------------------------------------------------------
// Simple line diff (provisional rendering; preview never mutates)
// ---------------------------------------------------------------------------

export type DiffRowType = 'same' | 'add' | 'remove';

export interface DiffRow {
  type: DiffRowType;
  text: string;
}

export interface LineDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
}

/** Guard so pathological inputs cannot blow up the UI (preview is capped). */
const MAX_DIFF_LINES = 400;
const MAX_DIFF_CELLS = 160_000;

function splitLines(content: string): string[] {
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Classic LCS line diff between the original and proposed file content.
 * Returns ordered rows (+ add / − remove / plain same), the added/removed
 * counts, and whether the input was capped for rendering.
 */
export function computeLineDiff(originalContent: string, proposedContent: string): LineDiff {
  const original = splitLines(originalContent);
  const proposed = splitLines(proposedContent);
  const truncated =
    original.length > MAX_DIFF_LINES || proposed.length > MAX_DIFF_LINES;
  const a = truncated ? original.slice(0, MAX_DIFF_LINES) : original;
  const b = truncated ? proposed.slice(0, MAX_DIFF_LINES) : proposed;
  const n = a.length;
  const m = b.length;

  const rows: DiffRow[] = [];
  if (n * m > MAX_DIFF_CELLS) {
    // Whole-block replace when the LCS table would be too large.
    for (const line of a) rows.push({ type: 'remove', text: line });
    for (const line of b) rows.push({ type: 'add', text: line });
  } else {
    const table: number[][] = Array.from({ length: n + 1 }, () =>
      new Array<number>(m + 1).fill(0),
    );
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i]![j] =
          a[i] === b[j]
            ? table[i + 1]![j + 1]! + 1
            : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        rows.push({ type: 'same', text: a[i]! });
        i++;
        j++;
      } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
        rows.push({ type: 'remove', text: a[i]! });
        i++;
      } else {
        rows.push({ type: 'add', text: b[j]! });
        j++;
      }
    }
    while (i < n) {
      rows.push({ type: 'remove', text: a[i]! });
      i++;
    }
    while (j < m) {
      rows.push({ type: 'add', text: b[j]! });
      j++;
    }
  }

  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.type === 'add') added++;
    else if (row.type === 'remove') removed++;
  }
  return { rows, added, removed, truncated };
}

/** Human file size (null size renders as an em dash). */
export function formatFileSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Relative-time-ish label for a millisecond timestamp (provisional). */
export function formatWhen(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return '—';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
