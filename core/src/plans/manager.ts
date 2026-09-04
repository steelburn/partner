/**
 * Plan manager (M5, PLAN-M5.md §"plan manager").
 *
 * Plans are structured goals -> milestones -> tasks with a checked status
 * (open|done|blocked) and an optional owning persona, stored as JSON in the
 * `plans` row (`document`). The manager owns document shape validation
 * (milestones array; each {id,title,tasks}; each task {id,title,status,
 * ownerPersonaId?,note?}), task status transitions via setTaskStatus (typed
 * not_found when the plan OR task is missing), and keeps the shared notes_fts
 * mirror in step (searchable plan text = title + description + milestone and
 * task TITLES — never task notes or task note content).
 *
 * Privacy invariant (PLAN-M5): document bodies appear in responses to the
 * OWNER only. Audit rows carry ids, lengths, status and counts — never
 * document/task-note content (note text length only where a note exists).
 */
import { randomUUID } from 'node:crypto';
import type {
  Plan,
  PlanDocument,
  PlanInput,
  PlanSummary,
  PlanTask,
  TaskStatus,
  TaskStatusInput,
} from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { NotesFtsStore, PlanRow, PlanRowPatch, PlanStore } from '../stores/types.js';
import { planError } from './errors.js';

export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'done', 'blocked'];

export interface PlanManagerOptions {
  stores: { plans: PlanStore; fts: NotesFtsStore };
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

/** Partial plan edit (title/description/document — validate the document). */
export type PlanPatch = {
  title?: string;
  /** null clears an existing description. */
  description?: string | null;
  document?: PlanDocument;
};

export interface PlanManager {
  /** Summaries (taskCount/doneCount) newest-updated first. */
  list(): PlanSummary[];
  get(id: string): Plan | null;
  /** Create an empty plan (document {milestones: []}). */
  create(input: PlanInput): Plan;
  /** Update title/description/document (document shape validated). */
  update(id: string, patch: PlanPatch): Plan;
  /** Remove a plan + its FTS row. Unknown id -> not_found. */
  remove(id: string): void;
  /**
   * Apply a task status transition (note replaces the task's current note;
   * omitted note clears it). Typed not_found for a missing plan OR task.
   */
  setTaskStatus(planId: string, taskId: string, input: TaskStatusInput): Plan;
  /** Owned-plan export bundle (schema plan/v1). Unknown id -> not_found. */
  exportPlan(id: string): PlanExportBundle;
}

export interface PlanExportBundle {
  schema: 'plan/v1';
  /** Epoch-ms export timestamp (mirrors the notes bundle). */
  exportedAt: number;
  plan: Plan;
}

function toSummary(row: PlanRow): PlanSummary {
  const document = parseDocumentStored(row.document);
  const tasks = document.milestones.flatMap((m) => m.tasks);
  const taskCount = tasks.length;
  const doneCount = tasks.filter((t) => t.status === 'done').length;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    taskCount,
    doneCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toPlan(row: PlanRow): Plan {
  return { ...toSummary(row), document: parseDocumentStored(row.document) };
}

/** Stored document JSON -> PlanDocument (rows are always manager-written). */
export function parseDocumentStored(raw: string): PlanDocument {
  const parsed: unknown = JSON.parse(raw);
  return validateDocument(parsed);
}

function requireTitle(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw planError('invalid_input', 'title must be a non-empty string');
  }
  return raw.trim();
}

function requireOptionalDescription(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw planError('invalid_input', 'description must be a string');
  }
  return raw;
}

function requireId(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw planError('invalid_input', `${where} id must be a non-empty string`);
  }
  return raw;
}

function requireTaskTitle(raw: unknown, where: string): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw planError('invalid_input', `${where} title must be a non-empty string`);
  }
  return raw;
}

function requireStatus(raw: unknown): TaskStatus {
  if (typeof raw !== 'string' || !(TASK_STATUSES as readonly string[]).includes(raw)) {
    throw planError(
      'invalid_input',
      `task status must be one of ${TASK_STATUSES.join('|')}`,
    );
  }
  return raw as TaskStatus;
}

function requireTask(raw: unknown, where: string): PlanTask {
  if (raw === null || typeof raw !== 'object') {
    throw planError('invalid_input', `${where} task must be an object`);
  }
  const maybe = raw as {
    id?: unknown;
    title?: unknown;
    status?: unknown;
    ownerPersonaId?: unknown;
    note?: unknown;
  };
  const task: PlanTask = {
    id: requireId(maybe.id, `${where} task`),
    title: requireTaskTitle(maybe.title, `${where} task`),
    status: requireStatus(maybe.status),
  };
  if (maybe.ownerPersonaId !== undefined) {
    if (typeof maybe.ownerPersonaId !== 'string') {
      throw planError('invalid_input', `${where} task ownerPersonaId must be a string`);
    }
    if (maybe.ownerPersonaId !== '') task.ownerPersonaId = maybe.ownerPersonaId;
  }
  if (maybe.note !== undefined) {
    if (typeof maybe.note !== 'string') {
      throw planError('invalid_input', `${where} task note must be a string`);
    }
    task.note = maybe.note;
  }
  return task;
}

