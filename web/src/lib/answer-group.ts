/**
 * Grouped answers — one submit for a message that asks more than one thing.
 *
 * The bug this fixes: a single assistant reply can carry several `:::partner.*`
 * containers (a `choice` and a `form`, or two forms). Each card used to render
 * its OWN submit button — "Confirm" and "Submit answers" — and each sent a user
 * turn containing only its own answer. Clicking one therefore discarded the
 * other's answers entirely, and the two buttons sat in the same reply as if
 * they were independent.
 *
 * The rule that replaces it: **a message offers exactly one submit when it asks
 * more than one question set.** The containers' answers are composed into a
 * single plain user message, which is exactly what the standalone cards already
 * produced individually — so nothing about the wire format changes, only that
 * the parts arrive together.
 *
 * Pure and dependency-free so the composition and readiness rules are
 * unit-testable in the node-only web suite (no DOM harness exists).
 */

import type { StructuredBlock } from '@partner/shared';

/** Blocks that ask the user something and can therefore carry an answer. */
export function isAnswerable(block: StructuredBlock): boolean {
  return block.kind === 'choice' || block.kind === 'form';
}

/** How many answerable containers one message carries. */
export function answerableCount(blocks: readonly StructuredBlock[]): number {
  return blocks.filter(isAnswerable).length;
}

/**
 * True when a message must present ONE shared submit instead of per-card
 * buttons. Deliberately `> 1`: a message with a single container keeps its
 * existing single-card affordance, so this change cannot regress the common
 * case (the card's own button, its own validation, its own draft clearing).
 */
export function shouldGroupAnswers(blocks: readonly StructuredBlock[]): boolean {
  return answerableCount(blocks) > 1;
}

/**
 * Whether a grouped-answer control is still LIVE — i.e. still interactive.
 *
 * A question set is live only while its message is the NEWEST in the
 * transcript. Once any later message exists, the set is behind us and the
 * control must be inert.
 *
 * Why transcript position rather than a stored flag: the lock has to survive a
 * reload, and neither available store can carry it. Component state dies with
 * the page; `lib/conversation-ui.ts` is a module-level `Map` that documents
 * itself as *not* durable across reloads; and a web-storage key is refused by
 * the storage census guard (`web/test/security-guards.test.ts`), which asserts
 * the persisted-key set exactly. Transcript position is durable because it
 * comes from the core's own history — so it also survives a reload on a
 * different device, which no client-side flag would.
 *
 * Fails CLOSED for every unusable input (negative, out of range, empty,
 * non-finite): defaulting to "live" would re-arm a stale control, which is the
 * exact bug class this replaces. Unit-tested; the React wiring that supplies
 * the position has no DOM harness, so this predicate carries the coverage.
 */
export function isGroupLive(messageIndex: number, messageCount: number): boolean {
  if (!Number.isFinite(messageIndex) || !Number.isFinite(messageCount)) return false;
  const index = Math.floor(messageIndex);
  const count = Math.floor(messageCount);
  if (count <= 0 || index < 0) return false;
  return index === count - 1;
}

/** One container's answer as it currently stands, reported by its card. */
export interface AnswerPart {
  /**
   * Stable identity for this part (the block index). Keys are used only for
   * React keys and to count completeness — never surfaced as content.
   */
  key: string;
  /** Label for the part, from the container's title (may be null). */
  title: string | null;
  /**
   * The part's answer text, or **null while the part is incomplete** by its own
   * rule. Null is what makes the group's submit stay disabled, so an incomplete
   * part can never be silently dropped from a submission.
   */
  text: string | null;
}

/**
 * The single user message for a group.
 *
 * Each part contributes the text it would have sent on its own, joined by a
 * blank line — so a grouped submit is byte-comparable to what the two separate
 * cards would have sent, just delivered once. Empty parts are skipped (they
 * cannot occur through the UI, since an incomplete part blocks submission, but
 * the function stays total for callers and tests).
 */
export function composeGroupedAnswer(parts: readonly AnswerPart[]): string {
  return parts
    .map((part) => (part.text ?? '').trim())
    .filter((text) => text !== '')
    .join('\n\n');
}

export interface GroupReadiness {
  /** Every expected part has arrived AND every part reports a complete answer. */
  ready: boolean;
  /**
   * What is still missing, as COUNTS — never content. Shown in place of a bare
   * disabled button so the user knows why they cannot submit, which is the same
   * rule the empty-state contract applies to lists.
   */
  hint: string | null;
}

/**
 * Whether the group may be submitted, and what to say when it may not.
 *
 * `expected` is how many answerable containers the message carried. A group is
 * ready only when every one of them has reported a complete answer — that is
 * what makes "submit once" produce *all* the answers rather than the first one
 * the user happened to fill in.
 */
export function groupReadiness(parts: readonly AnswerPart[], expected: number): GroupReadiness {
  const wanted = Math.max(0, Math.floor(expected));
  const complete = parts.filter((part) => part.text !== null && part.text.trim() !== '').length;
  if (wanted === 0) return { ready: false, hint: null };
  if (complete >= wanted) return { ready: true, hint: null };
  const missing = wanted - complete;
  return {
    ready: false,
    hint:
      missing === 1
        ? '1 answer still needed'
        : `${missing} answers still needed`,
  };
}

/**
 * Label for the shared submit across its three states.
 *
 * Two DIFFERENT inert reasons must not share one label. A stale group that the
 * user never answered previously read "Answers sent", which asserts something
 * untrue about their actions — uniformity of state is not worth a false
 * statement in the UI. Answered means sent; stale means the conversation moved
 * on; only the live case offers to send.
 */
export function groupedSubmitText(options: {
  answered: boolean;
  stale: boolean;
  expected: number;
}): string {
  if (options.answered) return 'Answers sent';
  if (options.stale) return 'Closed';
  return groupedSubmitLabel(options.expected);
}

/**
 * Label for the shared submit. Names what happens, per the design rule that a
 * control says what it does ("Send answers", not "Submit").
 */
export function groupedSubmitLabel(expected: number): string {
  return expected === 1 ? 'Send answer' : 'Send answers';
}
