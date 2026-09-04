import { describe, expect, it } from 'vitest';
import {
  LEVEL_ORDER,
  TASK_CLASS_OPTIONS,
  conversationTitle,
  defaultTitleFromMessage,
  levelExplain,
  levelLabel,
  personaAriaLabel,
  personaInitials,
  riskLabel,
  sortConversations,
  timeAgo,
} from '../src/lib/persona-helpers.js';
import type { ConversationSummary, Persona } from '@partner/shared';

function summary(overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id: 'c-1',
    personaId: 'p-1',
    title: 'A title',
    messageCount: 3,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function persona(overrides: Partial<Persona> = {}): Persona {
  return {
    id: 'p-1',
    name: 'Maya',
    character: {
      voice: 'warm-professional',
      language: 'en',
      systemPrompt: 'x',
      temperature: 0.6,
    },
    model: { taskClasses: {} },
    independence: { level: 'assist', requireHumanFor: ['high'], autoScopes: [] },
    memory: { userProfile: 'none', episodes: 'none' },
    isDefault: false,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

describe('independence levels', () => {
  it('orders levels least -> most autonomous', () => {
    expect(LEVEL_ORDER).toEqual(['assist', 'suggest', 'auto', 'autonomous']);
  });

  it('labels every level', () => {
    expect(levelLabel('assist')).toBe('Assist');
    expect(levelLabel('suggest')).toBe('Suggest');
    expect(levelLabel('auto')).toBe('Auto');
    expect(levelLabel('autonomous')).toBe('Autonomous');
  });

  it('explains every level with a distinct one-liner (PLAN §5.1)', () => {
    const assist = levelExplain('assist');
    const suggest = levelExplain('suggest');
    const auto = levelExplain('auto');
    const autonomous = levelExplain('autonomous');
    for (const line of [assist, suggest, auto, autonomous]) {
      expect(line.length).toBeGreaterThan(20);
    }
    expect(assist).toMatch(/never runs a tool/i);
    expect(suggest).toMatch(/low-risk/i);
    expect(auto).toMatch(/medium risk/i);
    expect(autonomous).toMatch(/pause/i);
  });
});

describe('riskLabel', () => {
  it('labels every risk tier', () => {
    expect(riskLabel('low')).toBe('Low');
    expect(riskLabel('medium')).toBe('Medium');
    expect(riskLabel('high')).toBe('High');
  });
});

describe('task class options', () => {
  it('covers exactly the five task classes in display order', () => {
    expect(TASK_CLASS_OPTIONS.map((o) => o.value)).toEqual([
      'chat',
      'deep',
      'coding',
      'vision',
      'cheap',
    ]);
    for (const option of TASK_CLASS_OPTIONS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('personaInitials', () => {
  it('produces up-to-two-letter initials from name words', () => {
    expect(personaInitials('Maya')).toBe('M');
    expect(personaInitials('Maya Chen')).toBe('MC');
    expect(personaInitials('Ana Maria Ruiz')).toBe('AM');
  });

  it('uppercases lowercase input and trims whitespace', () => {
    expect(personaInitials('  maya chen ')).toBe('MC');
    expect(personaInitials('builder')).toBe('B');
  });

  it('falls back for empty or garbled names', () => {
    expect(personaInitials('')).toBe('?');
    expect(personaInitials('   ')).toBe('?');
  });
});

describe('personaAriaLabel', () => {
  it('flags default and paused personas in the accessible name', () => {
    expect(personaAriaLabel(persona())).toBe('Maya');
    expect(personaAriaLabel(persona({ isDefault: true }))).toBe('Maya (default)');
    expect(personaAriaLabel(persona({ paused: true }))).toBe('Maya (paused)');
    expect(personaAriaLabel(persona({ isDefault: true, paused: true }))).toBe(
      'Maya (default) (paused)',
    );
  });
});

describe('defaultTitleFromMessage', () => {
  it('takes the trimmed first line of a multi-line message', () => {
    expect(defaultTitleFromMessage('  Draft the report\n\nThen send it  ')).toBe('Draft the report');
  });

  it('keeps short messages intact', () => {
    const title = 'Summarize the Q3 metrics into a table';
    expect(defaultTitleFromMessage(title)).toBe(title);
  });

  it('truncates past 60 characters with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const title = defaultTitleFromMessage(long);
    expect(title).toHaveLength(61);
    expect(title.endsWith('…')).toBe(true);
    expect(title.slice(0, 60)).toBe('x'.repeat(60));
  });

  it('handles empty input', () => {
    expect(defaultTitleFromMessage('')).toBe('');
  });
});

describe('conversationTitle', () => {
  it('falls back for untitled conversations', () => {
    expect(conversationTitle(summary())).toBe('A title');
    expect(conversationTitle(summary({ title: null }))).toBe('New chat');
    expect(conversationTitle(summary({ title: '   ' }))).toBe('New chat');
  });
});

describe('sortConversations', () => {
  it('sorts most-recent-updated first', () => {
    const old = summary({ id: 'a', updatedAt: 100 });
    const mid = summary({ id: 'b', updatedAt: 300 });
    const fresh = summary({ id: 'c', updatedAt: 500 });
    expect(sortConversations([old, fresh, mid]).map((s) => s.id)).toEqual(['c', 'b', 'a']);
  });

  it('breaks updatedAt ties by createdAt (desc) then id, deterministically', () => {
    const a = summary({ id: 'a', updatedAt: 200, createdAt: 50 });
    const b = summary({ id: 'b', updatedAt: 200, createdAt: 90 });
    const c = summary({ id: 'c', updatedAt: 200, createdAt: 90 });
    expect(sortConversations([a, b, c]).map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('does not mutate the input list', () => {
    const input = [summary({ id: 'a', updatedAt: 1 }), summary({ id: 'b', updatedAt: 2 })];
    sortConversations(input);
    expect(input.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('timeAgo', () => {
  const NOW = 1_700_000_000_000;

  it('labels fresh timestamps and falls back for missing ones', () => {
    expect(timeAgo(NOW - 10_000, NOW)).toBe('now');
    expect(timeAgo(0, NOW)).toBe('—');
    expect(timeAgo(NaN, NOW)).toBe('—');
  });

  it('renders compact minute/hour/day labels', () => {
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(timeAgo(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(timeAgo(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
  });

  it('falls back to a short date past a week', () => {
    const old = NOW - 40 * 86_400_000;
    expect(timeAgo(old, NOW)).toMatch(/^\d{1,2}\/\d{1,2}\/\d{2}$/);
  });
});
