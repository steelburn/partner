/**
 * M5 notes API client (PLAN-M5.md).
 *
 * Same chokepoint rules as every other client (lib/api.ts): the pairing
 * token travels ONLY as `Authorization: Bearer …`; transport is injectable
 * for tests; non-2xx maps to ApiRequestError with a readable message.
 * Redaction discipline: note content is the OWNER's data — it may be
 * returned to the UI (list/editor/search) but nothing in this module logs,
 * prints or embeds it in error text. Validation errors name fields and
 * indices, never content. The one exception is search SNIPPETS, which are
 * content the core itself sent as a response to an owner search query — they
 * travel through this module untouched and render in the UI only.
 */

import { ApiRequestError, expectJson, readErrorMessage, type FetchLike } from './api.js';
import { validateNotesExportBundle } from './note-helpers.js';
import type { Note, NoteInput, NoteSummary, NotesExportBundle, TagCount } from '@partner/shared';

const NOTES_PATH = '/v1/notes';
const DAILY_PATH = '/v1/notes/daily';
const SUMMARIZE_PATH = '/v1/notes/daily/summarize';
const SEARCH_PATH = '/v1/notes/search';
const EXPORT_PATH = '/v1/notes/export';
const CAPTURE_PATH = '/v1/notes/capture';
const TAGS_PATH = '/v1/tags';

export type { FetchLike };

export interface NoteSearchResult extends NoteSummary {
  /** FTS snippet the core returned (owner-only content; null on plain lists). */
  snippet: string | null;
  /** Relevance rank when the core sent one (0 otherwise). */
  rank: number;
}

/** A note that links TO the note being viewed (a backlink row). */
export interface NoteBacklink {
  id: string;
  title: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Number out of an epoch field; tolerates the core serializing a numeric string. */
function epoch(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/** tags field: absent/garbage normalizes to [] (tags are auxiliary). */
function readTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((tag): tag is string => typeof tag === 'string' && tag.length > 0);
}

/**
 * Normalize one note response into a full Note. Tolerates a bare note or
 * `{note: …}` / `{daily: …}` envelopes. Identity fields (id, title,
 * content, timestamps) are required; missing tags/isDaily default safely.
 */
export function parseNote(value: unknown, status = 200): Note {
  const record = isRecord(value) ? value : null;
  const direct = record;
  const enveloped = record
    ? isRecord(record.note)
      ? record.note
      : isRecord(record.daily)
        ? record.daily
        : null
    : null;
  const note = (enveloped ?? direct) as Record<string, unknown> | null;
  if (
    note === null ||
    typeof note.id !== 'string' ||
    note.id.length === 0 ||
    typeof note.title !== 'string' ||
    typeof note.content !== 'string' ||
    epoch(note.createdAt) === null ||
    epoch(note.updatedAt) === null
  ) {
    throw new ApiRequestError(status, 'The note response had an unexpected shape.');
  }
  return {
    id: note.id,
    title: note.title,
    content: note.content,
    tags: readTags(note.tags),
    isDaily: note.isDaily === true,
    createdAt: epoch(note.createdAt) as number,
    updatedAt: epoch(note.updatedAt) as number,
  };
}

/**
 * Normalize a note-list response ({notes: [...]} or a bare array). Rows need
 * the summary identity fields; a bad row fails the whole list loudly so a
 * contract drift cannot silently empty the Notes screen.
 */
export function parseNoteList(value: unknown, status = 200): NoteSummary[] {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.notes) ? value.notes : null;
  if (list === null) {
    throw new ApiRequestError(status, 'The notes response had an unexpected shape.');
  }
  return list.map((row, index) => {
    const summary = summaryFromRow(row, status, `note ${index}`);
    return summary;
  });
}

function summaryFromRow(row: unknown, status: number, label: string): NoteSummary {
  if (
    !isRecord(row) ||
    typeof row.id !== 'string' ||
    row.id.length === 0 ||
    typeof row.title !== 'string' ||
    epoch(row.createdAt) === null ||
    epoch(row.updatedAt) === null
  ) {
    throw new ApiRequestError(status, `${label} had an unexpected shape.`);
  }
  return {
    id: row.id,
    title: row.title,
    tags: readTags(row.tags),
    isDaily: row.isDaily === true,
    createdAt: epoch(row.createdAt) as number,
    updatedAt: epoch(row.updatedAt) as number,
  };
}

/** Search hits: unwrap {hits}/{results}/{notes} or a bare array. */
export function parseSearchResults(value: unknown, status = 200): NoteSearchResult[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value)
      ? Array.isArray(value.hits)
        ? value.hits
        : Array.isArray(value.results)
          ? value.results
          : Array.isArray(value.notes)
            ? value.notes
            : null
      : null;
  if (list === null) {
    throw new ApiRequestError(status, 'The notes search response had an unexpected shape.');
  }
  const rows: NoteSearchResult[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue; // drop stray non-objects defensively
    const snippet = typeof row.snippet === 'string' ? row.snippet : null;
    const rank = typeof row.rank === 'number' && Number.isFinite(row.rank) ? row.rank : 0;
    // The core may answer with note summaries or with FTS hits; both carry
    // an id/title surface we can open in the editor.
    const id = typeof row.id === 'string' && row.id.length > 0 ? row.id : undefined;
    const refId =
      id === undefined && typeof row.noteId === 'string' && row.noteId.length > 0
        ? row.noteId
        : typeof row.refId === 'string' && row.refId.length > 0
          ? row.refId
          : undefined;
    const noteId = refId ?? id;
    if (noteId === undefined) continue; // not openable — skip silently
    const title =
      typeof row.title === 'string' && row.title.length > 0
        ? row.title
        : snippet !== null && snippet.length > 0
          ? snippet
          : '';
    const createdAt = epoch(row.createdAt) ?? 0;
    const updatedAt = epoch(row.updatedAt) ?? createdAt;
    rows.push({
      id: noteId,
      title,
      tags: readTags(row.tags),
      isDaily: row.isDaily === true,
      createdAt,
      updatedAt,
      snippet,
      rank,
    });
  }
  return rows;
}

