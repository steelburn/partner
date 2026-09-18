/**
 * M4 export/import tests (PLAN-M4.md §"Tests"): export bundle shape, schema
 * guard, malformed-array guards, additive import with NEW ids, counts, and
 * episode import skipping when a conversation is already summarized.
 */
import { describe, expect, it } from 'vitest';
import type { MemoryExportBundle } from '@partner/shared';
import { MemoryError } from '../../src/memory/index.js';
import { makeMemoryEnv } from './memEnv.js';
import type { MemoryTestEnv } from './memEnv.js';

describe('memory export/import', () => {
  it('exportBundle emits schema memory/v1 with the full profile + episodes', async () => {
    const env = makeMemoryEnv({ demo: true });
    try {
      const entry = env.profile.add({ kind: 'preference', value: 'export-shape-fact' });
      const conv = env.conversations.create({ personaId: 'p-scribe' });
      env.conversations.append(conv.id, 'user', { content: 'export me' });
      const { episode } = await env.episodes.summarize(conv.id);

      const bundle = env.transfer.exportBundle();
      expect(bundle.schema).toBe('memory/v1');
      expect(typeof bundle.exportedAt).toBe('number');
      expect(bundle.profile).toHaveLength(1);
      expect(bundle.episodes).toHaveLength(1);
      expect(bundle.profile[0]).toMatchObject({
        id: entry.id,
        kind: 'preference',
        value: 'export-shape-fact',
        source: 'user',
        status: 'confirmed',
        personaScopes: [],
      });
      expect(bundle.episodes[0]).toMatchObject({
        id: episode.id,
        conversationId: conv.id,
        personaId: 'p-scribe',
      });

      // Audit: memory.export with counts, never content.
      const rows = env.audit.list(100).filter((r) => r.action === 'memory.export');
      expect(rows).toHaveLength(1);
      const blob = env.audit
        .list(100)
        .map((r) => JSON.stringify(r))
        .join('\n');
      expect(blob).not.toContain('export-shape-fact');
      expect(blob).not.toContain('Demo summary');
    } finally {
      env.close();
    }
  });

  it('importBundle round-trips into an EMPTY store with NEW ids and counts', async () => {
    const source = makeMemoryEnv({ demo: true });
    const target = makeMemoryEnv({ demo: true });
    try {
      const entry = source.profile.add({
        kind: 'style',
        value: 'round-trip style fact',
        evidence: 'seen in drafts',
        personaScopes: ['p-scribe'],
        source: 'partner_suggestion',
      });
      const conv = source.conversations.create({ personaId: 'p-scribe' });
      source.conversations.append(conv.id, 'user', { content: 'original topic' });
      const { episode } = await source.episodes.summarize(conv.id);
      const bundle = source.transfer.exportBundle();

      const counts = target.transfer.importBundle(bundle);
      expect(counts).toEqual({ profile: 1, episodes: 1 });

      const importedEntry = target.profile.list()[0];
      expect(importedEntry).toBeDefined();
      expect(importedEntry?.id).not.toBe(entry.id); // NEW id, additive
      expect(importedEntry).toMatchObject({
        kind: 'style',
        value: 'round-trip style fact',
        evidence: 'seen in drafts',
        personaScopes: ['p-scribe'],
        source: 'partner_suggestion',
        status: 'suggested',
        createdAt: entry.createdAt, // timestamps round-trip unchanged
      });
      const importedEpisode = target.episodes.list()[0];
      expect(importedEpisode?.id).not.toBe(episode.id);
      expect(importedEpisode).toMatchObject({
        conversationId: episode.conversationId,
        title: episode.title,
        summary: episode.summary,
        personaId: 'p-scribe',
      });
      // Imported rows are searchable (FTS mirrored).
      expect(target.search.query('round-trip style fact').map((h) => h.refId)).toEqual([
        importedEntry?.id,
      ]);
      expect(target.search.query('original topic').map((h) => h.refId)).toEqual([
        importedEpisode?.id,
      ]);
    } finally {
      source.close();
      target.close();
    }
  });

  it('import is additive onto an existing store (never overwrites)', async () => {
    const source = makeMemoryEnv({ demo: true });
    const target = makeMemoryEnv({ demo: true });
    try {
      source.profile.add({ kind: 'preference', value: 'imported-fact-1' });
      target.profile.add({ kind: 'identity', value: 'local-fact' });
      const before = target.profile.list({ includeRejected: true });

      const counts = target.transfer.importBundle(source.transfer.exportBundle());
      expect(counts.profile).toBe(1);
      const after = target.profile.list({ includeRejected: true });
      expect(after).toHaveLength(before.length + 1);
      // The local row survived untouched (same id).
      expect(after.some((e) => e.value === 'local-fact' && e.id === before[0]?.id)).toBe(true);
    } finally {
      source.close();
      target.close();
    }
  });

  it('import skips an episode whose conversation is already summarized locally', async () => {
    const source = makeMemoryEnv({ demo: true });
    const target = makeMemoryEnv({ demo: true });
    try {
      const conv = source.conversations.create({});
      source.conversations.append(conv.id, 'user', { content: 'shared conversation' });
      const { episode } = await source.episodes.summarize(conv.id);
      const bundle = source.transfer.exportBundle();

      // Target already has an episode for the SAME conversation (different id).
      const localConv = target.conversations.create({});
      target.stores.episodes.insert({
        id: 'local-episode-1',
        conversationId: localConv.id,
        personaId: null,
        title: 'local',
        summary: 'local summary',
        model: null,
        createdAt: 1,
        updatedAt: 1,
      });
      // Re-point the imported episode's conversation_id to the LOCAL one so
      // the uniqueness collision is real.
      bundle.episodes = bundle.episodes.map((e) => ({ ...e, conversationId: localConv.id }));
      const counts = target.transfer.importBundle(bundle);
      expect(counts).toEqual({ profile: 0, episodes: 0 });
      expect(target.episodes.list()).toHaveLength(1);
      expect(target.episodes.get('local-episode-1')).not.toBeNull();
      expect(target.episodes.get(episode.id)).toBeNull();
    } finally {
      source.close();
      target.close();
    }
  });

  it('schema guard + malformed rows are invalid_input; nothing is written', async () => {
    const target = makeMemoryEnv({ demo: true });
    try {
      const good = () => target.transfer.exportBundle();
      const badBundles: unknown[] = [
        null,
        42,
        'memory/v1',
        { schema: 'memory/v2', profile: [], episodes: [] },
        { schema: 'memory/v1' }, // missing arrays
        { schema: 'memory/v1', profile: 'x', episodes: [] },
        { schema: 'memory/v1', profile: [], episodes: [{}] },
        {
          schema: 'memory/v1',
          profile: [{ kind: 'bogus', value: 'x' }],
          episodes: [],
        },
        {
          schema: 'memory/v1',
          profile: [],
          episodes: [{ conversationId: 'c', summary: 's' }], // missing id/createdAt
        },
      ];
      for (const bundle of badBundles) {
        try {
          target.transfer.importBundle(bundle);
          expect.unreachable(`should throw for ${JSON.stringify(bundle).slice(0, 80)}`);
        } catch (err) {
          expect((err as MemoryError).code, JSON.stringify(bundle).slice(0, 80)).toBe(
            'invalid_input',
          );
        }
      }
      // Nothing was written by any failed import.
      expect(target.transfer.exportBundle().profile).toEqual([]);
      expect(target.transfer.exportBundle().episodes).toEqual([]);
      expect(good()).toBeDefined();
    } finally {
      target.close();
    }
  });

  it('rejected entries export but are NOT indexed on import', async () => {
    const source = makeMemoryEnv({ demo: true });
    const target = makeMemoryEnv({ demo: true });
    try {
      source.profile.add({
        kind: 'rule',
        value: 'rejected-but-exported',
        status: 'rejected',
      });
      const bundle = source.transfer.exportBundle();
      expect(bundle.profile).toHaveLength(1);

      const counts = target.transfer.importBundle(bundle);
      expect(counts.profile).toBe(1);
      expect(target.profile.list({ includeRejected: true })).toHaveLength(1);
      expect(target.profile.list()).toHaveLength(0); // still hidden by default
      expect(target.search.query('rejected-but-exported')).toHaveLength(0);
    } finally {
      source.close();
      target.close();
    }
  });
});

