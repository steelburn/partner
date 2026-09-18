/**
 * M35 — the Folders page's contents pane: what is inside the selected folder.
 *
 * The request: "Make Folders view somewhat similar to Windows Explorer view. We
 * should be able to have subfolders too." So the page has a navigation pane
 * (the folder tree) and this list of the selected folder's contents — its
 * subfolders first, then the chats filed there — in Explorer's columns
 * (Name · Type · Items · Assets · Modified).
 *
 * Two disciplines this component must not break:
 *  1. **One definition per control.** The folder row's controls are
 *     `FolderActions`, the chat row's are `ChatActions` — the same components
 *     the conversation rail renders. A second hand-written copy is how the M32
 *     regression happened (folder controls that existed on one surface and not
 *     the other).
 *  2. **Honest numbers.** Items counts chats in the folder AND its subfolders
 *     (`FolderNode.chatTotal`), because that is what "inside this folder" means
 *     to someone scanning the column; the rail's badge keeps its own
 *     direct-child meaning (M34 open end 2). The **Assets** column carries the
 *     other count the owner asked for — a chat row shows the assets saved in
 *     that session (M11 F10), and a folder row sums its subtree, so a parent
 *     that visibly holds a subfolder can never read 0 while the child holds
 *     some. A chat with none reads "0 assets" rather than blank: the column is
 *     a measurement, and "0" is the measurement.
 *
 * Naming, empty states and the Create field follow the repo rules: the empty
 * state names the action that fills it, and the label says where the folder
 * will land ("in Client work" / "at the top level").
 */
import { useState, type FormEvent } from 'react';
import type { ConversationSummary, Folder } from '@partner/shared';
import ChatActions from './ChatActions.js';
import FolderActions from './FolderActions.js';
import type { FolderNode } from './lib/folder-tree.js';
import { assetCountOf } from './lib/folder-tree.js';
import { conversationTitle, timeAgo } from './lib/persona-helpers.js';

export interface FolderContentsProps {
  /** The folder being shown; null = the root ("All folders"). */
  folder: FolderNode | null;
  /** Every folder, flat — the move select is a picker (M11 contract). */
  folders: readonly Folder[];
  /** Subfolders of `folder` (root folders when it is the root). */
  subfolders: readonly FolderNode[];
  /** Chats filed directly in `folder` (unfiled chats when it is the root). */
  chats: readonly ConversationSummary[];
  /** Open the chat in the Chat view. */
  activeConversationId?: string | null;
  /** True while the Create field is open for this folder. */
  creating: boolean;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  /** Create a folder inside the shown folder (name already trimmed). */
  onCreateFolder: (name: string) => Promise<void> | void;
  /** Enter a subfolder (selecting it in the navigation pane). */
  onEnterFolder: (folderId: string) => void;
  onRenameFolder: (folderId: string, name: string) => Promise<void> | void;
  onDeleteFolder: (folderId: string) => Promise<void> | void;
  /** The row's “add subfolder”: enter the folder and open the Create field. */
  onAddSubfolder: (folderId: string) => void;
  onOpenChat: (conversationId: string) => void;
  onMoveChat: (conversationId: string, folderId: string | null) => Promise<void> | void;
  onDeleteChat: (conversationId: string) => Promise<void> | void;
  /** Locked while a turn streams (rows must not switch mid-turn). */
  disabled?: boolean;
}

const NEW_FOLDER_NAME = 'New folder';

/** "4 chats" / "1 chat" — a folder's Items cell, never a bare number. */
export function itemCountLabel(count: number): string {
  return `${count} chat${count === 1 ? '' : 's'}`;
}

/** "2 assets" / "0 assets" — the Assets cell, for a chat or a folder subtree. */
export function assetCountLabel(count: number): string {
  return `${count} asset${count === 1 ? '' : 's'}`;
}

/** "12 msgs" — a chat row's Items cell (messages, which is what it holds). */
export function messageCountLabel(count: number): string {
  return `${count} msg${count === 1 ? '' : 's'}`;
}

