/**
 * M11 F9 clickable choices (PLAN-M11.md).
 *
 * Renders a `:::partner.choice` container as a real single/multi selection
 * control. Confirm produces ONE plain user message through the normal chat
 * path (nothing client-only). Styling is token-driven; every control has
 * focus-visible + disabled states. While a turn is streaming (`busy`) the
 * card is inert so an answer can never interleave with an in-flight turn.
 */
import { useEffect, useState } from 'react';
import { useChoiceMemory } from './ChoiceMemory.js';
import { conversationUi } from './lib/conversation-ui.js';

export interface ChoiceCardProps {
  mode: 'single' | 'multi';
  title: string | null;
  options: string[];
  busy: boolean;
  /**
   * Standalone submit handler. Optional because a card inside an answer group
   * renders inputs only — the group owns the single submit — and is driven by
   * `onAnswerChange` instead. Passing a no-op `onConfirm` there would be a
   * silent trap, so the absence is explicit.
   */
  onConfirm?: (labels: string[]) => void;
  /**
   * M20.A: false when another container in the same message also asks a
   * question. One message must offer exactly one submit, or pressing one
   * button discards the other's answers.
   */
  showSubmit?: boolean;
  /** Report the current answer upward (null while incomplete) for the group. */
  onAnswerChange?: (text: string | null) => void;
  /** The group has submitted: clear this card's pending draft once. */
  answered?: boolean;
}

export function ChoiceCard({
  mode,
  title,
  options,
  busy,
  onConfirm,
  showSubmit = true,
  onAnswerChange,
  answered = false,
}: ChoiceCardProps) {
  // M14: when a conversation context is present, pending selections survive
  // "move to another chat and come back" (per-conversation UI memory).
  const { conversationId } = useChoiceMemory();
  const memoryKey =
    conversationId !== null
      ? conversationUi.getChoiceKey(mode, title, options)
      : null;
  const remembered = memoryKey !== null ? conversationUi.getChoice(conversationId, memoryKey) : null;
  const [single, setSingle] = useState<string | null>(
    () => remembered?.single ?? null,
  );
  const [multi, setMulti] = useState<ReadonlySet<string>>(
    () => new Set(remembered?.multi ?? []),
  );
  const [noneMode, setNoneMode] = useState(false);
  const [freeText, setFreeText] = useState('');

  // Persist pending selections so returning to this conversation restores
  // them (conversation-scoped UI memory — see lib/conversation-ui.ts).
  useEffect(() => {
    if (memoryKey === null) return;
    conversationUi.setChoice(conversationId, memoryKey, {
      single,
      multi: mode === 'multi' ? [...multi] : [],
    });
  }, [conversationId, memoryKey, mode, single, multi]);

  const selected = mode === 'single' ? single : multi;
  const hasSelection =
    mode === 'single' ? single !== null : (selected as ReadonlySet<string>).size > 0;
  const canConfirm = !busy && (hasSelection || (noneMode && freeText.trim() !== ''));

  const toggle = (label: string): void => {
    if (mode === 'single') {
      setSingle(label);
      return;
    }
    setMulti((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });
  };

  const confirm = (): void => {
    if (answerText === null) return;
    if (noneMode && freeText.trim() !== '') {
      onConfirm?.([freeText.trim()]);
      return;
    }
    const labels =
      mode === 'single'
        ? single !== null
          ? [single]
          : []
        : [...(selected as ReadonlySet<string>)];
    if (labels.length === 0) return;
    // The card is answered — forget the pending selection for this card.
    if (memoryKey !== null) conversationUi.setChoice(conversationId, memoryKey, null);
    onConfirm?.(labels);
  };

  /**
   * The exact text this card would send, or null while it cannot be sent. The
   * group composes its one message from this, and it is derived from the same
   * labels `confirm()` sends — so a grouped submit is byte-identical to what
   * this card would have sent alone.
   */
  const answerText: string | null = (() => {
    if (!canConfirm) return null;
    if (noneMode && freeText.trim() !== '') return freeText.trim();
    const labels =
      mode === 'single'
        ? single !== null
          ? [single]
          : []
        : [...(selected as ReadonlySet<string>)];
    if (labels.length === 0) return null;
    return mode === 'multi' ? labels.join('; ') : (labels[0] ?? null);
  })();

  useEffect(() => {
    onAnswerChange?.(answerText);
  }, [onAnswerChange, answerText]);

  // Grouped card: the group submits on this card's behalf, so the pending draft
  // is cleared here once that has happened.
  useEffect(() => {
    if (!answered || memoryKey === null) return;
    conversationUi.setChoice(conversationId, memoryKey, null);
  }, [answered, conversationId, memoryKey]);

  return (
    <fieldset className="choice-card" disabled={busy} aria-busy={busy}>
      <legend className="choice-title">{title ?? 'Choose one'}</legend>
      <div className="choice-options" role="group" aria-label={title ?? 'Options'}>
        {options.map((option) => {
          const checked =
            mode === 'single'
              ? single === option
              : (selected as ReadonlySet<string>).has(option);
          return (
            <label key={option} className="choice-option">
              <input
                type={mode === 'single' ? 'radio' : 'checkbox'}
                name={mode === 'single' ? 'choice' : undefined}
                className="choice-input"
                checked={checked}
                disabled={busy || noneMode}
                onChange={() => {
                  setNoneMode(false);
                  toggle(option);
                }}
              />
              <span className="choice-label">{option}</span>
            </label>
          );
        })}
      </div>
      {noneMode ? (
        <div className="choice-none-row">
          <input
            className="field"
            value={freeText}
            aria-label="Your own answer"
            disabled={busy}
            autoFocus
            onChange={(event) => setFreeText(event.target.value)}
          />
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-link btn-sm choice-none-toggle"
          onClick={() => setNoneMode(true)}
          disabled={busy}
        >
          None of these — type my own
        </button>
      )}
      <div className="choice-actions">
        {showSubmit ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={confirm}
            disabled={!canConfirm}
          >
            {mode === 'multi' ? 'Confirm selections' : 'Confirm'}
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}
