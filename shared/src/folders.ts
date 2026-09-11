/**
 * M11 F11 folder wire contracts (PLAN-M11.md).
 *
 * Folders organize conversations into a user tree (the user's "Projects /
 * Folders"). A folder is a row in `folders`; conversations carry an optional
 * folder_id (NULL = Inbox). The tree is arbitrary depth but cycle-free and
 * bounded (manager-enforced); clients render it flat and build the tree from
 * parentId themselves.
 */

export interface Folder {
  id: string;
  name: string;
  /** Parent folder id; null = root (rail top level). */
  parentId: string | null;
  /** Sibling order (0-based, append by default). */
  position: number;
  /** Conversations directly inside this folder (not descendants). */
  chatCount: number;
  /** M17: notes directly in this folder (not descendants). */
  noteCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface FolderInput {
  name: string;
  /** Optional parent folder; null/absent = root. */
  parentId?: string;
}

export interface FolderUpdate {
  name?: string;
  /** Move under another folder (or null/'' = root). Cycle-free (manager). */
  parentId?: string | null;
}

/** Conversation move/rename body for PUT /v1/conversations/:id. */
export interface ConversationUpdateInput {
  title?: string;
  /** Folder id to move under, or null/'' to move to Inbox. */
  folderId?: string | null;
}
