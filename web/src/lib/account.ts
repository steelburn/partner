/**
 * M29 client — the account lane, invitations, shared access and shares.
 *
 * Split out of `api.ts` to keep one cohesive lane in one file. Every call sends
 * the session token as a Bearer header and nothing else; no token, invite code
 * or shared body is ever placed in a URL, a log, or web storage. A share body is
 * owner content the grantee was explicitly given — it is rendered and then
 * dropped, like any other fetched content.
 */
import type { KeyAccess, ShareKind, UserRole } from '@partner/shared';
import { ApiRequestError, expectJson, readErrorMessage } from './api.js';
import type { FetchLike } from './api.js';

const ACCOUNT_PATH = '/v1/account';
const SIGNOUT_PATH = '/v1/auth/signout';
const USERS_PATH = '/v1/users';
const INVITES_PATH = '/v1/invites';
const SHARED_ACCESS_PATH = '/v1/shared-access';
const SHARES_PATH = '/v1/shares';

export interface AccountInfo {
  id: string;
  label: string;
  role: UserRole;
  keyAccess: KeyAccess;
  disabledAt: number | null;
}

export interface UserRecord {
  id: string;
  label: string;
  role: UserRole;
  keyAccess: KeyAccess;
  disabledAt: number | null;
}

export interface InviteRecord {
  id: string;
  role: UserRole;
  keyAccess: KeyAccess;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
  state: 'pending' | 'used' | 'expired';
}

export interface MintedInvite {
  id: string;
  code: string;
  url: string;
  role: UserRole;
  keyAccess: KeyAccess;
  createdAt: number;
  expiresAt: number;
}

export interface SharedAccessStatus {
  canManage: boolean;
  configured: boolean;
  providerCount: number;
  searchConfigured: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
}

export interface ShareRecord {
  id: string;
  ownerId: string;
  kind: ShareKind;
  resourceId: string;
  conversationId: string | null;
  granteeId: string;
  permission: string;
  title: string;
  bodyChars: number;
  createdAt: number;
  updatedAt: number;
  ownerLabel?: string | null;
  granteeLabel?: string | null;
}

export interface ShareDetail extends ShareRecord {
  body: string;
  meta: Record<string, unknown> | null;
}

function authHeaders(token: string, json = false): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(json ? { 'content-type': 'application/json' } : {}),
  };
}

/** GET /v1/account → the signed-in account, or null on a paired desktop core. */
export async function fetchAccount(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<AccountInfo | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(ACCOUNT_PATH, { headers: authHeaders(token) });
  const parsed = await expectJson<{ user: AccountInfo | null }>(response);
  return parsed.user ?? null;
}

/**
 * POST /v1/auth/signout → 204. Best-effort like `revokeSession`: a 401 means the
 * session is already gone, which is the outcome the caller wanted.
 */
export async function signOut(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SIGNOUT_PATH, {
    method: 'POST',
    headers: authHeaders(token),
  });
  if (response.status !== 204 && response.status !== 401 && response.status !== 403) {
    throw new ApiRequestError(response.status, 'Could not sign out.');
  }
}

/** GET /v1/users (owner only) → every account, for the members view. */
export async function listUsers(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<UserRecord[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(USERS_PATH, { headers: authHeaders(token) });
  const parsed = await expectJson<{ users: UserRecord[] }>(response);
  return parsed.users;
}

/** POST /v1/invites → a single-use invitation whose code is returned ONCE. */
export async function mintInvite(
  token: string,
  input: { role: UserRole; keyAccess: KeyAccess },
  options: { fetchImpl?: FetchLike } = {},
): Promise<MintedInvite> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(INVITES_PATH, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(input),
  });
  return expectJson<MintedInvite>(response);
}

/** GET /v1/invites (owner only) → invitations without their codes. */
export async function listInvites(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<InviteRecord[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(INVITES_PATH, { headers: authHeaders(token) });
  const parsed = await expectJson<{ invites: InviteRecord[] }>(response);
  return parsed.invites;
}

/** DELETE /v1/invites/:id → 204. */
export async function revokeInvite(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${INVITES_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!response.ok) throw new ApiRequestError(response.status, await readErrorMessage(response));
}

/** GET /v1/shared-access → publication status (readable by any account). */
export async function fetchSharedAccess(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SharedAccessStatus> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SHARED_ACCESS_PATH, { headers: authHeaders(token) });
  return expectJson<SharedAccessStatus>(response);
}

/** PUT /v1/shared-access (owner) → publish the owner's own configuration. */
export async function publishSharedAccess(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ providerCount: number; searchConfigured: boolean }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SHARED_ACCESS_PATH, {
    method: 'PUT',
    headers: authHeaders(token),
  });
  return expectJson<{ providerCount: number; searchConfigured: boolean }>(response);
}

/** DELETE /v1/shared-access (owner) → withdraw everything published. */
export async function clearSharedAccess(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SHARED_ACCESS_PATH, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!response.ok) throw new ApiRequestError(response.status, await readErrorMessage(response));
}

export interface CreateShareInput {
  kind: ShareKind;
  resourceId: string;
  conversationId?: string | null;
  grantee: string;
}

/** POST /v1/shares → the snapshot the grantee will read. */
export async function createShare(
  token: string,
  input: CreateShareInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ShareDetail> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SHARES_PATH, {
    method: 'POST',
    headers: authHeaders(token, true),
    body: JSON.stringify(input),
  });
  const parsed = await expectJson<{ share: ShareDetail }>(response);
  return parsed.share;
}

async function listShares(
  token: string,
  side: 'sent' | 'received',
  fetchImpl: FetchLike,
): Promise<ShareRecord[]> {
  const response = await fetchImpl(`${SHARES_PATH}/${side}`, { headers: authHeaders(token) });
  const parsed = await expectJson<{ shares: ShareRecord[] }>(response);
  return parsed.shares;
}

export function listSentShares(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ShareRecord[]> {
  return listShares(token, 'sent', options.fetchImpl ?? fetch);
}

export function listReceivedShares(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ShareRecord[]> {
  return listShares(token, 'received', options.fetchImpl ?? fetch);
}

/** GET /v1/shares/received/:id → the shared copy WITH its body. */
export async function readReceivedShare(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ShareDetail> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${SHARES_PATH}/received/${encodeURIComponent(id)}`, {
    headers: authHeaders(token),
  });
  const parsed = await expectJson<{ share: ShareDetail }>(response);
  return parsed.share;
}

/** POST /v1/shares/:id/refresh (owner) → push the current content into the copy. */
export async function refreshShare(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ShareDetail> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${SHARES_PATH}/${encodeURIComponent(id)}/refresh`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const parsed = await expectJson<{ share: ShareDetail }>(response);
  return parsed.share;
}

/** DELETE /v1/shares/:id (owner) → 204. */
export async function revokeShare(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${SHARES_PATH}/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(token),
  });
  if (!response.ok) throw new ApiRequestError(response.status, await readErrorMessage(response));
}

/** POST /v1/shares/:id/import (grantee) → a copy in the caller's own store. */
export async function importShare(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ kind: ShareKind; id: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${SHARES_PATH}/${encodeURIComponent(id)}/import`, {
    method: 'POST',
    headers: authHeaders(token),
  });
  const parsed = await expectJson<{ imported: { kind: ShareKind; id: string } }>(response);
  return parsed.imported;
}
