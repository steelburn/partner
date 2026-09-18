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
      env.profile.add({ kind: 'identity', value: 'scribe-scoped', personaScopes: ['p-scribe'] });
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

  it('M19: persona-scoped entries inject ONLY when the persona has private memory on', () => {
    const env = makeMemoryEnv();
    try {
      env.profile.add({ kind: 'identity', value: 'global fact' });
      env.profile.add({ kind: 'preference', value: 'studio secret', personaScopes: ['p-studio'] });
      env.profile.add({ kind: 'preference', value: 'builder secret', personaScopes: ['p-builder'] });

      const off = buildTailoring(env.profile, { id: 'p-studio', memory: { personaMemory: 'off' } });
      expect(off).toBe('- identity: global fact');

      const on = buildTailoring(env.profile, { id: 'p-studio', memory: { personaMemory: 'on' } });
      expect(on).toContain('global fact');
      expect(on).toContain('studio secret');
      expect(on).not.toContain('builder secret');

      // A bare id keeps the M4 global-only contract (never scoped).
      expect(buildTailoring(env.profile, 'p-studio')).toBe('- identity: global fact');
    } finally {
      env.close();
    }
  });

  it('M19: global + scoped share the single 8-entry cap, newest first', () => {
    const clock = { t: 1_000 };
    const env = makeMemoryEnv({ demo: false, now: () => clock.t });
    try {
      for (let i = 0; i < 6; i += 1) {
        env.profile.add({ kind: 'rule', value: `global ${i}` });
        clock.t += 1;
      }
      for (let i = 0; i < 4; i += 1) {
        env.profile.add({ kind: 'rule', value: `scoped ${i}`, personaScopes: ['p-x'] });
        clock.t += 1;
      }
      const text = buildTailoring(env.profile, { id: 'p-x', memory: { personaMemory: 'on' } });
      expect(text?.split('\n')).toHaveLength(TAILORING_MAX_ENTRIES);
      // The four newest are the scoped facts.
      expect(text?.split('\n')[0]).toContain('scoped 3');
      expect(text).not.toContain('global 0');
    } finally {
      env.close();
    }
  });
});

/**
 * M33 — a fact shared by several personas.
 *
 * `personaScopes` is an id set: an entry scoped to ['p-a','p-b'] is honored by
 * each of those personas when its private memory is on, and by neither when it
 * is off. A persona outside the set never sees it.
 */
describe('buildTailoring — multi-persona scope (M33)', () => {
  it('injects a shared fact for every listed persona and for no other', () => {
    const env = makeMemoryEnv();
    try {
      env.profile.add({
        kind: 'preference',
        value: 'shared preference',
        personaScopes: ['p-a', 'p-b'],
      });
      const on = (id: string): string | null =>
        buildTailoring(env.profile, { id, memory: { personaMemory: 'on' } });

      expect(on('p-a')).toBe('- preference: shared preference');
      expect(on('p-b')).toBe('- preference: shared preference');
      expect(on('p-c')).toBeNull();

      // Private memory off -> the shared fact never rides the prelude.
      expect(buildTailoring(env.profile, 'p-a')).toBeNull();
      expect(
        buildTailoring(env.profile, { id: 'p-a', memory: { personaMemory: 'off' } }),
      ).toBeNull();
    } finally {
      env.close();
    }
  });

  it('a fact widened to all personas is honored even with private memory off', () => {
    const env = makeMemoryEnv();
    try {
      env.profile.add({ kind: 'identity', value: 'lives in Berlin' });
      expect(buildTailoring(env.profile, 'p-a')).toBe('- identity: lives in Berlin');
      expect(
        buildTailoring(env.profile, { id: 'p-a', memory: { personaMemory: 'off' } }),
      ).toBe('- identity: lives in Berlin');
    } finally {
      env.close();
    }
  });
});
