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
  onConfirm: (message: string) => void;
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

export function FormCard({ title, questions, busy, onConfirm }: FormCardProps) {
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

  const canSubmit = !busy && answers.some((answer) => answer.trim() !== '');

  const setAnswer = (index: number, value: string): void => {
    setAnswers((prev) => {
      if (prev[index] === value) return prev;
      const next = [...prev];
      next[index] = value;
      return next;
    });
  };

  const submit = (): void => {
    if (!canSubmit) return;
    const message = formatFormAnswers(questions, answers);
    if (message === '') return;
    // The form is answered — forget the pending draft for this card.
    if (memoryKey !== null) conversationUi.setForm(conversationId, memoryKey, null);
    onConfirm(message);
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
              autoFocus={index === 0}
              aria-label={question}
              placeholder="Type your answer…"
              onChange={(event) => setAnswer(index, event.target.value)}
            />
          </label>
        ))}
      </div>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={submit}
          disabled={!canSubmit}
        >
          Submit answers
        </button>
      </div>
    </fieldset>
  );
}
