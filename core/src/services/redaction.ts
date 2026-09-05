/**
 * Redaction service — the single serialization point for audit rows.
 *
 * Every audit write funnels through {@link auditLog}, which serializes
 * `details` with the shared redaction helpers BEFORE it touches storage, so a
 * secret that slips into a details object can never reach the audit_log
 * table, request logs, or any downstream consumer.
 */
import { redactJson, redactString, redactValue } from '@partner/shared';
import type { AuditQuery, AuditRow, AuditStore } from '../stores/types.js';

export { redactJson, redactString, redactValue };

export interface AuditService {
  /**
   * Record an audit row. `details` is redacted with {@link redactJson} at the
   * single serialization point — never pass pre-serialized secret text here.
   */
  log(actor: string, action: string, target: string, details: unknown): void;
  /** Newest first, capped at limit (used by GET /v1/audit). */
  list(limit: number): AuditRow[];
  /** Newest first with optional actor/action/q filters, capped at limit. */
  query(criteria: AuditQuery): AuditRow[];
}

export function auditLog(deps: { store: AuditStore; now?: () => number }): AuditService {
  const now = deps.now ?? Date.now;
  return {
    log(actor: string, action: string, target: string, details: unknown): void {
      deps.store.add(actor, action, target, redactJson(details), now());
    },
    list(limit: number): AuditRow[] {
      return deps.store.list(limit);
    },
    query(criteria: AuditQuery): AuditRow[] {
      return deps.store.listFiltered(criteria);
    },
  };
}