/**
 * M33 — scope compatibility in an export bundle.
 *
 * `memory/v1` is unchanged: a canonical bundle row carries the `personaScopes`
 * array. A PRE-M33 file (and any hand-written bundle) that carries only the
 * single `personaScope` still imports, with its scope mapped into the array
 * form — an upgrade must not widen a persona-private fact to every persona.
 */
describe('memory export/import — M33 scope compatibility', () => {
  it('imports a pre-M33 row (personaScope string) as a one-element scope', () => {
    const target = makeMemoryEnv({ demo: true });
    try {
      const legacyBundle = {
        schema: 'memory/v1',
        exportedAt: 1,
        profile: [
          {
            id: 'old-1',
            kind: 'rule',
            key: null,
            value: 'legacy scoped fact',
            evidence: null,
            source: 'user',
            status: 'confirmed',
            personaScope: 'p-scribe',
            createdAt: 10,
            updatedAt: 11,
          },
          {
            id: 'old-2',
            kind: 'rule',
            key: null,
            value: 'legacy global fact',
            evidence: null,
            source: 'user',
            status: 'confirmed',
            personaScope: null,
            createdAt: 12,
            updatedAt: 13,
          },
        ],
        episodes: [],
      };
      expect(target.transfer.importBundle(legacyBundle)).toEqual({ profile: 2, episodes: 0 });

      const byValue = new Map(target.profile.list().map((e) => [e.value, e.personaScopes]));
      expect(byValue.get('legacy scoped fact')).toEqual(['p-scribe']);
      expect(byValue.get('legacy global fact')).toEqual([]);
    } finally {
      target.close();
    }
  });

  it('rejects a bundle whose scope field is neither an array nor a string/null', () => {
    const target = makeMemoryEnv({ demo: true });
    try {
      const bad = {
        schema: 'memory/v1',
        exportedAt: 1,
        profile: [
          {
            id: 'bad-1',
            kind: 'rule',
            key: null,
            value: 'bad scope',
            evidence: null,
            source: 'user',
            status: 'confirmed',
            personaScopes: [42],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        episodes: [],
      };
      let err: unknown;
      try {
        target.transfer.importBundle(bad);
      } catch (cause) {
        err = cause;
      }
      expect(err).toBeInstanceOf(MemoryError);
      expect((err as MemoryError).code).toBe('invalid_input');
      expect(target.profile.list({ includeRejected: true })).toHaveLength(0);
    } finally {
      target.close();
    }
  });
});
