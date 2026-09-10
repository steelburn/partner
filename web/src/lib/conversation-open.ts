/**
 * "Open conversation" navigation decision (M16 follow-up).
 *
 * A single `onOpenConversation(id)` call is used from several places — the
 * conversation rail, an asset's Discuss action, and the Notes graph's
 * **Linked brainstorms → Open** row. The graph case is the tricky one: the
 * link usually points at the conversation that is ALREADY active (you just
 * brainstormed from those notes, then walked into Notes), so a naive
 * `id === activeConversationId → return` guard left the button dead — it
 * never brought the Chat view forward.
 *
 * Pure and unit-tested so the rule cannot drift.
 */

export type ConversationOpenAction =
  /** Same conversation is already active: just show the Chat view. */
  | 'switch'
  /** Different conversation: select it (adopting its persona) and show Chat. */
  | 'adopt'
  /** A turn is streaming on another conversation — do not strand it. */
  | 'ignore';

export function conversationOpenAction(
  id: string,
  activeConversationId: string | null,
  streaming: boolean,
): ConversationOpenAction {
  if (id === activeConversationId) return 'switch';
  if (streaming) return 'ignore';
  return 'adopt';
}
