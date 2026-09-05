/**
 * M11 F10 asset API client (PLAN-M11.md).
 */
import { ApiRequestError, expectJson, expectNoContent, type FetchLike } from './api.js';
import type { Asset, AssetInput } from '@partner/shared';

export type { FetchLike };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const assetsPath = (conversationId: string): string =>
  `/v1/conversations/${encodeURIComponent(conversationId)}/assets`;

function parseAssetList(value: unknown, status = 200): Asset[] {
  if (Array.isArray(value)) return value as Asset[];
  if (isRecord(value) && Array.isArray(value.assets)) return value.assets as unknown as Asset[];
  throw new ApiRequestError(status, 'The assets response had an unexpected shape.');
}

export async function listAssets(
  token: string,
  conversationId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<Asset[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(assetsPath(conversationId), {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return parseAssetList(await expectJson<unknown>(response), response.status);
}

export async function createAssets(
  token: string,
  conversationId: string,
  inputs: AssetInput[],
  options: { fetchImpl?: FetchLike } = {},
): Promise<Asset[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(assetsPath(conversationId), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(inputs),
  });
  const body: unknown = await expectJson<unknown>(response);
  if (isRecord(body) && Array.isArray(body.assets)) {
    return body.assets as unknown as Asset[];
  }
  throw new ApiRequestError(response.status, 'The save response had an unexpected shape.');
}

export async function deleteAsset(
  token: string,
  conversationId: string,
  assetId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${assetsPath(conversationId)}/${encodeURIComponent(assetId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Deleting the asset');
}

export async function promoteAsset(
  token: string,
  conversationId: string,
  assetId: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ noteId: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(
    `${assetsPath(conversationId)}/${encodeURIComponent(assetId)}/promote`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` } },
  );
  const body: unknown = await expectJson<unknown>(response);
  if (isRecord(body) && typeof body.noteId === 'string') {
    return { noteId: body.noteId };
  }
  throw new ApiRequestError(response.status, 'The promotion response had an unexpected shape.');
}
