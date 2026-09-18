/**
 * M4 memory API client (PLAN-M4.md).
 *
 * Same chokepoint rules as every other client (lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; transport is injectable
 * for tests; non-2xx maps to ApiRequestError with a readable message.
 * Redaction discipline: memory content (profile values, episode summaries)
 * is user data — it may be rendered to the OWNER by the UI, but nothing in
 * this module ever logs, prints or embeds it in error text. Validation
 * errors name fields/indices, never content.
 */

import { ApiRequestError, expectJson, readErrorMessage, type FetchLike } from './api.js';
import { validateBundle } from './memory-helpers.js';
import type {
  EpisodeSummary,
  ForgetRequest,
  MemoryExportBundle,
  MemorySearchHit,
  ProfileEntry,
  ProfileEntryInput,
} from '@partner/shared';

const PROFILE_PATH = '/v1/memory/profile';
const SETTINGS_PATH = '/v1/memory/settings';
const EPISODES_PATH = '/v1/memory/episodes';
const SEARCH_PATH = '/v1/memory/search';
const FORGET_PATH = '/v1/memory/forget';
const EXPORT_PATH = '/v1/memory/export';
const IMPORT_PATH = '/v1/memory/import';

export type { FetchLike };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const KINDS: readonly string[] = ['preference', 'identity', 'rule', 'style'];
const STATUSES: readonly string[] = ['confirmed', 'suggested', 'rejected'];

/**
 * Normalize a single profile entry response (bare or wrapped under
 * `entry`/`profile`). Throws ApiRequestError on shapes missing the required
 * identity fields.
 */
export function parseProfileEntry(value: unknown, status = 200): ProfileEntry {
  const record = isRecord(value) ? value : null;
  const direct = record;
  const enveloped = record
    ? (isRecord(record.entry) ? record.entry : isRecord(record.profile) ? record.profile : null)
    : null;
  const entry = (enveloped ?? direct) as Record<string, unknown> | null;
  if (
    entry === null ||
    typeof entry.id !== 'string' ||
    typeof entry.value !== 'string' ||
    typeof entry.kind !== 'string' ||
    !KINDS.includes(entry.kind) ||
    typeof entry.status !== 'string' ||
    !STATUSES.includes(entry.status) ||
    typeof entry.createdAt !== 'number' ||
    typeof entry.updatedAt !== 'number'
  ) {
    throw new ApiRequestError(status, 'The profile entry response had an unexpected shape.');
  }
  // M33 scope normalization: the canonical field is `personaScopes` (string
  // array; [] = every persona). A pre-M33 payload carrying only `personaScope`
  // (string | null) still reads correctly, so a mixed-version pair never
  // silently widens a persona-scoped fact to global.
  return { ...entry, personaScopes: readScopeArray(entry) } as unknown as ProfileEntry;
}

/** Persona ids from either the M33 array field or the legacy single scope. */
export function readScopeArray(entry: Record<string, unknown>): string[] {
  const raw = entry.personaScopes;
  if (Array.isArray(raw)) {
    const ids: string[] = [];
    for (const value of raw) {
      if (typeof value !== 'string') continue;
      const id = value.trim();
      if (id === '' || ids.includes(id)) continue;
      ids.push(id);
    }
    return ids;
  }
  const legacy = entry.personaScope;
  return typeof legacy === 'string' && legacy.trim() !== '' ? [legacy.trim()] : [];
}

/**
 * Normalize a profile list response ({profile: [...]} or a bare array).
 */
export function parseProfileList(value: unknown, status = 200): ProfileEntry[] {
  if (Array.isArray(value)) return value.map((row) => parseProfileEntry(row, status));
  if (isRecord(value) && Array.isArray(value.profile)) {
    return value.profile.map((row) => parseProfileEntry(row, status));
  }
  throw new ApiRequestError(status, 'The profile response had an unexpected shape.');
}

/**
 * Normalize a single episode summary response (bare or under `episode`).
 */
