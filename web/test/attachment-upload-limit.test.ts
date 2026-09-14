/**
 * R7 — the SPA learns the attachment cap before it uploads.
 *
 * Why the client needs it: the core refuses an over-size body with a 413, but a
 * phone that has already pushed megabytes at the server may see a network error
 * instead of that response. So the cap is published on the public /v1/health and
 * the composer refuses the file locally, quoting the same sentence the core
 * would have sent (`attachmentTooLargeMessage`).
 */
import { describe, expect, it } from 'vitest';
import { fetchUploadLimit, type FetchLike } from '../src/lib/attachments.js';

function healthFetch(body: unknown, calls: string[] = [], status = 200): FetchLike {
  return (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as FetchLike;
}

describe('fetchUploadLimit', () => {
  it('reads the cap from the public health route (no credential, no URL clutter)', async () => {
    const calls: string[] = [];
    const limit = await fetchUploadLimit({
      fetchImpl: healthFetch({ status: 'ok', maxUploadBytes: 8 * 1024 * 1024 }, calls),
    });
    expect(limit).toBe(8 * 1024 * 1024);
    expect(calls).toEqual(['/v1/health']);
  });

  it('honours a tightened cap', async () => {
    const limit = await fetchUploadLimit({ fetchImpl: healthFetch({ maxUploadBytes: 1024 }) });
    expect(limit).toBe(1024);
  });

  it('reports "not stated" for a core that does not publish one', async () => {
    // An older core: the pre-check is skipped and its own 413 answers.
    const limit = await fetchUploadLimit({ fetchImpl: healthFetch({ status: 'ok' }) });
    expect(limit).toBeNull();
  });

  it('reports "not stated" for a nonsense value rather than trusting it', async () => {
    for (const value of [0, -1, Number.NaN, '8MB', null]) {
      const limit = await fetchUploadLimit({ fetchImpl: healthFetch({ maxUploadBytes: value }) });
      expect(limit).toBeNull();
    }
  });

  it('rejects when health itself fails (the caller decides; nothing is cached)', async () => {
    await expect(
      fetchUploadLimit({ fetchImpl: healthFetch({ error: 'nope' }, [], 500) }),
    ).rejects.toThrow();
  });
});
