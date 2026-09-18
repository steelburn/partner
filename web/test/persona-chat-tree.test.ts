/**
 * M32 — the pure grouping behind `PersonaChatTree`.
 *
 * Renderer-independent on purpose: the tree component is JSX, but the rule
 * that decides which sessions belong to which persona (and that a chat with no
 * live persona stays visible as `Unassigned`) is a plain function so it can be
 * exercised without a DOM.
 */
import { describe, expect, it } from 'vitest';
import type { ConversationSummary, Persona } from '@partner/shared';
import { groupConversations } from '../src/PersonaChatTree.js';

function persona(id: string, name: string): Persona {
  return {
    id,
    name,
    isDefault: false,
    paused: false,
    colorTheme: null,
    tagline: null,
    character: { voice: 'v', language: 'en', systemPrompt: '', temperature: 0.6 },
    model: { taskClasses: {} },
    independence: { level: 'assist', requireHumanFor: [], autoScopes: [], schedules: [] },
    memory: { userProfile: 'none', episodes: 'none', personaMemory: 'off' },
  } as Persona;
}

function chat(overrides: Partial<ConversationSummary> & { id: string }): ConversationSummary {
  return {
    personaId: null,
    title: null,
    folderId: null,
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as ConversationSummary;
}

describe('groupConversations', () => {
  it('keeps a bucket per persona, even with no chats', () => {
    const { byPersona } = groupConversations([persona('p1', 'One'), persona('p2', 'Two')], []);
    expect([...byPersona.keys()]).toEqual(['p1', 'p2']);
    expect(byPersona.get('p1')).toEqual([]);
  });

  it('routes each chat to its persona and sorts most-recent first', () => {
    const { byPersona } = groupConversations(
      [persona('p1', 'One')],
      [
        chat({ id: 'a', personaId: 'p1', updatedAt: 10 }),
        chat({ id: 'b', personaId: 'p1', updatedAt: 30 }),
      ],
    );
    expect(byPersona.get('p1')?.map((c) => c.id)).toEqual(['b', 'a']);
  });

  it('keeps a chat whose persona is gone (or absent) in Unassigned', () => {
    const { byPersona, unassigned } = groupConversations(
      [persona('p1', 'One')],
      [
        chat({ id: 'live', personaId: 'p1', updatedAt: 5 }),
        chat({ id: 'ghost', personaId: 'deleted', updatedAt: 20 }),
        chat({ id: 'none', personaId: null, updatedAt: 15 }),
      ],
    );
    expect(byPersona.get('p1')?.map((c) => c.id)).toEqual(['live']);
    expect(unassigned.map((c) => c.id)).toEqual(['ghost', 'none']);
  });
});
