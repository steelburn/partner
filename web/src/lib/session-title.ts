/**
 * M34 — the session-title header's rules (PLAN-M34.md slice B).
 *
 * Renderer-independent on purpose (the same reason `persona-helpers.ts` and the
 * `PersonaChatTree` grouping are): the header is JSX, but "may I ask for a
 * title yet", "what does this title read as" and "what does the UI say about
 * where the title came from" are plain functions the node-only suite can pin.
 *
 * The threshold is the owner's own words: "the chat topic can be reviewed after
 * a few back and forth communication". Two user turns is that boundary — at one
 * turn the title would be the opening message, which the core already uses as
 * the automatic title (PLAN-M3), so asking a model to repeat it is noise.
 */

/** The `conversations.title` column cap in the core (manager clamps at 120). */
export const TITLE_MAX_CHARS = 120;
/** Mirror of the core's `TITLE_MIN_USER_TURNS`. */
export const TITLE_MIN_USER_TURNS = 2;

/** The minimum a row has to expose for the count below. */
export interface TitleTurnRow {
  role: string;
  text: string;
}

/** User turns with content — the "has this chat found a topic yet" measure. */
export function countTitleUserTurns(rows: readonly TitleTurnRow[]): number {
  return rows.filter((row) => row.role === 'user' && row.text.trim() !== '').length;
}

/**
 * Whether the "Suggest title" action is available. The core enforces the same
 * rule (400 `not_enough_context`), so a bypassed control still cannot name a
 * session from "hello" — this only keeps the button from offering it.
 */
export function canSuggestTitle(rows: readonly TitleTurnRow[]): boolean {
  return countTitleUserTurns(rows) >= TITLE_MIN_USER_TURNS;
}

/** Why the action is unavailable — shown as the control's hint, never as noise. */
export function suggestTitleHint(rows: readonly TitleTurnRow[]): string | undefined {
  if (canSuggestTitle(rows)) return undefined;
  return 'A title suggestion needs a couple of turns to read a topic.';
}

/** What an empty title reads as (the same string the rails use). */
export function titleForDisplay(title: string | null | undefined): string {
  const trimmed = typeof title === 'string' ? title.trim() : '';
  return trimmed === '' ? 'New chat' : trimmed;
}

/** Collapse whitespace, then clamp to what the core will store. */
export function normalizeTitleInput(value: string): string {
  const collapsed = value.replace(/\s+/g, ' ').trim();
  return collapsed.length > TITLE_MAX_CHARS ? collapsed.slice(0, TITLE_MAX_CHARS).trim() : collapsed;
}

/**
 * The one sentence that keeps a derived title honest. A suggestion naming
 * `source: 'transcript'` was NOT named by a model (demo mode, or nothing
 * configured) — it is the opening message — and saying so is the difference
 * between a helpful shortcut and implying the partner read the chat.
 */
export function suggestionSourceNote(source: 'model' | 'transcript'): string | null {
  return source === 'transcript'
    ? 'No model named this — it is your opening message, shortened.'
    : null;
}
