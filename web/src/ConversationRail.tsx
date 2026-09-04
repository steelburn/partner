import { useEffect, useRef, useState } from 'react';
import type { ConversationSummary } from '@partner/shared';
import { conversationTitle, sortConversations, timeAgo } from './lib/persona-helpers.js';

export interface ConversationRailProps {
  /** Sorted list (most recent first); null while loading. */
  conversations: ConversationSummary[] | null;
  /** Load failure text; shown with a retry action. */
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
}

/**
 * M3 conversation rail: New chat + the recent conversations (title +
 * updatedAt), each with a delete action revealed on hover/focus (two-step
 * confirm). Selecting a conversation loads its history into the chat strip;
 * while a turn streams the rail locks so an in-flight turn is never orphaned.
 */
export default function ConversationRail({
  conversations,
  loadError,
  disabled,
  creating,
  activeConversationId,
  onNewChat,
  onOpen,
  onDelete,
  onRetry,
}: ConversationRailProps) {
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const disarmTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    };
  }, []);

  const armDelete = (id: string): void => {
    setConfirmingId((current) => {
      if (current === id) return current;
      return id;
    });
    if (disarmTimer.current !== null) window.clearTimeout(disarmTimer.current);
    // A row left alone for a moment stops asking; no surprise deletes.
    disarmTimer.current = window.setTimeout(() => setConfirmingId(null), 4000);
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
          <ul className="rail-list">
            {list.map((conversation) => {
              const isActive = conversation.id === activeConversationId;
              const isConfirming = confirmingId === conversation.id;
              const isDeleting = deletingId === conversation.id;
              return (
                <li
                  key={conversation.id}
                  className={isActive ? 'rail-item rail-item-active' : 'rail-item'}
                >
                  <button
                    type="button"
                    className="rail-item-open"
                    onClick={() => onOpen(conversation.id)}
                    disabled={disabled || isDeleting}
                    aria-current={isActive ? 'true' : undefined}
                  >
                    <span className="rail-item-title">{conversationTitle(conversation)}</span>
                    <span className="rail-item-meta">
                      {conversation.messageCount > 0
                        ? `${conversation.messageCount} msg${conversation.messageCount === 1 ? '' : 's'} · `
                        : ''}
                      {timeAgo(conversation.updatedAt)}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={
                      isConfirming || isDeleting
                        ? 'btn btn-secondary btn-sm rail-item-del rail-item-del-visible'
                        : 'btn btn-secondary btn-sm rail-item-del'
                    }
                    onClick={() =>
                      void (isConfirming ? confirmDelete(conversation.id) : armDelete(conversation.id))
                    }
                    disabled={disabled || isDeleting}
                    aria-busy={isDeleting}
                    aria-label={
                      isConfirming
                        ? `Confirm deleting conversation ${conversationTitle(conversation)}`
                        : `Delete conversation ${conversationTitle(conversation)}`
                    }
                  >
                    {isDeleting ? '…' : isConfirming ? 'Confirm' : 'Delete'}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}
