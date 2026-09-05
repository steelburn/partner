/**
 * M10 W5 session-only chat panel (PLAN-M10.md): reached from the pairing
 * gate when no Partner core is available. Talks DIRECTLY to an
 * OpenAI-compatible endpoint from the browser.
 *
 * Boundaries (by design): the pasted key lives ONLY in this component's
 * state for the tab — it is never stored, never put in a URL, never logged;
 * refreshing the page wipes it. No tools, memory, notes, personas or file
 * access exist in this mode; multi-turn history is in-memory only. A clear
 * notice says exactly what is disabled and why. Errors are readable (CORS
 * hint included) and never echo the key.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  normalizeChatEndpoint,
  streamSessionChat,
  validateSessionEndpoint,
  type SessionChatMessage,
} from './lib/session-chat.js';

export interface SessionChatProps {
  /** Return to the pairing gate (drops the in-memory key with this view). */
  onBack: () => void;
}

interface Turn extends SessionChatMessage {
  /** Stable key for rendering. */
  key: string;
}

const DEFAULT_ENDPOINT = 'https://api.ne1.dev/v1';
const DEFAULT_MODEL = 'gpt-4o-mini';

function roleLabel(turn: Turn): string {
  return turn.role === 'user' ? 'You' : turn.role === 'assistant' ? 'Session-only partner' : 'System';
}

export default function SessionChat({ onBack }: SessionChatProps) {
  // Setup state (one-shot until a session starts).
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [key, setKey] = useState('');
  const [started, setStarted] = useState(false);

  // Live session state (all in memory).
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyRef = useRef('');
  const endpointRef = useRef('');
  const modelRef = useRef(DEFAULT_MODEL);
  const messagesRef = useRef<SessionChatMessage[]>([]);
  const nextKeyRef = useRef(1);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [turns, streaming]);

  const start = (event: FormEvent): void => {
    event.preventDefault();
    const endpointError = validateSessionEndpoint(endpoint);
    if (endpointError !== null) {
      setError(endpointError);
      return;
    }
    if (key.trim().length < 8) {
      setError('Paste your API key — it stays in this tab and is never stored.');
      return;
    }
    if (model.trim() === '') {
      setError('A model id is required (e.g. gpt-4o-mini).');
      return;
    }
    const base = normalizeChatEndpoint(endpoint);
    endpointRef.current = base;
    keyRef.current = key.trim();
    modelRef.current = model.trim();
    messagesRef.current = [];
    setTurns([]);
    setError(null);
    setStarted(true);
  };

  const send = async (): Promise<void> => {
    const content = draft.trim();
    if (content === '' || streaming) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const userTurn: Turn = {
      role: 'user',
      content,
      key: `t-${nextKeyRef.current++}`,
    };
    messagesRef.current = [...messagesRef.current, { role: 'user', content }];
    setTurns((prev) => [...prev, userTurn]);
    setDraft('');
    setStreaming(true);
    setError(null);

    let assistantText = '';
    const { outcome, assistant } = await streamSessionChat(
      {
        endpoint: endpointRef.current,
        key: keyRef.current,
        model: modelRef.current,
        messages: messagesRef.current,
        signal: controller.signal,
      },
      (delta) => {
        assistantText += delta;
        // Stream into the LAST assistant turn (upsert pattern).
        setTurns((prev) => {
          const rest = prev;
          const last = rest[rest.length - 1];
          if (last !== undefined && last.role === 'assistant' && last.key.startsWith('stream-')) {
            return [...rest.slice(0, -1), { ...last, content: last.content + delta }];
          }
          return [...rest, { role: 'assistant', content: delta, key: 'stream-pending' }];
        });
      },
    );

    if (outcome.ok) {
      messagesRef.current = [
        ...messagesRef.current,
        { role: 'assistant', content: assistant },
      ];
      setTurns((prev) => {
        const rest = prev;
        const last = rest[rest.length - 1];
        if (last !== undefined && last.role === 'assistant' && last.key.startsWith('stream-')) {
          return [...rest.slice(0, -1), { ...last, key: `t-${nextKeyRef.current++}` }];
        }
        return rest;
      });
    } else if (outcome.kind !== 'aborted') {
      setError(outcome.message);
    }
    setStreaming(false);
    abortRef.current = null;
  };

  const stop = (): void => {
    abortRef.current?.abort();
  };

  const exit = (): void => {
    abortRef.current?.abort();
    // Drop every in-memory secret; back to pairing.
    keyRef.current = '';
    setKey('');
    setStarted(false);
    setTurns([]);
    setError(null);
    onBack();
  };

  if (!started) {
    return (
      <section className="gate" aria-label="Session-only chat">
        <div className="gate-panel">
          <h1 className="gate-title">Session-only chat</h1>
          <p className="gate-copy">
            No Partner core here? Chat directly with an OpenAI-compatible endpoint. The key stays
            in this tab for this session only — it is never stored, never sent anywhere except the
            endpoint you type, and disappears on refresh.
          </p>
          <p className="session-notice" role="note">
            Disabled in this mode: file access, memory, notes/plans, personas, skills and the
            browser extension. This is a plain chat with your own endpoint.
          </p>

          <form className="gate-form" onSubmit={start}>
            <label className="label" htmlFor="session-endpoint">
              Endpoint
            </label>
            <input
              id="session-endpoint"
              className="field"
              type="url"
              placeholder="https://api.ne1.dev/v1"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
            />
            <label className="label" htmlFor="session-model">
              Model
            </label>
            <input
              id="session-model"
              className="field"
              type="text"
              placeholder={DEFAULT_MODEL}
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
            <label className="label" htmlFor="session-key">
              API key
            </label>
            <input
              id="session-key"
              className="field"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="sk-…"
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
            <button type="submit" className="btn btn-primary btn-block">
              Start session-only chat
            </button>
            <button type="button" className="btn btn-secondary btn-block" onClick={onBack}>
              Back to pairing
            </button>
          </form>
        </div>
      </section>
    );
  }

  return (
    <section className="gate gate-wide" aria-label="Session-only chat transcript">
      <div className="gate-panel">
        <div className="session-head">
          <div className="session-meta">
            <h1 className="gate-title session-title">Session-only chat</h1>
            <p className="gate-copy session-sub">
              Endpoint {endpointRef.current} · model {modelRef.current} — key in memory only.
            </p>
          </div>
          <button type="button" className="btn btn-secondary" onClick={exit}>
            End session
          </button>
        </div>

        <div className="session-transcript" ref={transcriptRef} aria-live="polite">
          {turns.length === 0 ? (
            <p className="session-empty">Say hello — this stays in the tab until you leave.</p>
          ) : (
            turns.map((turn) => (
              <div key={turn.key} className={`session-bubble session-${turn.role}`}>
                <p className="session-role">{roleLabel(turn)}</p>
                <p className="session-text">{turn.content}</p>
              </div>
            ))
          )}
          {streaming ? <p className="session-typing">Streaming…</p> : null}
        </div>

        {error ? (
          <p className="form-error session-error" role="alert">
            {error}
          </p>
        ) : null}

        <form
          className="session-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <input
            className="field session-input"
            type="text"
            placeholder="Message the endpoint…"
            aria-label="Message to session-only partner"
            value={draft}
            disabled={streaming}
            onChange={(event) => setDraft(event.target.value)}
          />
          {streaming ? (
            <button type="button" className="btn btn-secondary" onClick={stop}>
              Stop
            </button>
          ) : (
            <button type="submit" className="btn btn-primary" disabled={draft.trim() === ''}>
              Send
            </button>
          )}
        </form>
      </div>
    </section>
  );
}
