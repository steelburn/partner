/**
 * Multi-question form card (:::partner.form).
 *
 * When the model has more than one open-ended question, it emits them as a
 * form container. The card gives each question its own textarea so the user
 * answers them one by one, then submits ONCE — the answers become a single
 * plain user message through the normal chat path (nothing client-only).
 * Answers are labelled with their question so the model can match them.
 *
 * Pending drafts survive "move to another chat and come back" via the
 * conversation-scoped UI memory (see lib/conversation-ui.ts). While a turn is
 * streaming (`busy`) the form is inert so an answer can never interleave with
 * an in-flight turn.
 */
import { useEffect, useState } from 'react';
import { useChoiceMemory } from './ChoiceMemory.js';
import { conversationUi } from './lib/conversation-ui.js';

export interface FormCardProps {
  title: string | null;
  questions: string[];
  busy: boolean;
  /**
   * Standalone submit handler. Optional because a card inside an answer group
   * renders inputs only — the group owns the single submit — and is driven by
   * `onAnswerChange` instead.
   */
  onConfirm?: (message: string) => void;
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
  /**
   * Grouped forms require EVERY question, unlike a standalone form (which
   * accepts any non-empty answer). Rationale: the point of a single grouped
   * submit is that the persona receives a complete answer set in one turn, so
   * a half-filled form would defeat it; alone, a form has no sibling answers to
   * be lost alongside, so its existing permissive rule is left untouched.
   */
  requireAllAnswers?: boolean;
}

/** Render the submitted answers as one labelled message for the model. */
export function formatFormAnswers(questions: string[], answers: string[]): string {
  const parts: string[] = [];
  questions.forEach((question, index) => {
    const answer = (answers[index] ?? '').trim();
    if (answer === '') return;
    parts.push(`Q: ${question}\nA: ${answer}`);
  });
  return parts.join('\n\n');
}

export function FormCard({
  title,
  questions,
  busy,
  onConfirm,
  showSubmit = true,
  onAnswerChange,
  answered = false,
  requireAllAnswers = false,
}: FormCardProps) {
  const { conversationId } = useChoiceMemory();
  const memoryKey =
    conversationId !== null ? conversationUi.getFormKey(title, questions) : null;
  const remembered = memoryKey !== null ? conversationUi.getForm(conversationId, memoryKey) : null;
  const [answers, setAnswers] = useState<string[]>(
    () => questions.map((_, index) => remembered?.answers[index] ?? ''),
  );

  // Persist the draft so returning to this conversation restores it.
  useEffect(() => {
    if (memoryKey === null) return;
    conversationUi.setForm(conversationId, memoryKey, { answers });
  }, [conversationId, memoryKey, answers]);

  const allAnswered = questions.every((_, index) => (answers[index] ?? '').trim() !== '');
  const someAnswered = answers.some((answer) => answer.trim() !== '');
  const canSubmit = !busy && (requireAllAnswers ? allAnswered : someAnswered);

  /** The text this form would send, or null while it is not answerable yet. */
  const answerText = canSubmit ? formatFormAnswers(questions, answers) : null;

  useEffect(() => {
    onAnswerChange?.(answerText === '' ? null : answerText);
  }, [onAnswerChange, answerText]);

  // Grouped card: the group submits on this card's behalf, so the pending draft
  // is cleared here once that has happened.
  useEffect(() => {
    if (!answered || memoryKey === null) return;
    conversationUi.setForm(conversationId, memoryKey, null);
  }, [answered, conversationId, memoryKey]);

  const setAnswer = (index: number, value: string): void => {
    setAnswers((prev) => {
      if (prev[index] === value) return prev;
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const submit = (): void => {
    if (!canSubmit || answerText === null) return;
    const message = answerText;
    if (message === '') return;
    // The form is answered — forget the pending draft for this card.
    if (memoryKey !== null) conversationUi.setForm(conversationId, memoryKey, null);
    onConfirm?.(message);
  };

  return (
    <fieldset className="form-card" disabled={busy} aria-busy={busy}>
      <legend className="form-title">{title ?? 'A few questions'}</legend>
      <div className="form-questions">
        {questions.map((question, index) => (
          <label key={`${question}-${index}`} className="form-question">
            <span className="form-question-label">{question}</span>
            <textarea
              className="field form-answer"
              value={answers[index] ?? ''}
              rows={2}
              disabled={busy}
              autoFocus={showSubmit && index === 0}
              aria-label={question}
              placeholder="Type your answer…"
              onChange={(event) => setAnswer(index, event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="form-actions">
        {showSubmit ? (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={submit}
            disabled={!canSubmit}
          >
            Submit answers
          </button>
        ) : null}
      </div>
    </fieldset>
  );
}
