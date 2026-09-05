/**
 * M11 F2 search API client (PLAN-M11.md).
 */
import { ApiRequestError, expectJson, expectNoContent, type FetchLike } from './api.js';
import type { SearchConfig, SearchConfigInput, SearchResult } from '@partner/shared';

export type { FetchLike };

const BASE = '/v1/search';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export async function getSearchConfig(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SearchConfig & { hasKey: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/config`, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const body: unknown = await expectJson<unknown>(response);
  if (isRecord(body) && typeof body.enabled === 'boolean') {
    return body as unknown as SearchConfig & { hasKey: boolean };
  }
  throw new ApiRequestError(response.status, 'The search config response had an unexpected shape.');
}

export async function updateSearchConfig(
  token: string,
  input: SearchConfigInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SearchConfig & { hasKey: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/config`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  const body: unknown = await expectJson<unknown>(response);
  if (isRecord(body) && typeof body.enabled === 'boolean') {
    return body as unknown as SearchConfig & { hasKey: boolean };
  }
  throw new ApiRequestError(response.status, 'The search config response had an unexpected shape.');
}

export async function setSearchKey(
  token: string,
  key: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/key`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ key }),
  });
  return expectNoContent(response, 'Storing the search API key');
}

export async function removeSearchKey(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/key`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Removing the search API key');
}

export async function runSearch(
  token: string,
  query: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SearchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${BASE}/query`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  const body: unknown = await expectJson<unknown>(response);
  if (isRecord(body) && Array.isArray(body.hits)) return body as unknown as SearchResult;
  throw new ApiRequestError(response.status, 'The search response had an unexpected shape.');
}
