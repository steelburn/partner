/**
 * M35 — folder plumbing in one place: the flat list the core sends becomes the
 * tree, the path, and the per-folder contents the UI renders.
 *
 * Why this module exists: M11 shipped the folder list and M17 the notes-scope
 * helpers (`folderSubtreeIds`, `folderTreeRows`) inside `note-helpers.ts`. The
 * moment a SECOND surface wanted the same tree — the conversation rail and the
 * Explorer-style Folders page — keeping the flattening in a notes file (or
 * copying it) would guarantee the two disagree about order, depth, or what a
 * dangling parent means. So the folder-shaped reads live here, `note-helpers`
 * re-exports the two functions it always owned (its existing callers keep
 * importing them from there), and both surfaces consume this module.
 *
 * The wire contract is unchanged (PLAN-M11.md): folders are flat rows with a
 * `parentId`; the client builds the tree. A folder whose parent id no longer
 * exists is **not** rendered anywhere (the same behaviour `folderTreeRows` has
 * always had) — the core re-parents children on delete, so that state means
 * corrupt data, and inventing a place for it here would be a second opinion.
 * A chat pointing at a folder that no longer exists reads as Inbox, the same
 * honest reading `folderStats` uses.
 *
 * Everything here is pure: no React, no I/O, so it is unit-testable and both
 * surfaces can derive from it per render without a shared cache to invalidate.
 */
import type { ConversationSummary, Folder } from '@partner/shared';
import { sortConversations } from './persona-helpers.js';

/** The folder id plus every descendant id, breadth-first (parent first). */
export function folderSubtreeIds(folders: readonly Folder[], id: string): string[] {
  if (!folders.some((folder) => folder.id === id)) return [];
  const out: string[] = [id];
  const queue: string[] = [id];
  const seen = new Set<string>([id]);
  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const folder of folders) {
      if (folder.parentId === current && !seen.has(folder.id)) {
        seen.add(folder.id);
        out.push(folder.id);
        queue.push(folder.id);
      }
    }
  }
  return out;
}

/** One row of the indented folder selector: folder + tree depth. */
export interface FolderTreeRow {
  folder: Folder;
  depth: number;
}

/**
 * Flatten folders into tree order (roots first, then their children) with a
 * depth per row for indentation in selectors and navigation panes. Sibling
 * order is `position` (the core's append order), name as the tie-break.
 */