export default function FolderContents({
  folder,
  folders,
  subfolders,
  chats,
  activeConversationId = null,
  creating,
  onStartCreate,
  onCancelCreate,
  onCreateFolder,
  onEnterFolder,
  onRenameFolder,
  onDeleteFolder,
  onAddSubfolder,
  onOpenChat,
  onMoveChat,
  onDeleteChat,
  disabled = false,
}: FolderContentsProps) {
  const [draft, setDraft] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const where = folder === null ? 'the top level' : folder.name;
  const label = folder === null ? 'All folders' : folder.name;

  const submitNew = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = draft.trim();
    if (name.length === 0) return;
    setDraft('');
    await onCreateFolder(name);
  };

  const submitRename = async (id: string): Promise<void> => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (name.length === 0) return;
    await onRenameFolder(id, name);
  };

  const deleteFolder = (id: string): void => {
    if (deletingId !== null) return;
    setDeletingId(id);
    void Promise.resolve(onDeleteFolder(id)).finally(() => setDeletingId(null));
  };

  const empty = subfolders.length === 0 && chats.length === 0;

  return (
    <section className="explorer-content" aria-label={`Contents of ${label}`}>
      <div className="explorer-head">
        <span className="explorer-cell-name">Name</span>
        <span className="explorer-cell-type">Type</span>
        <span className="explorer-cell-items">Items</span>
        <span className="explorer-cell-assets">Assets</span>
        <span className="explorer-cell-when">Modified</span>
        <span className="explorer-cell-actions" aria-hidden="true" />
      </div>

      {creating ? (
        <form className="explorer-new" onSubmit={(event) => void submitNew(event)}>
          <input
            className="field"
            value={draft}
            autoFocus
            placeholder={NEW_FOLDER_NAME}
            aria-label={`Name for the new folder in ${where}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onCancelCreate();
            }}
          />
          <button
            type="submit"
            className="btn btn-secondary btn-sm"
            disabled={draft.trim().length === 0}
          >
            Create
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onCancelCreate}>
            Cancel
          </button>
        </form>
      ) : null}

      {empty && !creating ? (
        <div className="explorer-empty">
          <p className="explorer-empty-title">
            {folder === null ? 'No folders yet' : `${folder.name} is empty`}
          </p>
          <p className="explorer-empty-text">
            {folder === null
              ? 'Folders file your chats. Create one, then drag a chat onto it in the list on the left.'
              : 'Chats filed here — and any subfolders — appear in this list.'}
          </p>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={disabled}
            onClick={onStartCreate}
          >
            {folder === null ? '+ New folder' : '+ New subfolder'}
          </button>
        </div>
      ) : (
        <ul className="explorer-rows">
          {subfolders.map((sub) => (
            <li key={sub.id} className="explorer-row">
              <span className="explorer-cell explorer-cell-name">
                {renamingId === sub.id ? (
                  <form
                    className="folder-rename"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void submitRename(sub.id);
                    }}
                  >
                    <input
                      className="field"
                      value={renameDraft}
                      autoFocus
                      aria-label={`Rename folder ${sub.name}`}
                      onChange={(event) => setRenameDraft(event.target.value)}
                      onBlur={() => void submitRename(sub.id)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') setRenamingId(null);
                      }}
                    />
                  </form>
                ) : (
                  <button
                    type="button"
                    className="explorer-open"
                    disabled={disabled}
                    title={`Open ${sub.name}`}
                    onClick={() => onEnterFolder(sub.id)}
                  >
                    {sub.name}
                  </button>
                )}
              </span>
              <span className="explorer-cell explorer-cell-type">Folder</span>
              <span className="explorer-cell explorer-cell-items">
                {itemCountLabel(sub.chatTotal)}
              </span>
              <span className="explorer-cell explorer-cell-assets">
                {assetCountLabel(sub.assetTotal)}
              </span>
              <span className="explorer-cell explorer-cell-when">{timeAgo(sub.updatedAt)}</span>
              <span className="explorer-cell explorer-cell-actions">
                <FolderActions
                  name={sub.name}
                  disabled={disabled}
                  busy={deletingId === sub.id}
                  onAddSubfolder={() => onAddSubfolder(sub.id)}
                  onRename={() => {
                    setRenamingId(sub.id);
                    setRenameDraft(sub.name);
                  }}
                  onDelete={() => deleteFolder(sub.id)}
                />
              </span>
            </li>
          ))}
          {chats.map((chat) => (
            <li
              key={chat.id}
              className={
                chat.id === activeConversationId ? 'explorer-row explorer-row-active' : 'explorer-row'
              }
            >
              <span className="explorer-cell explorer-cell-name">
                <button
                  type="button"
                  className="explorer-open"
                  disabled={disabled}
                  aria-current={chat.id === activeConversationId ? 'true' : undefined}
                  onClick={() => onOpenChat(chat.id)}
                >
                  {conversationTitle(chat)}
                </button>
              </span>
              <span className="explorer-cell explorer-cell-type">Chat</span>
              <span className="explorer-cell explorer-cell-items">
                {chat.messageCount > 0 ? messageCountLabel(chat.messageCount) : '—'}
              </span>
              <span className="explorer-cell explorer-cell-assets">
                {assetCountLabel(assetCountOf(chat))}
              </span>
              <span className="explorer-cell explorer-cell-when">{timeAgo(chat.updatedAt)}</span>
              <span className="explorer-cell explorer-cell-actions">
                {/* drag: {} — the handle writes the payload; these rows are the
                  * drag SOURCE, the folder rows on the left are the targets. */}
                <ChatActions
                  chat={chat}
                  folders={folders}
                  disabled={disabled}
                  onMove={(folderId) => void onMoveChat(chat.id, folderId)}
                  onDelete={() => onDeleteChat(chat.id)}
                  drag={{}}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
