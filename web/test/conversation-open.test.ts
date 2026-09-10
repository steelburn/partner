/**
 * "Open conversation" navigation rule tests — the Notes graph's Linked
 * brainstorms → Open button must bring the Chat view forward even when the
 * linked brainstorm is ALREADY the active conversation (the common case),
 * while a mid-stream switch to a different conversation is refused.
 */
import { describe, expect, it } from 'vitest';
import { conversationOpenAction } from '../src/lib/conversation-open.js';

describe('conversationOpenAction', () => {
  it('shows the chat view for the already-active conversation (linked brainstorm Open)', () => {
    expect(conversationOpenAction('c1', 'c1', false)).toBe('switch');
    // Even while another turn streams, re-opening the ACTIVE one still shows it.
    expect(conversationOpenAction('c1', 'c1', true)).toBe('switch');
  });

  it('adopts a different conversation when idle', () => {
    expect(conversationOpenAction('c2', 'c1', false)).toBe('adopt');
    expect(conversationOpenAction('c2', null, false)).toBe('adopt');
  });

  it('refuses to strand a streaming turn on a different conversation', () => {
    expect(conversationOpenAction('c2', 'c1', true)).toBe('ignore');
    expect(conversationOpenAction('c2', null, true)).toBe('ignore');
  });
});
