/**
 * OpenAI-compatible gateway client (M1, PLAN-M1.md "Gateway design").
 *
 * The only ProviderClient implementation in v1. Talks to any
 * OpenAI-compatible base URL (`{endpoint}/chat/completions`, `{endpoint}/models`)
 * with strict header discipline:
 *
 *  - the client sends ONLY the headers it controls: `content-type`,
 *    `accept`, `authorization` and a neutral `user-agent: partner-core/0.1`;
 *  - it NEVER emits OpenAI-SDK telemetry (`x-stainless-*`) or the OpenAI
 *    user-agent — the api.ne1.dev WAF fix (PLAN §2), so no local relay is
 *    needed;
 *  - the key only ever travels inside the `Authorization` header and is never
 *    placed in an error message, event, log, or audit row.
 *
 * Transport: SSE `data:` lines with `stream_options.include_usage`, an
 * `AbortController` connect timeout (default 15s) and idle timeout (default
 * 60s), and typed {@link UpstreamError} mapping that converts to SAFE
 * `ChatEvent {type:'error'}` messages.
 */

import type {
  ChatEvent,
  ChatRequest,
  HealthReport,
  ProviderClient,
} from '@partner/shared';

export const USER_AGENT = 'partner-core/0.1';
export const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export type UpstreamErrorCode =
  | 'invalid_key'
  | 'model_not_found'
  | 'rate_limited'
  | 'timeout'
  | 'network'
  | 'http';

export class UpstreamError extends Error {
  readonly code: UpstreamErrorCode;
  readonly status: number | null;

  constructor(code: UpstreamErrorCode, status: number | null = null) {
    super(upstreamMessageForCode(code, status));
    this.name = 'UpstreamError';
    this.code = code;
    this.status = status;
  }
}

/** Safe, human-facing messages — never echo upstream bodies or auth material. */
function upstreamMessageForCode(code: UpstreamErrorCode, status: number | null): string {
  switch (code) {
    case 'invalid_key':
      return 'invalid API key';
    case 'model_not_found':
      return 'model not found';
    case 'rate_limited':
      return 'rate limited';
    case 'timeout':
      return 'request timed out';
    case 'network':
      return 'upstream request failed';
    case 'http':
      return `upstream error ${status ?? 'unknown'}`;
  }
}

/** Map an HTTP status (the only thing we ever read from a failed response). */
export function upstreamMessageForStatus(status: number): string {
  if (status === 401) return 'invalid API key';
  if (status === 404) return 'model not found';
  if (status === 429) return 'rate limited';
  return `upstream error ${status}`;
}