export function parseEpisode(value: unknown, status = 200): EpisodeSummary {
  const record = isRecord(value) ? value : null;
  const direct = record;
  const enveloped = record && isRecord(record.episode) ? record.episode : null;
  const episode = (enveloped ?? direct) as Record<string, unknown> | null;
  if (
    episode === null ||
    typeof episode.id !== 'string' ||
    typeof episode.conversationId !== 'string' ||
    typeof episode.summary !== 'string' ||
    typeof episode.createdAt !== 'number' ||
    typeof episode.updatedAt !== 'number'
  ) {
    throw new ApiRequestError(status, 'The episode response had an unexpected shape.');
  }
  return episode as unknown as EpisodeSummary;
}

/**
 * Normalize an episodes list response ({episodes: [...]} or a bare array).
 */
export function parseEpisodeList(value: unknown, status = 200): EpisodeSummary[] {
  if (Array.isArray(value)) return value.map((row) => parseEpisode(row, status));
  if (isRecord(value) && Array.isArray(value.episodes)) {
    return value.episodes.map((row) => parseEpisode(row, status));
  }
  throw new ApiRequestError(status, 'The episodes response had an unexpected shape.');
}

/**
 * Normalize a search response ({hits: [...]} or a bare array). A hit needs
 * kind/refId/snippet to be useful; rank is optional (missing -> 0).
 */
export function parseSearchHits(value: unknown, status = 200): MemorySearchHit[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.hits)
      ? value.hits
      : null;
  if (list === null) {
    throw new ApiRequestError(status, 'The memory search response had an unexpected shape.');
  }
  return list.map((row, index) => {
    if (!isRecord(row) || typeof row.refId !== 'string' || typeof row.snippet !== 'string') {
      throw new ApiRequestError(status, `Search hit ${index} had an unexpected shape.`);
    }
    const kind = row.kind;
    if (kind !== 'profile' && kind !== 'episode') {
      throw new ApiRequestError(status, `Search hit ${index} had an unexpected kind.`);
    }
    const rank = typeof row.rank === 'number' ? row.rank : 0;
    return { kind, refId: row.refId, snippet: row.snippet, rank };
  });
}

/** Result counts reported by an import (additive; ids are always new). */
export interface MemoryImportResult {
  /** Profile rows imported; null when the core did not report a count. */
  profileImported: number | null;
  /** Episode rows imported; null when the core did not report a count. */
  episodesImported: number | null;
}

/**
 * Tolerant reader for the import response (the core may echo counts under
 * several shapes, or nothing at all). Unknown shapes yield null counts —
 * never an error, because the import itself succeeded.
 */
export function parseImportResult(value: unknown): MemoryImportResult {
  const fallback: MemoryImportResult = { profileImported: null, episodesImported: null };
  if (!isRecord(value)) return fallback;
  const count = (record: Record<string, unknown>, key: string): number | null => {
    const v = record[key];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const nested = isRecord(value.imported) ? value.imported : null;
  const profileImported =
    count(value, 'profileImported') ?? (nested ? count(nested, 'profile') : null);
  const episodesImported =
    count(value, 'episodesImported') ?? (nested ? count(nested, 'episodes') : null);
  return { profileImported, episodesImported };
}

// ---------------------------------------------------------------------------
// Settings (M19 follow-up: user-level global auto-remember consent)
// ---------------------------------------------------------------------------

/** The user-level memory consent this client reads/writes. */
export interface MemorySettings {
  /** May the partner propose facts that apply to every persona? Default ON. */
  autoRememberGlobal: boolean;
}

/** Normalize the settings response; throws on an unexpected shape. */
export function parseMemorySettings(value: unknown, status = 200): MemorySettings {
  if (!isRecord(value) || typeof value.autoRememberGlobal !== 'boolean') {
    throw new ApiRequestError(status, 'The memory settings response had an unexpected shape.');
  }
  return { autoRememberGlobal: value.autoRememberGlobal };
}

/** GET /v1/memory/settings -> the global auto-remember consent. */
export async function getMemorySettings(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<MemorySettings> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SETTINGS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseMemorySettings(await expectJson<unknown>(response), response.status);
}

/** PUT /v1/memory/settings -> the stored consent. */
export async function updateMemorySettings(
  token: string,
  settings: MemorySettings,
  options: { fetchImpl?: FetchLike } = {},
): Promise<MemorySettings> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SETTINGS_PATH, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ autoRememberGlobal: settings.autoRememberGlobal }),
  });
  return parseMemorySettings(await expectJson<unknown>(response), response.status);
}

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

