/**
 * OpenAI-compatible client tests (PLAN-M1 gateway, TDD 1-5):
 * header discipline (no x-stainless-*, neutral UA, correct Bearer), SSE
 * fixture -> delta/usage/done, safe error mapping (401/404/429/other/
 * timeouts), URL building when the endpoint already ends in /v1, and
 * listModels parsing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { ServerResponse } from 'node:http';
import type { ChatEvent, ChatRequest } from '@partner/shared';
import { createOpenAICompatibleClient } from '../../src/gateway/openaiCompatible.js';
import { startHttpServer } from '../support/server.js';
import type { TestServer } from '../support/server.js';

const KEY = 'sk-test-waf-key-123456';
const up: TestServer[] = [];

async function captureServer(
  handler: (req: Parameters<Parameters<typeof startHttpServer>[0]>[0], res: ServerResponse) => void,
): Promise<TestServer> {
  const s = await startHttpServer(handler);
  up.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(up.splice(0).map((s) => s.close()));
});

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function chatRequest(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return { model: 'gpt-4o', messages: [{ role: 'user', content: 'hello' }], ...overrides };
}

describe('header discipline (api.ne1.dev WAF fix)', () => {
  it('sends ONLY controlled headers: Bearer auth, neutral UA, never x-stainless-*', async () => {
    let captured: Record<string, string | string[] | undefined> | undefined;
    const s = await captureServer((req, res) => {
      captured = { ...req.headers };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end('data: [DONE]\n\n');
    });
    const client = createOpenAICompatibleClient({ endpoint: s.base, apiKey: KEY });
    const events = await collect(client.chatStream(chatRequest()));

    if (captured === undefined) throw new Error('upstream saw no request');
    expect(captured.authorization).toBe(`Bearer ${KEY}`);
    expect(captured['user-agent']).toBe('partner-core/0.1');
    expect(captured['content-type']).toContain('application/json');
    expect(captured.accept).toContain('text/event-stream');
    const keys = Object.keys(captured);
    expect(keys.some((k) => k.toLowerCase().startsWith('x-stainless'))).toBe(false);
    expect(keys.some((k) => k.toLowerCase().startsWith('stainless'))).toBe(false);
    expect(keys.some((k) => k.toLowerCase().includes('openai'))).toBe(false);
    // No upstream error is ever raised on a healthy [DONE] stream.
    expect(events).toEqual([{ type: 'done', model: 'gpt-4o', latencyMs: expect.any(Number) }]);
  });

  it('builds URLs correctly when the endpoint already ends in /v1', async () => {
    const paths: string[] = [];
    const s = await captureServer((req, res) => {
      paths.push(req.url ?? '');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
    });
    const client = createOpenAICompatibleClient({ endpoint: `${s.base}/v1/`, apiKey: KEY });
    await collect(client.chatStream(chatRequest()));
    await client.listModels();
    expect(paths).toContain('/v1/chat/completions');
    expect(paths).toContain('/v1/models');
  });
});

describe('SSE streaming', () => {
  it('yields delta chunks then a usage event then done', async () => {
    const s = await captureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"id":"1","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}\n\n');
      res.write('data: {"id":"1","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}\n\n');
      res.write(
        'data: {"id":"2","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":7,"total_tokens":19}}\n\n',
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    const client = createOpenAICompatibleClient({ endpoint: s.base, apiKey: KEY });
    const events = await collect(client.chatStream(chatRequest()));

    expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'usage', 'done']);
    expect((events[0] as Extract<ChatEvent, { type: 'delta' }>).text).toBe('Hello');
    expect((events[1] as Extract<ChatEvent, { type: 'delta' }>).text).toBe(' world');
    expect(events[2]).toEqual({ type: 'usage', promptTokens: 12, completionTokens: 7, totalTokens: 19 });
    const done = events[3] as Extract<ChatEvent, { type: 'done' }>;
    expect(done.model).toBe('gpt-4o');
    expect(typeof done.latencyMs).toBe('number');
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('falls back to a whole JSON document when the server ignores stream:true', async () => {
    const s = await captureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ index: 0, message: { role: 'assistant', content: 'plain json reply' } }],
          usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
        }),
      );
    });
    const client = createOpenAICompatibleClient({ endpoint: s.base, apiKey: KEY });
    const events = await collect(client.chatStream(chatRequest()));
    expect(events.map((e) => e.type)).toEqual(['delta', 'usage', 'done']);
    expect((events[0] as Extract<ChatEvent, { type: 'delta' }>).text).toBe('plain json reply');
  });
});

describe('safe upstream error mapping', () => {
  it.each([
    [401, 'invalid API key'],
    [404, 'model not found'],
    [429, 'rate limited'],
    [500, 'upstream error 500'],
  ])('HTTP %s surfaces a SAFE error message (%s)', async (status, message) => {
    const s = await captureServer((_req, res) => {
      res.writeHead(status as number, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `secret detail ${KEY}` } }));
    });
    const client = createOpenAICompatibleClient({ endpoint: s.base, apiKey: KEY });
    const events = await collect(client.chatStream(chatRequest()));
    expect(events).toEqual([{ type: 'error', message }]);
    // The upstream body (which quoted the key) must never surface.
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain('secret detail');
  });

  it('a connect timeout (headers never arrive) yields request timed out', async () => {
    // The server accepts the connection and never writes a response.
    const s = await captureServer((_req, _res) => {
      // intentionally never respond
    });
    const client = createOpenAICompatibleClient({
      endpoint: s.base,
      apiKey: KEY,
      connectTimeoutMs: 60,
      idleTimeoutMs: 60,
    });
    const events = await collect(client.chatStream(chatRequest()));
    expect(events).toEqual([{ type: 'error', message: 'request timed out' }]);
  });

  it('an idle timeout mid-stream (server stalls) surfaces request timed out', async () => {
    const s = await captureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
      // then stall forever
    });
    const client = createOpenAICompatibleClient({
      endpoint: s.base,
      apiKey: KEY,
      connectTimeoutMs: 2_000,
      idleTimeoutMs: 60,
    });
    const events = await collect(client.chatStream(chatRequest()));
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('delta');
    expect(types[types.length - 1]).toBe('error');
    expect((events[events.length - 1] as Extract<ChatEvent, { type: 'error' }>).message).toBe(
      'request timed out',
    );
  });
});

describe('listModels + health', () => {
  it('parses data[].id and tolerates an unparsable 2xx body as []', async () => {
    const s = await captureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }, { id: 'gpt-4.1-mini', extra: 1 }] }));
    });
    const client = createOpenAICompatibleClient({ endpoint: s.base, apiKey: KEY });
    await expect(client.listModels()).resolves.toEqual(['gpt-4o', 'gpt-4.1-mini']);

    const s2 = await captureServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('not json at all');
    });
    const client2 = createOpenAICompatibleClient({ endpoint: s2.base, apiKey: KEY });
    await expect(client2.listModels()).resolves.toEqual([]);
  });

  it('health reports ok=false with a safe error on 401', async () => {
    const s = await captureServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    const client = createOpenAICompatibleClient({ endpoint: s.base, apiKey: KEY });
    const health = await client.health();
    expect(health.ok).toBe(false);
    expect(health.error).toBe('invalid API key');
    expect(typeof health.latencyMs).toBe('number');
  });
});
