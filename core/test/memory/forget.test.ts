/**
 * M4 forget tests (PLAN-M4.md §"Tests"): entry/episode/all/before variants,
 * FTS rows cleaned with the rows, typed errors for unknown ids/malformed
 * bodies, and audit rows with counts only.
 */
import { describe, expect, it } from 'vitest';
import { MemoryError } from '../../src/memory/index.js';
import { makeMemoryEnv } from './memEnv.js';

const BASE = Date.parse('2024-06-01T00:00:00Z');

describe('memory forget', () => {
  it("what:'entry' removes one profile entry and its FTS row", async () => {
    const env = makeMemoryEnv({ demo: true });
    try {
      const keep = env.profile.add({ kind: 'preference', value: 'forget-entry-topic-alpha' });
      const gone = env.profile.add({ kind: 'rule', value: 'forget-entry-topic-beta' });
      expect(env.search.query('forget-entry-topic-alpha')).toHaveLength(1);

      const result = env.forget.forget({ what: 'entry', id: gone.id });
      expect(result).toEqual({ entriesRemoved: 1, episodesRemoved: 0 });
      expect(env.profile.get(gone.id)).toBeNull();
      expect(env.profile.get(keep.id)).not.toBeNull();
      expect(env.search.query('forget-entry-topic-beta')).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it("what:'entry' without an id is invalid_input; unknown id is not_found", () => {
    const env = makeMemoryEnv();
    try {
      try {
        env.forget.forget({ what: 'entry' });
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as MemoryError).code).toBe('invalid_input');
      }
      try {
        env.forget.forget({ what: 'entry', id: 'ghost' });
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as MemoryError).code).toBe('not_found');
      }
      try {
        env.forget.forget({ what: 'nonsense' as never });
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as MemoryError).code).toBe('invalid_input');
      }
    } finally {
      env.close();
    }
  });

  it("what:'episode' removes one episode and its FTS row (conversation untouched)", async () => {
    const env = makeMemoryEnv({ demo: true });
    try {
      const conv = env.conversations.create({});
      env.conversations.append(conv.id, 'user', { content: 'episode-forget-topic-9' });
      const { episode } = await env.episodes.summarize(conv.id);
      expect(env.search.query('episode-forget-topic-9')).toHaveLength(1);

      const result = env.forget.forget({ what: 'episode', id: episode.id });
      expect(result).toEqual({ entriesRemoved: 0, episodesRemoved: 1 });
      expect(env.episodes.get(episode.id)).toBeNull();
      // The CONVERSATION is untouched (forget only removes memory rows).
      expect(env.conversations.get(conv.id).summary.id).toBe(conv.id);
      expect(env.search.query('episode-forget-topic-9')).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it("what:'all' wipes entries + episodes + every FTS row", async () => {
    const env = makeMemoryEnv({ demo: true });
    try {
      env.profile.add({ kind: 'preference', value: 'wipe-topic-1' });
      env.profile.add({ kind: 'identity', value: 'wipe-topic-2' });
      const conv = env.conversations.create({});
      env.conversations.append(conv.id, 'user', { content: 'wipe-topic-3' });
      await env.episodes.summarize(conv.id);

      expect(env.search.query('wipe-topic-1')).toHaveLength(1);
      expect(env.search.query('wipe-topic-3')).toHaveLength(1);
      const result = env.forget.forget({ what: 'all' });
      expect(result).toEqual({ entriesRemoved: 2, episodesRemoved: 1 });
      expect(env.profile.list({ includeRejected: true })).toHaveLength(0);
      expect(env.episodes.list()).toHaveLength(0);
      expect(env.search.query('wipe-topic-1')).toHaveLength(0);
      expect(env.search.query('wipe-topic-3')).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('before: an ISO date forgets rows created strictly before the cutoff only', async () => {
    const clock = { t: BASE };
    const env = makeMemoryEnv({ demo: true, now: () => clock.t });
    try {
      clock.t = BASE + 60_000;
      const old1 = env.profile.add({ kind: 'preference', value: 'before-topic-old-1' });
      clock.t = BASE + 180_000;
      const survivor = env.profile.add({ kind: 'rule', value: 'before-topic-new-2' });

      // Cutoff 90s after BASE: old1 (60s) goes, survivor (180s) stays.
      const result = env.forget.forget({ what: 'all', before: '2024-06-01T00:01:30Z' });
      expect(result).toEqual({ entriesRemoved: 1, episodesRemoved: 0 });
      expect(env.profile.get(old1.id)).toBeNull();
      expect(env.profile.get(survivor.id)).not.toBeNull();
      expect(env.search.query('before-topic-old-1')).toHaveLength(0);
      expect(env.search.query('before-topic-new-2').map((h) => h.refId)).toEqual([survivor.id]);
    } finally {
      env.close();
    }
  });

  it('before also forgets episodes older than the cutoff', async () => {
    const clock = { t: BASE };
    const env = makeMemoryEnv({ demo: true, now: () => clock.t });
    try {
      clock.t = BASE + 30_000;
      const convOld = env.conversations.create({});
      env.conversations.append(convOld.id, 'user', { content: 'before-episode-old' });
      const oldEpisode = (await env.episodes.summarize(convOld.id)).episode;

      clock.t = BASE + 300_000;
      const convNew = env.conversations.create({});
      env.conversations.append(convNew.id, 'user', { content: 'before-episode-new' });
      const newEpisode = (await env.episodes.summarize(convNew.id)).episode;

      const result = env.forget.forget({ what: 'all', before: '2024-06-01T00:02:00Z' });
      expect(result).toEqual({ entriesRemoved: 0, episodesRemoved: 1 });
      expect(env.episodes.get(oldEpisode.id)).toBeNull();
      expect(env.episodes.get(newEpisode.id)).not.toBeNull();
      expect(env.search.query('before-episode-old')).toHaveLength(0);
      expect(env.search.query('before-episode-new').map((h) => h.refId)).toEqual([newEpisode.id]);
    } finally {
      env.close();
    }
  });

  it('an unparsable before date is invalid_input', () => {
    const env = makeMemoryEnv();
    try {
      for (const bad of ['not-a-date', '2024-13-99', '']) {
        try {
          env.forget.forget({ what: 'all', before: bad });
          expect.unreachable(`should throw for ${JSON.stringify(bad)}`);
        } catch (err) {
          expect((err as MemoryError).code).toBe('invalid_input');
        }
      }
    } finally {
      env.close();
    }
  });

  it('audit rows: memory.forget carries what/id/counts — never content', () => {
    const env = makeMemoryEnv();
    const secret = 'forget-audit-never-contains-this';
    try {
      const entry = env.profile.add({ kind: 'rule', value: secret });
      env.forget.forget({ what: 'entry', id: entry.id });
      env.forget.forget({ what: 'all' });

      const rows = env.audit.list(100).filter((r) => r.action === 'memory.forget');
      expect(rows).toHaveLength(2);
      const blob = env.audit
        .list(100)
        .map((r) => JSON.stringify(r))
        .join('\n');
      expect(blob).not.toContain(secret);
      // rows[0] is the NEWEST (what:'all'); find the entry forget row.
      const entryRow = rows.find((r) => r.details.includes('"what":"entry"'));
      expect(JSON.parse(entryRow?.details ?? '{}')).toMatchObject({
        what: 'entry',
        entriesRemoved: 1,
        episodesRemoved: 0,
      });
      const allRow = rows.find((r) => r.details.includes('"what":"all"'));
      expect(JSON.parse(allRow?.details ?? '{}')).toMatchObject({
        what: 'all',
        entriesRemoved: 0,
        episodesRemoved: 0,
      });
    } finally {
      env.close();
    }
  });
});
