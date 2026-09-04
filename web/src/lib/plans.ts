/**
 * M5 plans API client (PLAN-M5.md).
 *
 * Same chokepoint rules as every other client (lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; transport is injectable
 * for tests; non-2xx maps to ApiRequestError with a readable message.
 * Redaction discipline: a plan document (milestone/task text) is the
 * OWNER's data — it flows to/from the UI untouched, but nothing in this
 * module logs, prints or embeds it in error text. Validation errors name
 * fields/indices, never content.
 */

import { ApiRequestError, expectJson, readErrorMessage, type FetchLike } from './api.js';
import { validateTaskStatusInput } from './note-helpers.js';
import type {
  Plan,
  PlanDocument,
  PlanInput,
  PlanMilestone,
  PlanTask,
  PlanSummary,
  TaskStatus,
  TaskStatusInput,
} from '@partner/shared';

const PLANS_PATH = '/v1/plans';
const TASK_PATH_PREFIX = '/tasks';
const EXPORT_SUFFIX = '/export';

export type { FetchLike };

/** Canonical download payload the UI saves as `<title>.partner-plan.json`. */
export interface PlanExportBundle {
  schema: 'plan/v1';
  exportedAt: number;
  plan: Plan;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function epoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

const STATUSES: readonly TaskStatus[] = ['open', 'done', 'blocked'];

/** Deep-check one task row; optional extras default safely. */
function parseTask(value: unknown, status: number, label: string): PlanTask {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.title !== 'string' ||
    typeof value.status !== 'string' ||
    !STATUSES.includes(value.status as TaskStatus)
  ) {
    throw new ApiRequestError(status, `${label} had an unexpected shape.`);
  }
  const task: PlanTask = {
    id: value.id,
    title: value.title,
    status: value.status as TaskStatus,
  };
  if (typeof value.ownerPersonaId === 'string' && value.ownerPersonaId.length > 0) {
    task.ownerPersonaId = value.ownerPersonaId;
  }
  if (typeof value.note === 'string' && value.note.length > 0) {
    task.note = value.note;
  }
  return task;
}

/** Deep-check one milestone row (tasks default to [] when absent). */
function parseMilestone(value: unknown, status: number, label: string): PlanMilestone {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    typeof value.title !== 'string'
  ) {
    throw new ApiRequestError(status, `${label} had an unexpected shape.`);
  }
  const rawTasks = Array.isArray(value.tasks) ? value.tasks : [];
  return {
    id: value.id,
    title: value.title,
    tasks: rawTasks.map((row, index) => parseTask(row, status, `${label} task ${index}`)),
  };
}

function parseDocument(value: unknown, status: number): PlanDocument {
  if (!isRecord(value) || !Array.isArray(value.milestones)) {
    throw new ApiRequestError(status, 'The plan document had an unexpected shape.');
  }
  return {
    milestones: value.milestones.map((row, index) => parseMilestone(row, status, `milestone ${index}`)),
  };
}

/**
 * Normalize one plan response into a full Plan (bare or {plan: …}). The
 * document is required for the full shape; summary counts are recomputed so
 * the planner always trusts the document it just saved.
 */
export function parsePlan(value: unknown, status = 200): Plan {
  const record = isRecord(value) ? value : null;
  const direct = record;
  const enveloped = record && isRecord(record.plan) ? record.plan : null;
  const plan = (enveloped ?? direct) as Record<string, unknown> | null;
  if (
    plan === null ||
    typeof plan.id !== 'string' ||
    plan.id.length === 0 ||
    typeof plan.title !== 'string' ||
    epoch(plan.createdAt) === null ||
    epoch(plan.updatedAt) === null
  ) {
    throw new ApiRequestError(status, 'The plan response had an unexpected shape.');
  }
  const description = typeof plan.description === 'string' ? plan.description : null;
  const document = parseDocument(plan.document, status);
  const taskCount = document.milestones.reduce((count, milestone) => count + milestone.tasks.length, 0);
  const doneCount = document.milestones.reduce(
    (count, milestone) =>
      count + milestone.tasks.filter((task) => task.status === 'done').length,
    0,
  );
  return {
    id: plan.id,
    title: plan.title,
    description,
    document,
    taskCount,
    doneCount,
    createdAt: epoch(plan.createdAt) as number,
    updatedAt: epoch(plan.updatedAt) as number,
  };
}

/**
 * Normalize a plan-list response ({plans: [...]} or a bare array) into
 * summaries. Rows need the summary identity fields; task/done counts default
 * to 0 when the core omitted them (the open-plan fetch recomputes).
 */
