/**
 * Export / import manager (M4, PLAN-M4.md §"export/import").
 *
 * exportBundle() -> {schema:'memory/v1', exportedAt, profile, episodes} —
 * the full memory store (user data; served only to the OWNER on
 * GET /v1/memory/export). importBundle() validates the envelope (schema +
 * arrays + row shapes), then re-inserts every row with a NEW id (additive —
 * an import never overwrites or dedupes against local rows). Episodes keep
 * their conversation_id; when that conversation is already summarized the
 * episode is skipped (conversation_id is UNIQUE) and not double-counted.
 * Timestamps round-trip unchanged.
 *
 * Audit: memory.export / memory.import carry counts only — never content.
 */
import { randomUUID } from 'node:crypto';
import type {
  EpisodeSummary,
  MemoryExportBundle,
  ProfileEntry,
  ProfileEntryKind,
  ProfileEntryStatus,
} from '@partner/shared';
import type { AuditService } from '../services/redaction.js';
import type { EpisodeRow, EpisodeStore, MemoryFtsStore, ProfileEntryRow, ProfileEntryStore } from '../stores/types.js';
import { memoryError } from './errors.js';
import { episodeSearchText } from './episodes.js';
import { profileSearchText } from './profile.js';

export interface MemoryImportCounts {
  profile: number;
  episodes: number;
}

export interface MemoryTransferManagerOptions {
  stores: { profile: ProfileEntryStore; episodes: EpisodeStore; fts: MemoryFtsStore };
  audit: AuditService;
  /** Injectable clock (epoch ms) — stamps imported rows when a bundle lacks
   *  a usable timestamp. */
  now?: () => number;
}

export interface MemoryTransferManager {
  exportBundle(): MemoryExportBundle;
  /** Additive import; throws invalid_input on a malformed bundle. */
  importBundle(bundle: unknown): MemoryImportCounts;
}

function entryToRow(entry: ProfileEntry, id: string): ProfileEntryRow {
  return {
    id,
    kind: entry.kind,
    key: entry.key ?? null,
    value: entry.value,
    evidence: entry.evidence ?? null,
    source: entry.source,
    status: entry.status,
    personaScope: entry.personaScope ?? null,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

function episodeToRow(episode: EpisodeSummary, id: string): EpisodeRow {
  return {
    id,
    conversationId: episode.conversationId,
    personaId: episode.personaId ?? null,
    title: episode.title,
    summary: episode.summary,
    model: episode.model ?? null,
    createdAt: episode.createdAt,
    updatedAt: episode.updatedAt,
  };
}

const ENTRY_KINDS: ReadonlySet<string> = new Set(['preference', 'identity', 'rule', 'style']);
const ENTRY_STATUSES: ReadonlySet<string> = new Set(['confirmed', 'suggested', 'rejected']);
const ENTRY_SOURCES: ReadonlySet<string> = new Set(['user', 'partner_suggestion']);

/** Structural row validation shared by profile + episode array entries. */
function isValidEntry(value: unknown): value is ProfileEntry {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.kind === 'string' &&
    ENTRY_KINDS.has(row.kind) &&
    typeof row.value === 'string' &&
    row.value !== '' &&
    typeof row.source === 'string' &&
    ENTRY_SOURCES.has(row.source) &&
    typeof row.status === 'string' &&
    ENTRY_STATUSES.has(row.status) &&
    (row.key === null || typeof row.key === 'string') &&
    (row.evidence === null || typeof row.evidence === 'string') &&
    (row.personaScope === null || typeof row.personaScope === 'string') &&
    typeof row.createdAt === 'number' &&
    typeof row.updatedAt === 'number'
  );
}

function isValidEpisode(value: unknown): value is EpisodeSummary {
  if (value === null || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === 'string' &&
    typeof row.conversationId === 'string' &&
    row.conversationId !== '' &&
    (row.personaId === null || typeof row.personaId === 'string') &&
    typeof row.title === 'string' &&
    typeof row.summary === 'string' &&
    row.summary !== '' &&
    (row.model === null || typeof row.model === 'string') &&
    typeof row.createdAt === 'number' &&
    typeof row.updatedAt === 'number'
  );
}

export function createMemoryTransferManager(
  options: MemoryTransferManagerOptions,
): MemoryTransferManager {
  const { stores, audit } = options;
  const now = options.now ?? Date.now;

  function exportBundle(): MemoryExportBundle {
    const profile: ProfileEntry[] = stores.profile.list().map((row) => ({
      id: row.id,
      kind: row.kind as ProfileEntryKind,
      key: row.key,
      value: row.value,
      evidence: row.evidence,
      source: row.source as ProfileEntry['source'],
      status: row.status as ProfileEntryStatus,
      personaScope: row.personaScope,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    const episodes: EpisodeSummary[] = stores.episodes.list().map((row) => ({
      id: row.id,
      conversationId: row.conversationId,
      personaId: row.personaId,
      title: row.title,
      summary: row.summary,
      model: row.model,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
    audit.log('web', 'memory.export', 'bundle', {
      profile: profile.length,
      episodes: episodes.length,
    });
    return { schema: 'memory/v1', exportedAt: now(), profile, episodes };
  }

  function importBundle(rawBundle: unknown): MemoryImportCounts {
    if (rawBundle === null || typeof rawBundle !== 'object' || Array.isArray(rawBundle)) {
      throw memoryError('invalid_input', 'bundle must be a memory export object');
    }
    const bundle = rawBundle as Record<string, unknown>;
    if (bundle.schema !== 'memory/v1') {
      throw memoryError('invalid_input', "bundle.schema must be 'memory/v1'");
    }
    if (!Array.isArray(bundle.profile)) {
      throw memoryError('invalid_input', 'bundle.profile must be an array');
    }
    if (!Array.isArray(bundle.episodes)) {
      throw memoryError('invalid_input', 'bundle.episodes must be an array');
    }

    const entries = bundle.profile as unknown[];
    if (!entries.every(isValidEntry)) {
      throw memoryError('invalid_input', 'bundle.profile contains malformed entries');
    }
    const episodes = bundle.episodes as unknown[];
    if (!episodes.every(isValidEpisode)) {
      throw memoryError('invalid_input', 'bundle.episodes contains malformed episodes');
    }

    let profileCount = 0;
    for (const entry of entries as ProfileEntry[]) {
      const id = randomUUID();
      stores.profile.insert(entryToRow(entry, id));
      // Mirror the add() rule: rejected imported entries stay un-indexed.
      if (entry.status !== 'rejected') {
        stores.fts.upsertProfile(id, profileSearchText(entry));
      }
      profileCount += 1;
    }

    let episodeCount = 0;
    for (const episode of episodes as EpisodeSummary[]) {
      // conversation_id is UNIQUE locally: an episode for an already
      // summarized conversation is skipped (additive, never duplicated).
      if (stores.episodes.findByConversationId(episode.conversationId)) continue;
      const id = randomUUID();
      stores.episodes.insert(episodeToRow(episode, id));
      stores.fts.upsertEpisode(id, episodeSearchText(episode));
      episodeCount += 1;
    }

    audit.log('web', 'memory.import', 'bundle', {
      profile: profileCount,
      episodes: episodeCount,
    });
    return { profile: profileCount, episodes: episodeCount };
  }

  return { exportBundle, importBundle };
}
