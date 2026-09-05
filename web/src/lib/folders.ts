/**
 * M11 F11 folder API client (PLAN-M11.md).
 *
 * Same chokepoint rules as every client (lib/api.ts + conversations.ts): the
 * pairing token travels ONLY as `Authorization: Bearer …`; transport is
 * injectable for tests; non-2xx maps to ApiRequestError with a readable
 * message. Folder names are owner metadata — never secret content.
 */
import { ApiRequestError, expectJson, expectNoContent, type FetchLike } from './api.js';
import type { ConversationUpdateInput } from '@partner/shared';
import type { Folder, FolderInput, FolderUpdate } from '@partner/shared';
import type { ConversationSummary } from '@partner/shared';
import { parseConversationSummary } from './conversations.js';

const FOLDERS_PATH = '/v1/folders';

export type { FetchLike };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Normalize a folders list response ({folders:[...]} or a bare array). */
export function parseFolderList(value: unknown, status = 200): Folder[] {
  if (Array.isArray(value)) return value as Folder[];
  if (isRecord(value) && Array.isArray(value.folders)) {
    return value.folders as unknown as Folder[];
  }
  throw new ApiRequestError(status, 'The folders response had an unexpected shape.');
}

function parseFolder(value: unknown, status = 200): Folder {
  if (isRecord(value) && typeof value.id === 'string') return value as unknown as Folder;
  throw new ApiRequestError(status, 'The folder response had an unexpected shape.');
}

/** GET /v1/folders -> flat folder list (tree assembly happens client-side). */
export async function listFolders(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Folder[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(FOLDERS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseFolderList(await expectJson<unknown>(response), response.status);
}

/** POST /v1/folders {name, parentId?} -> created folder. */
export async function createFolder(
  token: string,
  input: FolderInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Folder> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(FOLDERS_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return parseFolder(await expectJson<unknown>(response), response.status);
}

/** PUT /v1/folders/:id {name?, parentId?} -> updated folder. */
export async function updateFolder(
  token: string,
  id: string,
  patch: FolderUpdate,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Folder> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${FOLDERS_PATH}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(patch),
  });
  return parseFolder(await expectJson<unknown>(response), response.status);
}

/** DELETE /v1/folders/:id -> 204. */
export async function deleteFolder(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${FOLDERS_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Deleting the folder');
}

/** PUT /v1/conversations/:id {title?, folderId?} -> updated summary. */
export async function updateConversation(
  token: string,
  id: string,
  patch: ConversationUpdateInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ConversationSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`/v1/conversations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(patch),
  });
  const body: unknown = await expectJson<unknown>(response);
  if (isRecord(body) && body.conversation !== undefined) {
    return parseConversationSummary(body, response.status);
  }
  return parseConversationSummary(body, response.status);
}
