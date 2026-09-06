/**
 * M14 schedule API client (PLAN-M14.md S6).
 *
 * Same chokepoint rules as every other client (lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; non-2xx maps to
 * ApiRequestError with a readable message. Schedule definitions ride the
 * persona surface (no CRUD here) — this file only covers the run-now action
 * and the run-history reads. Run rows are owner data; nothing here logs or
 * stores schedule prompts.
 */
import { ApiRequestError, expectJson, type FetchLike } from './api.js';

export type { FetchLike };

export interface ScheduleRun {
  id: string;
  personaId: string;
  scheduleId: string;
  /** Snapshot label at run time (owner data). */
  label: string;
  /** running|done|queued|error|loop_exhausted */
  status: string;
  conversationId: string | null;
  pendingId: string | null;
  toolCalls: number;
  rounds: number;
  model: string | null;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  /** Whether the run is still live (running/queued). */
  live: boolean;
}

function isRun(value: unknown): value is ScheduleRun {
  const record = value as Record<string, unknown> | null;
  return (
    record !== null &&
    typeof record === 'object' &&
    typeof record.id === 'string' &&
    typeof record.personaId === 'string' &&
    typeof record.status === 'string'
  );
}

/** POST /v1/personas/:id/schedules/:scheduleId/run-now (headless fire). */
export async function runScheduleNow(
  token: string,
  personaId: string,
  scheduleId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ runId: string; status: string; conversationId: string | null }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `/v1/personas/${encodeURIComponent(personaId)}/schedules/${encodeURIComponent(scheduleId)}/run-now`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    },
  );
  const value = await expectJson(response);
  const record = value as Record<string, unknown> | null;
  if (record === null || typeof record.runId !== 'string') {
    throw new ApiRequestError(response.status, 'The run-now response had an unexpected shape.');
  }
  return {
    runId: record.runId,
    status: typeof record.status === 'string' ? record.status : 'running',
    conversationId: typeof record.conversationId === 'string' ? record.conversationId : null,
  };
}

/** GET /v1/schedules/runs -> newest first (persona/status/limit filters). */
export async function listScheduleRuns(
  token: string,
  filter: { personaId?: string; status?: string; limit?: number } = {},
  options: { fetchImpl?: FetchLike } = {},
): Promise<ScheduleRun[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const query = new URLSearchParams();
  if (filter.personaId !== undefined) query.set('personaId', filter.personaId);
  if (filter.status !== undefined) query.set('status', filter.status);
  if (filter.limit !== undefined) query.set('limit', String(filter.limit));
  const qs = query.toString();
  const response = await fetchImpl(`/v1/schedules/runs${qs === '' ? '' : `?${qs}`}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const value = await expectJson(response);
  const record = value as { runs?: unknown } | null;
  if (record === null || !Array.isArray(record.runs)) {
    throw new ApiRequestError(response.status, 'The runs response had an unexpected shape.');
  }
  return record.runs.filter(isRun);
}
