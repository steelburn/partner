/**
 * Grant manager (M2) — the (tool, project) allow-list over the plain row
 * store. Deny-by-default lives in the broker: a tool call executes ONLY when
 * hasGrant() is true. Expiry is enforced at READ time (a row past expires_at
 * counts as absent without being deleted), so clocks and revokes stay simple.
 *
 * No audit here: routes/broker own audit rows. No key material, ever.
 */
import { randomUUID } from 'node:crypto';
import type { GrantRecord, ToolId } from '@partner/shared/tools.js';
import { toolError } from './errors.js';
import type { GrantRow, GrantStore } from '../stores/types.js';

export interface GrantManagerOptions {
  store: GrantStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface GrantAddOptions {
  /** Epoch ms ttl; omitted = never expires. */
  ttlMs?: number;
  note?: string;
}

export interface GrantManager {
  /**
   * Persist a user grant for (tool, project). Validates non-empty ids only —
   * the broker/route layer verifies the tool exists and the project root is
   * registered (managers stay decoupled from the manifest registry).
   */
  add(toolId: string, projectId: string, opts?: GrantAddOptions): GrantRecord;
  /** Active grants only (expired rows are hidden at read). */
  list(): GrantRecord[];
  /** True while an ACTIVE (non-expired) grant covers (tool, project). */
  hasGrant(toolId: string, projectId: string, at?: number): boolean;
  /** The first ACTIVE grant covering (tool, project), for audit traceability. */
  activeGrant(toolId: string, projectId: string, at?: number): GrantRecord | null;
  /** Revoke by id; throws not_found when absent (or already expired). */
  remove(id: string): void;
}

function toRecord(row: GrantRow): GrantRecord {
  return {
    id: row.id,
    toolId: row.toolId as ToolId,
    projectId: row.projectId,
    source: 'user',
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    ...(row.note !== null && row.note !== '' ? { note: row.note } : {}),
  };
}

export function createGrantManager(options: GrantManagerOptions): GrantManager {
  const { store } = options;
  const now = options.now ?? Date.now;

  function active(row: GrantRow, at: number): boolean {
    return row.expiresAt === null || row.expiresAt > at;
  }

  function add(toolId: string, projectId: string, opts: GrantAddOptions = {}): GrantRecord {
    const tool = typeof toolId === 'string' ? toolId.trim() : '';
    const project = typeof projectId === 'string' ? projectId.trim() : '';
    if (tool === '' || project === '') {
      throw toolError('bad_params', 'toolId and projectId are required');
    }
    const ttl = opts.ttlMs;
    if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
      throw toolError('bad_params', 'ttlMs must be a positive number of ms');
    }
    const at = now();
    const id = randomUUID();
    const row: GrantRow = {
      id,
      toolId: tool,
      projectId: project,
      source: 'user',
      createdAt: at,
      expiresAt: ttl === undefined ? null : at + ttl,
      note: opts.note !== undefined && opts.note.trim() !== '' ? opts.note.trim() : null,
    };
    store.insert(row);
    return toRecord(row);
  }

  function list(): GrantRecord[] {
    const at = now();
    return store
      .list()
      .filter((row) => active(row, at))
      .map(toRecord);
  }

  function hasGrant(toolId: string, projectId: string, at?: number): boolean {
    return activeGrant(toolId, projectId, at) !== null;
  }

  function activeGrant(toolId: string, projectId: string, at?: number): GrantRecord | null {
    const checkAt = at ?? now();
    const row = store
      .list()
      .find((r) => r.toolId === toolId && r.projectId === projectId && active(r, checkAt));
    return row ? toRecord(row) : null;
  }

  function remove(id: string): void {
    const row = store.findById(id);
    if (!row) throw toolError('not_found', 'grant not found');
    store.remove(id);
  }

  return { add, list, hasGrant, activeGrant, remove };
}
