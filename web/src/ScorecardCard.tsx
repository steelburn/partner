/**
 * Scorecard card (`:::partner.scorecard`).
 *
 * Several named items, each rated on one shared numeric scale — the row is an
 * item, the columns are scores 1..scale. Each row is its own radio group, so a
 * single score per item is a structural guarantee rather than a validation
 * rule. Submitting once produces ONE plain user message through the normal
 * chat path (nothing client-only), labelled like the multi-question form so
 * the model can match every rating to its item:
 *
 *   Q: Onboarding flow
 *   A: 4/5
 *
 * Pending ratings survive "move to another chat and come back" via the
 * conversation-scoped UI memory (see lib/conversation-ui.ts). While a turn is
 * streaming (`busy`) the card is inert so an answer can never interleave with
 * an in-flight turn.
 */
import { useEffect, useId, useState } from 'react';
import { useChoiceMemory } from './ChoiceMemory.js';
import { conversationUi } from './lib/conversation-ui.js';

export interface ScorecardCardProps {
  title: string | null;
  items: string[];
  /** Highest score; scores run 1..scale. */
  scale: number;
  /** Optional [low, high] labels for the scale ends. */
  labels?: [string, string] | null;
  busy: boolean;
  /**
   * Standalone submit handler. Optional because a card inside an answer group
   * renders inputs only — the group owns the single submit — and is driven by
   * `onAnswerChange` instead.
   */
  onConfirm?: (message: string) => void;
  /** False when another container in the same message also asks something. */
  showSubmit?: boolean;
  /** Report the current answer upward (null while incomplete) for the group. */
  onAnswerChange?: (text: string | null) => void;
  /** The group has submitted: clear this card's pending draft once. */
  answered?: boolean;
  /**
   * Grouped scorecards require EVERY item rated, unlike a standalone one
   * (which accepts any non-empty rating set) — the same rule the grouped form
   * uses, for the same reason: the single grouped submit must carry a complete
   * answer set or the point of "send once" is lost.
   */
  requireAllAnswers?: boolean;
}

/** Render the submitted ratings as one labelled message for the model. */
export function formatScorecardAnswers(
  items: string[],
  scores: readonly (number | null)[],
  scale: number,
): string {
  const parts: string[] = [];
  items.forEach((item, index) => {
    const score = scores[index];
    if (score === null || score === undefined) return;
    parts.push(`Q: ${item}\nA: ${score}/${scale}`);
  });
  return parts.join('\n\n');
}

/** The 1..scale score values, in order. */
function scoreRange(scale: number): number[] {
  const max = Math.max(2, Math.floor(scale));
  return Array.from({ length: max }, (_, index) => index + 1);
}

export function ScorecardCard({
  title,
  items,
  scale,
  labels = null,
  busy,
  onConfirm,
  showSubmit = true,
  onAnswerChange,
  answered = false,
  requireAllAnswers = false,
}: ScorecardCardProps) {
  const { conversationId } = useChoiceMemory();
  const groupName = useId();
  const memoryKey =
    conversationId !== null
      ? conversationUi.getScorecardKey(title, scale, items)
      : null;
  const remembered =
    memoryKey !== null ? conversationUi.getScorecard(conversationId, memoryKey) : null;
  const [scores, setScores] = useState<(number | null)[]>(() =>
    items.map((_, index) => {
      const rememberedScore = remembered?.scores[index];
      if (typeof rememberedScore !== 'number') return null;
      return rememberedScore >= 1 && rememberedScore <= scale ? rememberedScore : null;
    }),
  );

  // Persist the draft so returning to this conversation restores it.
  useEffect(() => {
    if (memoryKey === null) return;
    conversationUi.setScorecard(conversationId, memoryKey, { scores });
  }, [conversationId, memoryKey, scores]);

  // Grouped card: the group submits on this card's behalf, so the pending draft
  // is cleared here once that has happened.
  useEffect(() => {
    if (!answered || memoryKey === null) return;
    conversationUi.setScorecard(conversationId, memoryKey, null);
  }, [answered, conversationId, memoryKey]);

  const ratedCount = scores.filter((score) => score !== null).length;
  const allRated = items.length > 0 && ratedCount === items.length;
  const canSubmit = !busy && (requireAllAnswers ? allRated : ratedCount > 0);

  /** The text this scorecard would send, or null while it is not answerable. */
  const answerText = canSubmit ? formatScorecardAnswers(items, scores, scale) : null;

  useEffect(() => {
    onAnswerChange?.(answerText === '' ? null : answerText);
  }, [onAnswerChange, answerText]);

  const setScore = (index: number, score: number): void => {
    setScores((prev) => {
      if (prev[index] === score) return prev;
      const next = [...prev];
      next[index] = score;
      return next;
    });
  };

  const submit = (): void => {
    if (!canSubmit || answerText === null || answerText === '') return;
    // The scorecard is answered — forget the pending draft for this card.
    if (memoryKey !== null) conversationUi.setScorecard(conversationId, memoryKey, null);
    onConfirm?.(answerText);
  };

  return (
    <fieldset className="scorecard-card" disabled={busy} aria-busy={busy}>
      <legend className="scorecard-title">{title ?? 'Rate these'}</legend>
      {labels !== null ? (
        <p className="scorecard-legend">
          <span>
            1 = {labels[0]}
          </span>
          <span>
            {scale} = {labels[1]}
          </span>
        </p>
      ) : null}
      <div className="scorecard-items">
        {items.map((item, index) => (
          <div className="scorecard-item" key={`${item}-${index}`} role="group" aria-label={item}>
            <span className="scorecard-item-label">{item}</span>
            <div className="scorecard-scores">
              {scoreRange(scale).map((score) => {
                const inputId = `${groupName}-${index}-${score}`;
                return (
                  <span className="scorecard-score" key={score}>
                    <input
                      id={inputId}
                      type="radio"
                      className="scorecard-input"
                      name={`${groupName}-${index}`}
                      value={score}
                      checked={scores[index] === score}
                      disabled={busy}
                      aria-label={`${item}: ${score} of ${scale}`}
                      onChange={() => setScore(index, score)}
                    />
                    <label htmlFor={inputId} className="scorecard-score-label">
                      {score}
                    </label>
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="scorecard-actions">
        {showSubmit ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={!canSubmit}
          >
            Submit ratings
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}
