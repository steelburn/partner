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
import { fetchUploadCaps, fetchUploadLimit, type FetchLike } from '../src/lib/attachments.js';

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

/**
 * M24 — the composer needs BOTH budgets. Storing a file and sending a photo to
 * a model are different limits, and the SPA previously only knew the first: it
 * encoded a phone photo to 8 MB, uploaded it, thumbnailed it — and the turn
 * then dropped the part over 3 MB, so the persona said "no image was sent"
 * while the user could see the photo attached.
 */
describe('fetchUploadCaps', () => {
  it('reads both budgets from one health call', async () => {
    const calls: string[] = [];
    const caps = await fetchUploadCaps({
      fetchImpl: healthFetch(
        { status: 'ok', maxUploadBytes: 8 * 1024 * 1024, maxInlineImageBytes: 3 * 1024 * 1024 },
        calls,
      ),
    });
    expect(caps).toEqual({
      maxUploadBytes: 8 * 1024 * 1024,
      maxInlineImageBytes: 3 * 1024 * 1024,
    });
    expect(calls).toEqual(['/v1/health']);
  });

  it('reports a missing inline budget as "not stated" (an older core)', async () => {
    const caps = await fetchUploadCaps({
      fetchImpl: healthFetch({ maxUploadBytes: 8 * 1024 * 1024 }),
    });
    expect(caps.maxUploadBytes).toBe(8 * 1024 * 1024);
    expect(caps.maxInlineImageBytes).toBeNull();
  });

  it('keeps fetchUploadLimit answering with the STORE cap', async () => {
    const caps = { maxUploadBytes: 2 * 1024 * 1024, maxInlineImageBytes: 1024 };
    const limit = await fetchUploadLimit({ fetchImpl: healthFetch(caps) });
    expect(limit).toBe(2 * 1024 * 1024);
  });
});
