/**
 * M4 search tests (PLAN-M4.md §"Tests"): one FTS query returns profile AND
 * episode hits ranked by bm25, caps at 50, FTS metacharacters in a query
 * never crash (they are escaped into quoted phrase terms), and an empty
 * query is a typed invalid_input.
 */
import { describe, expect, it } from 'vitest';
import type { ChatEvent, ProviderClient } from '@partner/shared';
import { MemoryError, escapeFtsQuery } from '../../src/memory/index.js';
import { makeMemoryEnv } from './memEnv.js';
import type { MemoryTestEnv } from './memEnv.js';

function providerReplying(reply: string): ProviderClient {
  return {
    async *chatStream(): AsyncGenerator<ChatEvent> {
      yield { type: 'delta', text: reply };
      yield { type: 'done', model: 'fake', latencyMs: 1 };
    },
    async health() {
      return { ok: true, latencyMs: 0 };
    },
  };
}

/** Add one profile entry through the real manager (keeps FTS mirrored). */
function addProfile(env: MemoryTestEnv, kind: string, value: string): string {
  return env.profile.add({ kind: kind as 'preference', value }).id;
}

/** Summarize a fresh conversation via the manager so the FTS mirror exists. */
async function addEpisode(env: MemoryTestEnv, content: string, summary: string): Promise<string> {
  const fakeEnv = makeMemoryEnv({
    demo: false,
    providerResolver: () => ({ client: providerReplying(summary), model: 'fake' }),
  });
  try {
    const conv = fakeEnv.conversations.create({});
    fakeEnv.conversations.append(conv.id, 'user', { content });
    const { episode } = await fakeEnv.episodes.summarize(conv.id);
    const row = fakeEnv.stores.episodes.findById(episode.id);
    if (row) {
      env.stores.episodes.insert({ ...row });
      env.stores.fts.upsertEpisode(row.id, `${row.title} ${row.summary}`);
    }
    return episode.id;
  } finally {
    fakeEnv.close();
  }
}

describe('FTS escaping (unit)', () => {
  it('wraps every whitespace token in double quotes and doubles embedded quotes', () => {
    expect(escapeFtsQuery('plain words')).toBe('"plain" "words"');
    expect(escapeFtsQuery('  spaced   out  ')).toBe('"spaced" "out"');
    expect(escapeFtsQuery('say "hi" now')).toBe('"say" """hi""" "now"');
    expect(escapeFtsQuery('')).toBe('');
    expect(escapeFtsQuery('   ')).toBe('');
  });
});

describe('search manager', () => {
  it('finds profile values and episode summary text in ONE query, both kinds', async () => {
    const env = makeMemoryEnv({ demo: false });
    try {
      const profileId = addProfile(env, 'preference', 'Prefer concise TLDR summaries before details');
      const profileId2 = addProfile(env, 'identity', 'Works remote first');
      const episodeId = await addEpisode(
        env,
        'write me an email about the tldr project',
        'user prefers tldr style summaries in emails',
      );

      const hits = env.search.query('tldr');
      const kinds = hits.map((h) => `${h.kind}:${h.refId}`).sort();
      expect(kinds).toEqual([`episode:${episodeId}`, `profile:${profileId}`].sort());
      expect(kinds).not.toContain(`profile:${profileId2}`);

      const byKind = new Map(hits.map((h) => [h.kind, h]));
      const profileHit = byKind.get('profile');
      expect(profileHit).toMatchObject({ kind: 'profile', refId: profileId });
      expect(profileHit?.snippet).toContain('TLDR summaries');
      const episodeHit = byKind.get('episode');
      expect(episodeHit).toMatchObject({ kind: 'episode', refId: episodeId });
      expect(episodeHit?.snippet).toContain('tldr style');
      // Ranks are finite numbers, sorted best-first (bm25 ascending).
      for (let i = 1; i < hits.length; i += 1) {
        expect(hits[i - 1]?.rank).toBeLessThanOrEqual(hits[i]?.rank as number);
      }
      expect(typeof hits[0]?.rank).toBe('number');
    } finally {
      env.close();
    }
  });

  it('episode snippet is the summary truncated to 200 chars', async () => {
    const env = makeMemoryEnv({ demo: false });
    try {
      const long = 'wordy '.repeat(60).trim(); // 300 chars
      const episodeId = await addEpisode(env, 'seed', long);
      const hits = env.search.query('wordy');
      expect(hits).toHaveLength(1);
      expect(hits[0]?.refId).toBe(episodeId);
      expect(hits[0]?.snippet.length).toBeLessThanOrEqual(201);
      expect(hits[0]?.snippet.endsWith('\u2026')).toBe(true);
    } finally {
      env.close();
    }
  });

  it('caps results at 50 even with 51 matching profile entries', async () => {
    const env = makeMemoryEnv({ demo: false });
    try {
      for (let i = 0; i < 51; i += 1) {
        addProfile(env, 'preference', `batchword entry number ${i}`);
      }
      const hits = env.search.query('batchword');
      expect(hits).toHaveLength(50);
      expect(new Set(hits.map((h) => h.refId)).size).toBe(50);
    } finally {
      env.close();
    }
  });

  it('FTS metacharacters in a query never crash (escaped as literal phrases)', async () => {
    const env = makeMemoryEnv({ demo: false });
    try {
      addProfile(env, 'preference', 'Always uses oauth2 token endpoints');
      addProfile(env, 'rule', '100% sure about versions pinning');
      addProfile(env, 'preference', 'avoid (parenthetical) phrasing in replies');

      // Each of these would be an FTS syntax error WITHOUT escaping.
      for (const nasty of [
        'oauth2 token', // plain AND
        '"', // bare quote
        '!!  ( )', // operators + parens
        '* - AND OR NOT', // reserved words/operators
        'a:b', // column syntax
        '100% sure', // embedded punctuation tokens
        'token (endpoint)',
      ]) {
        let hits;
        try {
          hits = env.search.query(nasty);
        } catch (err) {
          expect.unreachable(`query ${JSON.stringify(nasty)} crashed: ${(err as Error).message}`);
        }
        expect(Array.isArray(hits)).toBe(true);
      }

      // A reserved-word-only query does not throw and yields nothing.
      expect(env.search.query('AND OR NOT')).toHaveLength(0);
      // Sensible queries still work after nasty ones.
      expect(env.search.query('oauth2 token')).toHaveLength(1);
    } finally {
      env.close();
    }
  });

  it('an empty or blank query is a typed invalid_input', async () => {
    const env = makeMemoryEnv({ demo: false });
    try {
      for (const empty of ['', '   '] as const) {
        try {
          env.search.query(empty);
          expect.unreachable('should throw');
        } catch (err) {
          expect(err).toBeInstanceOf(MemoryError);
          expect((err as MemoryError).code).toBe('invalid_input');
        }
      }
      // Non-string input is rejected the same way.
      try {
        env.search.query(undefined as never);
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as MemoryError).code).toBe('invalid_input');
      }
    } finally {
      env.close();
    }
  });

  it('skips hits whose backing row was forgotten (index/query race)', async () => {
    const env = makeMemoryEnv({ demo: false });
    try {
      const id = addProfile(env, 'preference', 'transient-before-forget-77');
      expect(env.search.query('transient-before-forget-77')).toHaveLength(1);
      env.profile.remove(id);
      // FTS row is cleaned by remove(); the search resolves nothing.
      expect(env.search.query('transient-before-forget-77')).toHaveLength(0);
    } finally {
      env.close();
    }
  });
});
