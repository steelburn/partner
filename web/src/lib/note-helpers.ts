/**
 * M5 notes + plans helpers (PLAN-M5.md) — DOM-free logic for the Notes view.
 *
 * Kept out of the components so every parse/sort/label decision is
 * unit-testable in the node vitest env (no jsdom). Redaction/privacy
 * discipline: note/plan CONTENT is the user's own data — it may be rendered
 * to the OWNER in the UI (editor, search snippets, backlink rows), but
 * nothing in this module embeds content into errors; validation errors name
 * the offending field/index, never the value. Errors/logs carry ids, titles
 * and lengths at most.
 */

import type {
  NoteSummary,
  NotesExportBundle,
  Plan,
  PlanSummary,
  PlanTask,
  TaskStatus,
} from '@partner/shared';

/** Wiki-link targets extracted from markdown content ([[Title]]). */
export const WIKI_LINK_RE = /\[\[([^[\]\r\n]+)\]\]/g;

/**
 * Extract the distinct [[Title]] targets from markdown content, in order of
 * first appearance. A title is the trimmed text between the brackets; empty
 * targets are ignored. Repeated titles are deduplicated case-insensitively
 * (the core resolves links case-insensitively), keeping the first spelling.
 */
export function extractWikiLinks(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of content.matchAll(WIKI_LINK_RE)) {
    const title = (match[1] ?? '').trim();
    if (title.length === 0) continue;
    const key = title.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(title);
  }
  return out;
}

/**
 * A wiki-link title -> a full-text phrase query for the search endpoint
 * (FTS5 treats a double-quoted term as an exact phrase). Interior double
 * quotes are stripped so the title cannot break out of the phrase.
 */
export function linkTitleToSearch(title: string): string {
  const safe = title.replace(/"/g, '').trim();
  return `"${safe}"`;
}

/** Max characters for one tag chip (keeps rows tidy; UI truncates with …). */
export const MAX_TAG_LENGTH = 40;

/**
 * Parse a raw tags input string ("work, ideas, m5 " / newline / semicolon
 * separated) into distinct, trimmed tags. Empty tokens drop out; duplicates
 * collapse case-insensitively (first spelling wins); order is preserved.
 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of raw.split(/[\s,;]+/)) {
    const tag = token.trim().slice(0, MAX_TAG_LENGTH);
    if (tag.length === 0) continue;
    const key = tag.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Sort note summaries most-recent first by updatedAt; equal timestamps fall
 * back to createdAt (also descending), then id, for determinism.
 */
export function noteListSort(list: readonly NoteSummary[]): NoteSummary[] {
  return [...list].sort(
    (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id),
  );
}

// ---------------------------------------------------------------------------
// Plans: progress + flattening (pure math over the wire shapes)
// ---------------------------------------------------------------------------

/** A shape that can report progress: a full Plan (document authoritative). */
export type PlanProgressSource = Plan | PlanSummary;

export interface ProgressStats {
  done: number;
  total: number;
  /** Whole percent 0..100 (0 when there are no tasks). */
  pct: number;
}

function hasDocument(plan: PlanProgressSource): plan is Plan {
  return 'document' in plan && plan.document !== undefined;
}

function countByStatus(tasks: readonly PlanTask[], status: TaskStatus): number {
  return tasks.reduce((count, task) => (task.status === status ? count + 1 : count), 0);
}

/**
 * Progress across every task in a plan. The document is authoritative when
 * present (counts can drift while the planner is live-editing); otherwise
 * the summary counts the core reported are used. pct rounds to a whole
 * number and is 0 when the plan has no tasks yet.
 */
export function planProgress(plan: PlanProgressSource): ProgressStats {
  if (hasDocument(plan)) {
    const tasks = plan.document.milestones.flatMap((milestone) => milestone.tasks);
    const total = tasks.length;
    const done = countByStatus(tasks, 'done');
    return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
  }
  const total = plan.taskCount;
  const done = plan.doneCount;
  return { done, total, pct: total === 0 ? 0 : Math.round((done / total) * 100) };
}

/** One flattened planner row: a task with the path to reach it. */
export interface PlanTaskRow {
  milestoneId: string;
  milestoneTitle: string;
  taskId: string;
  taskTitle: string;
  status: TaskStatus;
  ownerPersonaId: string | null;
  /** Note carried on the task (e.g. why a task is blocked). */
  note: string | null;
  /** "Milestone / Task" display path used for row labels and keys. */
  path: string;
}

/**
 * Flatten a plan document into milestone+task rows in document order. Each
 * row carries its full path ("Milestone title / Task title") for keyboard
 * labels and stable keys. A plan without a document flattens to [].
 */
export function flattenPlanTasks(plan: PlanProgressSource): PlanTaskRow[] {
  if (!hasDocument(plan)) return [];
  const rows: PlanTaskRow[] = [];
  for (const milestone of plan.document.milestones) {
    for (const task of milestone.tasks) {
      rows.push({
        milestoneId: milestone.id,
        milestoneTitle: milestone.title,
        taskId: task.id,
        taskTitle: task.title,
        status: task.status,
        ownerPersonaId: task.ownerPersonaId ?? null,
        note: task.note ?? null,
        path: `${milestone.title} / ${task.title}`,
      });
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Task-status input validation (before setTaskStatus)
// ---------------------------------------------------------------------------

export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'done', 'blocked'];

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  open: 'Open',
  done: 'Done',
  blocked: 'Blocked',
};

/** Max characters for the note attached to a status change. */
export const MAX_STATUS_NOTE = 500;

/**
 * Validate a TaskStatusInput before it is sent. Returns a human message (no
 * content echoed) or null when the input is usable. Empty note text
 * normalizes to "no note" (the caller omits the field).
 */
export function validateTaskStatusInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return 'Choose a status first.';
  }
  const record = input as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== 'string' || !TASK_STATUSES.includes(status as TaskStatus)) {
    return 'Status must be open, done or blocked.';
  }
  if (record.note !== undefined && record.note !== null) {
    if (typeof record.note !== 'string') {
      return 'The status note must be text.';
    }
    if (record.note.length > MAX_STATUS_NOTE) {
      return `The status note is too long (max ${MAX_STATUS_NOTE} characters).`;
    }
  }
  return null;
}

