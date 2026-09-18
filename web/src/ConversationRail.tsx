import { Fragment, useState, type CSSProperties, type DragEvent, type FormEvent, type ReactNode } from 'react';
import type { ConversationSummary, Folder } from '@partner/shared';
import ChatActions from './ChatActions.js';
import FolderActions from './FolderActions.js';
import { buildFolderTree, type FolderNode } from './lib/folder-tree.js';
import { conversationTitle, timeAgo } from './lib/persona-helpers.js';

export interface ConversationRailProps {
  /** Sorted list (most recent first); null while loading. */
  conversations: ConversationSummary[] | null;
  /** Flat folder list (M11 F11); null while loading. */
  folders: Folder[] | null;
  loadError: string | null;
  /** Disabled while a turn is streaming (rows must not switch mid-turn). */
  disabled: boolean;
  /** New chat is being created server-side. */
  creating: boolean;
  /** Active conversation id (highlighted). */
  activeConversationId: string | null;
  onNewChat: () => void;
  onOpen: (id: string) => void;
  /** Delete + refresh; resolves when done. */
  onDelete: (id: string) => Promise<void> | void;
  onRetry: () => void;
  /** Folder tree ops (M11 F11). parentId null = root. */
  onCreateFolder: (name: string, parentId: string | null) => Promise<void> | void;
  onRenameFolder: (id: string, name: string) => Promise<void> | void;
  onDeleteFolder: (id: string) => Promise<void> | void;
  onMoveConversation: (id: string, folderId: string | null) => Promise<void> | void;
  /**
   * M30: render as the sidebar's Chat section instead of a standalone rail
   * column. Same tree and folder controls; the wrapper only drops the fixed
   * column width so it fills the sidebar. The phone tier keeps the standalone
   * overlay (sidebar is hidden there), so this defaults to false.
   */
  embedded?: boolean;
  /**
   * M35: render as the **navigation pane** of the Explorer-style Folders page
   * — folder rows only (no chat rows, no Inbox bucket), plus a selectable
   * "All folders" root. The rail stays the one definition of a folder row and
   * of its controls; the page's contents pane is what lists chats. It is the
   * same tree, so a folder created, renamed or deleted anywhere is the same
   * folder here.
   */
  nav?: boolean;
  /** M35: the folder the nav pane highlights (null = "All folders"). */
  selectedFolderId?: string | null;
  /** M35: a nav-pane row was selected (null = "All folders"). */
  onSelectFolder?: (folderId: string | null) => void;
}

/**
 * M30 is the tree the sidebar/overlay renders; M35 reuses `buildFolderTree`
 * from `lib/folder-tree.ts` so this component and the Folders page cannot
 * disagree about order, nesting or which chats belong where. `TreeFolder` is
 * that node type, kept under its historical name for the render code below.
 */
type TreeFolder = FolderNode;

const EMPTY_FOLDER_NAME = 'New folder';

/**
 * M11 conversation rail: folder tree (F11) + conversations. Chats without a
 * folder live under Inbox; each folder row can create a child, rename
 * (inline), delete (two-step), and each chat row has a move control. While a
 * turn streams the rail locks so an in-flight turn is never orphaned.
 */
