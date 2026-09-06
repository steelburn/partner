/**
 * Choice-card conversation context.
 *
 * ChoiceCard lives inside PartnerMarkdown, which is rendered in several
 * places (chat transcript, assets lane note previews). Only the chat
 * transcript knows WHICH conversation is active, so ChatStrip provides this
 * tiny context; consumers without a provider (default value) keep the
 * previous local-only behavior.
 */
import { createContext, useContext } from 'react';

export interface ChoiceMemoryValue {
  /** Active conversation id, or null when no conversation context exists. */
  conversationId: string | null;
}

export const ChoiceMemoryContext = createContext<ChoiceMemoryValue>({
  conversationId: null,
});

export function useChoiceMemory(): ChoiceMemoryValue {
  return useContext(ChoiceMemoryContext);
}
