/**
 * M34 — the session title suggestion (PLAN-M34.md, slice B).
 *
 * The owner's request: "write chat session title at the top. Make it
 * editable/AI-suggestible — meaning the chat topic can be reviewed after a few
 * back and forth communication between persona and user."
 *
 * So this is a REVIEW action, not an auto-rename: the core proposes a title for
 * an existing conversation, and the only thing that writes it is the owner's
 * own `PUT /v1/conversations/:id`. Nothing here persists anything.
 *
 * The call itself is `runBoundedModelCall` (the ONE bounded one-shot call the
 * skill-authoring and flow-authoring paths already share — M28 D), so this
 * module inherits its byte cap and abort timeout rather than growing a second
 * bound. What stays HERE is what is title-specific:
 *
 *   bounded input   the transcript is clamped (last N turns, each clipped) so a
 *                   100-message conversation cannot push an unbounded prompt.
 *   bounded output  the reply is sanitized through {@link sanitizeTitle}: one
 *                   line, no quotes/markup/`Title:` prefix, no trailing
 *                   punctuation, clamped to {@link TITLE_MAX_CHARS}.
 *   honest fallback with no model configured (or in demo mode) the title is
 *                   DERIVED from the opening message and reported as
 *                   `source: 'transcript'` — the same honesty as the demo chat
 *                   provider. A provider that IS configured but unusable stays a
 *                   typed failure, because the owner asked a model to name the
 *                   chat and must be told it did not happen.
 *
 * Secrets discipline: message content is passed to the model and to nobody
 * else — it is never logged, returned in a failure message, or audited. The
 * audit row the route writes carries counts and the model name only.
 */
import type { ConversationMessage } from '@partner/shared';
import {
  runBoundedModelCall,
  type ModelCallFailureCode,
  type ModelCallOptions,
} from '../skills/model.js';

/** Hard cap on a stored/suggested title (the DB column clamps at 120). */
export const TITLE_MAX_CHARS = 80;
/** What the prompt asks the model for — a searchable, list-friendly length. */
export const TITLE_ASK_CHARS = 60;
/**
 * "A few back and forth": the suggestion is offered once the exchange has at
 * least two user turns, so a title is named from a topic rather than a hello.
 */
export const TITLE_MIN_USER_TURNS = 2;
/** How many recent turns the prompt sees (the newest ones). */
export const TITLE_TRANSCRIPT_TURNS = 12;
/** Per-turn clip, so one pasted document cannot dominate the prompt. */
export const TITLE_TURN_CHARS = 400;

const ELLIPSIS = '…';

/** The whole contract the model is handed. Kept explicit: it is the prompt. */
export const TITLE_SYSTEM_PROMPT = [
  'You name chat sessions so their owner can find them again.',
  '',
  `Answer with ONE title of at most ${TITLE_ASK_CHARS} characters.`,
  'Rules:',
  '- One line. No quotes, no markdown, no `Title:` prefix, no trailing punctuation.',
  '- Name the SUBJECT of the conversation (the thing being worked on), not the greeting.',
  '- Prefer the owner\'s own words.',
  '- Write it in the language the conversation is written in.',
  '- Answer with the title and nothing else.',
].join('\n');

