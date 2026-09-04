/**
 * llm-self-service integrated key import (M1, PLAN-M1.md "Import", S0 spec in
 * ~/apps/llm-self-service/PLAN-S0.md).
 *
 * Client-side of the S0 companion API, driven by the core's authed
 * /v1/self-service routes:
 *
 *   1. GET {endpoint}/api/login-key          -> envelope public key (web UI)
 *   2. POST {endpoint}/api/session           -> session cookie
 *   3. GET  {endpoint}/api/me/key            -> {email, proxyBaseUrl, endpoint, key, expiresAt}
 *
 * Secrets discipline: the session cookie is held in an in-memory jar for the
 * duration of one connect and discarded; the retrieved key goes straight to
 * the OS keychain via the provider manager — it is never re-serialized into a
 * response, log, or audit detail. The passwordCipher is forwarded verbatim and
 * never logged or echoed.
 */
import type { ProviderSummary, SelfServiceConnectInput } from '@partner/shared';
import type { ProviderManager } from '../providers/providerManager.js';

export type SelfServiceErrorKind = 'invalid_endpoint' | 'invalid_input' | 'auth_failed' | 'upstream';

export class SelfServiceError extends Error {
  readonly kind: SelfServiceErrorKind;
  readonly httpStatus: number;

  constructor(httpStatus: number, kind: SelfServiceErrorKind, message: string) {
    super(message);
    this.name = 'SelfServiceError';
    this.kind = kind;
    this.httpStatus = httpStatus;
  }
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/**
 * A self-service endpoint must be https, or http on a loopback host (so local
 * tests and the demo fake can run). Trailing slashes stripped.
 */
export function validateSelfServiceEndpoint(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new SelfServiceError(400, 'invalid_endpoint', 'endpoint is required');
  }
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SelfServiceError(400, 'invalid_endpoint', 'endpoint must be a valid URL');
  }
  if (url.protocol === 'https:') {
    // fine
  } else if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) {
    // loopback only — local tests / demo fakes
  } else {
    throw new SelfServiceError(
      400,
      'invalid_endpoint',
      'endpoint must be https (or http on 127.0.0.1/localhost for local testing)',
    );
  }
  return trimmed.replace(/\/+$/, '');
}

export interface SelfServiceOptions {
  /** Per-outbound-call timeout (default 15s). */
  timeoutMs?: number;
  /** Injectable fetch (tests); defaults to the global. */
  fetchImpl?: typeof fetch;
}

interface SelfServiceResult {
  email: string;
  /** e.g. https://api.ne1.dev — the key's proxy origin. */
  proxyBaseUrl: string;
  /** e.g. https://api.ne1.dev/v1 — the OpenAI-compatible base to use. */
  endpoint: string;
  key: string;
  expiresAt: string | null;
}

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

/** GET {endpoint}/api/login-key (proxied for the web UI's envelope). */
export async function fetchSelfServiceLoginKey(
  rawEndpoint: unknown,
  options: SelfServiceOptions = {},
): Promise<{ publicKeyPem: string }> {
  const endpoint = validateSelfServiceEndpoint(rawEndpoint);
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${endpoint}/api/login-key`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } catch (err) {
    throw upstreamError(err, isAbortLike(err), timeoutMs);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
  try {
    const body = (await res.json()) as { publicKeyPem?: unknown };
    if (typeof body.publicKeyPem !== 'string' || body.publicKeyPem === '') {
      throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
    }
    return { publicKeyPem: body.publicKeyPem };
  } catch (err) {
    if (err instanceof SelfServiceError) throw err;
    throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
  }
}

function upstreamError(err: unknown, aborted: boolean, timeoutMs: number): SelfServiceError {
  if (err instanceof SelfServiceError) return err;
  if (aborted) {
    return new SelfServiceError(
      504,
      'upstream',
      `Upstream request timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  }
  return new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
}