function upstreamForStatus(status: number): UpstreamError {
  const code: UpstreamErrorCode =
    status === 401 ? 'invalid_key' : status === 404 ? 'model_not_found' : status === 429 ? 'rate_limited' : 'http';
  return new UpstreamError(code, status);
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function classify(err: unknown, timedOut: boolean): UpstreamError {
  if (err instanceof UpstreamError) return err;
  if (timedOut || isAbortLike(err)) return new UpstreamError('timeout');
  return new UpstreamError('network');
}

/** Safe message for any thrown value (used by health/probe callers). */
export function safeUpstreamMessage(err: unknown): string {
  if (err instanceof UpstreamError) return err.message;
  return 'provider_stream_failed';
}

export interface OpenAICompatibleOptions {
  /** OpenAI-compatible base URL; trailing slashes are tolerated. */
  endpoint: string;
  /** Bearer key — used ONLY in the Authorization header. */
  apiKey: string;
  /** Connect timeout (default 15s): headers must arrive within this. */
  connectTimeoutMs?: number;
  /** Idle timeout (default 60s): no body bytes within this aborts the stream. */
  idleTimeoutMs?: number;
  /** Injectable fetch (tests); defaults to the global. */
  fetchImpl?: typeof fetch;
}

export interface OpenAICompatibleClient extends ProviderClient {
  chatStream(req: ChatRequest): AsyncGenerator<ChatEvent>;
  health(): Promise<HealthReport>;
  /** GET {endpoint}/models -> data[].id; [] on an unparsable 2xx body. */
  listModels(): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// URL + header helpers
// ---------------------------------------------------------------------------

function withBase(endpoint: string): string {
  return endpoint.replace(/\/+$/, '');
}

function chatCompletionsUrl(endpoint: string): string {
  return `${withBase(endpoint)}/chat/completions`;
}

function modelsUrl(endpoint: string): string {
  return `${withBase(endpoint)}/models`;
}

/** The headers this client controls — and ONLY these. Never x-stainless-*. */
function requestHeaders(apiKey: string, accept: string): Headers {
  const headers = new Headers();
  headers.set('content-type', 'application/json');
  headers.set('accept', accept);
  headers.set('authorization', `Bearer ${apiKey}`);
  headers.set('user-agent', USER_AGENT);
  return headers;
}

// ---------------------------------------------------------------------------
// Payload parsing helpers
// ---------------------------------------------------------------------------

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function textOfChoice(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const choice = raw as Record<string, unknown>;
  const message = choice.message;
  if (message !== null && typeof message === 'object') {
    const m = message as Record<string, unknown>;
    if (typeof m.content === 'string' && m.content !== '') return m.content;
  }
  const delta = choice.delta;
  if (delta !== null && typeof delta === 'object') {
    const d = delta as Record<string, unknown>;
    if (typeof d.content === 'string' && d.content !== '') return d.content;
  }
  return null;
}

function usageEvent(raw: unknown): ChatEvent | null {
  if (raw === null || typeof raw !== 'object') return null;
  const usage = (raw as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== 'object') return null;
  const u = usage as Record<string, unknown>;
  const promptTokens = num(u.prompt_tokens, 0);
  const completionTokens = num(u.completion_tokens, 0);
  const totalTokens = num(u.total_tokens, promptTokens + completionTokens);
  return { type: 'usage', promptTokens, completionTokens, totalTokens };
}

/** Turn one decoded chunk/line payload into safe ChatEvents. */
function eventsFromPayload(raw: unknown): ChatEvent[] {
  if (raw === null || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  // A mid-stream upstream error object — surface a SAFE generic message.
  if (obj.error !== undefined && obj.error !== null) {
    return [{ type: 'error', message: 'upstream request failed' }];
  }
  const events: ChatEvent[] = [];
  const choices = Array.isArray(obj.choices) ? obj.choices : [];
  const text = textOfChoice(choices[0]);
  if (text !== null) events.push({ type: 'delta', text });
  const usage = usageEvent(obj);
  if (usage !== null) events.push(usage);
  return events;
}

/** One SSE data line -> events + whether the stream is done. */
function handleSseLine(line: string): { events: ChatEvent[]; end: boolean } {
  const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!trimmed.startsWith('data:')) return { events: [], end: false };
  let payload = trimmed.slice('data:'.length);
  if (payload.startsWith(' ')) payload = payload.slice(1);
  if (payload.trim() === '[DONE]') return { events: [], end: true };
  try {
    return { events: eventsFromPayload(JSON.parse(payload) as unknown), end: false };
  } catch {
    return { events: [], end: false };
  }
}

export function createOpenAICompatibleClient(options: OpenAICompatibleOptions): OpenAICompatibleClient {
  const endpoint = options.endpoint;
  const apiKey = options.apiKey;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  function chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
    return (async function* chatStreamGen(): AsyncGenerator<ChatEvent> {
      const started = Date.now();
      const controller = new AbortController();
      let timedOut = false;
      const connectTimer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, connectTimeoutMs);

      try {
        const res = await fetchImpl(chatCompletionsUrl(endpoint), {
          method: 'POST',
          headers: requestHeaders(apiKey, 'text/event-stream'),
          body: JSON.stringify({
            model: req.model,
            messages: req.messages,
            stream: true,
            stream_options: { include_usage: true },
          }),
          signal: controller.signal,
        });
        clearTimeout(connectTimer);

        if (!res.ok) {
          // Non-2xx: the status alone is safe; the body is never read/echoed.
          yield { type: 'error', message: upstreamMessageForStatus(res.status) };
          return;
        }
        if (!res.body) {
          yield { type: 'error', message: 'upstream request failed' };
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let idleTimer: NodeJS.Timeout | undefined;
        const armIdle = (): void => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, idleTimeoutMs);
        };

        const readAll = async (): Promise<string> => {
          let out = '';
          for (;;) {
            armIdle();
            const { done, value } = await reader.read();
            if (done) break;
            out += decoder.decode(value, { stream: true });
          }
          return out + decoder.decode();
        };

        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        if (contentType.includes('application/json')) {
          // The upstream ignored stream:true and returned one JSON document.
          const text = await readAll();
          let payload: unknown;
          try {
            payload = JSON.parse(text) as unknown;
          } catch {
            yield { type: 'error', message: 'upstream request failed' };
            return;
          }
          for (const event of eventsFromPayload(payload)) yield event;
          yield { type: 'done', model: req.model, latencyMs: Date.now() - started };
          return;
        }

        // SSE parse: process complete lines as they arrive; keep a partial
        // line in the buffer across chunk boundaries.
        let buffer = '';
        let sawDone = false;
        try {
          for (;;) {
            armIdle();
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let nl = buffer.indexOf('\n');
            while (nl !== -1) {
              const line = buffer.slice(0, nl);
              buffer = buffer.slice(nl + 1);
              const { events, end } = handleSseLine(line);
              for (const event of events) yield event;
              if (end) {
                sawDone = true;
                break;
              }
              nl = buffer.indexOf('\n');
            }
            if (sawDone) break;
          }
          if (!sawDone && buffer.trim() !== '') {
            const { events } = handleSseLine(buffer);
            for (const event of events) yield event;
          }
        } finally {
          clearTimeout(idleTimer);
        }

        yield { type: 'done', model: req.model, latencyMs: Date.now() - started };
      } catch (err) {
        // Connect/idle timeouts and network failures -> safe error event.
        yield { type: 'error', message: classify(err, timedOut).message };
      } finally {
        clearTimeout(connectTimer);
        controller.abort();
      }
    })();
  }

  async function listModels(): Promise<string[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), connectTimeoutMs);
    try {
      const res = await fetchImpl(modelsUrl(endpoint), {
        method: 'GET',
        headers: requestHeaders(apiKey, 'application/json'),
        signal: controller.signal,
      });
      if (!res.ok) throw upstreamForStatus(res.status);
      const text = await res.text();
      try {
        const obj = JSON.parse(text) as Record<string, unknown>;
        const data = Array.isArray(obj.data) ? obj.data : [];
        const ids: string[] = [];
        for (const entry of data) {
          const id = (entry as { id?: unknown } | null)?.id;
          if (typeof id === 'string' && id !== '') ids.push(id);
        }
        return ids;
      } catch {
        return [];
      }
    } catch (err) {
      throw classify(err, false);
    } finally {
      clearTimeout(timer);
    }
  }

  async function health(): Promise<HealthReport> {
    const started = Date.now();
    try {
      await listModels();
      return { ok: true, latencyMs: Date.now() - started };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - started, error: safeUpstreamMessage(err) };
    }
  }

  return { chatStream, listModels, health };
}
