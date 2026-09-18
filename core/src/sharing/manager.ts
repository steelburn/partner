/**
 * Cross-user shares (M29) — a note or asset one person hands to another.
 *
 * ## Why a snapshot and not a live reference
 *
 * M22's per-user partitions make "a query cannot cross users" structural: two
 * users never open the same database, so there is no filter to forget. A share
 * route that read the owner's note on each grantee request would undo exactly
 * that property — it would be a standing cross-partition read, and it would stop
 * working the moment the owner signed out (their key leaves memory).
 *
 * So sharing COPIES what is being shared into the system database. The grantee
 * reads a copy; the owner can refresh it (push their current edit) or revoke it.
 * The copy is honest about being a copy, which is why the UI calls it a shared
 * copy rather than pretending to be live.
 *
 * Everything here is metadata + owner content; nothing is ever audited beyond
 * ids and counts.
 */
import { randomUUID } from 'node:crypto';
import type { ShareKind } from '@partner/shared';
import type { ShareRow, ShareStore } from '../stores/types.js';

/** An active share as a list returns it: no body (lists stay small). */
export interface ShareRecord {
  id: string;
  ownerId: string;
  kind: ShareKind;
  resourceId: string;
  conversationId: string | null;
  granteeId: string;
  permission: string;
  title: string;
  /** Body length, so a list can show size without shipping the content. */
  bodyChars: number;
  createdAt: number;
  updatedAt: number;
}

/** One share WITH its snapshot body (the read view / import path). */
export interface ShareDetail extends ShareRecord {
  body: string;
  /** Parsed `meta` JSON, or null when the row carried none. */
  meta: Record<string, unknown> | null;
}

export interface CreateShareInput {
  ownerId: string;
  kind: ShareKind;
  resourceId: string;
  conversationId?: string | null;
  granteeId: string;
  permission?: string;
  title: string;
  body: string;
  meta?: Record<string, unknown> | null;
}

export interface ShareManagerOptions {
  store: ShareStore;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface ShareManager {
  create(input: CreateShareInput): ShareDetail;
  listSent(ownerId: string): ShareRecord[];
  listReceived(granteeId: string): ShareRecord[];
  /** A share the caller OWNS. Null when absent, revoked, or someone else's. */
  getSent(id: string, ownerId: string): ShareDetail | null;
  /** A share granted TO the caller. Null when absent, revoked, or not theirs. */
  getReceived(id: string, granteeId: string): ShareDetail | null;
  /** Owner pushes the current content into the copy. Null when not the owner. */
  refresh(
    id: string,
    ownerId: string,
    content: { title: string; body: string; meta?: Record<string, unknown> | null },
  ): ShareDetail | null;
  revoke(id: string, ownerId: string): boolean;
}

const MAX_PERMISSION_CHARS = 16;

function toRecord(row: ShareRow): ShareRecord {
  return {
    id: row.id,
    ownerId: row.ownerId,
    kind: row.kind,
    resourceId: row.resourceId,
    conversationId: row.conversationId,
    granteeId: row.granteeId,
    permission: row.permission,
    title: row.title,
    bodyChars: row.body.length,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function parseMeta(raw: string | null): Record<string, unknown> | null {
  if (raw === null || raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function toDetail(row: ShareRow): ShareDetail {
  return { ...toRecord(row), body: row.body, meta: parseMeta(row.meta) };
}

export function createShareManager(options: ShareManagerOptions): ShareManager {
  const { store } = options;
  const now = options.now ?? Date.now;

  /** A row is visible only while unrevoked and owned/granted as asked. */
  function active(id: string): ShareRow | undefined {
    const row = store.findById(id);
    return row === undefined || row.revokedAt !== null ? undefined : row;
  }

  return {
    create(input: CreateShareInput): ShareDetail {
      const at = now();
      const permission =
        typeof input.permission === 'string' && input.permission.trim() !== ''
          ? input.permission.trim().slice(0, MAX_PERMISSION_CHARS)
          : 'read';
      const meta = input.meta ?? null;
      const row: ShareRow = {
        id: randomUUID(),
        ownerId: input.ownerId,
        kind: input.kind,
        resourceId: input.resourceId,
        conversationId: input.conversationId ?? null,
        granteeId: input.granteeId,
        permission,
        title: input.title,
        body: input.body,
        meta: meta === null ? null : JSON.stringify(meta),
        createdAt: at,
        updatedAt: at,
        revokedAt: null,
      };
      store.insert(row);
      return toDetail(row);
    },

    listSent(ownerId: string): ShareRecord[] {
      return store.listByOwner(ownerId).map(toRecord);
    },

    listReceived(granteeId: string): ShareRecord[] {
      return store.listByGrantee(granteeId).map(toRecord);
    },

    getSent(id: string, ownerId: string): ShareDetail | null {
      const row = active(id);
      return row !== undefined && row.ownerId === ownerId ? toDetail(row) : null;
    },

    getReceived(id: string, granteeId: string): ShareDetail | null {
      const row = active(id);
      return row !== undefined && row.granteeId === granteeId ? toDetail(row) : null;
    },

    refresh(id, ownerId, content): ShareDetail | null {
      const meta = content.meta ?? null;
      const changed = store.refresh(
        id,
        ownerId,
        content.title,
        content.body,
        meta === null ? null : JSON.stringify(meta),
        now(),
      );
      return changed ? this.getSent(id, ownerId) : null;
    },

    revoke(id: string, ownerId: string): boolean {
      return store.revoke(id, ownerId, now());
    },
  };
}