function requireMilestone(raw: unknown, where: string): PlanDocument['milestones'][number] {
  if (raw === null || typeof raw !== 'object') {
    throw planError('invalid_input', `${where} milestone must be an object`);
  }
  const maybe = raw as { id?: unknown; title?: unknown; tasks?: unknown };
  const id = requireId(maybe.id, `${where} milestone`);
  const title = requireTaskTitle(maybe.title, `${where} milestone`);
  if (!Array.isArray(maybe.tasks)) {
    throw planError('invalid_input', `${where} milestone tasks must be an array`);
  }
  const tasks = maybe.tasks.map((t, i) => requireTask(t, `${where} milestone #${i}`));
  return { id, title, tasks };
}

/**
 * Validate an arbitrary payload as a PlanDocument. The document is an object
 * with a `milestones` array; milestones hold {id,title,tasks:[…]} and tasks
 * hold {id,title,status,ownerPersonaId?,note?}. Error messages name the
 * field path only — never the offending value (document content is user data
 * and must not cross errors/audit).
 */
export function validateDocument(raw: unknown): PlanDocument {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw planError('invalid_input', 'plan document must be an object');
  }
  const maybe = raw as { milestones?: unknown };
  if (!Array.isArray(maybe.milestones)) {
    throw planError('invalid_input', 'plan document milestones must be an array');
  }
  const milestones = maybe.milestones.map((m, i) => requireMilestone(m, `milestone #${i}`));
  // Globally-unique ids (M5 review finding 2): duplicates make status
  // lookups ambiguous, so reject them up front.
  const milestoneIds = new Set<string>();
  const taskIds = new Set<string>();
  for (const milestone of milestones) {
    if (milestoneIds.has(milestone.id)) {
      throw planError('invalid_input', `duplicate milestone id: ${milestone.id}`);
    }
    milestoneIds.add(milestone.id);
    for (const task of milestone.tasks) {
      if (taskIds.has(task.id)) {
        throw planError('invalid_input', `duplicate task id: ${task.id}`);
      }
      taskIds.add(task.id);
    }
  }
  return { milestones };
}

function parseBodyInput(input: unknown): PlanInput {
  if (input === null || typeof input !== 'object') {
    throw planError('invalid_input', 'body must be an object');
  }
  const maybe = input as { title?: unknown; description?: unknown };
  if (maybe.title === undefined) {
    throw planError('invalid_input', 'title is required');
  }
  const title = requireTitle(maybe.title);
  let description: string | undefined;
  if (maybe.description !== undefined && maybe.description !== null) {
    if (typeof maybe.description !== 'string') {
      throw planError('invalid_input', 'description must be a string');
    }
    description = maybe.description;
  }
  return { title, ...(description !== undefined ? { description } : {}) };
}

function parsePatch(input: unknown): PlanPatch {
  if (input === null || typeof input !== 'object') {
    throw planError('invalid_input', 'body must be an object');
  }
  const maybe = input as {
    title?: unknown;
    description?: unknown;
    document?: unknown;
  };
  const patch: PlanPatch = {};
  if (maybe.title !== undefined) patch.title = requireTitle(maybe.title);
  if (maybe.description !== undefined) {
    // null explicitly clears the stored description.
    patch.description =
      maybe.description === null
        ? null
        : requireOptionalDescription(maybe.description);
  }
  if (maybe.document !== undefined) patch.document = validateDocument(maybe.document);
  return patch;
}

/** Searchable plan text = title + description + flattened milestone/task
 *  TITLES (PLAN-M5 — no task note content, no ids). */
export function planSearchText(plan: {
  title: string;
  description: string | null;
  document: PlanDocument;
}): string {
  const parts: string[] = [plan.title];
  if (plan.description !== null && plan.description !== '') parts.push(plan.description);
  for (const milestone of plan.document.milestones) {
    parts.push(milestone.title);
    for (const task of milestone.tasks) parts.push(task.title);
  }
  return parts.join(' ');
}

