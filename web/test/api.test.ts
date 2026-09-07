import { describe, expect, it } from 'vitest';
import {
  ApiRequestError,
  asChatEvent,
  createPurposeProviders,
  discoverProviderModels,
  fetchCoreHealth,
  fetchDemoPairCode,
  requestPair,
  streamChat,
  type FetchLike,
} from '../src/lib/api.js';
import type { ChatEvent } from '@partner/shared';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function streamResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
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

describe('requestPair', () => {
  it('POSTs {code} to /v1/pair and returns the token', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ token: 'tok-123' }));
    const result = await requestPair('483920', { fetchImpl });
    expect(result.token).toBe('tok-123');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/v1/pair');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: '483920' });
  });

  it('throws ApiRequestError(401) for an invalid code', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'bad code' }, 401));
    await expect(requestPair('000000', { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 401,
    });
  });

  it('throws ApiRequestError(429) for rate limiting', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({}, 429));
    await expect(requestPair('000000', { fetchImpl })).rejects.toSatisfy((e: unknown) => {
      return e instanceof ApiRequestError && e.status === 429;
    });
  });

  it('rejects a 200 whose body has no token', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ session: 'nope' }));
    await expect(requestPair('483920', { fetchImpl })).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('surfaces transport failures as a plain network error', async () => {
    const { fetchImpl } = recordFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(requestPair('483920', { fetchImpl })).rejects.toThrow('network');
  });
});

describe('fetchCoreHealth (M15)', () => {
  it('parses the demo flag from /v1/health', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ status: 'ok', demo: false, version: '0.1.0', schemaVersion: 13 }),
    );
    const health = await fetchCoreHealth({ fetchImpl });
    expect(health).toEqual({ demo: false, version: '0.1.0', schemaVersion: 13 });
    expect(calls[0]?.input).toBe('/v1/health');
  });

  it('returns null when the core is unreachable', async () => {
    const { fetchImpl } = recordFetch(() => {
      throw new Error('network down');
    });
    expect(await fetchCoreHealth({ fetchImpl })).toBeNull();
  });

  it('returns null on non-2xx or a malformed body (caller keeps neutral copy)', async () => {
    const notOk = recordFetch(() => new Response('nope', { status: 503 }));
    expect(await fetchCoreHealth({ fetchImpl: notOk.fetchImpl })).toBeNull();
    const badShape = recordFetch(() => jsonResponse({ status: 'ok' }));
    expect(await fetchCoreHealth({ fetchImpl: badShape.fetchImpl })).toBeNull();
  });
});

describe('fetchDemoPairCode', () => {
  it('returns the demo code on 200', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ code: '111222' }));
    const result = await fetchDemoPairCode({ fetchImpl });
    expect(result).toEqual({ ok: true, code: '111222' });
    expect(calls[0]?.input).toBe('/v1/dev/pair-code');
    expect(calls[0]?.init?.method).toBe('GET');
  });

  it('reports notDemo on 404', async () => {
    const { fetchImpl } = recordFetch(() => new Response('nope', { status: 404 }));
    const result = await fetchDemoPairCode({ fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.notDemo).toBe(true);
      expect(result.status).toBe(404);
    }
  });
});

describe('asChatEvent', () => {
  it('accepts exactly the shared ChatEvent union', () => {
    const valid: unknown[] = [
      { type: 'delta', text: 'hi' },
      { type: 'usage', promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      { type: 'done', model: 'demo', latencyMs: 4 },
      { type: 'error', message: 'boom' },
    ];
    for (const value of valid) expect(asChatEvent(value)).not.toBeNull();
    for (const value of [
      null,
      'nope',
      { type: 'delta', text: 5 },
      { type: 'usage', promptTokens: '1', completionTokens: 2, totalTokens: 3 },
      { type: 'unknown', text: 'x' },
      { type: 'done', model: 'demo' },
    ]) {
      expect(asChatEvent(value)).toBeNull();
    }
  });
});

describe('streamChat', () => {
  const event = (e: ChatEvent) => `data: ${JSON.stringify(e)}\n\n`;

  it('POSTs the user message with the Bearer token and delivers deltas', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      streamResponse([
        event({ type: 'delta', text: 'Hel' }),
        event({ type: 'delta', text: 'lo' }),
        event({ type: 'usage', promptTokens: 4, completionTokens: 5, totalTokens: 9 }),
        event({ type: 'done', model: 'demo', latencyMs: 12 }),
      ]),
    );

    const received: ChatEvent[] = [];
    const result = await streamChat({
      token: 'tok-secret',
      content: 'hello',
      onEvent: (e) => received.push(e),
      fetchImpl,
    });

    expect(result).toEqual({ ok: true });
    expect(calls[0]?.input).toBe('/v1/chat');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({
      authorization: 'Bearer tok-secret',
      accept: 'text/event-stream',
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(received.map((e) => e.type)).toEqual(['delta', 'delta', 'usage', 'done']);
    expect(received.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text)).toEqual([
      'Hel',
      'lo',
    ]);
  });

  it('keeps streaming when frames arrive split mid-JSON', async () => {
    const frame = `data: ${JSON.stringify({ type: 'delta', text: 'split' })}\n\n`;
    const { fetchImpl } = recordFetch(() => streamResponse([frame.slice(0, 9), frame.slice(9)]));
    const received: ChatEvent[] = [];
    const result = await streamChat({
      token: 't',
      content: 'x',
      onEvent: (e) => received.push(e),
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(received).toEqual([{ type: 'delta', text: 'split' }]);
  });

  it('skips [DONE] and non-JSON frames defensively', async () => {
    const { fetchImpl } = recordFetch(() =>
      streamResponse(['data: [DONE]\n\n', 'data: not json\n\n', event({ type: 'done', model: 'm', latencyMs: 1 })]),
    );
    const received: ChatEvent[] = [];
    const result = await streamChat({
      token: 't',
      content: 'x',
      onEvent: (e) => received.push(e),
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(received).toEqual([{ type: 'done', model: 'm', latencyMs: 1 }]);
  });

  it('delivers SSE error events', async () => {
    const { fetchImpl } = recordFetch(() =>
      streamResponse([event({ type: 'error', message: 'upstream failed' })]),
    );
    const received: ChatEvent[] = [];
    const result = await streamChat({
      token: 't',
      content: 'x',
      onEvent: (e) => received.push(e),
      fetchImpl,
    });
    expect(result.ok).toBe(true);
    expect(received).toEqual([{ type: 'error', message: 'upstream failed' }]);
  });

  it('marks 401/403 responses as unauthorized without opening a stream', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'no session' }, 401));
    const result = await streamChat({ token: 'stale', content: 'x', onEvent: () => undefined, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unauthorized).toBe(true);
      expect(result.status).toBe(401);
    }
  });

  it('surfaces the server error message for other failures', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'model not configured' } }, 500),
    );
    const result = await streamChat({ token: 't', content: 'x', onEvent: () => undefined, fetchImpl });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('model not configured');
    }
  });

  it('propagates transport errors', async () => {
    const { fetchImpl } = recordFetch(() => {
      throw new TypeError('fetch failed');
    });
    await expect(
      streamChat({ token: 't', content: 'x', onEvent: () => undefined, fetchImpl }),
    ).rejects.toThrow();
  });

  it('continueTurn streams the next round with no user message (M12.6)', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      streamResponse([event({ type: 'delta', text: 'Here is what the search found.' })]),
    );
    const received: ChatEvent[] = [];
    const result = await streamChat({
      token: 'tok-secret',
      content: 'ignored',
      continueTurn: true,
      conversationId: 'conv-1',
      personaId: 'p-1',
      onEvent: (e) => received.push(e),
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    expect(received).toEqual([{ type: 'delta', text: 'Here is what the search found.' }]);
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.continueTurn).toBe(true);
    expect(body.conversationId).toBe('conv-1');
    expect(body.personaId).toBe('p-1');
    // No user message rides a resume round — the stored history is the turn.
    expect(body.messages).toEqual([]);
  });
});

