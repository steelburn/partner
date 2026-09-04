import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChatEvent, ConversationMessage } from '@partner/shared';
import { ApiRequestError, streamChat, type StreamDoneMeta } from './lib/api.js';
import { getConversation } from './lib/conversations.js';
import { readStoredToken } from './lib/token.js';

export interface ChatStripProps {
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
  /** Active persisted conversation (null = fresh chat, auto-created on send). */
  conversationId: string | null;
  /** Active persona for routing (null = no persona / demo fallback). */
  personaId: string | null;
  /** Active persona display name for the meta line. */
  personaName: string | null;
  /** Paused active persona -> banner + disabled input (core refuses 423). */
  personaPaused: boolean;
  /** Reported on turn start/end so the shell can disable switching controls. */
  onStreamingChange?: (streaming: boolean) => void;
  /** Server-confirmed ids after a turn (App refreshes + adopts the conversation). */
  onDone?: (meta: StreamDoneMeta) => void;
}

interface ChatRow {
  /** Stable render key: server message id when known, else a local counter. */
  key: string;
  role: 'system' | 'user' | 'assistant';
  text: string;
}

interface UsageSummary {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

interface TurnError {
  message: string;
  canRepair: boolean;
}

const EMPTY_STATE = 'Say hello to your partner.';
const EMPTY_CONVERSATION_STATE = 'A new conversation — say hello.';

function isSessionLost(cause: unknown): boolean {
  return cause instanceof ApiRequestError && (cause.status === 401 || cause.status === 403);
}

/** Map a persisted message onto a render row (order kept as delivered). */
function rowFromMessage(message: ConversationMessage): ChatRow {
  return { key: message.id, role: message.role, text: message.content };
}

/**
 * M3 ChatStrip: streams into the active conversation (or auto-creates one),
 * loads history when a conversation is selected, and shows the active
 * persona's name + paused state. When the selected persona is paused the
 * composer is disabled and the banner explains why — the core also refuses
 * paused personas with a 423. Message bodies are rendered only; never
 * logged or echoed outside the transcript.
 */
export default function ChatStrip({
  onUnpair,
  conversationId,
  personaId,
  personaName,
  personaPaused,
  onStreamingChange,
  onDone,
}: ChatStripProps) {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [modelLatency, setModelLatency] = useState<{ model: string; latencyMs: number } | null>(
    null,
  );
  const [turnError, setTurnError] = useState<TurnError | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const loadHistory = useCallback(async (): Promise<void> => {
    if (conversationId === null) {
      setRows([]);
      setHistoryError(null);
      return;
    }
    const token = readStoredToken();
    if (!token) {
      setHistoryError('Not paired with the Partner core.');
      return;
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const detail = await getConversation(token, conversationId);
      // A fresh conversation may have no messages yet; history replaces the
      // transcript wholesale (turn state is only valid for the same id).
      setRows(detail.messages.map(rowFromMessage));
    } catch (cause) {
      if (isSessionLost(cause)) {
        onUnpair();
        return;
      }
      setHistoryError(
        cause instanceof Error ? cause.message : 'Could not load this conversation.',
      );
    } finally {
      setHistoryLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    if (conversationId === null) {
      setRows([]);
      setHistoryError(null);
      setHistoryLoading(false);
      return;
    }
    void loadHistory();
  }, [conversationId, loadHistory, reloadToken]);

  const canSend =
    !streaming && draft.trim().length > 0 && !personaPaused && historyLoading === false;

  /**
   * End the in-flight turn: drop a still-empty assistant placeholder and
   * quietly re-key the finished assistant row with the server message id so
   * keys stay stable across a history reload of the same conversation.
   */
  const finishTurn = (meta: StreamDoneMeta | null): void => {
    setStreaming(false);
    onStreamingChange?.(false);
    setRows((prev) => {
      const last = prev[prev.length - 1];
      if (!last || last.role !== 'assistant') return prev;
      if (last.text === '') return prev.slice(0, -1);
      if (meta && meta.messageId.length > 0) {
        const next = prev.slice(0, -1);
        next.push({ ...last, key: meta.messageId });
        return next;
      }
      return prev;
    });
  };

  const send = async (): Promise<void> => {
    const content = draft.trim();
    if (content.length === 0 || streaming || personaPaused) return;

    const token = readStoredToken();
    if (!token) {
      setTurnError({ message: 'Not paired with the Partner core.', canRepair: true });
      return;
    }

    const userRow: ChatRow = { key: `local-${++nextId.current}`, role: 'user', text: content };
    const placeholder: ChatRow = { key: `local-${++nextId.current}`, role: 'assistant', text: '' };
    setRows((prev) => [...prev, userRow, placeholder]);
    setDraft('');
    setUsage(null);
    setModelLatency(null);
    setTurnError(null);
    setHistoryError(null);
    setStreaming(true);
    onStreamingChange?.(true);

    const controller = new AbortController();
    abortRef.current = controller;
    let doneMeta: StreamDoneMeta | null = null;

    const onEvent = (event: ChatEvent): void => {
      switch (event.type) {
        case 'delta':
          setRows((prev) => {
            const last = prev[prev.length - 1];
            if (!last || last.role !== 'assistant') return prev;
            const index = prev.length - 1;
            return prev.map((row, i) =>
              i === index ? { ...row, text: row.text + event.text } : row,
            );
          });
          break;
        case 'usage':
          setUsage({
            promptTokens: event.promptTokens,
            completionTokens: event.completionTokens,
            totalTokens: event.totalTokens,
          });
          break;
        case 'done':
          setModelLatency({ model: event.model, latencyMs: event.latencyMs });
          break;
        case 'error':
          setTurnError({ message: event.message, canRepair: false });
          break;
        case 'budget_reached':
          setTurnError({ message: event.message, canRepair: false });
          break;
      }
    };

    try {
      const result = await streamChat({
        token,
        content,
        conversationId: conversationId ?? undefined,
        personaId: personaId ?? undefined,
        signal: controller.signal,
        onEvent,
        onDoneMeta: (meta) => {
          doneMeta = meta;
        },
      });
      if (!result.ok) {
        setTurnError({
          message: result.unauthorized
            ? 'Your session with the Partner core has expired. Pair again to continue.'
            : result.message,
          canRepair: result.unauthorized,
        });
      }
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') return;
      setTurnError({
        message: 'Lost connection to the Partner core. Check that it is running and try again.',
        canRepair: false,
      });
    } finally {
      finishTurn(doneMeta);
      if (doneMeta) onDone?.(doneMeta);
    }
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void send();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  const metaParts: string[] = [];
  if (personaName) metaParts.push(personaName);
  if (usage) metaParts.push(`${usage.totalTokens} tokens`);
  if (modelLatency) metaParts.push(`${modelLatency.model} · ${modelLatency.latencyMs} ms`);
  const metaText = metaParts.join(' · ');
  const showPending = streaming && rows[rows.length - 1]?.role === 'assistant';
  const emptyState = conversationId === null ? EMPTY_STATE : EMPTY_CONVERSATION_STATE;

  return (
    <section className="chat" aria-label="Chat with Partner">
      <div className="chat-transcript" aria-live="polite">
        {historyLoading ? (
          <p className="chat-empty" aria-busy="true">
            Loading conversation…
          </p>
        ) : rows.length === 0 && !historyLoading ? (
          <p className="chat-empty">{emptyState}</p>
        ) : (
          rows.map((row) =>
            row.role === 'user' ? (
              <div key={row.key} className="msg msg-user">
                {row.text}
              </div>
            ) : row.role === 'system' ? (
              <div key={row.key} className="msg msg-system">
                {row.text}
              </div>
            ) : (
              <div key={row.key} className="msg msg-assistant">
                {row.text === '' && showPending ? '…' : row.text}
              </div>
            ),
          )
        )}
      </div>

      <div className="chat-status" aria-live="polite">
        {historyError && !streaming ? (
          <div className="chat-error" role="alert">
            <span className="chat-error-text">{historyError}</span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => setReloadToken((n) => n + 1)}
            >
              Try again
            </button>
          </div>
        ) : turnError ? (
          <div className="chat-error" role="alert">
            <span className="chat-error-text">{turnError.message}</span>
            {turnError.canRepair ? (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onUnpair}>
                Pair again
              </button>
            ) : null}
          </div>
        ) : metaText.length > 0 ? (
          <span className="chat-meta">{metaText}</span>
        ) : streaming ? (
          <span className="chat-meta">Working…</span>
        ) : null}
      </div>

      {personaPaused && personaId ? (
        <div className="waiting-box paused-banner" role="alert">
          <span className="waiting-text">
            This persona is paused — resume it in Personas to continue.
          </span>
        </div>
      ) : null}

      <form className="chat-form" onSubmit={handleSubmit}>
        <textarea
          id="partner-message"
          className="field chat-input"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={personaPaused ? 'Persona paused' : 'Message Partner…'}
          aria-label="Message to Partner"
          disabled={personaPaused}
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!canSend}
          aria-busy={streaming}
        >
          {streaming ? 'Working…' : 'Send'}
        </button>
      </form>
    </section>
  );
}