async function outbound(
  endpoint: string,
  path: string,
  init: { method: string; body?: string; cookie?: string | null },
  options: SelfServiceOptions,
): Promise<{ status: number; cookies: string[]; text: string }> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = new Headers();
  headers.set('accept', 'application/json');
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  if (init.cookie) headers.set('cookie', init.cookie);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(`${endpoint}${path}`, {
      method: init.method,
      headers,
      body: init.body,
      signal: controller.signal,
    });
  } catch (err) {
    throw upstreamError(err, isAbortLike(err), timeoutMs);
  } finally {
    clearTimeout(timer);
  }
  const cookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ?? '').split(',').filter(Boolean);
  return { status: res.status, cookies, text: await res.text() };
}

function sessionCookieHeader(setCookies: string[]): string | null {
  const names = setCookies.map((c) => c.split(';')[0]?.trim()).filter((c) => c !== undefined && c !== '');
  return names.length > 0 ? names.join('; ') : null;
}

/**
 * Full connect flow (S0): envelope login -> session cookie jar -> /api/me/key
 * -> provider row (source 'llm-self-service') + key into the keychain.
 * Returns the created ProviderSummary — never the key.
 */
export async function connectSelfService(
  manager: ProviderManager,
  input: SelfServiceConnectInput,
  options: SelfServiceOptions = {},
): Promise<ProviderSummary> {
  const endpoint = validateSelfServiceEndpoint(input.endpoint);
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const passwordCipher = typeof input.passwordCipher === 'string' ? input.passwordCipher.trim() : '';
  if (email === '') throw new SelfServiceError(400, 'invalid_input', 'email is required');
  if (passwordCipher === '') {
    throw new SelfServiceError(400, 'invalid_input', 'passwordCipher is required');
  }

  // 1. Envelope login — wrong creds and unknown users both surface 401 here
  //    with the SAME generic message upstream (no enumeration); we never
  //    echo the upstream body or our ciphertext.
  const session = await outbound(
    endpoint,
    '/api/session',
    { method: 'POST', body: JSON.stringify({ email, passwordCipher }) },
    options,
  );
  if (session.status === 401) {
    throw new SelfServiceError(401, 'auth_failed', 'Invalid email or password');
  }
  if (session.status < 200 || session.status >= 300) {
    throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
  }
  const cookie = sessionCookieHeader(session.cookies);
  if (cookie === null) {
    throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
  }

  // 2. Session-authenticated key fetch.
  const me = await outbound(endpoint, '/api/me/key', { method: 'GET', cookie }, options);
  if (me.status === 401) {
    // Cookie refused (expired/invalid) — identical generic wording.
    throw new SelfServiceError(401, 'auth_failed', 'Invalid email or password');
  }
  if (me.status < 200 || me.status >= 300) {
    throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(me.text) as Record<string, unknown>;
  } catch {
    throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
  }
  const key = typeof payload.key === 'string' && payload.key !== '' ? payload.key : null;
  const proxyBaseUrl =
    typeof payload.proxyBaseUrl === 'string' && payload.proxyBaseUrl !== ''
      ? payload.proxyBaseUrl.replace(/\/+$/, '')
      : null;
  const upstreamEndpoint =
    typeof payload.endpoint === 'string' && payload.endpoint !== ''
      ? payload.endpoint
      : proxyBaseUrl !== null
        ? `${proxyBaseUrl}/v1`
        : null;
  if (key === null || upstreamEndpoint === null) {
    throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
  }

  // 3. Profile row + keychain entry. If the keychain write fails, roll the row
  //    back so no orphan profile claims a key it cannot hold.
  const summary = await manager.create(
    {
      name: 'llm-self-service (org)',
      kind: 'openai-compatible',
      endpoint: upstreamEndpoint,
      enabled: true,
      budgetCents: null,
      defaultModels: [],
    },
    'llm-self-service',
  );
  try {
    await manager.setKey(summary.id, key);
  } catch (err) {
    await manager.remove(summary.id).catch(() => undefined);
    throw err;
  }
  return summary;
}
