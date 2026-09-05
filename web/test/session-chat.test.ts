import { describe, expect, it } from 'vitest';
import {
  normalizeChatEndpoint,
  streamSessionChat,
  validateSessionEndpoint,
  type SessionChatMessage,
} from '../src/lib/session-chat.js';

const KEY = 'sk-live-ABCDEFGH123456789012';
const MODEL = 'gpt-4o-mini';

function sseBody(frames: string[]): Response {
  const body = frames.join('\n') + '\n\n';
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
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

describe('normalizeChatEndpoint / validateSessionEndpoint', () => {
  it('normalizes bare bases to .../v1 and strips trailing slashes', () => {
    expect(normalizeChatEndpoint('https://api.ne1.dev')).toBe('https://api.ne1.dev/v1');
    expect(normalizeChatEndpoint('https://api.ne1.dev/')).toBe('https://api.ne1.dev/v1');
    expect(normalizeChatEndpoint('https://api.ne1.dev/v1')).toBe('https://api.ne1.dev/v1');
    expect(normalizeChatEndpoint('  http://localhost:8080/v1/  ')).toBe('http://localhost:8080/v1');
  });

  it('validates shape only (never content)', () => {
    expect(validateSessionEndpoint('')).toBe('Endpoint is required.');
    expect(validateSessionEndpoint('not a url')).toContain('https://');
    expect(validateSessionEndpoint('https://x.dev/v1')).toBeNull();
  });
});

describe('streamSessionChat', () => {
  const messages: SessionChatMessage[] = [{ role: 'user', content: 'hi' }];

  it('POSTs to /chat/completions with the minimal header set and streams deltas', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      sseBody([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: [DONE]',
      ]),
    );
    const deltas: string[] = [];
    const { outcome, assistant } = await streamSessionChat(
      { fetchImpl, endpoint: 'https://api.ne1.dev/v1', key: KEY, model: MODEL, messages },
      (d) => deltas.push(d),
    );
    expect(outcome).toEqual({ ok: true });
    expect(assistant).toBe('Hello');
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(calls[0]?.input).toBe('https://api.ne1.dev/v1/chat/completions');
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    // Minimal header set: content-type/accept/authorization ONLY — no
    // telemetry or extra fields ever leave this client.
    expect(Object.keys(headers).sort()).toEqual(['accept', 'authorization', 'content-type']);
    const body = JSON.parse(String(calls[0]?.init?.body)) as { model: string; stream: boolean };
    expect(body).toMatchObject({ model: MODEL, stream: true });
    // The key never rides in the URL.
    expect(String(calls[0]?.input)).not.toContain(KEY);
  });

  it('maps 401/429 to readable errors that never echo the key', async () => {
    const { fetchImpl } = recordFetch(
      () =>
        new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const { outcome, assistant } = await streamSessionChat(
      { fetchImpl, endpoint: 'https://x.dev/v1', key: KEY, model: MODEL, messages },
      () => undefined,
    );
    expect(outcome.kind).toBe('http');
    expect(outcome.status).toBe(401);
    expect(assistant).toBe('');
    expect(JSON.stringify(outcome.message)).not.toContain(KEY);
  });

  it('maps a browser-blocked fetch (CORS/network) to the readable hint', async () => {
    const { fetchImpl } = recordFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const { outcome } = await streamSessionChat(
      { fetchImpl, endpoint: 'https://blocked.dev/v1', key: KEY, model: MODEL, messages },
      () => undefined,
    );
    expect(outcome.kind).toBe('cors');
    expect(outcome.message).toContain('Access-Control-Allow-Origin');
    expect(outcome.message).not.toContain(KEY);
  });

  it('treats an abort as a clean stop (no error thrown)', async () => {
    const controller = new AbortController();
    const { fetchImpl } = recordFetch(() => {
      controller.abort();
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const { outcome } = await streamSessionChat(
      { fetchImpl, endpoint: 'https://x.dev/v1', key: KEY, model: MODEL, messages, signal: controller.signal },
      () => undefined,
    );
    expect(outcome.kind).toBe('aborted');
  });

  it('flushes a final unterminated data frame (no trailing newline)', async () => {
    // The endpoint closes cleanly after a data line WITHOUT '\n\n' — the
    // last delta must still arrive.
    const body = 'data: {"choices":[{"delta":{"content":"tail"}}]}';
    const { fetchImpl } = recordFetch(() =>
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    const deltas: string[] = [];
    const { outcome, assistant } = await streamSessionChat(
      { fetchImpl, endpoint: 'https://x.dev/v1', key: KEY, model: MODEL, messages },
      (d) => deltas.push(d),
    );
    expect(outcome).toEqual({ ok: true });
    expect(assistant).toBe('tail');
    expect(deltas).toEqual(['tail']);
  });

  it('surfaces a mid-stream error frame without echoing the key', async () => {
    const { fetchImpl } = recordFetch(() =>
      sseBody([
        'data: {"choices":[{"delta":{"content":"part"}}]}',
        `data: {"error":{"message":"upstream broke with ${KEY}"}}`,
        'data: [DONE]',
      ]),
    );
    const { outcome, assistant } = await streamSessionChat(
      { fetchImpl, endpoint: 'https://x.dev/v1', key: KEY, model: MODEL, messages },
      () => undefined,
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.kind).toBe('http');
    expect(JSON.stringify(outcome.message)).not.toContain(KEY);
    expect(assistant).toBe('part');
  });
});
