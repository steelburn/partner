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
  ProviderPurpose,
  ProviderSummary,
} from '@partner/shared';
import { parseSseStream } from './sse.js';

const PAIR_PATH = '/v1/pair';
const AUTH_SESSION_PATH = '/v1/auth/session';
const PAIR_PAYLOAD_PATH = '/v1/pair/payload';
const HEALTH_PATH = '/v1/health';
const CHAT_PATH = '/v1/chat';
const SESSION_PATH = '/v1/session';
const DEMO_PAIR_CODE_PATH = '/v1/dev/pair-code';
const PROVIDERS_PATH = '/v1/providers';

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

export interface CoreHealth {
  demo: boolean;
  version: string;
  schemaVersion: number;
  /**
   * M22: which gate to render. `login` is a remote-hosted core authenticating
   * users; `pairing` is the desktop ceremony. Absent (an older core) = pairing.
   */
  authMode: 'pairing' | 'login';
  /** M22: only sent in login mode — false means "no account exists yet". */
  hasUsers?: boolean;
}

/**
 * Probe the public /v1/health surface. Returns null when the core is
 * unreachable or the body is not the expected shape (callers then keep the
 * neutral pairing copy instead of guessing the mode).
 */
export async function fetchCoreHealth(
  options: { fetchImpl?: FetchLike } = {},
): Promise<CoreHealth | null> {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(HEALTH_PATH, { headers: { accept: 'application/json' } });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.demo !== 'boolean') return null;
  return {
    demo: record.demo,
    version: typeof record.version === 'string' ? record.version : '',
    schemaVersion: typeof record.schemaVersion === 'number' ? record.schemaVersion : 0,
    authMode: record.authMode === 'login' ? 'login' : 'pairing',
    ...(typeof record.hasUsers === 'boolean' ? { hasUsers: record.hasUsers } : {}),
  };
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
  // A top-level `message` is the human sentence; `error` is the machine code.
  // (Preferring `error` showed users "invalid_input" and "no_account".)
  if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
  if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error;
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

/** M22: sign in with a username + passphrase (the hosted shape). */
export interface SignInResult {
  token: string;
  userId: string;
  clientClass: string;
  expiresAt: number;
}

/**
 * POST /v1/auth/session {username, password} -> a session that names its user.
 *
 * 401 is one message for "no such user" and "wrong password" (no enumeration),
 * 429 carries the lockout/rate-limit retry, and 409 means the core has no
 * account yet — the fix is an operator command, so the caller should surface the
 * server's wording rather than say "wrong password".
 */
