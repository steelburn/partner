/**
 * M34/M35 — the Folders section (M34 entry in PLAN.md §15; M35 spec:
 * PLAN-M35.md).
 *
 * M34 created the page: a chat session has two independent organizations — the
 * persona that runs it (the tree under Personas, M32) and the folder it is
 * FILED in (this page). They are orthogonal on purpose: filing a chat here
 * never touches `personaId`.
 *
 * M35 reshapes the page into an Explorer: "Make Folders view somewhat similar
 * to Windows Explorer view. We should be able to have subfolders too, with this
 * kind of organization." The folder support has been nested since M11 (`folders`
 * carry a `parentId`), but the page only ever showed one tree, so "inside this
 * folder" and "everything below it" were the same picture. Now there are two
 * panes, as in Explorer:
 *
 *   navigation pane  the folder tree — `board`, the SAME `ConversationRail`
 *                    in its `nav` mode (folders only, selectable, with its own
 *                    create / rename / delete / add-subfolder controls)
 *   contents pane    `FolderContents` — the selected folder's subfolders and
 *                    chats, with the address bar (Up + breadcrumbs) above them
 *
 * Both panes read ONE tree (`buildFolderTree`), so the navigation pane and the
 * contents pane cannot disagree about nesting or about which chats are filed
 * where. The page itself still owns only the FRAME: it does not build a second
 * folder row, and it holds no copy of a chat row's controls — those are the
 * shared `FolderActions` / `ChatActions` components the rail renders too. That
 * is the M32 lesson (a control that exists twice drifts), kept intact.
 *
 * The page's own state is the selection; the shell owns it (App) because the
 * navigation pane is passed in as `board`. The selection is CLAMPED against the
 * folder list: a folder deleted while it was open falls back to the root rather
 * than showing an empty page for something that no longer exists — the same
 * honest reading `folderStats` uses for a dangling chat `folderId`.
 *
 * The stats line is derived from the two lists, so a chat pointing at a folder
 * that no longer exists counts as unfiled.
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ConversationSummary, Folder } from '@partner/shared';
import FolderContents from './FolderContents.js';
import { buildFolderTree, folderPath, type FolderNode } from './lib/folder-tree.js';

export interface FoldersViewProps {
  /** Flat folder list (M11 F11); null while loading. */
  folders: Folder[] | null;
  /** Conversation summaries (M3); null while loading. */
  conversations: ConversationSummary[] | null;
  /** The folder shown in the contents pane; null = the root ("All folders"). */
  selectedFolderId: string | null;
  /** Select a folder (from the breadcrumbs, Up, or an empty state). */
  onSelectFolder: (folderId: string | null) => void;
  /**
   * Start a chat. The rail's own "New chat" head is suppressed in its `nav`
   * mode (a full-width primary bar would read as the page's action), so the
   * page header carries it — which is also what makes the empty state's "start
   * with New chat" land on a control that is present.
   */
  onNewChat: () => void;
  /** A chat is being created server-side. */
  creatingChat?: boolean;
  /** Locked while a turn streams (rows must not switch mid-turn). */
  disabled?: boolean;
  /** The open chat, highlighted in the contents list. */
  activeConversationId?: string | null;
  onOpenChat: (conversationId: string) => void;
  onDeleteChat: (conversationId: string) => Promise<void> | void;
  onMoveChat: (conversationId: string, folderId: string | null) => Promise<void> | void;
  /** Create a folder inside `parentId` (the shown folder, or the root). */
  onCreateFolder: (name: string, parentId: string | null) => Promise<void> | void;
  onRenameFolder: (folderId: string, name: string) => Promise<void> | void;
  onDeleteFolder: (folderId: string) => Promise<void> | void;
  /** The navigation pane — the embedded rail in its `nav` mode (see above). */
  board: ReactNode;
}

export interface FolderStats {
  /** Folders in the tree (every depth). */
  folders: number;
  /** Chats filed in an existing folder. */
  filed: number;
  /** Chats in Inbox — no folder, or a folder that no longer exists. */
  unfiled: number;
  /** Every chat the two lists agree on. */
  total: number;
}

/** Count the two organizations without trusting a dangling folder id. */
export function folderStats(
  folders: readonly Folder[] | null,
  conversations: readonly ConversationSummary[] | null,
): FolderStats {
  const known = new Set((folders ?? []).map((folder) => folder.id));
  const chats = conversations ?? [];
  let filed = 0;
  for (const chat of chats) {
    if (chat.folderId !== null && chat.folderId !== undefined && known.has(chat.folderId)) {
      filed += 1;
    }
  }
  return {
    folders: known.size,
    filed,
    unfiled: chats.length - filed,
    total: chats.length,
  };
}

/** "3 folders · 7 chats (4 filed)" — only the parts that carry information. */
export function statsLine(stats: FolderStats): string {
  if (stats.total === 0 && stats.folders === 0) return '';
  const folders = `${stats.folders} folder${stats.folders === 1 ? '' : 's'}`;
  const chats = `${stats.total} chat${stats.total === 1 ? '' : 's'}`;
  if (stats.filed === 0) return `${folders} · ${chats}, none filed yet`;
  return `${folders} · ${chats} (${stats.filed} filed, ${stats.unfiled} in Inbox)`;
}