/**
 * Backlinks: unwrap {backlinks: [...]} or a bare array of linking notes.
 * Rows may be note summaries or {fromNoteId, fromTitle} link records — both
 * name the note that links here, which is all the panel needs to open it.
 */
export function parseBacklinks(value: unknown, status = 200): NoteBacklink[] {
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.backlinks)
      ? value.backlinks
      : null;
  if (list === null) {
    throw new ApiRequestError(status, 'The backlinks response had an unexpected shape.');
  }
  const rows: NoteBacklink[] = [];
  for (const row of list) {
    if (!isRecord(row)) continue;
    const id =
      typeof row.id === 'string' && row.id.length > 0
        ? row.id
        : typeof row.fromNoteId === 'string' && row.fromNoteId.length > 0
          ? row.fromNoteId
          : undefined;
    if (id === undefined) continue;
    const rawTitle = row.title ?? row.fromTitle;
    const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : '';
    rows.push({ id, title });
  }
  return rows;
}

/**
 * Normalize a tags response: {tags: [{tag, count}]}, a bare array of the
 * same, or a {tag: count} map. Every row normalizes to TagCount.
 */
export function parseTags(value: unknown, status = 200): TagCount[] {
  if (isRecord(value) && !('tags' in value)) {
    // {tag: count} map form
    const map: TagCount[] = [];
    for (const [tag, count] of Object.entries(value)) {
      if (typeof count === 'number' && Number.isFinite(count) && tag.length > 0) {
        map.push({ tag, count });
      }
    }
    return map;
  }
  const list = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tags)
      ? value.tags
      : null;
  if (list === null) {
    throw new ApiRequestError(status, 'The tags response had an unexpected shape.');
  }
  return list.flatMap((row) => {
    if (!isRecord(row) || typeof row.tag !== 'string' || row.tag.length === 0) return [];
    const count = typeof row.count === 'number' && Number.isFinite(row.count) ? row.count : 0;
    return [{ tag: row.tag, count }];
  });
}

/** GET /v1/notes -> note summaries (never bodies). */
export async function listNotes(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<NoteSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(NOTES_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseNoteList(await expectJson<unknown>(response), response.status);
}

/** POST /v1/notes -> the created note (wiki-links parsed server-side). */
export async function createNote(
  token: string,
  input: NoteInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Note> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(NOTES_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parseNote(await expectJson<unknown>(response), response.status);
}

/** GET /v1/notes/:id -> the full note. */
export async function getNote(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Note> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${NOTES_PATH}/${encodeURIComponent(id)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseNote(await expectJson<unknown>(response), response.status);
}

/** PUT /v1/notes/:id -> the updated note (wiki-links re-parsed). */
export async function updateNote(
  token: string,
  id: string,
  input: NoteInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Note> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${NOTES_PATH}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parseNote(await expectJson<unknown>(response), response.status);
}

/** DELETE /v1/notes/:id -> 204. */
export async function deleteNote(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${NOTES_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
}

/** POST /v1/notes/capture {text} — quick capture (title = first line). */
export async function captureNote(
  token: string,
  text: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Note> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(CAPTURE_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ text }),
  });
  return parseNote(await expectJson<unknown>(response), response.status);
}

/** GET /v1/notes/daily — today's daily note (created when missing). */
export async function getDailyNote(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Note> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(DAILY_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseNote(await expectJson<unknown>(response), response.status);
}

/**
 * POST /v1/notes/daily/summarize — the provider condenses the day's notes
 * into the daily note body (deterministic placeholder without a provider).
 * Returns the refreshed daily note when the core echoes one; null on bare
 * success shapes (callers refetch the daily note to show the new body).
 */
export async function summarizeDaily(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Note | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SUMMARIZE_PATH, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
  if (response.status === 204) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  try {
    return parseNote(body, response.status);
  } catch {
    return null; // 2xx without an echoable note — nothing to show yet
  }
}

/** GET /v1/notes/search?q= — FTS over note titles/bodies (owner query). */
export async function searchNotes(
  token: string,
  query: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<NoteSearchResult[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const q = query.trim();
  const response = await fetchImpl(`${SEARCH_PATH}?q=${encodeURIComponent(q)}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseSearchResults(await expectJson<unknown>(response), response.status);
}

/** GET /v1/notes/:id/backlinks — notes that link to this one. */
export async function getBacklinks(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<NoteBacklink[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${NOTES_PATH}/${encodeURIComponent(id)}/backlinks`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseBacklinks(await expectJson<unknown>(response), response.status);
}

/** GET /v1/tags — every tag with its note count (tag name only, no bodies). */
export async function listTags(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<TagCount[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(TAGS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseTags(await expectJson<unknown>(response), response.status);
}

/**
 * GET /v1/notes/export -> the notes/v1 JSON bundle. The response may be the
 * bundle bare or wrapped under a `bundle` key; anything failing the schema
 * guard throws ApiRequestError (no content in the message).
 */
export async function exportNotes(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<NotesExportBundle> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(EXPORT_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  const bundle = isRecord(parsed) && isRecord(parsed.bundle) ? parsed.bundle : parsed;
  const error = validateNotesExportBundle(bundle);
  if (error !== null) {
    throw new ApiRequestError(response.status, `The notes export was invalid: ${error}`);
  }
  return bundle as unknown as NotesExportBundle;
}
