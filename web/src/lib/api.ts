/**
 * Client for the Partner core's /v1 HTTP surface (M0 scope).
 *
 * All requests are same-origin (dev: Vite proxy '/v1' -> 127.0.0.1:4390;
 * prod: the core serves this SPA). The pairing token is sent only as the
 * `Authorization: Bearer …` header. No URL query parameters, no cookies,
 * no console output ever carry the token.
 */

import type { ChatEvent } from '@partner/shared';
import { parseSseStream } from './sse.js';

const PAIR_PATH = '/v1/pair';
const CHAT_PATH = '/v1/chat';
const DEMO_PAIR_CODE_PATH = '/v1/dev/pair-code';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Thrown for non-2xx HTTP responses; carries the HTTP status. */
export class ApiRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
  }
}

export interface PairResult {
  token: string;
}

/** Parse the session token out of an unknown pairing response body. */
function readToken(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const value = (body as Record<string, unknown>).token;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Pull a human message out of common JSON error shapes. */
function extractMessage(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.error === 'object' && obj.error !== null) {
    const err = obj.error as Record<string, unknown>;
    if (typeof err.message === 'string' && err.message.length > 0) return err.message;
  }
  if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error;
  if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
  return null;
}

/** Best-effort error text from a failed response body (capped, sanitized). */
async function readErrorMessage(response: Response): Promise<string> {
  let text = '';
  try {
    text = (await response.text()).trim();
  } catch {
    return `Request failed (${response.status}).`;
  }
  if (text.length === 0) return `Request failed (${response.status}).`;
  try {
    const parsed: unknown = JSON.parse(text);
    const message = extractMessage(parsed);
    if (message) return message.length <= 280 ? message : `${message.slice(0, 280)}…`;
  } catch {
    // Not JSON — fall through to the raw (capped) text.
  }
  return text.length <= 280 ? text : `${text.slice(0, 280)}…`;
}

/**
 * Exchange a 6-digit pairing code for a session token.
 *
 * Throws ApiRequestError on non-2xx (callers map 401/423/429 to friendly
 * copy) and lets transport errors propagate.
 */
export async function requestPair(
  code: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<PairResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(PAIR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new Error('network');
  }
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ApiRequestError(response.status, 'Pairing response was not valid JSON.');
  }
  const token = readToken(body);
  if (token === null) {
    throw new ApiRequestError(response.status, 'Pairing response did not include a session token.');
  }
  return { token };
}

export type DemoPairCodeResult =
  | { ok: true; code: string }
  | { ok: false; notDemo: boolean; status: number | null; message: string };

/**
 * Fetch the demo pairing code. The endpoint exists only when the core runs
 * in demo mode (DEMO_MODE=1); a 404 means "core not in demo mode".
 */
export async function fetchDemoPairCode(
  options: { fetchImpl?: FetchLike } = {},
): Promise<DemoPairCodeResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(DEMO_PAIR_CODE_PATH, {
      method: 'GET',
      headers: { accept: 'application/json' },
    });
  } catch {
    return { ok: false, notDemo: false, status: null, message: 'Could not reach the Partner core.' };
  }
  if (response.status === 404) {
    return { ok: false, notDemo: true, status: 404, message: 'Core not in demo mode.' };
  }
  if (!response.ok) {
    return { ok: false, notDemo: false, status: response.status, message: await readErrorMessage(response) };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, notDemo: false, status: response.status, message: 'Demo code response was not valid JSON.' };
  }
  if (typeof body !== 'object' || body === null) {
    return { ok: false, notDemo: false, status: response.status, message: 'Demo code response was empty.' };
  }
  const code = (body as Record<string, unknown>).code;
  if (typeof code !== 'string' || code.length === 0) {
    return { ok: false, notDemo: false, status: response.status, message: 'Demo code response did not include a code.' };
  }
  return { ok: true, code };
}

/**
 * Adapt a fetch ReadableStream into an async iterable of byte chunks (the
 * DOM lib's ReadableStream is not typed as AsyncIterable).
 */
async function* streamChunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Validate that an arbitrary JSON value matches the shared ChatEvent union. */
export function asChatEvent(value: unknown): ChatEvent | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  switch (v.type) {
    case 'delta':
      return typeof v.text === 'string' ? { type: 'delta', text: v.text } : null;
    case 'usage': {
      const promptTokens = v.promptTokens;
      const completionTokens = v.completionTokens;
      const totalTokens = v.totalTokens;
      return typeof promptTokens === 'number' &&
        typeof completionTokens === 'number' &&
        typeof totalTokens === 'number'
        ? { type: 'usage', promptTokens, completionTokens, totalTokens }
        : null;
    }
    case 'done':
      return typeof v.model === 'string' && typeof v.latencyMs === 'number'
        ? { type: 'done', model: v.model, latencyMs: v.latencyMs }
        : null;
    case 'error':
      return typeof v.message === 'string' ? { type: 'error', message: v.message } : null;
    default:
      return null;
  }
}

export type StreamChatResult =
  | { ok: true }
  | { ok: false; status: number | null; unauthorized: boolean; message: string };

export interface StreamChatOptions {
  token: string;
  content: string;
  /** Dispatched as each SSE frame of the chat stream arrives. */
  onEvent: (event: ChatEvent) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/**
 * POST /v1/chat and consume the SSE stream. One user message per call (M0
 * has no server-side conversation state). Returns after the stream ends.
 */
export async function streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
  const { token, content, onEvent, signal, fetchImpl = fetch } = options;
  const response = await fetchImpl(CHAT_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ messages: [{ role: 'user', content }] }),
    signal,
  });

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      unauthorized: response.status === 401 || response.status === 403,
      message: await readErrorMessage(response),
    };
  }
  if (response.body === null) {
    return { ok: false, status: response.status, unauthorized: false, message: 'The stream was empty.' };
  }

  for await (const frame of parseSseStream(streamChunks(response.body))) {
    if (frame.data === '[DONE]') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame.data);
    } catch {
      continue; // Ignore non-JSON frames defensively.
    }
    const event = asChatEvent(parsed);
    if (event) onEvent(event);
  }
  return { ok: true };
}
