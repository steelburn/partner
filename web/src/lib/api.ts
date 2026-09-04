/**
 * Client for the Partner core's /v1 HTTP surface (M0 scope).
 *
 * All requests are same-origin (dev: Vite proxy '/v1' -> 127.0.0.1:4390;
 * prod: the core serves this SPA). The pairing token is sent only as the
 * `Authorization: Bearer …` header. No URL query parameters, no cookies,
 * no console output ever carry the token.
 */

import type {
  ChatEvent,
  ProviderInput,
  ProviderSummary,
  SelfServiceConnectInput,
  SelfServiceLoginKey,
} from '@partner/shared';
import { parseSseStream } from './sse.js';

const PAIR_PATH = '/v1/pair';
const CHAT_PATH = '/v1/chat';
const SESSION_PATH = '/v1/session';
const DEMO_PAIR_CODE_PATH = '/v1/dev/pair-code';
const PROVIDERS_PATH = '/v1/providers';
const SELF_SERVICE_LOGIN_KEY_PATH = '/v1/self-service/login-key';
const SELF_SERVICE_CONNECT_PATH = '/v1/self-service/connect';

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
export async function readErrorMessage(response: Response): Promise<string> {
  let text = '';
  try {
    text = (await response.text()).trim();
  } catch {
    return `Request failed (${response.status}).`;
  }
  return extractErrorMessage(text, response.status);
}

/**
 * Human error text from an already-consumed body string. Used by callers
 * that must buffer the body themselves (e.g. to sniff a broker decision
 * before falling back to the generic error). Mirrors readErrorMessage's
 * extraction + capping exactly.
 */
export function extractErrorMessage(text: string, status: number): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return `Request failed (${status}).`;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const message = extractMessage(parsed);
    if (message) return message.length <= 280 ? message : `${message.slice(0, 280)}…`;
  } catch {
    // Not JSON — fall through to the raw (capped) text.
  }
  return trimmed.length <= 280 ? trimmed : `${trimmed.slice(0, 280)}…`;
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
    case 'budget_reached': {
      // Ignore-safe: any malformed member drops the whole event (frame skipped).
      const message = v.message;
      const spentCents = v.spentCents;
      const requests = v.requests;
      if (
        typeof message !== 'string' ||
        typeof spentCents !== 'number' ||
        typeof requests !== 'number'
      ) {
        return null;
      }
      const limitCents = typeof v.limitCents === 'number' ? v.limitCents : null;
      const limitRequests = typeof v.limitRequests === 'number' ? v.limitRequests : null;
      return { type: 'budget_reached', message, spentCents, limitCents, requests, limitRequests };
    }
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

/**
 * Revoke the session server-side ("Unpair" / "Pair again"). Best-effort:
 * a 401/403 means the session is already gone, which is success here.
 */
export async function revokeSession(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SESSION_PATH, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status !== 204 && response.status !== 401 && response.status !== 403) {
    throw new ApiRequestError(response.status, 'Could not revoke the session.');
  }
}

// ---------------------------------------------------------------------------
// M1 providers & llm-self-service import (PLAN-M1.md wire spec)
//
// The pairing token travels ONLY in the Authorization header, exactly like
// every other call in this file. None of these functions accept, return, log
// or persist a provider key — setProviderKey sends it once and returns 204.
// ---------------------------------------------------------------------------

function providerPath(id: string, suffix: '' | '/key' | '/test'): string {
  return `${PROVIDERS_PATH}/${encodeURIComponent(id)}${suffix}`;
}

/** Parse a 2xx JSON body; non-2xx becomes ApiRequestError with a readable message. */
export async function expectJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new ApiRequestError(response.status, 'The response was not valid JSON.');
  }
}

/** Require a 204 (void endpoints); non-2xx becomes ApiRequestError. */
export async function expectNoContent(response: Response, action: string): Promise<void> {
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
  if (response.status !== 204) {
    throw new ApiRequestError(response.status, `${action} did not return a 204 response.`);
  }
}

/** GET /v1/providers -> all provider profiles (never keys/keyRefs). */
export async function listProviders(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProviderSummary[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(PROVIDERS_PATH, {
    method: 'GET',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  const parsed = await expectJson<unknown>(response);
  // Wire envelope: { providers: [...] }. A bare array is tolerated so the
  // client stays robust to either serialization of the same contract.
  if (Array.isArray(parsed)) return parsed as ProviderSummary[];
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    Array.isArray((parsed as { providers?: unknown }).providers)
  ) {
    return (parsed as { providers: ProviderSummary[] }).providers;
  }
  throw new ApiRequestError(response.status, 'The providers response had an unexpected shape.');
}

/** POST /v1/providers -> the created profile (key is stored separately). */
export async function createProvider(
  token: string,
  input: ProviderInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProviderSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(PROVIDERS_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return expectJson<ProviderSummary>(response);
}

/** POST /v1/providers/:id/key {key} -> 204. The key is never echoed back. */
export async function setProviderKey(
  token: string,
  id: string,
  key: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(providerPath(id, '/key'), {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ key }),
  });
  return expectNoContent(response, 'Setting the provider key');
}

/** DELETE /v1/providers/:id -> 204 (keychain item + row removed). */
export async function deleteProvider(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(providerPath(id, ''), {
    method: 'DELETE',
    headers: { authorization: `Bearer ${token}` },
  });
  return expectNoContent(response, 'Deleting the provider');
}

/**
 * POST /v1/providers/:id/test -> refreshed profile. The core probes the
 * upstream (models + 1-token chat), stores default_models and health; the
 * profile returned replaces the stale row in the UI.
 */
export async function testProvider(
  token: string,
  id: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProviderSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(providerPath(id, '/test'), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  return expectJson<ProviderSummary>(response);
}

/**
 * POST /v1/self-service/login-key {endpoint} -> the S0 envelope public key.
 * The core proxies GET {endpoint}/api/login-key (S0). 502/504 mean the
 * upstream self-service app is unreachable through the core.
 */
export async function fetchSelfServiceLoginKey(
  token: string,
  endpoint: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SelfServiceLoginKey> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SELF_SERVICE_LOGIN_KEY_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({ endpoint }),
  });
  if (response.status === 502 || response.status === 504) {
    throw new ApiRequestError(response.status, 'Upstream service unavailable');
  }
  const loginKey = await expectJson<SelfServiceLoginKey>(response);
  if (typeof loginKey?.publicKeyPem !== 'string' || loginKey.publicKeyPem.length === 0) {
    throw new ApiRequestError(
      response.status,
      'The self-service login key response was missing its public key.',
    );
  }
  return loginKey;
}

/**
 * POST /v1/self-service/connect {endpoint, email, passwordCipher} -> the
 * created provider profile. The ciphertext was produced IN THE PAGE by
 * cryptoEnvelope; the plaintext password never crosses the loopback.
 * A 401 from the core means the upstream rejected the org credentials (the
 * core sends the same wording for wrong-credential/unknown-user — no
 * enumeration); 502 means the self-service app is unreachable.
 */
export async function connectSelfService(
  token: string,
  input: SelfServiceConnectInput,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProviderSummary> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(SELF_SERVICE_CONNECT_PATH, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  if (response.status === 401) {
    throw new ApiRequestError(401, 'Invalid email or password');
  }
  if (response.status === 502) {
    throw new ApiRequestError(502, 'Upstream service unavailable');
  }
  return expectJson<ProviderSummary>(response);
}