/** Collapse every whitespace run to one space (and trim). */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Clip to `max` characters, marking the cut. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}${ELLIPSIS}`;
}

/** User turns with content — the "has this chat found a topic yet" measure. */
export function countUserTurns(messages: readonly ConversationMessage[]): number {
  return messages.filter((m) => m.role === 'user' && collapseWhitespace(m.content) !== '').length;
}

/**
 * The transcript the prompt sees: the last {@link TITLE_TRANSCRIPT_TURNS}
 * user/assistant turns with content, each clipped. System messages are left out
 * — they are instructions to the model, not the conversation's subject, and
 * they can be very long.
 */
export function buildTitleTranscript(messages: readonly ConversationMessage[]): string {
  const turns = messages
    .filter((m) => m.role !== 'system' && collapseWhitespace(m.content) !== '')
    .slice(-TITLE_TRANSCRIPT_TURNS);
  return turns
    .map((turn) => {
      const who = turn.role === 'user' ? 'User' : 'Assistant';
      return `${who}: ${clip(collapseWhitespace(turn.content), TITLE_TURN_CHARS)}`;
    })
    .join('\n');
}

/**
 * Reduce a model reply to a title, or null when there is nothing usable.
 *
 * The reply is untrusted text: only the FIRST non-empty line survives, list
 * markers / a `Title:` label / surrounding quotes / markdown emphasis are
 * stripped, and trailing punctuation is dropped. This is what keeps a reply
 * like `**Title:** "Refactor the auth flow."` from becoming a 60-character
 * label that reads like a sentence.
 */
export function sanitizeTitle(raw: string): string | null {
  const firstLine = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (firstLine === undefined) return null;
  let title = firstLine
    // A leading list marker or ATX heading.
    .replace(/^\s*(?:[-*•]|\d+[.)]|#{1,6})\s*/, '')
    // A `Title:` / `Session title -` label.
    .replace(/^\s*(?:session\s+)?title\s*[:\-–—]\s*/i, '')
    .trim();
  // Surrounding emphasis/quotes/backticks (repeatedly: `**"x"**`).
  let previous = '';
  while (previous !== title) {
    previous = title;
    title = title
      .replace(/^[*_`"'\u201c\u2018]+/, '')
      .replace(/[*_`"'\u201d\u2019]+$/, '')
      .trim();
  }
  // A trailing sentence stop reads as prose in a list.
  title = title.replace(/[.,;:!?\u2014-]+$/, '').trim();
  title = collapseWhitespace(title);
  if (title === '') return null;
  return clip(title, TITLE_MAX_CHARS);
}

export type TitleParseResult =
  | { ok: true; title: string }
  | { ok: false; message: string };

export function parseTitleReply(text: string): TitleParseResult {
  const title = sanitizeTitle(text);
  if (title === null) return { ok: false, message: 'the model returned no usable title' };
  return { ok: true, title };
}

/**
 * The deterministic title (demo mode, or no provider configured): the owner's
 * opening message, collapsed and clipped. It is what the core already uses for
 * an auto-created chat (PLAN-M3: the first user message, 60 chars), so the
 * fallback and the automatic path agree on what a session is called.
 */
export function derivedTitle(messages: readonly ConversationMessage[]): string | null {
  const source =
    messages.find((m) => m.role === 'user' && collapseWhitespace(m.content) !== '') ??
    messages.find((m) => collapseWhitespace(m.content) !== '');
  if (source === undefined) return null;
  const title = clip(collapseWhitespace(source.content), TITLE_ASK_CHARS);
  return title === '' ? null : title;
}

export type TitleSuggestionFailureCode =
  | 'no_context'
  | 'no_provider'
  | 'timeout'
  | 'reply_too_large'
  | 'upstream'
  | 'unusable_reply';

export type TitleSuggestionOutcome =
  | { ok: true; title: string; model: string; source: 'model' | 'transcript' }
  | { ok: false; code: TitleSuggestionFailureCode; message: string };

/** The slice of the provider manager the suggestion needs (structural). */
export interface TitleSuggesterOptions {
  providers: ModelCallOptions['providers'];
  /** Demo mode never calls a provider — the derived title answers instead. */
  demo: boolean;
  /** Injectable clock (epoch ms) — forwarded to the bounded call. */
  now?: () => number;
  /** Injectable bound, so a test can reach the abort path promptly. */
  timeoutMs?: number;
  /** Injectable cap, so a test can exceed it cheaply. */
  replyCapBytes?: number;
}

export interface TitleSuggestionInput {
  messages: readonly ConversationMessage[];
}

export interface TitleSuggester {
  suggest(input: TitleSuggestionInput): Promise<TitleSuggestionOutcome>;
}

const FAILURE_CODE: Record<Exclude<ModelCallFailureCode, 'no_model'>, TitleSuggestionFailureCode> = {
  no_provider: 'no_provider',
  timeout: 'timeout',
  reply_too_large: 'reply_too_large',
  upstream: 'upstream',
  empty_reply: 'unusable_reply',
};

/**
 * One bounded suggestion. Returns a typed outcome instead of throwing, so the
 * route decides the status and the UI decides what it says.
 */
export async function suggestConversationTitle(
  options: TitleSuggesterOptions,
  input: TitleSuggestionInput,
): Promise<TitleSuggestionOutcome> {
  const derived = derivedTitle(input.messages);
  if (derived === null) {
    return { ok: false, code: 'no_context', message: 'this conversation has nothing to name yet' };
  }
  const deterministic: TitleSuggestionOutcome = {
    ok: true,
    title: derived,
    model: 'transcript',
    source: 'transcript',
  };
  // Demo mode answers deterministically (like the demo chat provider) so the
  // whole flow is walkable with no credentials.
  if (options.demo) return deterministic;

  const outcome = await runBoundedModelCall(
    {
      providers: options.providers,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.replyCapBytes === undefined ? {} : { replyCapBytes: options.replyCapBytes }),
    },
    {
      system: TITLE_SYSTEM_PROMPT,
      user: `Conversation so far:\n\n${buildTitleTranscript(input.messages)}\n\nName this session now.`,
    },
  );
  if (!outcome.ok) {
    // "No model configured" is a walkable state, not a failure: the derived
    // title keeps the control useful and says where it came from. A provider
    // that IS configured but unusable stays a typed failure.
    if (outcome.code === 'no_model') return deterministic;
    return {
      ok: false,
      code: FAILURE_CODE[outcome.code],
      message:
        outcome.code === 'no_provider'
          ? 'this provider cannot name the session - check its key, or rename it yourself'
          : outcome.message,
    };
  }
  const parsed = parseTitleReply(outcome.text);
  if (!parsed.ok) return { ok: false, code: 'unusable_reply', message: parsed.message };
  return { ok: true, title: parsed.title, model: outcome.model, source: 'model' };
}

/** The hook the route takes (mirrors `createSkillGenerator`). */
export function createTitleSuggester(options: TitleSuggesterOptions): TitleSuggester {
  return { suggest: (input) => suggestConversationTitle(options, input) };
}