/** "7 items" / "1 item" — the address bar's count for the open folder. */
export function itemsLabel(count: number): string {
  return `${count} item${count === 1 ? '' : 's'}`;
}

export default function FoldersView({
  folders,
  conversations,
  selectedFolderId,
  onSelectFolder,
  onNewChat,
  creatingChat = false,
  disabled = false,
  activeConversationId = null,
  onOpenChat,
  onDeleteChat,
  onMoveChat,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  board,
}: FoldersViewProps) {
  const stats = folderStats(folders, conversations);
  const line = statsLine(stats);
  const tree = useMemo(() => buildFolderTree(folders, conversations), [folders, conversations]);

  /** Clamp: a selected folder that no longer exists reads as the root. */
  const currentId =
    selectedFolderId !== null && tree.byId.has(selectedFolderId) ? selectedFolderId : null;
  const current: FolderNode | null = currentId === null ? null : (tree.byId.get(currentId) as FolderNode);
  const path = folderPath(tree.folders, currentId);
  const subfolders = current === null ? tree.roots : current.children;
  const chats = current === null ? tree.inboxChats : current.chats;

  /** One Create field, opened by the toolbar or by a row's “add subfolder”. */
  const [creating, setCreating] = useState(false);
  const [createParent, setCreateParent] = useState<string | null>(null);

  const startCreate = (parentId: string | null): void => {
    setCreateParent(parentId);
    setCreating(true);
  };

  const submitNewFolder = async (name: string): Promise<void> => {
    setCreating(false);
    await onCreateFolder(name, createParent);
  };

  /* The row's “+”: enter that folder first, so the field that opens is visibly
   * inside the folder the user pointed at, and the new folder appears in the
   * list it was created from. */
  const addSubfolder = (folderId: string): void => {
    onSelectFolder(folderId);
    startCreate(folderId);
  };

  return (
    <section className="folders" aria-label="Folders">
      <div className="folders-panel">
        <div className="page-head">
          <div className="page-head-titles">
            <div className="kicker">Organize</div>
            <h1 className="page-title">Folders</h1>
          </div>
          <div className="page-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={onNewChat}
              disabled={disabled || creatingChat}
              aria-busy={creatingChat}
            >
              {creatingChat ? 'Starting…' : 'New chat'}
            </button>
          </div>
        </div>
        <p className="page-copy">
          Where chat sessions are filed. This is the folder half of a session's organization —
          the persona that runs it lives under <strong>Personas</strong>, and the two are
          independent: filing a chat here never changes its persona, and switching persona never
          moves it out of its folder.
        </p>
        {line === '' ? null : (
          <p className="folders-stats" aria-live="polite">
            {line}
          </p>
        )}

        <div className="explorer">
          <div className="explorer-toolbar">
            <button
              type="button"
              className="btn btn-secondary btn-sm explorer-up"
              onClick={() => onSelectFolder(current?.parentId ?? null)}
              disabled={disabled || current === null}
              aria-label="Go up one folder"
              title="Up one folder"
            >
              ↑ Up
            </button>
            <nav className="explorer-crumbs" aria-label="Folder path">
              <button
                type="button"
                className="explorer-crumb"
                aria-current={current === null ? 'page' : undefined}
                onClick={() => onSelectFolder(null)}
              >
                All folders
              </button>
              {path.map((crumb) => (
                <span key={crumb.id} className="explorer-crumb-part">
                  <span className="explorer-crumb-sep" aria-hidden="true">
                    ›
                  </span>
                  <button
                    type="button"
                    className="explorer-crumb"
                    aria-current={current?.id === crumb.id ? 'page' : undefined}
                    onClick={() => onSelectFolder(crumb.id)}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </nav>
            <span className="explorer-count">{itemsLabel(subfolders.length + chats.length)}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm explorer-new-folder"
              onClick={() => (creating ? setCreating(false) : startCreate(current?.id ?? null))}
              disabled={disabled}
              aria-expanded={creating}
            >
              {current === null ? '+ New folder' : '+ New subfolder'}
            </button>
          </div>

          <div className="explorer-body">
            <div className="explorer-nav">{board}</div>            {/* Keyed by folder: moving between folders starts with a clean
              * Create field and rename draft, and never carries a half-typed
              * name into a folder it was not meant for. */}
            <FolderContents
              key={current?.id ?? 'root'}
              folder={current}
              folders={tree.folders}
              subfolders={subfolders}
              chats={chats}
              activeConversationId={activeConversationId}
              creating={creating}
              onStartCreate={() => startCreate(current?.id ?? null)}
              onCancelCreate={() => setCreating(false)}
              onCreateFolder={submitNewFolder}
              onEnterFolder={onSelectFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onAddSubfolder={addSubfolder}
              onOpenChat={onOpenChat}
              onMoveChat={onMoveChat}
              onDeleteChat={onDeleteChat}
              disabled={disabled}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
