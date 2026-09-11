import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@partner/shared';
import {
  applyStructuredGuidance,
  structuredInstructions,
  DEFAULT_STRUCTURED_FEATURES,
  independenceDeclaration,
  SEARCH_TOOL_INSTRUCTION,
} from '../../src/chat/instructions.js';

describe('M11 C3 structured guidance', () => {
  it('is deterministic for the default feature set and documents the grammar', () => {
    const a = structuredInstructions(DEFAULT_STRUCTURED_FEATURES);
    const b = structuredInstructions(DEFAULT_STRUCTURED_FEATURES);
    expect(a).toBe(b);
    expect(a).toContain(':::partner.choice');
    expect(a).toContain(':::partner.form');
    expect(a).toContain(':::partner.asset');
    expect(a).toContain('mode=single');
    expect(a).toContain('mode=multi');
    expect(structuredInstructions(new Set(['choices']))).not.toContain('partner.asset');
    expect(structuredInstructions(new Set(['choices']))).not.toContain('partner.form');
    expect(structuredInstructions(new Set())).toBe('');
  });

  it('applyStructuredGuidance appends only to the persona system message', () => {
    const out: ChatMessage[] = [{ role: 'system', content: 'Identity.' }];
    applyStructuredGuidance(out, 0);
    expect(out[0]?.content).toContain('Identity.');
    expect(out[0]?.content).toContain(':::partner.choice');
    expect(out).toHaveLength(1);

    // No-op when the index is not a system message or features are empty.
    const empty: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    applyStructuredGuidance(empty, 0, new Set());
    expect(empty[0]?.content).toBe('hi');
  });
});

describe('M12 capability declarations', () => {
  it('independenceDeclaration is deterministic and names the level', () => {
    for (const level of ['assist', 'suggest', 'auto', 'autonomous'] as const) {
      const text = independenceDeclaration(level);
      expect(text).toBe(independenceDeclaration(level));
      expect(text).toContain(`independence level is ${level}`);
    }
    expect(independenceDeclaration('assist')).toContain('never execute tools');
    expect(independenceDeclaration('autonomous')).not.toContain('assist');
  });

  it('SEARCH_TOOL_INSTRUCTION teaches the directive grammar once, deterministically', () => {
    expect(SEARCH_TOOL_INSTRUCTION).toBe(SEARCH_TOOL_INSTRUCTION);
    expect(SEARCH_TOOL_INSTRUCTION).toContain('[[partner:tool search');
    expect(SEARCH_TOOL_INSTRUCTION).toContain('"query"');
    // No template holes / secrets — a static string.
    expect(SEARCH_TOOL_INSTRUCTION).not.toContain('${');
    expect(SEARCH_TOOL_INSTRUCTION).not.toContain('sk-');
    // Tells the model not to invent results and that notes arrive next turn.
    expect(SEARCH_TOOL_INSTRUCTION).toContain('never invent');
    expect(SEARCH_TOOL_INSTRUCTION).toContain('AFTER your reply');
  });
});