export function createPlanManager(options: PlanManagerOptions): PlanManager {
  const { stores, audit } = options;
  const now = options.now ?? Date.now;

  function persist(row: PlanRow): void {
    stores.plans.insert(row);
    stores.fts.upsertPlan(row.id, planSearchText(toPlan(row)));
  }

  function requireRow(id: string): PlanRow {
    const row = stores.plans.findById(id);
    if (!row) throw planError('not_found', 'plan not found');
    return row;
  }

  function create(input: PlanInput): Plan {
    const { title, description } = parseBodyInput(input);
    const at = now();
    const row: PlanRow = {
      id: randomUUID(),
      title,
      description: description ?? null,
      document: JSON.stringify({ milestones: [] }),
      createdAt: at,
      updatedAt: at,
    };
    persist(row);
    const plan = toPlan(row);
    audit.log('web', 'plan.create', row.id, {
      titleLength: plan.title.length,
      descriptionLength: plan.description?.length ?? 0,
      taskCount: 0,
    });
    return plan;
  }

  function update(id: string, patchIn: PlanPatch): Plan {
    const row = requireRow(id);
    const patch = parsePatch(patchIn);
    const at = now();
    const rowPatch: PlanRowPatch = { updatedAt: at };
    if (patch.title !== undefined) rowPatch.title = patch.title;
    if (patch.description !== undefined) rowPatch.description = patch.description;
    if (patch.document !== undefined) rowPatch.document = JSON.stringify(patch.document);
    stores.plans.update(id, rowPatch);
    const updated = requireRow(id);
    stores.fts.upsertPlan(id, planSearchText(toPlan(updated)));
    audit.log('web', 'plan.update', id, {
      titleLength: updated.title.length,
      descriptionLength: updated.description?.length ?? 0,
      taskCount: toPlan(updated).document.milestones.flatMap((m) => m.tasks).length,
    });
    return toPlan(updated);
  }

  function remove(id: string): void {
    const row = requireRow(id);
    stores.plans.remove(id);
    stores.fts.deleteRef('plan', id);
    audit.log('web', 'plan.delete', id, {
      titleLength: row.title.length,
    });
  }

  function list(): PlanSummary[] {
    return stores.plans
      .list()
      .map(toSummary)
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  function get(id: string): Plan | null {
    const row = stores.plans.findById(id);
    return row ? toPlan(row) : null;
  }

  function setTaskStatus(planId: string, taskId: string, input: TaskStatusInput): Plan {
    const row = requireRow(planId);
    const document = parseDocumentStored(row.document);
    if (typeof taskId !== 'string' || taskId.trim() === '') {
      throw planError('invalid_input', 'taskId must be a non-empty string');
    }
    if (input === null || typeof input !== 'object') {
      throw planError('invalid_input', 'body must be an object');
    }
    const status = requireStatus((input as { status?: unknown }).status);
    let note: string | undefined;
    if ((input as { note?: unknown }).note !== undefined) {
      if (typeof (input as { note?: unknown }).note !== 'string') {
        throw planError('invalid_input', 'note must be a string');
      }
      note = (input as { note?: unknown }).note as string;
    }

    let milestoneId: string | null = null;
    let found: PlanTask | null = null;
    for (const milestone of document.milestones) {
      const task = milestone.tasks.find((t) => t.id === taskId);
      if (task) {
        milestoneId = milestone.id;
        found = task;
        break;
      }
    }
    if (found === null) {
      throw planError('not_found', 'task not found');
    }

    // Apply the transition: status always; an EXPLICIT note replaces the
    // previous one (an empty string clears it); an omitted note preserves the
    // existing note (M5 review finding 3 — a status-only toggle must not wipe
    // a blocked-reason).
    const updatedTask: PlanTask = { ...found, status };
    if (note !== undefined) updatedTask.note = note;

    for (const milestone of document.milestones) {
      if (milestone.id !== milestoneId) continue;
      milestone.tasks = milestone.tasks.map((t) => (t.id === taskId ? updatedTask : t));
    }

    const at = now();
    const rowPatch: PlanRowPatch = { document: JSON.stringify(document), updatedAt: at };
    stores.plans.update(planId, rowPatch);
    const updated = requireRow(planId);
    stores.fts.upsertPlan(planId, planSearchText(toPlan(updated)));
    audit.log('web', 'plan.setTaskStatus', planId, {
      taskId,
      taskTitleLength: found.title.length,
      milestoneId,
      status: updatedTask.status,
      noteLength: updatedTask.note !== undefined ? updatedTask.note.length : 0,
      planTitleLength: updated.title.length,
    });
    return toPlan(updated);
  }

  function exportPlan(id: string): PlanExportBundle {
    const row = requireRow(id);
    return { schema: 'plan/v1', exportedAt: now(), plan: toPlan(row) };
  }

  return { create, update, remove, list, get, setTaskStatus, exportPlan };
}
