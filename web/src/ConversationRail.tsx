import { Fragment, useEffect, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type ReactNode } from 'react';
import type { ConversationSummary, Folder } from '@partner/shared';
import { conversationTitle, sortConversations, timeAgo } from './lib/persona-helpers.js';

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
}

interface TreeFolder extends Folder {
  children: TreeFolder[];
  chats: ConversationSummary[];
}

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
}: ConversationRailProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** Drag-to-move (M11 extra): dragged chat + current drop target
   *  ('' = Inbox, else a folder id; null = none). The move select on each
   *  chat row remains the accessible fallback. */
  const [dragChatId, setDragChatId] = useState<string | null>(null);
  const [dropTargetKey, setDropTargetKey] = useState<string | null>(null);

  const dragStart = (event: DragEvent<HTMLElement>, chatId: string): void => {
    if (disabled) return;
    event.dataTransfer.setData('text/plain', chatId);
    event.dataTransfer.effectAllowed = 'move';
    setDragChatId(chatId);
  };

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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmingFolderId, setConfirmingFolderId] = useState<string | null>(null);
  const [deletingFolderId, setDeletingFolderId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  /** Folder id the "new folder" input is creating under (null = root). */
  const [creatingFor, setCreatingFor] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const disarmTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    };
  }, []);

  const armConfirm = (kind: 'chat' | 'folder', id: string): void => {
    if (kind === 'chat') setConfirmingFolderId(null);
    else setConfirmingId(null);
    setRenamingId(null);
    if (kind === 'chat') setConfirmingId(id);
    else setConfirmingFolderId(id);
    if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    disarmTimer.current = window.setTimeout(() => {
      setConfirmingId(null);
      setConfirmingFolderId(null);
    }, 4000);
  };

  const confirmDelete = async (id: string): Promise<void> => {
    if (deletingId !== null) return;
    setDeletingId(id);
    setConfirmingId(null);
    try {
      await onDelete(id);
    } finally {
      setDeletingId(null);
    }
  };

  const confirmFolderDelete = async (id: string): Promise<void> => {
    if (deletingFolderId !== null) return;
    setDeletingFolderId(id);
    setConfirmingFolderId(null);
    try {
      await onDeleteFolder(id);
    } finally {
      setDeletingFolderId(null);
    }
  };

  const beginRename = (folder: Folder): void => {
    setRenamingId(folder.id);
    setRenameDraft(folder.name);
    setConfirmingId(null);
    setConfirmingFolderId(null);
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

  const flat = conversations === null ? [] : sortConversations(conversations);

  // Build the folder tree once per render from the flat lists.
  const allFolders = folders === null ? [] : folders;
  const byParent = new Map<string | null, TreeFolder[]>();
  const lookup = new Map<string, TreeFolder>();
  for (const folder of allFolders) {
    const node: TreeFolder = { ...folder, children: [], chats: [] };
    lookup.set(folder.id, node);
    const parent = folder.parentId ?? null;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent)?.push(node);
  }
  for (const [, nodes] of byParent) nodes.sort((a, b) => a.position - b.position);
  const roots = byParent.get(null) ?? [];
  const chatByFolder = new Map<string | null, ConversationSummary[]>();
  for (const chat of flat) {
    const key = chat.folderId ?? null;
    if (!chatByFolder.has(key)) chatByFolder.set(key, []);
    chatByFolder.get(key)?.push(chat);
  }
  const assign = (node: TreeFolder): void => {
    node.chats = chatByFolder.get(node.id) ?? [];
    node.children = byParent.get(node.id) ?? [];
    for (const child of node.children) assign(child);
  };
  for (const root of roots) assign(root);
  const inboxChats = chatByFolder.get(null) ?? [];
  const totalFolderChats = flat.length - inboxChats.length;

  // M16 F4 discuss lineage: forked discussions (parentId set) render as
  // one-level threads indented under their parent conversation.
  const threadChildren = new Map<string, ConversationSummary[]>();
  for (const chatRow of flat) {
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
    const isConfirming = confirmingId === chat.id;
    const isDeleting = deletingId === chat.id;
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
          disabled={disabled || isDeleting}
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
        <span
          className="rail-item-drag"
          draggable={!disabled && !isDeleting}
          onDragStart={(event) => dragStart(event, chat.id)}
          onDragEnd={dragEnd}
          title="Drag to a folder"
          role="button"
          aria-label={`Drag ${conversationTitle(chat)} to a folder`}
          tabIndex={-1}
        >
          ≡
        </span>
        <select
          className="rail-item-move"
          aria-label={`Move ${conversationTitle(chat)} to folder`}
          value={chat.folderId ?? ''}
          disabled={disabled || isDeleting}
          onChange={(event) => {
            const target = event.target.value;
            void onMoveConversation(chat.id, target === '' ? null : target);
          }}
        >
          <option value="">Inbox</option>
          {allFolders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className={
            isConfirming || isDeleting
              ? 'btn btn-secondary btn-sm rail-item-del rail-item-del-visible'
              : 'btn btn-secondary btn-sm rail-item-del'
          }
          onClick={() =>
            void (isConfirming ? confirmDelete(chat.id) : armConfirm('chat', chat.id))
          }
          disabled={disabled || isDeleting}
          aria-busy={isDeleting}
          aria-label={
            isConfirming
              ? `Confirm deleting conversation ${conversationTitle(chat)}`
              : `Delete conversation ${conversationTitle(chat)}`
          }
        >
          {isDeleting ? '…' : isConfirming ? 'Confirm' : 'Delete'}
        </button>
      </li>
    );
  };

  const renderFolder = (folder: TreeFolder, depth: number): ReactNode => {
    const isCollapsed = collapsed.has(folder.id);
    const isConfirming = confirmingFolderId === folder.id;
    const isDeleting = deletingFolderId === folder.id;
    const isRenaming = renamingId === folder.id;
    const hasChildren = folder.children.length > 0 || folder.chats.length > 0;
    return (
      <li
        key={folder.id}
        className="folder-node"
        style={{ '--folder-depth': depth } as CSSProperties}
      >
        <div
          className={dropTargetKey === folder.id ? 'folder-row drop-target' : 'folder-row'}
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
          ) : (
            <span className="folder-name" title={`${folder.chatCount} chat${folder.chatCount === 1 ? '' : 's'}`}>
              {folder.name}
              <span className="folder-count">
                {folder.chatCount > 0 ? folder.chatCount : ''}
              </span>
            </span>
          )}
          <span className="folder-actions">
            <button
              type="button"
              className="folder-action"
              aria-label={`Add subfolder under ${folder.name}`}
              title="Add subfolder"
              disabled={disabled || isDeleting}
              onClick={() => {
                setCreatingFor((current) => (current === folder.id ? null : folder.id));
                setNewName('');
              }}
            >
              +
            </button>
            <button
              type="button"
              className="folder-action"
              aria-label={`Rename folder ${folder.name}`}
              title="Rename"
              disabled={disabled || isDeleting}
              onClick={() => beginRename(folder)}
            >
              ✎
            </button>
            <button
              type="button"
              className={
                isConfirming
                  ? 'folder-action folder-action-danger folder-action-confirm'
                  : 'folder-action folder-action-danger'
              }
              aria-label={
                isConfirming
                  ? `Confirm deleting folder ${folder.name}`
                  : `Delete folder ${folder.name}`
              }
              title={isConfirming ? 'Confirm delete' : 'Delete'}
              disabled={disabled || isDeleting}
              onClick={() =>
                void (isConfirming ? confirmFolderDelete(folder.id) : armConfirm('folder', folder.id))
              }
            >
              {isDeleting ? '…' : isConfirming ? 'OK' : '×'}
            </button>
          </span>
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
            {folder.chats.map(renderChatWithThreads)}
          </ul>
        ) : null}
      </li>
    );
  };

  const anyFolders = allFolders.length > 0;
  const list = conversations === null ? [] : sortConversations(conversations);

  return (
    <aside className="rail" aria-label="Conversations">
      <div className="rail-head">
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
        ) : list.length === 0 ? (
          <p className="rail-note">Your conversations appear here — start with New chat.</p>
        ) : (
          <ul className="rail-list rail-tree">
            {/* Inbox: chats with no folder — always shown when non-empty. */}
            {inboxChats.length > 0 || !anyFolders ? (
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
            ) : null}
            {roots.map((root) => renderFolder(root, 0))}
          </ul>
        )}
        {folders !== null ? (
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
        <span className="rail-total">
          {flat.length} chat{flat.length === 1 ? '' : 's'}
          {totalFolderChats > 0 ? ` · ${totalFolderChats} in folders` : ''}
        </span>
      </div>
    </aside>
  );
}
