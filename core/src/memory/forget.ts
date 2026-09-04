/**
 * Forgetting manager (M4, PLAN-M4.md §"forget").
 *
 * Four variants over the same rules as the wire ForgetRequest:
 *   {what:'entry', id}   remove one profile entry (FTS row cleaned)
 *   {what:'episode', id} remove one episode (FTS row cleaned)
 *   {what:'all'}         wipe the whole memory store (entries + episodes)
 *   {before: ISO date}   forget EVERYTHING created before the cutoff
 *                        (entries + episodes; a date boundary is
 *                        whole-memory by design, PLAN-M4)
 * Unknown single ids are not_found; malformed bodies are invalid_input.
 * Every removal is audited with ids/counts — never content.
 */
import type { ForgetRequest } from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { EpisodeRow, EpisodeStore, MemoryFtsStore, ProfileEntryRow, ProfileEntryStore } from '../stores/types.js';
import { memoryError } from './errors.js';

export interface MemoryForgetResult {
  entriesRemoved: number;
  episodesRemoved: number;
}

export interface MemoryForgetManagerOptions {
  stores: { profile: ProfileEntryStore; episodes: EpisodeStore; fts: MemoryFtsStore };
  audit: AuditService;
  /** Injectable clock (epoch ms) — unused today but keeps the shape uniform. */
  now?: () => number;
}

export interface MemoryForgetManager {
  forget(input: ForgetRequest): MemoryForgetResult;
}

/** ISO date string -> epoch ms cutoff; throws invalid_input when unparsable. */
export function parseBeforeCutoff(raw: unknown): number {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw memoryError('invalid_input', 'before must be an ISO date string');
  }
  const ms = Date.parse(raw.trim());
  if (!Number.isFinite(ms)) {
    throw memoryError('invalid_input', 'before must be an ISO date string');
  }
  return ms;
}

export function createMemoryForgetManager(options: MemoryForgetManagerOptions): MemoryForgetManager {
  const { stores, audit } = options;

  function removeEntryRow(row: ProfileEntryRow): void {
    stores.profile.remove(row.id);
    stores.fts.deleteRef('profile', row.id);
  }

  function removeEpisodeRow(row: EpisodeRow): void {
    stores.episodes.remove(row.id);
    stores.fts.deleteRef('episode', row.id);
  }

  function forget(input: ForgetRequest): MemoryForgetResult {
    const body = (input ?? {}) as ForgetRequest;
    const what = body.what;

    // Whole-memory date boundary. A date cutoff must not be combined with
    // what/id — that would silently ignore one of the two intents.
    if (body.before !== undefined) {
      if (body.id !== undefined || (body.what !== undefined && body.what !== 'all')) {
        throw memoryError(
          'invalid_input',
          "'before' forgets whole memory up to the cutoff — do not combine it with an id or another what",
        );
      }
      const cutoff = parseBeforeCutoff(body.before);
      const beforeEntries = stores.profile
        .list()
        .filter((row) => row.createdAt < cutoff);
      const beforeEpisodes = stores.episodes
        .list()
        .filter((row) => row.createdAt < cutoff);
      for (const row of beforeEntries) removeEntryRow(row);
      for (const row of beforeEpisodes) removeEpisodeRow(row);
      audit.log('web', 'memory.forget', 'before', {
        before: body.before,
        entriesRemoved: beforeEntries.length,
        episodesRemoved: beforeEpisodes.length,
      });
      return {
        entriesRemoved: beforeEntries.length,
        episodesRemoved: beforeEpisodes.length,
      };
    }

    if (what === 'entry') {
      if (typeof body.id !== 'string' || body.id.trim() === '') {
        throw memoryError('invalid_input', "forget what:'entry' requires an id");
      }
      const row = stores.profile.findById(body.id);
      if (!row) throw memoryError('not_found', 'profile entry not found');
      removeEntryRow(row);
      audit.log('web', 'memory.forget', row.id, {
        what: 'entry',
        entriesRemoved: 1,
        episodesRemoved: 0,
      });
      return { entriesRemoved: 1, episodesRemoved: 0 };
    }

    if (what === 'episode') {
      if (typeof body.id !== 'string' || body.id.trim() === '') {
        throw memoryError('invalid_input', "forget what:'episode' requires an id");
      }
      const row = stores.episodes.findById(body.id);
      if (!row) throw memoryError('not_found', 'episode not found');
      removeEpisodeRow(row);
      audit.log('web', 'memory.forget', row.id, {
        what: 'episode',
        entriesRemoved: 0,
        episodesRemoved: 1,
      });
      return { entriesRemoved: 0, episodesRemoved: 1 };
    }

    if (what === 'all') {
      const entries = stores.profile.list();
      const episodes = stores.episodes.list();
      for (const row of entries) removeEntryRow(row);
      for (const row of episodes) removeEpisodeRow(row);
      audit.log('web', 'memory.forget', 'all', {
        what: 'all',
        entriesRemoved: entries.length,
        episodesRemoved: episodes.length,
      });
      return { entriesRemoved: entries.length, episodesRemoved: episodes.length };
    }

    throw memoryError(
      'invalid_input',
      "what must be one of 'entry'|'episode'|'all' (or pass before)",
    );
  }

  return { forget };
}
