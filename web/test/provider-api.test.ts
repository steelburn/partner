import { describe, expect, it } from 'vitest';
import {
  ApiRequestError,
  asChatEvent,
  createProvider,
  deleteProvider,
  listProviders,
  setProviderKey,
  testProvider,
  type FetchLike,
} from '../src/lib/api.js';
import type { ProviderSummary } from '@partner/shared';

const TOKEN = 'tok-secret';

function providerSummary(overrides: Partial<ProviderSummary> = {}): ProviderSummary {
  return {
    id: 'p-1',
    name: 'My provider',
    kind: 'openai-compatible',
    source: 'manual',
    endpoint: 'https://api.ne1.dev/v1',
    defaultModels: [],
    enabled: true,
    budgetCents: null,
    createdAt: 1,
    updatedAt: 1,
    health: { ok: false, latencyMs: null, error: null, models: [], checkedAt: null },
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordFetch(fn: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(fn(input, init));
  };
  return { fetchImpl, calls };
}

describe('provider API', () => {
  it('listProviders GETs /v1/providers with the Bearer token and parses the envelope', async () => {
    const list = [providerSummary(), providerSummary({ id: 'p-2', name: 'Other' })];
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ providers: list }));
    const result = await listProviders(TOKEN, { fetchImpl });
    expect(result).toEqual(list);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/v1/providers');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(calls[0]?.init?.body).toBeUndefined();
    // Profiles never carry key material (wire contract) — the parsed result
    // contains exactly the ProviderSummary keys.
    expect(Object.keys(result[0] ?? {})).not.toContain('key');
    expect(Object.keys(result[0] ?? {})).not.toContain('keyRef');
  });

  it('listProviders tolerates a bare-array response', async () => {
    const list = [providerSummary()];
    const { fetchImpl } = recordFetch(() => jsonResponse(list));
    const result = await listProviders(TOKEN, { fetchImpl });
    expect(result).toEqual(list);
  });

  it('listProviders rejects an unexpected body shape', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ items: [] }));
    await expect(listProviders(TOKEN, { fetchImpl })).rejects.toThrow(
      'unexpected shape',
    );
  });

  it('listProviders throws ApiRequestError(401) when the session is gone', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'no session' }, 401));
    await expect(listProviders(TOKEN, { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 401,
    });
  });

  it('createProvider POSTs the ProviderInput and parses the 201 profile', async () => {
    const created = providerSummary({ name: 'Ne1', endpoint: 'https://api.ne1.dev/v1', defaultModels: ['gpt-4o'], budgetCents: 250 });
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(created, 201));
    const result = await createProvider(TOKEN, {
      name: 'Ne1',
      endpoint: 'https://api.ne1.dev/v1',
      defaultModels: ['gpt-4o'],
      budgetCents: 250,
    }, { fetchImpl });
    expect(result).toEqual(created);
    expect(calls[0]?.input).toBe('/v1/providers');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      name: 'Ne1',
      endpoint: 'https://api.ne1.dev/v1',
      defaultModels: ['gpt-4o'],
      budgetCents: 250,
    });
  });

  it('createProvider maps a 400 to the readable server message', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'unsupported kind (v1: openai-compatible)' } }, 400),
    );
    await expect(
      createProvider(TOKEN, { name: 'x', endpoint: 'https://x.example/v1', kind: 'anthropic' }, { fetchImpl }),
    ).rejects.toMatchObject({ name: 'ApiRequestError', status: 400 });
  });

  it('setProviderKey POSTs the key to /:id/key and resolves undefined on 204 (no echo)', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    const result = await setProviderKey(TOKEN, 'p-1', 'sk-abc', { fetchImpl });
    expect(result).toBeUndefined();
    expect(calls[0]?.input).toBe('/v1/providers/p-1/key');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ key: 'sk-abc' });
  });

  it('setProviderKey URL-encodes the provider id and throws on non-204', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response('missing', { status: 404 }));
    await expect(setProviderKey(TOKEN, 'a/b c', 'k', { fetchImpl })).rejects.toMatchObject({
      status: 404,
    });
    expect(calls[0]?.input).toBe('/v1/providers/a%2Fb%20c/key');
  });

  it('deleteProvider DELETEs /:id and resolves undefined on 204', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    const result = await deleteProvider(TOKEN, 'p-1', { fetchImpl });
    expect(result).toBeUndefined();
    expect(calls[0]?.input).toBe('/v1/providers/p-1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('deleteProvider throws ApiRequestError when the server refuses', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'not found' }, 404));
    await expect(deleteProvider(TOKEN, 'p-missing', { fetchImpl })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });

  it('testProvider POSTs /:id/test and returns the refreshed profile', async () => {
    const refreshed = providerSummary({
      defaultModels: ['gpt-4o'],
      health: { ok: true, latencyMs: 120, error: null, models: ['gpt-4o'], checkedAt: 5 },
    });
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(refreshed));
    const result = await testProvider(TOKEN, 'p-1', { fetchImpl });
    expect(result).toEqual(refreshed);
    expect(calls[0]?.input).toBe('/v1/providers/p-1/test');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBeUndefined();
  });

  it('testProvider surfaces upstream failure messages on non-2xx', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'upstream refused' }, 502));
    await expect(testProvider(TOKEN, 'p-1', { fetchImpl })).rejects.toMatchObject({
      status: 502,
      message: 'upstream refused',
    });
  });
});

describe('asChatEvent budget_reached', () => {
  it('parses a well-formed budget_reached event including null limits', () => {
    const value = {
      type: 'budget_reached',
      message: 'Session budget reached',
      spentCents: 12,
      limitCents: 50,
      requests: 4,
      limitRequests: null,
    };
    expect(asChatEvent(value)).toEqual(value);
    const nullLimits = { ...value, limitCents: null, limitRequests: null };
    expect(asChatEvent(nullLimits)).toEqual(nullLimits);
  });

  it('is ignore-safe: malformed budget_reached frames yield null, not a crash', () => {
    expect(asChatEvent({ type: 'budget_reached', message: 'x', spentCents: 1 })).toBeNull();
    expect(asChatEvent({ type: 'budget_reached', spentCents: 1, requests: 1 })).toBeNull();
    expect(asChatEvent({ type: 'budget_reached', message: 5, spentCents: 1, requests: 1 })).toBeNull();
    // Unknown members are tolerated; the known members drive acceptance.
    expect(
      asChatEvent({
        type: 'budget_reached',
        message: 'ok',
        spentCents: 1,
        requests: 1,
        extra: 'ignored',
      }),
    ).toEqual({
      type: 'budget_reached',
      message: 'ok',
      spentCents: 1,
      limitCents: null,
      requests: 1,
      limitRequests: null,
    });
  });
});