export default function ConversationRail({
  conversations,
  folders,
  loadError,
  disabled,
  creating,
  activeConversationId,
  onNewChat,
  onOpen,
  onDelete,
  onRetry,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMoveConversation,
  embedded = false,
  nav = false,
  selectedFolderId = null,
  onSelectFolder,
}: ConversationRailProps) {
  /** Drag-to-move (M11 extra): dragged chat + current drop target
   *  ('' = Inbox, else a folder id; null = none). The move select on each
   *  chat row remains the accessible fallback. */
  const [dragChatId, setDragChatId] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);

  const dragEnd = (): void => {
    setDragChatId(null);
    setDropTargetKey(null);
  };

  const dropOver = (event: DragEvent<HTMLElement>, targetKey: string): void => {
    if (event.dataTransfer.types.includes('text/plain')) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      if (dropTargetKey !== targetKey) setDropTargetKey(targetKey);
    }
  };

  const dropLeave = (targetKey: string): void => {
    setDropTargetKey((current) => (current === targetKey ? null : current));
  };

  const drop = (event: DragEvent<HTMLElement>, targetKey: string): void => {
    event.preventDefault();
    const chatId = event.dataTransfer.getData('text/plain');
    setDragChatId(null);
    setDropTargetKey(null);
    if (chatId !== '' && !disabled) {
      void onMoveConversation(chatId, targetKey === '' ? null : targetKey);
    }
  };
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Folder id the "new folder" input is creating under (null = root). */
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newName, setNewName] = useState('');

  const beginRename = (folder: Folder): void => {
    setRenamingId(folder.id);
    setRenameDraft(folder.name);
  };

  const commitRename = async (id: string): Promise<void> => {
    const name = renameDraft.trim();
    setRenamingId(null);
    if (name.length === 0) return;
    await onRenameFolder(id, name);
  };

  const submitNewFolder = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const name = newName.trim();
    if (name.length === 0) return;
    const parentId = creatingFor;
    setCreatingFor(null);
    setNewName('');
    await onCreateFolder(name, parentId);
  };

  const toggleCollapsed = (id: string): void => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const tree = buildFolderTree(folders, conversations);
  const flat = tree.chats;
  const allFolders = tree.folders;
  const roots = tree.roots;
  const inboxChats = tree.inboxChats;
  const totalFolderChats = flat.length - inboxChats.length;

  // M16 F4 discuss lineage: forked discussions (parentId set) render as
  // one-level threads indented under their parent conversation.
  const threadChildren = new Map<string, ConversationSummary[]>();
  for (const node of tree.byId.values()) {
    for (const chatRow of node.chats) {
      if (chatRow.parentId === null || chatRow.parentId === undefined) continue;
      const list = threadChildren.get(chatRow.parentId) ?? [];
      list.push(chatRow);
      threadChildren.set(chatRow.parentId, list);
    }
  }
  for (const chatRow of tree.inboxChats) {
    if (chatRow.parentId === null || chatRow.parentId === undefined) continue;
    const list = threadChildren.get(chatRow.parentId) ?? [];
    list.push(chatRow);
    threadChildren.set(chatRow.parentId, list);
  }
  const renderThread = (child: ConversationSummary): ReactNode => (
    <li key={child.id} className={child.id === activeConversationId ? 'rail-item rail-item-thread rail-item-active' : 'rail-item rail-item-thread'}>
      <button
        type="button"
        className="rail-item-open"
        onClick={() => onOpen(child.id)}
        disabled={disabled}
        aria-current={child.id === activeConversationId ? 'true' : undefined}
        title="Forked discussion — opens in its own chat"
      >
        <span className="rail-item-title rail-item-thread-title">↳ {conversationTitle(child)}</span>
        <span className="rail-item-meta">fork · {timeAgo(child.updatedAt)}</span>
      </button>
    </li>
  );
  const renderChatWithThreads = (chat: ConversationSummary): ReactNode => {
    const children = threadChildren.get(chat.id) ?? [];
    return (
      <Fragment key={chat.id}>
        {renderChat(chat)}
        {children.map(renderThread)}
      </Fragment>
    );
  };

  const renderChat = (chat: ConversationSummary): ReactNode => {
    const isActive = chat.id === activeConversationId;
    return (
      <li key={chat.id} className={
          isActive
            ? dragChatId === chat.id
              ? 'rail-item rail-item-active rail-item-dragging'
              : 'rail-item rail-item-active'
            : dragChatId === chat.id
              ? 'rail-item rail-item-dragging'
              : 'rail-item'
        }>
        <button
          type="button"
          className="rail-item-open"
          onClick={() => onOpen(chat.id)}
          disabled={disabled}
          aria-current={isActive ? 'true' : undefined}
        >
          <span className="rail-item-title">{conversationTitle(chat)}</span>
          <span className="rail-item-meta">
            {chat.messageCount > 0
              ? `${chat.messageCount} msg${chat.messageCount === 1 ? '' : 's'} · `
              : ''}
            {timeAgo(chat.updatedAt)}
          </span>
        </button>
        {/* M35: the row's controls are ONE component, shared with the Folders
          * page's contents pane — move select, drag handle, two-step delete. */}
        <ChatActions
          chat={chat}
          folders={allFolders}
          disabled={disabled}
          onMove={(folderId) => void onMoveConversation(chat.id, folderId)}
          onDelete={() => onDelete(chat.id)}
          drag={{
            onStart: () => setDragChatId(chat.id),
            onEnd: dragEnd,
          }}
        />
      </li>
    );
  };

  const renderFolder = (folder: TreeFolder, depth: number): ReactNode => {
    const isCollapsed = collapsed.has(folder.id);
    const isDeleting = deletingFolderId === folder.id;
    const isRenaming = renamingId === folder.id;
    const isSelected = nav && selectedFolderId === folder.id;
    /* In the navigation pane there are no chat rows, so a folder is
     * expandable exactly when it has subfolders — a caret that expands to
     * nothing is a dead control. */
    const hasChildren = nav
      ? folder.children.length > 0
      : folder.children.length > 0 || folder.chats.length > 0;
    return (
      <li
        key={folder.id}
        className="folder-node"
        style={{ '--folder-depth': depth } as CSSProperties}
      >
        <div
          className={`folder-row${dropTargetKey === folder.id ? ' drop-target' : ''}${
            isSelected ? ' folder-row-current' : ''
          }`}
          onDragOver={(event) => dropOver(event, folder.id)}
          onDragLeave={() => dropLeave(folder.id)}
          onDrop={(event) => drop(event, folder.id)}
        >
          <button
            type="button"
            className="folder-toggle"
            aria-expanded={!isCollapsed}
            disabled={!hasChildren || disabled}
            onClick={() => toggleCollapsed(folder.id)}
            aria-label={
              isCollapsed ? `Expand folder ${folder.name}` : `Collapse folder ${folder.name}`
            }
          >
            {hasChildren ? (isCollapsed ? '▸' : '▾') : ''}
          </button>
          {isRenaming ? (
            <form
              className="folder-rename"
              onSubmit={(event) => {
                event.preventDefault();
                void commitRename(folder.id);
              }}
            >
              <input
                className="field"
                value={renameDraft}
                autoFocus
                aria-label={`Rename folder ${folder.name}`}
                onChange={(event) => setRenameDraft(event.target.value)}
                onBlur={() => void commitRename(folder.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setRenamingId(null);
                }}
              />
            </form>
          ) : nav ? (
            /* The navigation pane's name cell is the selection control. */
            <button
              type="button"
              className="folder-name folder-select"
              aria-current={isSelected ? 'true' : undefined}
              disabled={disabled}
              title={`${folder.chatTotal} chat${folder.chatTotal === 1 ? '' : 's'} in ${folder.name} and its subfolders`}
              onClick={() => onSelectFolder?.(folder.id)}
            >
              {folder.name}
              <span className="folder-count">
                {folder.chatTotal > 0 ? folder.chatTotal : ''}
              </span>
            </button>
          ) : (
            <span className="folder-name" title={`${folder.chatCount} chat${folder.chatCount === 1 ? '' : 's'}`}>
              {folder.name}
              <span className="folder-count">
                {folder.chatCount > 0 ? folder.chatCount : ''}
              </span>
            </span>
          )}
          <FolderActions
            name={folder.name}
            disabled={disabled}
            busy={isDeleting}
            onAddSubfolder={() => {
              setCreatingFor((current) => (current === folder.id ? null : folder.id));
              setNewName('');
            }}
            onRename={() => beginRename(folder)}
            onDelete={() => {
              if (deletingFolderId !== null) return;
              setDeletingFolderId(folder.id);
              void Promise.resolve(onDeleteFolder(folder.id)).finally(() =>
                setDeletingFolderId(null),
              );
            }}
          />
        </div>
        {creatingFor === folder.id ? (
          <form className="folder-new-row" onSubmit={(event) => void submitNewFolder(event)}>
            <input
              className="field"
              placeholder={EMPTY_FOLDER_NAME}
              aria-label={`Name for the new subfolder under ${folder.name}`}
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              onBlur={() => setCreatingFor(null)}
              autoFocus
            />
          </form>
        ) : null}
        {!isCollapsed ? (
          <ul className="folder-group">
            {folder.children.map((child) => renderFolder(child, depth + 1))}
            {/* M35: the navigation pane shows folders only — the chats filed
              * here are the contents pane's job, not a second copy here. */}
            {nav ? null : folder.chats.map(renderChatWithThreads)}
          </ul>
        ) : null}
      </li>
    );
  };

  const anyFolders = allFolders.length > 0;
  const list = tree.chats;

  return (
    <aside
      className={embedded ? 'rail rail-embedded' : 'rail'}
      aria-label={nav ? 'Folders' : 'Conversations'}
    >
      <div className="rail-head" hidden={nav}>
        <button
          type="button"
          className="btn btn-primary btn-block rail-new"
          onClick={onNewChat}
          disabled={disabled || creating}
          aria-busy={creating}
        >
          {creating ? 'Starting…' : 'New chat'}
        </button>
      </div>

      <div className="rail-body" aria-busy={conversations === null}>
        {conversations === null && loadError === null ? (
          <p className="rail-note">Loading conversations…</p>
        ) : loadError !== null ? (
          <div className="rail-error" role="alert">
            <p className="rail-error-text">{loadError}</p>
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
              Try again
            </button>
          </div>
        ) : list.length === 0 && !anyFolders ? (
          /* Only when there is NOTHING at all. With folders present but no
           * chats, the tree renders below — a folder page that hides the
           * folders you own because you have not filed a chat yet is the one
           * shape this surface must not have. */
          nav ? (
            <p className="rail-note">No folders yet.</p>
          ) : (
            <p className="rail-note">Your conversations appear here — start with New chat.</p>
          )
        ) : (
          <ul className="rail-list rail-tree">
            {nav ? (
              /* M35: the Explorer navigation pane's root — the content pane
               * shows the root folders and the unfiled chats under it. */
              <li className="folder-node" style={{ '--folder-depth': 0 } as CSSProperties}>
                <div
                  className={`folder-row folder-row-root${
                    dropTargetKey === '' ? ' drop-target' : ''
                  }${selectedFolderId === null ? ' folder-row-current' : ''}`}
                  onDragOver={(event) => dropOver(event, '')}
                  onDragLeave={() => dropLeave('')}
                  onDrop={(event) => drop(event, '')}
                >
                  <span className="folder-toggle" aria-hidden="true" />
                  <button
                    type="button"
                    className="folder-name folder-select"
                    aria-current={selectedFolderId === null ? 'true' : undefined}
                    disabled={disabled}
                    title={`Every folder — ${flat.length} chat${flat.length === 1 ? '' : 's'} in all`}
                    onClick={() => onSelectFolder?.(null)}
                  >
                    All folders
                    {/* The root counts every chat, exactly like a folder row
                      * counts its subtree: a drive that read "0" while
                      * holding subfolders would contradict the pane beside it. */}
                    <span className="folder-count">{flat.length > 0 ? flat.length : ''}</span>
                  </button>
                </div>
              </li>
            ) : (
              /* Inbox: chats with no folder — always shown when non-empty. */
              inboxChats.length > 0 || !anyFolders ? (
                <li className="folder-node" style={{ '--folder-depth': 0 } as CSSProperties}>
                  <div
                    className={
                      dropTargetKey === '' ? 'folder-row folder-row-inbox drop-target' : 'folder-row folder-row-inbox'
                    }
                    onDragOver={(event) => dropOver(event, '')}
                    onDragLeave={() => dropLeave('')}
                    onDrop={(event) => drop(event, '')}
                  >
                    <span className="folder-name folder-name-inbox">Inbox</span>
                    <span className="folder-count">{inboxChats.length}</span>
                  </div>
                  <ul className="folder-group">{inboxChats.map(renderChatWithThreads)}</ul>
                </li>
              ) : null
            )}
            {roots.map((root) => renderFolder(root, 0))}
          </ul>
        )}
        {folders !== null && !nav ? (
          <div className="rail-foot">
            {creatingFor === null ? (
              <button
                type="button"
                className="btn btn-secondary btn-block btn-sm"
                disabled={disabled}
                onClick={() => {
                  setCreatingFor('');
                  setNewName('');
                }}
              >
                + New folder
              </button>
            ) : (
              <form className="folder-new-row" onSubmit={(event) => void submitNewFolder(event)}>
                <input
                  className="field"
                  placeholder={EMPTY_FOLDER_NAME}
                  aria-label="Name for the new folder"
                  value={newName}
                  autoFocus
                  onChange={(event) => setNewName(event.target.value)}
                  onBlur={() => setCreatingFor(null)}
                />
              </form>
            )}
          </div>
        ) : null}
        <span className="rail-total" hidden={nav}>
          {flat.length} chat{flat.length === 1 ? '' : 's'}
          {totalFolderChats > 0 ? ` · ${totalFolderChats} in folders` : ''}
        </span>
      </div>
    </aside>
  );
}
