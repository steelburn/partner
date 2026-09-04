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
 * never logged or echoed. Every outbound call carries a deadline that covers
 * the BODY, not just the headers.
 *
 * Demo mode (DEMO_MODE=1) is fully OFFLINE: the core serves an in-process
 * double of the S0 API (createSelfServiceDemoDouble) so "Connect
 * llm-self-service" works with no credentials and no network.
 */
import type { ProviderSummary, SelfServiceConnectInput } from '@partner/shared';
import type { ProviderManager } from '../providers/providerManager.js';
import { generateKeyPairSync, privateDecrypt, constants } from 'node:crypto';

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

function isAbortLike(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function upstreamError(err: unknown, timeoutMs: number): SelfServiceError {
  if (err instanceof SelfServiceError) return err;
  if (isAbortLike(err)) {
    return new SelfServiceError(
      504,
      'upstream',
      `Upstream request timed out after ${Math.round(timeoutMs / 1000)}s`,
    );
  }
  return new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
}

/** Whole-call fetch with a deadline covering headers AND body. */
async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** GET {endpoint}/api/login-key (proxied for the web UI's envelope). */
export async function fetchSelfServiceLoginKey(
  rawEndpoint: unknown,
  options: SelfServiceOptions = {},
): Promise<{ publicKeyPem: string }> {
  const endpoint = validateSelfServiceEndpoint(rawEndpoint);
  // Demo mode stays offline: serve the double's own envelope key.
  if (options.demo) {
    if (!options.demoDouble) {
      throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
    }
    return options.demoDouble.loginKey();
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  const fetchImpl = options.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchWithDeadline(fetchImpl, `${endpoint}/api/login-key`, {
      method: 'GET',
      headers: { accept: 'application/json' },
    }, timeoutMs);
  } catch (err) {
    throw upstreamError(err, timeoutMs);
  }
  if (!res.ok) throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
  try {
    // json() is inside the same deadline window.
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

export interface SelfServiceOptions {
  /** Per-outbound-call timeout (default 15s). */
  timeoutMs?: number;
  /** Injectable fetch (tests); defaults to the global. */
  fetchImpl?: typeof fetch;
  /** Demo mode: the connect runs against the in-process double (offline). */
  demo?: boolean;
  /** The demo double instance (server builds one per process). */
  demoDouble?: SelfServiceDemoDouble;
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

  let res: Response;
  try {
    res = await fetchWithDeadline(
      fetchImpl,
      `${endpoint}${path}`,
      { method: init.method, headers, body: init.body },
      timeoutMs,
    );
  } catch (err) {
    throw upstreamError(err, timeoutMs);
  }
  const cookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : (res.headers.get('set-cookie') ?? '').split(',').filter(Boolean);
  let text: string;
  try {
    // Body read happens inside the SAME deadline window (slow-drip upstreams
    // must not hold the connect open forever).
    text = await res.text();
  } catch (err) {
    throw upstreamError(err, timeoutMs);
  }
  return { status: res.status, cookies, text };
}

function sessionCookieHeader(setCookies: string[]): string | null {
  const names = setCookies.map((c) => c.split(';')[0]?.trim()).filter((c) => c !== undefined && c !== '');
  return names.length > 0 ? names.join('; ') : null;
}

// ---------------------------------------------------------------------------
// Demo double — in-process S0 API so demo mode is fully offline.
// ---------------------------------------------------------------------------

export interface SelfServiceDemoDouble {
  loginKey(): { publicKeyPem: string };
  /** Decrypt the envelope; identical generic failure semantics to upstream. */
  connect(email: string, passwordCipher: string): Promise<SelfServiceResult>;
}

export function createSelfServiceDemoDouble(port: number): SelfServiceDemoDouble {
  let pair: { publicPem: string; privateKey: string } | null = null;
  const ensurePair = (): void => {
    if (pair) return;
    const generated = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    pair = { publicPem: generated.publicKey, privateKey: generated.privateKey };
  };

  return {
    loginKey(): { publicKeyPem: string } {
      ensurePair();
      return { publicKeyPem: (pair as { publicPem: string }).publicPem };
    },

    async connect(email, passwordCipher): Promise<SelfServiceResult> {
      ensurePair();
      if (typeof email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
        throw new SelfServiceError(401, 'auth_failed', 'Invalid email or password');
      }
      let password = '';
      try {
        password = privateDecrypt(
          {
            key: (pair as { privateKey: string }).privateKey,
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: 'sha256',
          },
          Buffer.from(String(passwordCipher ?? ''), 'base64'),
        ).toString('utf8');
      } catch {
        password = '';
      }
      if (password === '' || password.length < 4) {
        throw new SelfServiceError(401, 'auth_failed', 'Invalid email or password');
      }
      // Demo key + an endpoint pointing back at this (offline) core; the chat
      // route ignores llm-self-service-sourced providers in demo mode.
      const base = `http://127.0.0.1:${port}`;
      return {
        email: email.trim(),
        proxyBaseUrl: base,
        endpoint: `${base}/v1`,
        key: 'sk-demo-import',
        expiresAt: null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Connect (real outbound path; demo mode goes through the double above).
// ---------------------------------------------------------------------------

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
  // The endpoint is validated even in demo mode (same 400 semantics), but in
  // demo mode the actual flow runs against the in-process double below.
  const endpoint = validateSelfServiceEndpoint(input.endpoint);
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const passwordCipher = typeof input.passwordCipher === 'string' ? input.passwordCipher.trim() : '';
  if (email === '') throw new SelfServiceError(400, 'invalid_input', 'email is required');
  if (passwordCipher === '') {
    throw new SelfServiceError(400, 'invalid_input', 'passwordCipher is required');
  }

  let result: SelfServiceResult;
  if (options.demo) {
    const double = options.demoDouble as SelfServiceDemoDouble;
    result = await double.connect(email, passwordCipher);
  } else {
    // 1. Envelope login — wrong creds and unknown users both surface 401 here
    //    with the SAME generic message (no enumeration); we never echo the
    //    upstream body or our ciphertext.
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
    // The upstream-reported endpoint is NOT blindly trusted: re-validate it
    // (https, or http on a loopback host) before it becomes a provider URL.
    try {
      validateSelfServiceEndpoint(upstreamEndpoint);
    } catch {
      throw new SelfServiceError(502, 'upstream', 'Upstream service unavailable');
    }
    result = {
      email,
      proxyBaseUrl: proxyBaseUrl as string,
      endpoint: upstreamEndpoint,
      key,
      expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
    };
  }

  // 3. Profile row + keychain entry. If the keychain write fails, roll the row
  //    back so no orphan profile claims a key it cannot hold.
  const summary = await manager.create(
    {
      name: 'llm-self-service (org)',
      kind: 'openai-compatible',
      endpoint: result.endpoint,
      enabled: true,
      budgetCents: null,
      defaultModels: [],
    },
    'llm-self-service',
  );
  try {
    await manager.setKey(summary.id, result.key);
  } catch (err) {
    await manager.remove(summary.id).catch(() => undefined);
    throw err;
  }
  return summary;
}
