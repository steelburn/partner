/**
 * M11 F1 file-reference client helpers (PLAN-M11.md).
 *
 * Autocomplete search over /v1/files/refs (granted roots only) + the
 * partner-file:// markdown link builder the composer inserts. The core reads
 * granted files into the model context when a turn carries such links.
 */
import { ApiRequestError, expectJson, type FetchLike } from './api.js';

export type { FetchLike };

export interface FileRefHit {
  rootId: string;
  rootLabel: string;
  path: string;
  kind: string;
  size: number | null;
}

export async function searchFileRefs(
  token: string,
  query: string,
  options: { fetchImpl?: FetchLike; limit?: number } = {},
): Promise<FileRefHit[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const limit = options.limit ?? 12;
  const qs = new URLSearchParams();
  if (query !== '') qs.set('q', query);
  qs.set('limit', String(limit));
  const response = await fetchImpl(`/v1/files/refs?${qs.toString()}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const body: unknown = await expectJson<unknown>(response);
  if (body !== null && typeof body === 'object' && Array.isArray((body as { refs?: unknown }).refs)) {
    return (body as { refs: FileRefHit[] }).refs;
  }
  throw new ApiRequestError(response.status, 'The file list response had an unexpected shape.');
}

/** Encode a ref's path segment-by-segment so spaces survive markdown. */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** [label](partner-file://<rootId>/<path>) — the mention markdown link. */
export function partnerFileLink(hit: FileRefHit): string {
  const label = hit.path.split('/').pop() ?? hit.path;
  const href = `partner-file://${encodeURIComponent(hit.rootId)}/${encodePath(hit.path)}`;
  return `[${label}](${href})`;
}
