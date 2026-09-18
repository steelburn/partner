/**
 * M35 — the chat row's controls: drag handle, the accessible move select, and
 * the two-step delete.
 *
 * Extracted from `ConversationRail` for the same reason as `FolderActions`: the
 * Explorer-style Folders page lists a chat in its contents pane, and a second
 * hand-written copy of "move this chat / delete this chat" is how a control
 * drifts from the one the rail renders. The confirm state lives here, so the
 * rail no longer tracks "which chat is armed" either.
 *
 * Drag and drop stay OUT of this component's state, but the DRAG PAYLOAD does
 * not: a row is dragged as `chat.id` under `text/plain`, and that contract
 * belongs with the handle that writes it, so a drop target cannot end up
 * parsing a different one. `drag: null` renders no handle (the contents pane on
 * a touch tier has the move select instead, and the stylesheet hides the handle
 * under `(hover: none)` in any case); the callbacks only let a caller style its
 * own row while the drag is in flight.
 */
import { useEffect, useState } from 'react';
import type { ConversationSummary, Folder } from '@partner/shared';
import { conversationTitle } from './lib/persona-helpers.js';

/** How long a two-step delete stays armed before disarming itself (M11). */
export const CHAT_DELETE_ARM_MS = 4000;

export interface ChatActionsProps {
  chat: ConversationSummary;
  /** Every folder, for the move select (flat list: the select is a picker). */
  folders: readonly Folder[];
  disabled?: boolean;
  /** Move to a folder id, or `null` for Inbox. */
  onMove: (folderId: string | null) => void;
  /** Called only on the CONFIRMED press (the second one). */
  onDelete: () => Promise<void> | void;
  /** Drag handle wiring, or null where dragging has no meaning. */
  drag?: { onStart?: () => void; onEnd?: () => void } | null;
}

export default function ChatActions({
  chat,
  folders,
  disabled = false,
  onMove,
  onDelete,
  drag = null,
}: ChatActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!confirming) return undefined;
    const timer = window.setTimeout(() => setConfirming(false), CHAT_DELETE_ARM_MS);
    return () => window.clearTimeout(timer);
  }, [confirming]);

  const title = conversationTitle(chat);

  const confirm = async (): Promise<void> => {
    if (deleting) return;
    setDeleting(true);
    setConfirming(false);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <>
      {drag === null ? null : (
        <span
          className="rail-item-drag"
          draggable={!disabled && !deleting}
          onDragStart={(event) => {
            event.dataTransfer.setData('text/plain', chat.id);
            event.dataTransfer.effectAllowed = 'move';
            drag.onStart?.();
          }}
          onDragEnd={() => drag.onEnd?.()}
          title="Drag to a folder"
          role="button"
          aria-label={`Drag ${title} to a folder`}
          tabIndex={-1}
        >
          ≡
        </span>
      )}
      <select
        className="rail-item-move"
        aria-label={`Move ${title} to folder`}
        value={chat.folderId ?? ''}
        disabled={disabled || deleting}
        onChange={(event) => {
          const target = event.target.value;
          onMove(target === '' ? null : target);
        }}
      >
        <option value="">Inbox</option>
        {folders.map((folder) => (
          <option key={folder.id} value={folder.id}>
            {folder.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className={
          confirming || deleting
            ? 'btn btn-secondary btn-sm rail-item-del rail-item-del-visible'
            : 'btn btn-secondary btn-sm rail-item-del'
        }
        onClick={() => void (confirming ? confirm() : setConfirming(true))}
        disabled={disabled || deleting}
        aria-busy={deleting}
        aria-label={
          confirming ? `Confirm deleting conversation ${title}` : `Delete conversation ${title}`
        }
      >
        {deleting ? '…' : confirming ? 'Confirm' : 'Delete'}
      </button>
    </>
  );
}
