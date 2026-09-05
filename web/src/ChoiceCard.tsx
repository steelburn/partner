/**
 * M11 F9 clickable choices (PLAN-M11.md).
 *
 * Renders a `:::partner.choice` container as a real single/multi selection
 * control. Confirm produces ONE plain user message through the normal chat
 * path (nothing client-only). Styling is token-driven; every control has
 * focus-visible + disabled states. While a turn is streaming (`busy`) the
 * card is inert so an answer can never interleave with an in-flight turn.
 */
import { useState } from 'react';

export interface ChoiceCardProps {
  mode: 'single' | 'multi';
  title: string | null;
  options: string[];
  busy: boolean;
  onConfirm: (labels: string[]) => void;
}

export function ChoiceCard({ mode, title, options, busy, onConfirm }: ChoiceCardProps) {
  const [single, setSingle] = useState<string | null>(null);
  const [multi, setMulti] = useState<ReadonlySet<string>>(new Set());
  const [noneMode, setNoneMode] = useState(false);
  const [freeText, setFreeText] = useState('');

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
    if (!canConfirm) return;
    if (noneMode && freeText.trim() !== '') {
      onConfirm([freeText.trim()]);
      return;
    }
    const labels =
      mode === 'single'
        ? single !== null
          ? [single]
          : []
        : [...(selected as ReadonlySet<string>)];
    if (labels.length > 0) onConfirm(labels);
  };

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
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={confirm}
          disabled={!canConfirm}
        >
          {mode === 'multi' ? 'Confirm selections' : 'Confirm'}
        </button>
      </div>
    </fieldset>
  );
}