/** GET /v1/memory/profile -> confirmed + suggested entries (rejected optional). */
export async function listProfile(
  token: string,
  options: { fetchImpl?: FetchLike; includeRejected?: boolean } = {},
): Promise<ProfileEntry[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = options.includeRejected === true
    ? `${PROFILE_PATH}?includeRejected=1`
    : PROFILE_PATH;
  const response = await fetchImpl(path, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseProfileList(await expectJson<unknown>(response), response.status);
}

/** POST /v1/memory/profile -> the created entry. */
export async function addProfileEntry(
  token: string,
  input: ProfileEntryInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProfileEntry> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(PROFILE_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parseProfileEntry(await expectJson<unknown>(response), response.status);
}

/** PUT /v1/memory/profile/:id -> the updated entry. */
export async function updateProfileEntry(
  token: string,
  id: string,
  input: ProfileEntryInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProfileEntry> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${PROFILE_PATH}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parseProfileEntry(await expectJson<unknown>(response), response.status);
}

/** DELETE /v1/memory/profile/:id -> 204. */
export async function removeProfileEntry(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${PROFILE_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorText(response));
  }
}

// ---------------------------------------------------------------------------
// Episodes
// ---------------------------------------------------------------------------

/** GET /v1/memory/episodes -> every stored episode summary. */
export async function listEpisodes(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<EpisodeSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(EPISODES_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseEpisodeList(await expectJson<unknown>(response), response.status);
}

/**
 * POST /v1/memory/episodes/:conversationId -> summarize a conversation NOW
 * via the chat provider (demo mode writes a deterministic placeholder — the
 * core marks those with model: null).
 */
export async function summarizeEpisode(
  token: string,
  conversationId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<EpisodeSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${EPISODES_PATH}/${encodeURIComponent(conversationId)}`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    },
  );
  return parseEpisode(await expectJson<unknown>(response), response.status);
}

/** DELETE /v1/memory/episodes/:id -> 204. */
export async function removeEpisode(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${EPISODES_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorText(response));
  }
}

// ---------------------------------------------------------------------------
// Search / forget / export / import
// ---------------------------------------------------------------------------

/** GET /v1/memory/search?q= — FTS over profile + episodes, ranked, cap 50. */
export async function searchMemory(
  token: string,
  query: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<MemorySearchHit[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const q = query.trim();
  const response = await fetchImpl(`${SEARCH_PATH}?q=${encodeURIComponent(q)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseSearchHits(await expectJson<unknown>(response), response.status);
}

/** POST /v1/memory/forget {what, id?, before?} — per-entry/episode or bulk. */
export async function forgetMemory(
  token: string,
  input: ForgetRequest,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(FORGET_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorText(response));
  }
}

/**
 * GET /v1/memory/export -> the JSON bundle. Response may be the bundle bare
 * or wrapped under a `bundle` key; anything failing the schema guard throws.
 */
export async function exportMemory(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<MemoryExportBundle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(EXPORT_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  const bundle = isRecord(parsed) && isRecord(parsed.bundle) ? parsed.bundle : parsed;
  const error = validateBundle(bundle);
  if (error !== null) {
    throw new ApiRequestError(response.status, `The memory export was invalid: ${error}`);
  }
  return bundle as unknown as MemoryExportBundle;
}

/**
 * POST /v1/memory/import {bundle} — additive; conflicts get new ids. The
 * caller runs validateBundle first; this guards again defensively.
 */
export async function importMemory(
  token: string,
  bundle: MemoryExportBundle,
  options: { fetchImpl?: FetchLike } = {},
): Promise<MemoryImportResult> {
  const error = validateBundle(bundle);
  if (error !== null) {
    throw new ApiRequestError(400, `Cannot import: ${error}`);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(IMPORT_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ bundle }),
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await errorText(response));
  }
  if (response.status === 204) return { profileImported: null, episodesImported: null };
  try {
    return parseImportResult(await response.json());
  } catch {
    return { profileImported: null, episodesImported: null };
  }
}

/** Body text for error paths without consuming the stream twice. */
async function errorText(response: Response): Promise<string> {
  return readErrorMessage(response);
}