export function parsePlanList(value: unknown, status = 200): PlanSummary[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.plans)
      ? value.plans
      : null;
  if (list === null) {
    throw new ApiRequestError(status, 'The plans response had an unexpected shape.');
  }
  return list.map((row, index) => {
    if (
      !isRecord(row) ||
      typeof row.id !== 'string' ||
      row.id.length === 0 ||
      typeof row.title !== 'string' ||
      epoch(row.createdAt) === null ||
      epoch(row.updatedAt) === null
    ) {
      throw new ApiRequestError(status, `plan ${index} had an unexpected shape.`);
    }
    const fromDocument =
      isRecord(row.document) && Array.isArray(row.document.milestones)
        ? parseDocument(row.document, status)
        : null;
    const taskCount =
      fromDocument !== null
        ? fromDocument.milestones.reduce((count, milestone) => count + milestone.tasks.length, 0)
        : typeof row.taskCount === 'number' && Number.isFinite(row.taskCount)
          ? row.taskCount
          : 0;
    const doneCount =
      fromDocument !== null
        ? fromDocument.milestones.reduce(
            (count, milestone) =>
              count + milestone.tasks.filter((task) => task.status === 'done').length,
            0,
          )
        : typeof row.doneCount === 'number' && Number.isFinite(row.doneCount)
          ? row.doneCount
          : 0;
    return {
      id: row.id,
      title: row.title,
      description: typeof row.description === 'string' ? row.description : null,
      taskCount,
      doneCount,
      createdAt: epoch(row.createdAt) as number,
      updatedAt: epoch(row.updatedAt) as number,
    };
  });
}

function planPath(id: string): string {
  return `${PLANS_PATH}/${encodeURIComponent(id)}`;
}

/** GET /v1/plans -> plan summaries (never full documents). */
export async function listPlans(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<PlanSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(PLANS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parsePlanList(await expectJson<unknown>(response), response.status);
}

/** POST /v1/plans {title, description?} -> the created (empty) plan. */
export async function createPlan(
  token: string,
  input: PlanInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Plan> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(PLANS_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parsePlan(await expectJson<unknown>(response), response.status);
}

/** GET /v1/plans/:id -> the full plan document. */
export async function getPlan(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Plan> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(planPath(id), {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parsePlan(await expectJson<unknown>(response), response.status);
}

/** Input for a full-document replace (PUT): meta + the whole document. */
export interface PlanUpdateInput {
  title: string;
  description?: string | null;
  document: PlanDocument;
}

/**
 * PUT /v1/plans/:id — replace title/description/document in one audited
 * write (validate shape server-side). Returns the refreshed plan.
 */
export async function updatePlan(
  token: string,
  id: string,
  input: PlanUpdateInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Plan> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { title: input.title, document: input.document };
  if (input.description !== undefined) body.description = input.description;
  const response = await fetchImpl(planPath(id), {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  return parsePlan(await expectJson<unknown>(response), response.status);
}

/** DELETE /v1/plans/:id -> 204. */
export async function deletePlan(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(planPath(id), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
}

/**
 * POST /v1/plans/:id/tasks/:taskId {status, note?} — an audited status
 * transition with an optional note (e.g. why a task is blocked). Validated
 * locally first (status values + note length); the core validates existence
 * and re-checks the shape. Returns the refreshed plan.
 */
export async function setTaskStatus(
  token: string,
  planId: string,
  taskId: string,
  input: TaskStatusInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Plan> {
  const validationError = validateTaskStatusInput(input);
  if (validationError !== null) {
    throw new ApiRequestError(400, validationError);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const body: Record<string, unknown> = { status: input.status };
  if (input.note !== undefined && input.note !== null && input.note.trim().length > 0) {
    body.note = input.note.trim();
  }
  const response = await fetchImpl(`${planPath(planId)}${TASK_PATH_PREFIX}/${encodeURIComponent(taskId)}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  return parsePlan(await expectJson<unknown>(response), response.status);
}

/**
 * POST /v1/plans/:id/export -> a JSON export bundle. The core may answer
 * with the plan bare, wrapped under {plan} or as {schema:'plan/v1',
 * exportedAt, plan}; every shape normalizes to a canonical PlanExportBundle
 * (missing exportedAt uses now) so the downloaded file always carries the
 * schema marker the format implies.
 */
export async function exportPlan(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<PlanExportBundle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${planPath(id)}${EXPORT_SUFFIX}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  const outer = isRecord(parsed) ? parsed : null;
  // Priority 1: an already-canonical bundle (it itself carries a `plan`
  // member, so it must be recognised before the {plan: …} unwrap below).
  const canonical =
    outer !== null && outer.schema === 'plan/v1'
      ? outer
      : isRecord(outer?.bundle) && outer?.bundle.schema === 'plan/v1'
        ? outer.bundle
        : null;
  if (canonical !== null) {
    const plan = parsePlan(canonical.plan, response.status);
    const exportedAt = epoch(canonical.exportedAt) ?? Date.now();
    return { schema: 'plan/v1', exportedAt, plan };
  }
  // Priority 2: the plan wrapped under {plan}, or a bare plan — export time
  // is stamped client-side so the file always carries the schema marker.
  const planValue = outer !== null && isRecord(outer.plan) ? outer.plan : parsed;
  return { schema: 'plan/v1', exportedAt: Date.now(), plan: parsePlan(planValue, response.status) };
}
