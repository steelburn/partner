/**
 * M11 A/B persona studio (PLAN-M11.md extra).
 *
 * Compare two personas head to head on the SAME prompt. Runs both turns
 * through the real /v1/chat path with {noPersist:true} — nothing is ever
 * saved to the rail, so comparisons stay clean. Streaming text appears per
 * side as it arrives; the resolved model and token usage are shown after
 * each side finishes.
 */
import { useEffect, useRef, useState } from 'react';
import type { Persona } from '@partner/shared';
import type { ChatEvent } from '@partner/shared';
import { streamChat } from './lib/api.js';
import { readStoredToken } from './lib/token.js';

export interface PersonaCompareProps {
  personas: Persona[] | null;
  onUnpair: () => void;
}

interface SideResult {
  text: string;
  model: string | null;
  tokens: number | null;
  error: string | null;
}

interface SideState {
  busy: boolean;
  result: SideResult | null;
}

const EMPTY_RESULT: SideResult = { text: '', model: null, tokens: null, error: null };

export function PersonaCompare({ personas, onUnpair }: PersonaCompareProps) {
  const list = personas ?? [];
  const [idA, setIdA] = useState<string>(list[0]?.id ?? '');
  const [idB, setIdB] = useState<string>(list[1]?.id ?? '');
  const [prompt, setPrompt] = useState('');
  const [sideA, setSideA] = useState<SideState>({ busy: false, result: null });
  const [sideB, setSideB] = useState<SideState>({ busy: false, result: null });
  const [error, setError] = useState<string | null>(null);
  const controllers = useRef<AbortController[]>([]);

  useEffect(() => {
    return () => {
      for (const controller of controllers.current) controller.abort();
    };
  }, []);

  // Keep ids valid as the persona list changes.
  useEffect(() => {
    if (list.length === 0) return;
    setIdA((current) => (list.some((p) => p.id === current) ? current : (list[0]?.id ?? '')));
    setIdB((current) => {
      if (list.some((p) => p.id === current)) return current;
      return list.find((p) => p.id !== idA)?.id ?? list[0]?.id ?? '';
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personas]);

  const personaName = (id: string): string =>
    list.find((p) => p.id === id)?.name ?? '(missing persona)';

  const canRun =
    idA !== '' && idB !== '' && idA !== idB && prompt.trim() !== '' && !sideA.busy && !sideB.busy;

  const runSide = async (key: 'A' | 'B', personaId: string, content: string): Promise<void> => {
    const token = readStoredToken();
    if (!token) {
      onUnpair();
      return;
    }
    const setSide = key === 'A' ? setSideA : setSideB;
    const controller = new AbortController();
    controllers.current.push(controller);
    let model: string | null = null;
    let tokens: number | null = null;
    let text = '';
    setSide({ busy: true, result: EMPTY_RESULT });
    const onEvent = (event: ChatEvent): void => {
      if (event.type === 'delta') {
        text += event.text;
        setSide({ busy: true, result: { text, model, tokens, error: null } });
      } else if (event.type === 'usage') {
        tokens = event.totalTokens;
      } else if (event.type === 'done') {
        model = event.model;
      } else if (event.type === 'error') {
        setSide({ busy: false, result: { text, model, tokens, error: event.message } });
      }
    };
    const result = await streamChat({
      token,
      content,
      personaId,
      noPersist: true,
      signal: controller.signal,
      onEvent,
    }).catch((cause: unknown) => ({
      ok: false,
      message: cause instanceof Error ? cause.message : 'Compare request failed.',
      unauthorized: false,
    }));
    if (!result.ok) {
      const unauthorized = (result as { unauthorized?: boolean }).unauthorized === true;
      if (unauthorized) {
        onUnpair();
        return;
      }
      setSide({
        busy: false,
        result: { text, model, tokens, error: result.message ?? 'Compare failed.' },
      });
      return;
    }
    setSide({ busy: false, result: { text, model, tokens, error: null } });
  };

  const run = async (): Promise<void> => {
    if (!canRun) return;
    setError(null);
    const content = prompt.trim();
    await Promise.all([runSide('A', idA, content), runSide('B', idB, content)]);
  };

  const copyText = async (text: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      setError('Clipboard unavailable.');
    }
  };

  const personaOption = (persona: Persona): string => `${persona.name}${persona.paused ? ' (paused)' : ''}`;

  return (
    <section className="card compare-card" aria-label="Compare personas">
      <h2 className="card-title">A/B — compare personas</h2>
      <p className="card-copy">
        Run the same prompt through two personas, side by side. Nothing is saved to your chats —
        this is a pure comparison.
      </p>

      <div className="compare-picks">
        <label className="label" htmlFor="compare-a">
          Persona A
        </label>
        <select id="compare-a" className="field" value={idA} onChange={(event) => setIdA(event.target.value)}>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {personaOption(p)}
            </option>
          ))}
        </select>
        <span className="compare-vs">vs</span>
        <label className="label" htmlFor="compare-b">
          Persona B
        </label>
        <select id="compare-b" className="field" value={idB} onChange={(event) => setIdB(event.target.value)}>
          {list.map((p) => (
            <option key={p.id} value={p.id}>
              {personaOption(p)}
            </option>
          ))}
        </select>
      </div>

      <div className="compare-prompt">
        <label className="label" htmlFor="compare-prompt">
          Prompt
        </label>
        <textarea
          id="compare-prompt"
          className="field chat-input"
          rows={3}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder="Ask both personas the same thing…"
          aria-label="Compare prompt"
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void run()}
          disabled={!canRun}
          aria-busy={sideA.busy || sideB.busy}
        >
          {sideA.busy || sideB.busy ? 'Comparing…' : 'Compare'}
        </button>
      </div>

      {error !== null ? (
        <p className="chat-attach-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="compare-results">
        {(['A', 'B'] as const).map((key) => {
          const state = key === 'A' ? sideA : sideB;
          const personaId = key === 'A' ? idA : idB;
          const sr = state.result;
          let body;
          if (state.busy && sr !== null && sr.text === '') {
            body = <p className="rail-note">Waiting…</p>;
          } else if (sr === null) {
            body = (
              <p className="rail-note">Run a comparison to see {personaName(personaId)}’s answer.</p>
            );
          } else if (sr.error !== null) {
            body = (
              <p className="chat-attach-error" role="alert">
                {sr.error}
              </p>
            );
          } else {
            body = (
              <>
                <pre className="compare-text">{sr.text}</pre>
                <button type="button" className="btn-link" onClick={() => void copyText(sr.text)} disabled={state.busy}>
                  Copy
                </button>
              </>
            );
          }
          return (
            <article key={key} className="compare-result" aria-busy={state.busy}>
              <header className="compare-result-head">
                <span className="compare-result-name">{personaName(personaId)}</span>
                {sr?.model ? <span className="compare-result-meta">{sr.model}</span> : null}
                {sr?.tokens !== null && sr?.tokens !== undefined ? (
                  <span className="compare-result-meta">{sr.tokens} tokens</span>
                ) : null}
              </header>
              {body}
            </article>
          );
        })}
      </div>
    </section>
  );
}
