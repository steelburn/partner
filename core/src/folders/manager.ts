/**
 * M11 F11 folder manager (PLAN-M11.md).
 *
 * Owns the conversation-organizing tree: naming, sibling ordering (append at
 * position max+1), parent validation, CYCLE prevention on move, and the
 * delete cascade semantics (children reparent to the removed folder's
 * parent; conversations move to the removed folder's parent = Inbox when the
 * folder was a root). Chat content never crosses this surface; audit rows
 * carry folder ids/names only.
 *
 * The manager talks to the conversation manager for chat counts and folder
 * reassignment on delete — the conversations table is the edge owner.
 */
import { randomUUID } from 'node:crypto';
import type { Folder, FolderInput, FolderUpdate } from '@partner/shared';
import type { ConversationManager } from '../conversations/manager.js';
import type { AuditService } from '../services/redaction.js';
import type { FolderRow, FolderStore } from '../stores/types.js';
import { FolderError, folderError } from './errors.js';

/** Depth bound so a runaway tree can never be built (arbitrary but bounded). */
const MAX_DEPTH = 16;
const NAME_MAX = 120;

export interface FolderManagerOptions {
  store: FolderStore;
  /** Conversation manager — chat counts + reassignment on folder delete. */
  conversations: ConversationManager;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface FolderManager {
  /** All folders as a flat list (tree assembly is the client's). */
  list(): Folder[];
  get(id: string): Folder | null;
  /** Validate + insert at the end of its parent's sibling list. */
  create(input: FolderInput): Folder;
  /** Rename and/or move (parentId null = root). Cycle-guarded. */
  update(id: string, patch: FolderUpdate): Folder;
  /** Remove; children reparent to the removed folder's parent, chats to it too. */
  remove(id: string): void;
}

function toFolder(row: FolderRow, chatCount: number): Folder {
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    position: row.position,
    chatCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizeName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (name === '') throw folderError('invalid_input', 'name is required and must be non-empty');
  return name.length > NAME_MAX ? name.slice(0, NAME_MAX) : name;
}

export function createFolderManager(options: FolderManagerOptions): FolderManager {
  const { store, conversations, audit } = options;
  const now = options.now ?? Date.now;

  /** Direct chat counts per folder id (conversations with folder_id NULL are Inbox). */
  function chatCounts(): Map<string, number> {
    const counts = new Map<string, number>();
    for (const summary of conversations.list()) {
      if (summary.folderId !== null) {
        counts.set(summary.folderId, (counts.get(summary.folderId) ?? 0) + 1);
      }
    }
    return counts;
  }

  /** Depth of `id` from the root (0 = root) — used by the cycle guard. */
  function depthOf(id: string, seen: Set<string> = new Set()): number {
    const row = store.findById(id);
    if (!row || row.parentId === null) return 0;
    if (seen.has(row.parentId)) return MAX_DEPTH; // corrupt cycle — treat as max
    seen.add(row.parentId);
    return 1 + depthOf(row.parentId, seen);
  }

  function resolveParent(parentId: string | null | undefined): string | null {
    if (parentId === undefined || parentId === null || parentId === '') return null;
    if (!store.findById(parentId)) {
      throw folderError('not_found', 'parent folder not found');
    }
    return parentId;
  }

  function nextPosition(parentId: string | null): number {
    let max = -1;
    for (const row of store.list()) {
      if (row.parentId === parentId && row.position > max) max = row.position;
    }
    return max + 1;
  }

  function list(): Folder[] {
    const counts = chatCounts();
    return store.list().map((row) => toFolder(row, counts.get(row.id) ?? 0));
  }

  function get(id: string): Folder | null {
    const row = store.findById(id);
    if (!row) return null;
    const counts = chatCounts();
    return toFolder(row, counts.get(id) ?? 0);
  }

  function create(input: FolderInput): Folder {
    const body = (input ?? {}) as FolderInput;
    const name = normalizeName(body.name);
    const parentId = resolveParent(body.parentId);
    if (parentId !== null && depthOf(parentId) >= MAX_DEPTH - 1) {
      throw folderError('too_deep', `folders may nest at most ${MAX_DEPTH} levels`);
    }
    const at = now();
    const id = randomUUID();
    const position = nextPosition(parentId);
    const row: FolderRow = { id, name, parentId, position, createdAt: at, updatedAt: at };
    store.insert(row);
    audit.log('web', 'folder.create', id, { name, parentId, position });
    return toFolder(row, 0);
  }

  function update(id: string, patch: FolderUpdate): Folder {
    const existing = store.findById(id);
    if (!existing) throw folderError('not_found', 'folder not found');
    const body = (patch ?? {}) as FolderUpdate;
    const nextName = body.name !== undefined ? normalizeName(body.name) : existing.name;

    // Moving to a folder that is this folder or one of its descendants would
    // create a cycle — walk up from the candidate parent and refuse.
    let parentId: string | null | undefined;
    if (body.parentId !== undefined) {
      parentId = resolveParent(body.parentId);
      if (parentId !== null) {
        if (parentId === id) {
          throw folderError('cycle', 'a folder cannot be its own parent');
        }
        let cursor: string | null = parentId;
        const guard = new Set<string>();
        while (cursor !== null && !guard.has(cursor)) {
          if (cursor === id) {
            throw folderError('cycle', 'a folder cannot be moved under its own descendant');
          }
          guard.add(cursor);
          const parentRow = store.findById(cursor);
          cursor = parentRow?.parentId ?? null;
        }
        if (depthOf(parentId) >= MAX_DEPTH - 1) {
          throw folderError('too_deep', `folders may nest at most ${MAX_DEPTH} levels`);
        }
      }
    } else {
      parentId = existing.parentId;
    }

    const at = now();
    const patchRow: Parameters<FolderStore['update']>[1] = { updatedAt: at };
    if (nextName !== existing.name) patchRow.name = nextName;
    if (parentId !== existing.parentId) {
      patchRow.parentId = parentId;
      // Reposition under the new parent (append at its end).
      patchRow.position = nextPosition(parentId);
    }
    store.update(id, patchRow);
    audit.log('web', 'folder.update', id, { name: nextName, parentId });
    return toFolder({ ...existing, name: nextName, parentId, updatedAt: at }, 0);
  }

  function remove(id: string): void {
    const existing = store.findById(id);
    if (!existing) throw folderError('not_found', 'folder not found');
    const parentId = existing.parentId;
    const at = now();

    // Children reparent to the removed folder's parent (Inbox when root),
    // preserving their relative sibling order by appending.
    const children = store.list().filter((row) => row.parentId === id);
    let position = nextPosition(parentId);
    for (const child of children) {
      store.update(child.id, { parentId, position, updatedAt: at });
      position += 1;
    }

    // Direct conversations move with the folder's chats to the same target.
    for (const summary of conversations.list()) {
      if (summary.folderId === id) {
        conversations.update(summary.id, { folderId: parentId });
      }
    }

    store.remove(id);
    audit.log('web', 'folder.delete', id, {
      name: existing.name,
      children: children.length,
      parentId,
    });
  }

  return { list, get, create, update, remove };
}