/** True when a status value is one of the three the core accepts. */
export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.includes(value as TaskStatus);
}

// ---------------------------------------------------------------------------
// Export file naming + serialization
// ---------------------------------------------------------------------------

export const NOTES_BUNDLE_FILE = 'partner-notes.json';

/** Downloadable notes payload (schema marker + exportedAt + every note). */
export function notesBundleToFile(bundle: NotesExportBundle): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

const MAX_EXPORT_CHARS = 900_000; // below the core's 1 MiB JSON body cap

/**
 * Schema guard for the notes/v1 export bundle (client + import-facing).
 * Returns a human error or null when the value is a plausible notes/v1
 * bundle. Element errors name the note index, never content.
 */
export function validateNotesExportBundle(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'This is not a Partner notes file — expected an object exported from Notes.';
  }
  const bundle = value as Record<string, unknown>;
  if (bundle.schema !== 'notes/v1') {
    return 'This is not a Partner notes export (missing the notes/v1 schema marker).';
  }
  if (typeof bundle.exportedAt !== 'number' || !Number.isFinite(bundle.exportedAt)) {
    return 'The notes export is missing its exportedAt timestamp.';
  }
  if (!Array.isArray(bundle.notes)) {
    return 'The notes file has no notes list — it may be from a different app.';
  }
  for (let i = 0; i < bundle.notes.length; i += 1) {
    const noteError = noteShapeError(bundle.notes[i], 'notes', i);
    if (noteError) return noteError;
  }
  return null;
}

/** Reject oversized note files early (cheap guard; honest UI). */
export function validateNotesExportSize(jsonText: string): string | null {
  if (jsonText.length > MAX_EXPORT_CHARS) {
    return 'The notes file is too large to import.';
  }
  return null;
}

function noteShapeError(row: unknown, listName: string, index: number): string | null {
  if (typeof row !== 'object' || row === null) return `${listName}[${index}] is not a note object.`;
  const note = row as Record<string, unknown>;
  if (typeof note.id !== 'string' || note.id.length === 0) {
    return `${listName}[${index}] is missing its id.`;
  }
  if (typeof note.title !== 'string') {
    return `${listName}[${index}] is missing its title.`;
  }
  if (typeof note.content !== 'string') {
    return `${listName}[${index}] is missing its content.`;
  }
  if (typeof note.createdAt !== 'number' || typeof note.updatedAt !== 'number') {
    return `${listName}[${index}] is missing its timestamps.`;
  }
  return null;
}

/**
 * A plan title -> a safe, readable download file name ending in the
 * .partner-plan.json suffix the core's export format uses. Non-word
 * characters become dashes; an empty/untitled plan falls back to "plan".
 */
export function planToExportFileName(plan: { title: string }): string {
  const slug = plan.title
    .trim()
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug.length > 0 ? slug : 'plan'}.partner-plan.json`;
}

/** Canonical JSON payload for the plan download (pretty-printed). */
export function planBundleToFile(bundle: PlanExportBundleLike): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}

/** Structural subset used for serialization so helpers stay dependency-free. */
export interface PlanExportBundleLike {
  schema: 'plan/v1';
  exportedAt: number;
  plan: Plan;
}

export type { TaskStatus };