export async function signIn(
  username: string,
  password: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<SignInResult> {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(AUTH_SESSION_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
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
    throw new ApiRequestError(response.status, 'Sign-in response was not valid JSON.');
  }
  const token = readToken(body);
  if (token === null) {
    throw new ApiRequestError(response.status, 'Sign-in response did not include a session token.');
  }
  const record = body as Record<string, unknown>;
  return {
    token,
    userId: typeof record.userId === 'string' ? record.userId : '',
    clientClass: typeof record.clientClass === 'string' ? record.clientClass : 'desktop',
    expiresAt: typeof record.expiresAt === 'number' ? record.expiresAt : 0,
  };
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
  return postPair({ code }, options.fetchImpl ?? fetch);
}

/**
 * M20-B S7: redeem a networked pairing secret (the QR/link path) for a session.
 * The core mints this session as the `mobile` client class — never `desktop`.
 *
 * `deviceLabel` is optional registry metadata (the core bounds and sanitizes
 * it); the secret is the only credential, and it crosses exactly this call.
 */
export async function requestPairSecret(
  secret: string,
  options: { deviceLabel?: string | null; fetchImpl?: FetchLike } = {},
): Promise<PairResult> {
  const body: Record<string, unknown> = { secret };
  const label = options.deviceLabel?.trim();
  if (label !== undefined && label !== '') body.deviceLabel = label;
  return postPair(body, options.fetchImpl ?? fetch);
}

/** The shared POST /v1/pair exchange: body in, session token out. */
async function postPair(body: Record<string, unknown>, fetchImpl: FetchLike): Promise<PairResult> {
  let response: Response;
  try {
    response = await fetchImpl(PAIR_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('network');
  }
  if (!response.ok) {
    throw new ApiRequestError(response.status, await readErrorMessage(response));
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new ApiRequestError(response.status, 'Pairing response was not valid JSON.');
  }
  const token = readToken(parsed);
  if (token === null) {
    throw new ApiRequestError(response.status, 'Pairing response did not include a session token.');
  }
  return { token };
}

/** M20-B S7: what POST /v1/pair/payload returns to the machine's own UI. */
export interface PairPayloadInfo {
  /** The JSON payload, base64url-encoded into the link/QR this UI renders. */
  payload: string;
  coreUrl: string;
  certFingerprint: string;
}

/**
 * Ask the core to ISSUE a networked pairing secret (M20-B S7).
 *
 * Local-only at the core: it refuses with 403 `loopback_required` when the
 * request did not come from this machine, 409 `remote_access_disabled` when
 * remote access is off, and 409 `tls_required` without a pinned certificate.
 */
export async function fetchPairPayload(
  token: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<PairPayloadInfo> {
  const fetchImpl: FetchLike = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(PAIR_PAYLOAD_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: '{}',
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
  if (typeof body !== 'object' || body === null) {
    throw new ApiRequestError(response.status, 'Pairing response was not the expected shape.');
  }
  const record = body as Record<string, unknown>;
  const payload = record.payload;
  const coreUrl = record.coreUrl;
  const certFingerprint = record.certFingerprint;
  if (
    typeof payload !== 'string' ||
    typeof coreUrl !== 'string' ||
    typeof certFingerprint !== 'string'
  ) {
    throw new ApiRequestError(response.status, 'Pairing response was not the expected shape.');
  }
  return { payload, coreUrl, certFingerprint };
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
    case 'tool_note':
      // Tool-pass outcome note streamed after `done` (search result/refusal).
      return typeof v.content === 'string' ? { type: 'tool_note', content: v.content } : null;
    case 'tool_continue':
      // Ask the client for one continuation round so the persona answers
      // against the tool outcome in the same interaction.
      return { type: 'tool_continue' };
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

// ---------------------------------------------------------------------------
// M3: persisted conversations — the trailing chat meta event
//
// The M3 core persists each turn into a conversation and ends the SSE stream
// with the persisted ids. The shared ChatEvent union (contracts.ts) is not
// widened; the web client reads the ids defensively off the same JSON frame
// instead — a `done` frame may carry extra `messageId`/`conversationId`
// members, or the core may send a dedicated trailing `done_meta` frame.
// Malformed frames simply yield no meta (the turn still completed).
// ---------------------------------------------------------------------------

/** Persisted-turn ids delivered by the trailing chat meta (M3). */
export interface StreamDoneMeta {
  messageId: string;
  conversationId: string;
}

/**
 * Tolerant reader for the persisted-turn meta carried on (or after) the
 * final `done` frame. Accepts either an enriched `done` frame or a dedicated
 * `done_meta` frame; returns null when the ids are absent/malformed.
 */
export function readDoneMeta(value: unknown): StreamDoneMeta | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.type !== 'done' && v.type !== 'done_meta') return null;
  const messageId = v.messageId;
  const conversationId = v.conversationId;
  if (typeof messageId !== 'string' || messageId.length === 0) return null;
  if (typeof conversationId !== 'string' || conversationId.length === 0) return null;
  return { messageId, conversationId };
}

export type StreamChatResult =
  | { ok: true }
  | {
      ok: false;
      status: number | null;
      unauthorized: boolean;
      /** True when the core refused the turn because the persona is paused (423). */
      paused: boolean;
      message: string;
    };

export interface StreamChatOptions {
  token: string;
  content: string;
  /** Dispatched as each SSE frame of the chat stream arrives. */
  onEvent: (event: ChatEvent) => void;
  /** Optional active conversation to persist the turn into (M3). */
  conversationId?: string;
  /** Optional persona to route the turn through (M3). */
  personaId?: string;
  /** Optional explicit model override (M3). */
  model?: string;
  /**
   * M13 per-turn provider pin (the chat model picker): when set alongside
   * `model`, the turn rides that provider regardless of persona pinning and
   * purpose routing.
   */
  providerId?: string;
  /** M11 F1: staged attachment ids to bind to this turn. */
  attachmentIds?: string[];
  /** M11 A/B studio: stream this persona turn WITHOUT persisting a conversation. */
  noPersist?: boolean;
  /**
   * M12.6 approval continuation: run the conversation's next persona round
   * with NO new user message — the approval decision just posted its
   * outcome note server-side and this streams the assistant's answer to it.
   * Requires conversationId; content is ignored.
   */
  continueTurn?: boolean;
  /** Receives the persisted-turn ids off the trailing chat meta frame. */
  onDoneMeta?: (meta: StreamDoneMeta) => void;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

/**
 * POST /v1/chat and consume the SSE stream. One user message per call; when
 * conversationId is set the turn is persisted server-side and the trailing
 * meta frame carries the resulting ids. Returns after the stream ends.
 */
export async function streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
  const {
    token,
    content,
    onEvent,
    conversationId,
    personaId,
    model,
    onDoneMeta,
    signal,
    fetchImpl = fetch,
  } = options;
  const body: Record<string, unknown> =
    options.continueTurn === true
      ? { messages: [], continueTurn: true }
      : { messages: [{ role: 'user', content }] };
  if (conversationId !== undefined) body.conversationId = conversationId;
  if (personaId !== undefined) body.personaId = personaId;
  if (model !== undefined) body.model = model;
  if (options.providerId !== undefined) body.providerId = options.providerId;
  if (options.attachmentIds !== undefined && options.attachmentIds.length > 0) {
    body.attachmentIds = options.attachmentIds;
  }
  if (options.noPersist === true) {
    body.noPersist = true;
  }
  const response = await fetchImpl(CHAT_PATH, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    const paused = response.status === 423;
    return {
      ok: false,
      status: response.status,
      unauthorized: response.status === 401 || response.status === 403,
      paused,
      message: paused
        ? 'This persona is paused — resume it in Personas to continue.'
        : await readErrorMessage(response),
    };
  }
  if (response.body === null) {
    return {
      ok: false,
      status: response.status,
      unauthorized: false,
      paused: false,
      message: 'The stream was empty.',
    };
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
    const meta = readDoneMeta(parsed);
    if (meta) onDoneMeta?.(meta);
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

/**
 * M13 purpose-provider bundle (PLAN-M13.md F2): one OpenAI-compatible
 * endpoint + ONE key -> one provider profile per purpose. The key is stored
 * into each profile's keychain item by the core and never returns. When
 * `modelPins` is supplied every requested purpose must map to a non-empty
 * list of models the endpoint actually reported (via discover) — the first
 * model is that purpose's default.
 */
export async function createPurposeProviders(
  token: string,
  input: {
    endpoint: string;
    key: string;
    purposes?: ProviderPurpose[];
    modelPins?: Partial<Record<ProviderPurpose, string[]>>;
    /** Optional per-profile spend cap in USD cents (applied to every purpose). */
    budgetCents?: number;
  },
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ created: ProviderSummary[]; models: string[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${PROVIDERS_PATH}/purposes`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return expectJson<{ created: ProviderSummary[]; models: string[] }>(response);
}

/**
 * M13 pre-bundle model discovery: fetch the upstream model list for an
 * endpoint + key WITHOUT persisting anything — the UI uses it to let the
 * user assign models to purposes before adding the purpose providers.
 */
export async function discoverProviderModels(
  token: string,
  input: { endpoint: string; key: string },
  options: { fetchImpl?: FetchLike } = {},
): Promise<{ endpoint: string; models: string[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(`${PROVIDERS_PATH}/discover`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(input),
  });
  return expectJson<{ endpoint: string; models: string[] }>(response);
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
 * POST /v1/providers/:id/test -> the provider after a probe.
 *
 * (The llm-self-service `login-key` and `connect` clients that lived here were
 * removed in M22 — provider setup is a base URL + key typed by the user.)
 */