describe('M13 per-turn model picker payloads', () => {
  const event = (e: ChatEvent) => `data: ${JSON.stringify(e)}\n\n`;

  it('streamChat sends providerId + model for an explicit per-turn pick', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      streamResponse([event({ type: 'done', model: 'gpt-4o', latencyMs: 3 })]),
    );
    const result = await streamChat({
      token: 'tok-secret',
      content: 'look at the photo',
      personaId: 'p-1',
      providerId: 'prov-vision',
      model: 'gpt-4o',
      onEvent: () => undefined,
      fetchImpl,
    });
    expect(result).toEqual({ ok: true });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.providerId).toBe('prov-vision');
    expect(body.model).toBe('gpt-4o');
    expect(body.personaId).toBe('p-1');
  });

  it('streamChat omits providerId when Auto (no per-turn pick)', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      streamResponse([event({ type: 'done', model: 'demo', latencyMs: 3 })]),
    );
    await streamChat({ token: 't', content: 'hi', onEvent: () => undefined, fetchImpl });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.providerId).toBeUndefined();
    expect(body.model).toBeUndefined();
  });

  it('createPurposeProviders posts endpoint+key+purposes and parses the created set', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({
        created: [{ id: 'p-vision', purpose: 'vision', defaultModels: ['gpt-4o'] }],
        models: ['gpt-4o', 'llama-3.1-8b'],
      }),
    );
    const result = await createPurposeProviders(
      'tok-secret',
      { endpoint: 'https://api.ne1.dev/v1', key: 'sk-bundle', purposes: ['vision', 'coding'] },
      { fetchImpl },
    );
    expect(result.created[0]?.purpose).toBe('vision');
    expect(calls[0]?.input).toBe('/v1/providers/purposes');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body).toEqual({
      endpoint: 'https://api.ne1.dev/v1',
      key: 'sk-bundle',
      purposes: ['vision', 'coding'],
    });
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer tok-secret' });
  });

  it('createPurposeProviders sends per-purpose model pins (first = default)', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ created: [{ id: 'p-vision', purpose: 'vision' }], models: ['gpt-4o'] }),
    );
    await createPurposeProviders(
      'tok-secret',
      {
        endpoint: 'https://api.ne1.dev/v1',
        key: 'sk-bundle',
        purposes: ['vision', 'coding'],
        modelPins: { vision: ['gpt-4o'], coding: ['deepseek-r1'] },
      },
      { fetchImpl },
    );
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.modelPins).toEqual({ vision: ['gpt-4o'], coding: ['deepseek-r1'] });
  });

  it('discoverProviderModels posts endpoint+key to discover and parses the model list', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ endpoint: 'https://api.ne1.dev/v1', models: ['gpt-4o', 'llama-3.1-8b'] }),
    );
    const result = await discoverProviderModels('tok-secret', {
      endpoint: 'https://api.ne1.dev/v1',
      key: 'sk-bundle',
    }, { fetchImpl });
    expect(result.models).toEqual(['gpt-4o', 'llama-3.1-8b']);
    expect(calls[0]?.input).toBe('/v1/providers/discover');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      endpoint: 'https://api.ne1.dev/v1',
      key: 'sk-bundle',
    });
  });
});
