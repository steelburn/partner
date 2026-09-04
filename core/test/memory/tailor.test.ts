/**
 * M4 tailoring tests (PLAN-M4.md §"chat-time tailoring"): buildTailoring
 * renders confirmed GLOBAL entries (max 8, trimmed 240) as '- kind: value'
 * lines with optional '(evidence: …)' and returns null when there is nothing
 * to honor. Suggested, rejected and persona-scoped entries never appear.
 */
import { describe, expect, it } from 'vitest';
import { buildTailoring, TAILORING_ENTRY_CAP, TAILORING_MAX_ENTRIES } from '../../src/memory/index.js';
import { makeMemoryEnv } from './memEnv.js';

describe('buildTailoring', () => {
  it('returns null with no confirmed-global entries', () => {
    const env = makeMemoryEnv();
    try {
      // Only suggested + rejected + persona-scoped -> nothing to honor.
      env.profile.add({ kind: 'preference', value: 'suggested one', source: 'partner_suggestion' });
      env.profile.add({ kind: 'rule', value: 'rejected one', status: 'rejected' });
      env.profile.add({ kind: 'identity', value: 'scribe-scoped', personaScope: 'p-scribe' });
      expect(buildTailoring(env.profile, 'p-default')).toBeNull();
      expect(buildTailoring(env.profile, 'p-scribe')).toBeNull(); // scoped-only never injects
    } finally {
      env.close();
    }
  });

  it('renders confirmed GLOBAL entries as "- kind: value" lines with evidence', () => {
    const clock = { t: 1_000 };
    const env = makeMemoryEnv({ demo: false, now: () => clock.t });
    try {
      env.profile.add({ kind: 'preference', value: 'start with a tldr', evidence: 'in 6 of 10 asks' });
      clock.t += 1_000;
      env.profile.add({ kind: 'identity', value: 'calls you by your first name' });
      const text = buildTailoring(env.profile, 'p-researcher');
      expect(text).not.toBeNull();
      // Newest first (deterministic clock): the identity entry was added last.
      expect(text).toBe(
        '- identity: calls you by your first name\n' +
          '- preference: start with a tldr (evidence: in 6 of 10 asks)',
      );
    } finally {
      env.close();
    }
  });

  it('caps the block at 8 entries and trims each line to 240 chars', () => {
    const env = makeMemoryEnv();
    try {
      for (let i = 0; i < 12; i += 1) {
        env.profile.add({ kind: 'rule', value: `rule number ${i} about long winded behaviour` });
      }
      const text = buildTailoring(env.profile, 'p-default');
      expect(text).not.toBeNull();
      expect(text?.split('\n')).toHaveLength(TAILORING_MAX_ENTRIES);
      // A 500-char value is trimmed to the entry cap.
      env.profile.add({ kind: 'style', value: 'v'.repeat(500) });
      const big = buildTailoring(env.profile, 'p-default');
      expect(big?.split('\n')[0]?.length).toBeLessThanOrEqual(TAILORING_ENTRY_CAP);
    } finally {
      env.close();
    }
  });

  it('confirmed entries are newest-first (recent facts win within the cap)', () => {
    const clock = { t: 1_000 };
    const env = makeMemoryEnv({ demo: false, now: () => clock.t });
    try {
      env.profile.add({ kind: 'identity', value: 'older fact' });
      clock.t += 1_000;
      env.profile.add({ kind: 'preference', value: 'newer fact' });
      const text = buildTailoring(env.profile, 'p-x');
      expect(text?.split('\n')[0]).toContain('newer fact');
      expect(text?.split('\n')[1]).toContain('older fact');
    } finally {
      env.close();
    }
  });
});
