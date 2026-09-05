/**
 * M10 audit log client (PLAN-M10 W4): GET /v1/audit with optional
 * actor/action/q filters over the core's redacted audit rows.
 *
 * Follows the M0–M8 chokepoint rules (see lib/api.ts): token travels only as
 * `Authorization: Bearer …`; transport injectable for tests; non-2xx maps
 * to ApiRequestError. Rows are redacted by the core BEFORE storage — nothing
 * in this module ever receives (or can leak) a secret.
 */
import { ApiRequestError, expectJson } from './api.js';
import type { FetchLike } from './api.js';

export interface AuditEntry {
  id: number;
  actor: string;
  action: string;
  target: string;
  /** Redacted JSON string (never raw secrets). */
  details: string;
  createdAt: number;
}

export interface AuditFilter {
  /** Newest-first cap (default 100, core caps at 500). */
  limit?: number;
  actor?: string;
  action?: string;
  q?: string;
}

export interface AuditResult {
  entries: AuditEntry[];
}

const AUDIT_PATH = '/v1/audit';

/** GET /v1/audit?limit&actor&action&q -> newest-first redacted entries. */
export async function listAudit(
  token: string,
  options: { filter?: AuditFilter; fetchImpl?: FetchLike } = {},
): Promise<AuditEntry[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const filter = options.filter ?? {};
  const params = new URLSearchParams();
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  if (filter.actor !== undefined && filter.actor !== '') params.set('actor', filter.actor);
  if (filter.action !== undefined && filter.action !== '') params.set('action', filter.action);
  if (filter.q !== undefined && filter.q !== '') params.set('q', filter.q);
  const query = params.toString();
  const response = await fetchImpl(`${AUDIT_PATH}${query === '' ? '' : `?${query}`}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  if (parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as AuditResult).entries)) {
    return (parsed as AuditResult).entries;
  }
  throw new ApiRequestError(response.status, 'The audit response had an unexpected shape.');
}
