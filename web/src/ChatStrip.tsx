import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ChatEvent } from '@partner/shared';
import { streamChat } from './lib/api.js';
import { readStoredToken } from './lib/token.js';

export interface ChatStripProps {
  /** Forget the session and return to the pairing gate (auth failure). */
  onUnpair: () => void;
}

interface ChatRow {
  id: number;
  role: 'user' | 'assistant';
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

/**
 * Minimal demo chat strip wired to the /v1/chat SSE stream. The user bubble
 * sits on the accent, the partner's on the surface; a muted footer carries
 * usage + latency once the turn completes.
 */
export default function ChatStrip({ onUnpair }: ChatStripProps) {
  const [rows, setRows] = useState<ChatRow[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [modelLatency, setModelLatency] = useState<{ model: string; latencyMs: number } | null>(
    null,
  );
  const [turnError, setTurnError] = useState<TurnError | null>(null);
  const nextId = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const canSend = !streaming && draft.trim().length > 0;

  /** End the in-flight turn and drop a still-empty assistant placeholder row. */
  const finishTurn = (): void => {
    setStreaming(false);
    setRows((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.role === 'assistant' && last.text === '') return prev.slice(0, -1);
      return prev;
    });
  };

  const send = async (): Promise<void> => {
    const content = draft.trim();
    if (content.length === 0 || streaming) return;

    const token = readStoredToken();
    if (!token) {
      setTurnError({ message: 'Not paired with the Partner core.', canRepair: true });
      return;
    }

    const userRow: ChatRow = { id: ++nextId.current, role: 'user', text: content };
    const placeholder: ChatRow = { id: ++nextId.current, role: 'assistant', text: '' };
    setRows((prev) => [...prev, userRow, placeholder]);
    setDraft('');
    setUsage(null);
    setModelLatency(null);
    setTurnError(null);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const onEvent = (event: ChatEvent): void => {
      switch (event.type) {
        case 'delta':
          // Append to the live assistant row (always the last row mid-turn).
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
      }
    };

    try {
      const result = await streamChat({
        token,
        content,
        signal: controller.signal,
        onEvent,
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
      finishTurn();
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
  if (usage) metaParts.push(`${usage.totalTokens} tokens`);
  if (modelLatency) metaParts.push(`${modelLatency.model} · ${modelLatency.latencyMs} ms`);
  const metaText = metaParts.join(' · ');
  const showPending = streaming && rows[rows.length - 1]?.role === 'assistant';

  return (
    <section className="chat" aria-label="Chat with Partner">
      <div className="chat-transcript" aria-live="polite">
        {rows.length === 0 ? (
          <p className="chat-empty">{EMPTY_STATE}</p>
        ) : (
          rows.map((row) =>
            row.role === 'user' ? (
              <div key={row.id} className="msg msg-user">
                {row.text}
              </div>
            ) : (
              <div key={row.id} className="msg msg-assistant">
                {row.text === '' && showPending ? '…' : row.text}
              </div>
            ),
          )
        )}
      </div>

      <div className="chat-status" aria-live="polite">
        {turnError ? (
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

      <form className="chat-form" onSubmit={handleSubmit}>
        <textarea
          id="partner-message"
          className="field chat-input"
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message Partner…"
          aria-label="Message to Partner"
        />
        <button type="submit" className="btn btn-primary" disabled={!canSend}>
          Send
        </button>
      </form>
    </section>
  );
}
