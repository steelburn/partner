/**
 * M29 — the account lane's client.
 *
 * The core's HTTP tests prove the server; this pins the CLIENT half, where a
 * silent drift would not fail anything else: the request bodies the routes
 * expect, the tolerant sign-out (a 401 means "already gone", which is success),
 * and that an invite's code is never placed in a URL — only its Bearer header
 * carries the session.
 */
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api.js';
import {
  createShare,
  fetchAccount,
  fetchSharedAccess,
  importShare,
  listInvites,
  mintInvite,
  publishSharedAccess,
  readReceivedShare,
  signOut,
} from '../src/lib/account.js';

type Call = { input: string; init?: RequestInit };

function fetchReturning(status: number, body: unknown): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('account client', () => {
  it('reads the signed-in account over a Bearer header only', async () => {
    const { fetchImpl, calls } = fetchReturning(200, {
      user: { id: 'ama', label: 'Ama', role: 'member', keyAccess: 'shared', disabledAt: null },
    });
    const account = await fetchAccount('tok', { fetchImpl });
    expect(account).toMatchObject({ id: 'ama', role: 'member', keyAccess: 'shared' });
    expect(calls[0].input).toBe('/v1/account');
    expect(calls[0].input).not.toContain('tok');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('treats an already-gone session as a successful sign-out', async () => {
    const { fetchImpl } = fetchReturning(401, { error: 'unauthorized' });
    await expect(signOut('tok', { fetchImpl })).resolves.toBeUndefined();
    const failing = fetchReturning(500, { error: 'boom' });
    await expect(signOut('tok', { fetchImpl: failing.fetchImpl })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });

  it('mints an invitation with the role and key access in the body, and returns the link', async () => {
    const { fetchImpl, calls } = fetchReturning(201, {
      id: 'inv1',
      code: 'c'.repeat(64),
      url: 'https://host/#signup=' + 'c'.repeat(64),
      role: 'member',
      keyAccess: 'shared',
      createdAt: 1,
      expiresAt: 2,
    });
    const minted = await mintInvite('tok', { role: 'member', keyAccess: 'shared' }, { fetchImpl });
    expect(minted.url).toContain('#signup=');
    expect(calls[0].input).toBe('/v1/invites');
    expect((calls[0].init?.method ?? 'GET')).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      role: 'member',
      keyAccess: 'shared',
    });
  });

  it('lists invitations and never asks for a code', async () => {
    const { fetchImpl, calls } = fetchReturning(200, { invites: [] });
    await listInvites('tok', { fetchImpl });
    expect(calls[0].input).toBe('/v1/invites');
  });

  it('publishes and reads shared access', async () => {
    const read = fetchReturning(200, {
      canManage: true,
      configured: false,
      providerCount: 0,
      searchConfigured: false,
      updatedAt: null,
      updatedBy: null,
    });
    expect((await fetchSharedAccess('tok', { fetchImpl: read.fetchImpl })).canManage).toBe(true);
    expect(read.calls[0].input).toBe('/v1/shared-access');

    const wrote = fetchReturning(200, { providerCount: 2, searchConfigured: true });
    const result = await publishSharedAccess('tok', { fetchImpl: wrote.fetchImpl });
    expect(result).toEqual({ providerCount: 2, searchConfigured: true });
    expect((wrote.calls[0].init?.method ?? 'GET')).toBe('PUT');
  });

  it('shares a resource with a typed account name, includes the conversation for assets', async () => {
    const { fetchImpl, calls } = fetchReturning(201, {
      share: {
        id: 's1',
        ownerId: 'ama',
        kind: 'asset',
        resourceId: 'a1',
        conversationId: 'c1',
        granteeId: 'bo',
        permission: 'read',
        title: 'Answer',
        bodyChars: 3,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await createShare(
      'tok',
      { kind: 'asset', resourceId: 'a1', conversationId: 'c1', grantee: 'bo' },
      { fetchImpl },
    );
    expect(calls[0].input).toBe('/v1/shares');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      kind: 'asset',
      resourceId: 'a1',
      conversationId: 'c1',
      grantee: 'bo',
    });
  });

  it('reads a received share and imports it', async () => {
    const read = fetchReturning(200, {
      share: {
        id: 's1',
        ownerId: 'ama',
        kind: 'note',
        resourceId: 'n1',
        conversationId: null,
        granteeId: 'bo',
        permission: 'read',
        title: 'Trip',
        bodyChars: 5,
        createdAt: 1,
        updatedAt: 1,
        body: 'hello',
        meta: null,
      },
    });
    const detail = await readReceivedShare('tok', 's1', { fetchImpl: read.fetchImpl });
    expect(detail.body).toBe('hello');
    expect(read.calls[0].input).toBe('/v1/shares/received/s1');

    const imported = fetchReturning(201, { imported: { kind: 'note', id: 'n2' } });
    expect(await importShare('tok', 's1', { fetchImpl: imported.fetchImpl })).toEqual({
      kind: 'note',
      id: 'n2',
    });
    expect((imported.calls[0].init?.method ?? 'GET')).toBe('POST');
  });
});