export function folderTreeRows(folders: readonly Folder[]): FolderTreeRow[] {
  const byParent = new Map<string | null, Folder[]>();
  for (const folder of folders) {
    const list = byParent.get(folder.parentId) ?? [];
    list.push(folder);
    byParent.set(folder.parentId, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }
  const rows: FolderTreeRow[] = [];
  const walk = (parentId: string | null, depth: number): void => {
    for (const folder of byParent.get(parentId) ?? []) {
      rows.push({ folder, depth });
      walk(folder.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

/** A folder node with the chats filed directly in it. */
export interface FolderNode extends Folder {
  children: FolderNode[];
  /** Chats filed directly here, most recent first. */
  chats: ConversationSummary[];
  /** Chats in this folder AND everything under it — what an Items column means. */
  chatTotal: number;
  /**
   * Saved assets (M11 F10) belonging to those same chats — the Assets column.
   * A folder's own row sums its subtree, so a parent that visibly holds a
   * subtler child can never read 0 assets while the child holds some.
   */
  assetTotal: number;
}

export interface FolderTree {
  /** Root-level nodes, in sibling order. */
  roots: FolderNode[];
  /** Every node by id (nodes with a dangling parent are present here, but not
   *  reachable from `roots` — see the module comment). */
  byId: Map<string, FolderNode>;
  /** Chats with no folder (or a folder that no longer exists), newest first. */
  inboxChats: ConversationSummary[];
  /** Every folder, as the caller passed them. */
  folders: Folder[];
  /** Every chat the caller passed (filed + unfiled). */
  chats: ConversationSummary[];
}

/**
 * Build the folder tree, filing each chat into the node it points at. A chat
 * whose `folderId` names no folder lands in `inboxChats`: unfiled, never
 * invisible and never silently attached somewhere else.
 */
export function buildFolderTree(
  folders: readonly Folder[] | null,
  conversations: readonly ConversationSummary[] | null,
): FolderTree {
  const list = folders ?? [];
  const chats = conversations === null ? [] : sortConversations(conversations);
  const byId = new Map<string, FolderNode>();
  for (const folder of list) {
    byId.set(folder.id, { ...folder, children: [], chats: [], chatTotal: 0, assetTotal: 0 });
  }
  const roots: FolderNode[] = [];
  for (const folder of list) {
    const node = byId.get(folder.id) as FolderNode;
    if (folder.parentId === null || folder.parentId === undefined) {
      roots.push(node);
      continue;
    }
    // A dangling parent keeps the node OUT of the tree (exactly like
    // `folderTreeRows`) — it stays in `byId` so a selected folder and its
    // crumbs still resolve, and the core re-parents children on delete, so
    // reaching this state means corrupt data, not a user action to honour.
    byId.get(folder.parentId)?.children.push(node);
  }
  for (const node of byId.values()) {
    node.children.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  }
  roots.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const inboxChats: ConversationSummary[] = [];
  for (const chat of chats) {
    const node = chat.folderId === null || chat.folderId === undefined ? undefined : byId.get(chat.folderId);
    if (node === undefined) inboxChats.push(chat);
    else node.chats.push(chat);
  }
  // Direct + descendant chats, computed bottom-up so a parent's number counts
  // the subfolders it visibly contains. The asset total rides the same walk.
  const totals = new Map<string, { chats: number; assets: number }>();
  const total = (node: FolderNode): { chats: number; assets: number } => {
    const cached = totals.get(node.id);
    if (cached !== undefined) return cached;
    let chats = node.chats.length;
    let assets = node.chats.reduce((sum, chat) => sum + assetCountOf(chat), 0);
    for (const child of node.children) {
      const sub = total(child);
      chats += sub.chats;
      assets += sub.assets;
    }
    totals.set(node.id, { chats, assets });
    node.chatTotal = chats;
    node.assetTotal = assets;
    return { chats, assets };
  };
  for (const node of byId.values()) total(node);
  return { roots, byId, inboxChats, folders: [...list], chats };
}

/**
 * The chain of folders from the root down to `id` (inclusive) — the breadcrumb.
 * Unknown ids give `[]`, and a corrupt parent cycle cannot hang the read: the
 * walk is bounded by the list length.
 */
export function folderPath(folders: readonly Folder[] | null, id: string | null): Folder[] {
  if (id === null) return [];
  const byId = new Map((folders ?? []).map((folder) => [folder.id, folder]));
  const chain: Folder[] = [];
  const seen = new Set<string>();
  let cursor: string | null = id;
  while (cursor !== null && byId.has(cursor) && !seen.has(cursor)) {
    const folder = byId.get(cursor) as Folder;
    seen.add(cursor);
    chain.push(folder);
    cursor = folder.parentId;
  }
  chain.reverse();
  return chain;
}

/**
 * A chat's saved-asset count. The wire field is required, but a web bundle can
 * meet a core that predates it (dev mode: a core started before the upgrade), so
 * an absent count reads as 0 instead of rendering `undefined`.
 */
export function assetCountOf(chat: { assetCount?: number }): number {
  const count = chat.assetCount;
  return typeof count === 'number' && Number.isFinite(count) && count > 0 ? count : 0;
}

/**
 * Chats filed directly in `folderId` (`null` = Inbox/unfiled), newest first.
 * The same bucket the tree files them in, for surfaces that render one folder
 * at a time instead of the whole tree.
 */
export function folderChats(
  conversations: readonly ConversationSummary[] | null,
  folderId: string | null,
  folders: readonly Folder[] | null = null,
): ConversationSummary[] {
  const known = folders === null ? null : new Set(folders.map((folder) => folder.id));
  const filed = (conversations ?? []).filter((chat) => {
    const id = chat.folderId ?? null;
    if (id === null) return folderId === null;
    if (known !== null && !known.has(id)) return folderId === null;
    return id === folderId;
  });
  return sortConversations(filed);
}
