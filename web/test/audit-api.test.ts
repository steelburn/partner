import { describe, expect, it } from 'vitest';
import { listAudit, type AuditEntry } from '../src/lib/audit.js';

const TOKEN = 'tok-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordFetch(fn: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ input: String(input), init });
    return Promise.resolve(fn(String(input), init));
  };
  return { calls, fetchImpl };
}

describe('listAudit', () => {
  const ENTRY: AuditEntry = {
    id: 1,
    actor: 'session',
    action: 'chat.stream',
    target: 'gpt-4o',
    details: '{"ok":true,"events":3}',
    createdAt: 1_700_000_000_000,
  };

  it('GETs /v1/audit with the filters it was given', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ entries: [ENTRY] }));
    const rows = await listAudit(TOKEN, {
      filter: { limit: 50, actor: 'session', action: 'chat', q: 'gpt' },
      fetchImpl,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe('chat.stream');
    expect(calls[0]?.input).toBe('/v1/audit?limit=50&actor=session&action=chat&q=gpt');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: `Bearer ${TOKEN}`,
      accept: 'application/json',
    });
  });

  it('omits empty filters and returns [] for an empty payload', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ entries: [] }));
    const rows = await listAudit(TOKEN, {
      filter: { actor: '', action: '', q: '' },
      fetchImpl,
    });
    expect(rows).toEqual([]);
    expect(calls[0]?.input).toBe('/v1/audit');
    expect(String(calls[0]?.input)).not.toContain(TOKEN);
  });

  it('throws ApiRequestError on an unexpected shape', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ nope: true }));
    await expect(listAudit(TOKEN, { fetchImpl })).rejects.toThrow(/unexpected shape/);
  });
});
