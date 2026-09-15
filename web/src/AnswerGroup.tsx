/**
 * Answer group — ONE submit for a reply that asks more than one question set.
 *
 * The bug this replaces: a reply containing e.g. a `:::partner.choice` and a
 * `:::partner.form` rendered two cards, each with its own submit ("Confirm" and
 * "Submit answers"). Pressing either sent a user turn containing only that
 * card's answer, so the other question set was silently discarded — and the two
 * buttons sat side by side as if they were unrelated.
 *
 * Now the containers report their current answer upward, this component owns a
 * single submit, and the composed message carries every part. The parts are
 * joined with the exact per-card text they would have sent alone, so nothing on
 * the wire changes except that they arrive together.
 *
 * Submission is blocked until every part is complete: "send once" is only an
 * improvement if it cannot be used to send a partial answer set.
 */
import { useCallback, useMemo, useState } from 'react';
import type { ChoiceBlock, FormBlock, ScorecardBlock } from '@partner/shared';
import { ChoiceCard } from './ChoiceCard.js';
import { FormCard } from './FormCard.js';
import { ScorecardCard } from './ScorecardCard.js';
import {
  composeGroupedAnswer,
  groupReadiness,
  groupedSubmitText,
  type AnswerPart,
} from './lib/answer-group.js';

export interface AnswerGroupProps {
  /** The answerable containers of ONE message, in the order they appeared. */
  blocks: readonly (ChoiceBlock | FormBlock | ScorecardBlock)[];
  /** A turn is streaming: the group is inert. */
  busy: boolean;
  /**
   * Whether this group's message is still the newest in the transcript
   * (`isGroupLive`). Defaults to true so a renderer with no notion of
   * transcript position (assets lane, note previews) behaves as before.
   *
   * This is what makes the lock survive a reload: component state dies with the
   * page, `conversation-ui` is a non-durable in-memory Map, and a web-storage
   * key is refused by the storage census guard — so transcript position is the
   * only durable signal available.
   */
  live?: boolean;
  /** Send the composed message through the normal chat path. */
  onAnswer: (message: string) => void;
}

export function AnswerGroup({ blocks, busy, live = true, onAnswer }: AnswerGroupProps) {
  const [parts, setParts] = useState<Record<string, AnswerPart>>({});
  const [answered, setAnswered] = useState(false);

  /**
   * Each card reports on mount and on every change, so the parts map fills
   * itself. Identity is stable so the cards' reporting effects do not loop.
   */
  const reportPart = useCallback(
    (key: string, title: string | null, text: string | null): void => {
      setParts((prev) => {
        const existing = prev[key];
        if (existing !== undefined && existing.text === text && existing.title === title) {
          return prev;
        }
        return { ...prev, [key]: { key, title, text } };
      });
    },
    [],
  );

  // Ordered by block position, not by arrival: a card reports a frame after
  // mount, so arrival order is not a reliable signal of question order.
  const ordered = useMemo<AnswerPart[]>(
    () =>
      blocks
        .map((_, index) => parts[String(index)])
        .filter((part): part is AnswerPart => part !== undefined),
    [blocks, parts],
  );

  const readiness = groupReadiness(ordered, blocks.length);
  /**
   * An earlier message can no longer be answered: the conversation has moved
   * past it. `answered` is kept as well because it locks the button the instant
   * it is pressed, before the transcript refresh has landed.
   */
  const stale = !live;
  const inert = answered || stale;
  /**
   * Once sent the group is inert. With a single prominent button this matters
   * more than it did with two small ones: a second press would post the same
   * multi-part answer as another user turn. Verified as a real gap — the group
   * otherwise re-enables as soon as the turn stops streaming.
   */
  const locked = inert || busy;

  // A stale group is not "waiting on you", so it must not report a missing-answer
  // count; it states why it is inert instead. Both hints reuse the existing
  // element and class — this change introduces no CSS.
  const hint = answered ? null : stale ? 'From an earlier reply.' : readiness.hint;

  const submit = (): void => {
    if (locked || !readiness.ready) return;
    const message = composeGroupedAnswer(ordered);
    if (message === '') return;
    // Flip `answered` BEFORE handing off, so each card clears its pending draft.
    setAnswered(true);
    onAnswer(message);
  };

  return (
    <div className="answer-group" role="group" aria-label="Questions waiting on your answer">
      <div className="answer-group-parts">
        {blocks.map((block, index) => {
          const key = String(index);
          if (block.kind === 'choice') {
            return (
              <ChoiceCard
                key={key}
                mode={block.mode === 'multi' ? 'multi' : 'single'}
                title={block.title}
                options={block.options}
                busy={locked}
                showSubmit={false}
                answered={answered}
                onAnswerChange={(text) => reportPart(key, block.title, text)}
              />
            );
          }
          if (block.kind === 'form') {
            return (
              <FormCard
                key={key}
                title={block.title}
                questions={block.questions}
                busy={locked}
                showSubmit={false}
                requireAllAnswers
                answered={answered}
                onAnswerChange={(text) => reportPart(key, block.title, text)}
              />
            );
          }
          return (
            <ScorecardCard
              key={key}
              title={block.title}
              items={block.items}
              scale={block.scale}
              labels={block.labels}
              busy={locked}
              showSubmit={false}
              requireAllAnswers
              answered={answered}
              onAnswerChange={(text) => reportPart(key, block.title, text)}
            />
          );
        })}
      </div>
      <div className="answer-group-actions">
        {/* A disabled button with no reason is the classic dead end, so the
            group always says what it is still waiting for (counts only), or why
            it is no longer interactive. It precedes the button so the reason is
            read before the control. */}
        {hint !== null ? (
          <span className="answer-group-hint" role="status">
            {hint}
          </span>
        ) : null}
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={locked || !readiness.ready}
        >
          {/* Two inert reasons, two truthful labels: "answered" means the user
              sent it, "stale" means the conversation has moved on. Collapsing
              both into "Answers sent" asserted something false for a group the
              user never answered — uniform state is not worth a false claim. */}
          {groupedSubmitText({ answered, stale, expected: blocks.length })}
        </button>
      </div>
    </div>
  );
}
