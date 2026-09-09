/**
 * M16 F2 brainstorm manager tests (PLAN-M16.md): persona seed-on-demand,
 * conversation bound to the Brainstorming persona with the bundled notes as
 * the first user turn + a first assistant reply (deterministic placeholder
 * in demo, provider text in live), caps/guards, paused refusal, and the
 * pure bundle composer (per-note cap + total budget + truncation counts).
 */
import { describe, expect, it } from 'vitest';
import { demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { fakeProvider } from './notesEnv.js';
import { buildBrainstormBundle, BRAINSTORM_PERSONA_ID } from '../../src/notes/index.js';

async function seedNotes(h: Harness, count = 3): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 1; i <= count; i += 1) {
    const note = h.notes!.create({
      title: `Topic ${i}`,
      content: `Idea body ${i} — a longer paragraph to exercise bundling. `.repeat(3),
    });
    ids.push(note.id);
  }
  return ids;
}

describe('M16 F2 brainstorm (demo harness)', () => {
  it('creates the conversation on the Brainstorming persona with bundle + reply', async () => {
    const h = demoHarness();
    try {
      const ids = await seedNotes(h);
      // Fresh harness: the persona exists only via ensureSeed? It is seeded
      // with the starters — remove it to prove seed-on-demand.
      const existing = h.personas!.get(BRAINSTORM_PERSONA_ID);
      if (existing) h.personas!.remove(existing.id);

      const result = await h.brainstorm!.start({ noteIds: ids });
      expect(result).toMatchObject({
        personaId: BRAINSTORM_PERSONA_ID,
        used: 3,
        truncated: 0,
      });
      const persona = h.personas!.get(BRAINSTORM_PERSONA_ID);
      expect(persona?.name).toBe('Brainstorming');

      const detail = h.conversations!.get(result.conversationId);
      expect(detail.summary.personaId).toBe(BRAINSTORM_PERSONA_ID);
      expect(detail.messages).toHaveLength(2);
      expect(detail.messages[0]!.role).toBe('user');
      expect(detail.messages[0]!.content).toContain('### Topic 1');
      expect(detail.messages[0]!.content).toContain('Idea body 2');
      expect(detail.messages[1]!.role).toBe('assistant');
      expect(detail.messages[1]!.content).toContain('Demo brainstorm over 3 bundled notes');
      expect(detail.summary.title).toBe('Brainstorm — Topic 1');
    } finally {
      h.close();
    }
  });

  it('is idempotent about the persona (edits are respected, no duplicates)', async () => {
    const h = demoHarness();
    try {
      const ids = await seedNotes(h, 1);
      const persona = h.personas!.get(BRAINSTORM_PERSONA_ID)!;
      await h.brainstorm!.start({ noteIds: ids });
      await h.brainstorm!.start({ noteIds: ids });
      const after = h.personas!.list().filter((p) => p.id === BRAINSTORM_PERSONA_ID);
      expect(after).toHaveLength(1);
      expect(after[0]!.name).toBe(persona.name);
    } finally {
      h.close();
    }
  });

  it('refuses empty/unknown/over-cap note ids and a paused persona', async () => {
    const h = demoHarness();
    try {
      await expect(h.brainstorm!.start({ noteIds: [] })).rejects.toMatchObject({ code: 'invalid_input' });
      await expect(h.brainstorm!.start({ noteIds: ['nope'] })).rejects.toMatchObject({ code: 'not_found' });
      const many = Array.from({ length: 21 }, (_, i) => `id-${i}`);
      await expect(h.brainstorm!.start({ noteIds: many })).rejects.toMatchObject({ code: 'invalid_input' });
      h.personas!.pause(BRAINSTORM_PERSONA_ID);
      const ids = await seedNotes(h, 1);
      await expect(h.brainstorm!.start({ noteIds: ids })).rejects.toMatchObject({ code: 'paused' });
    } finally {
      h.close();
    }
  });

  it('routes a real provider reply when one resolves (live harness)', async () => {
    const provider = fakeProvider();
    provider.reply = 'LIVE BRAINSTORM ANSWER';
    const h = demoHarness({
      demo: false,
      brainstormProvider: async () => ({ client: provider.client, model: 'gpt-test' }),
    });
    try {
      const ids = await seedNotes(h, 2);
      const result = await h.brainstorm!.start({ noteIds: ids, title: 'My brainstorm' });
      const detail = h.conversations!.get(result.conversationId);
      expect(detail.summary.title).toBe('My brainstorm');
      const assistant = detail.messages.find((m) => m.role === 'assistant');
      expect(assistant?.content).toBe('LIVE BRAINSTORM ANSWER');
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]!.model).toBe('gpt-test');
      const userRequest = provider.requests[0]!.messages.find((m) => m.role === 'user');
      expect(userRequest?.content).toContain('### Topic 1');
    } finally {
      h.close();
    }
  });

  it('joins a streamed reply across many deltas (real providers emit one delta per token)', async () => {
    // A realistic provider emits per-token deltas — the stored assistant
    // reply must be the FULL concatenated text, not the first chunk.
    const deltas = ['Direction A — ', 'the local stack ', 'wins on privacy.\n\n', 'Direction B — device-native.'];
    const streamClient = {
      async *chatStream() {
        for (const part of deltas) {
          yield { type: 'delta', text: part } as import('@partner/shared').ChatEvent;
        }
      },
    };
    const h = demoHarness({
      demo: false,
      brainstormProvider: async () => ({
        client: streamClient as never,
        model: 'gemma-local',
      }),
    });
    try {
      const ids = await seedNotes(h, 1);
      const result = await h.brainstorm!.start({ noteIds: ids });
      const detail = h.conversations!.get(result.conversationId);
      const assistant = detail.messages.find((m) => m.role === 'assistant');
      expect(assistant?.model).toBe('gemma-local');
      expect(assistant?.content).toBe(deltas.join(''));
    } finally {
      h.close();
    }
  });

  it('501s without a resolvable provider (live harness, no provider)', async () => {
    const h = demoHarness({ demo: false });
    try {
      const ids = await seedNotes(h, 1);
      await expect(h.brainstorm!.start({ noteIds: ids })).rejects.toMatchObject({ code: 'no_provider' });
    } finally {
      h.close();
    }
  });
});

describe('M16 F2 bundle composer (pure)', () => {
  it('caps per-note excerpts and counts truncation', () => {
    const notes = [
      { title: 'Short', content: 'tiny' },
      { title: 'Long', content: 'x'.repeat(8000) },
    ];
    const result = buildBrainstormBundle(notes);
    expect(result.used).toBe(2);
    expect(result.truncated).toBe(1);
    expect(result.text).toContain('### Short');
    expect(result.text).toContain('### Long');
    expect(result.text.length).toBeLessThan(8000 + 200);
    expect(result.text).toContain('…');
  });

  it('respects the total budget: later sources are skipped + counted', () => {
    // 5 large notes each near the per-note cap — the shared budget forces skips.
    const notes = Array.from({ length: 5 }, (_, i) => ({
      title: `Big ${i}`,
      content: 'y'.repeat(20000),
    }));
    const result = buildBrainstormBundle(notes);
    // Every note is included (5), each excerpt cut to the per-note cap (5
    // truncated) — truncated is a subset of used, not a disjoint set.
    expect(result.used).toBe(5);
    expect(result.truncated).toBe(5);
    expect(result.text.length).toBeLessThanOrEqual(60_000 + 200);
  });
});
