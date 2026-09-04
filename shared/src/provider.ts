/**
 * M1 provider wire contracts (PLAN-M1.md).
 *
 * Provider profiles live in the core's SQLite with ONLY a keyRef — the key
 * itself sits in the OS keychain (account `provider:<id>`). These shapes are
 * what crosses the loopback between core and web; keys never appear in any of
 * them.
 */

export type ProviderKind = 'openai-compatible';

export type ProviderSource = 'manual' | 'llm-self-service';

export interface ProviderHealth {
  ok: boolean;
  /** Latency of the last live probe (listModels), ms. */
  latencyMs: number | null;
  error: string | null;
  /** Models reported by the last probe. */
  models: string[];
  checkedAt: number | null;
}

/** Provider as returned to clients — never contains the key or keyRef. */
export interface ProviderSummary {
  id: string;
  name: string;
  kind: ProviderKind;
  source: ProviderSource;
  /** Full OpenAI-compatible base URL, e.g. https://api.ne1.dev/v1 */
  endpoint: string;
  defaultModels: string[];
  enabled: boolean;
  /** Optional per-session spend cap in USD cents (null = off). */
  budgetCents: number | null;
  createdAt: number;
  updatedAt: number;
  health: ProviderHealth;
}

/** Input for creating a provider. */
export interface ProviderInput {
  name: string;
  kind?: ProviderKind;
  endpoint: string;
  defaultModels?: string[];
  enabled?: boolean;
  budgetCents?: number | null;
}

// ---------------------------------------------------------------------------
// llm-self-service integrated import (S0 endpoints, PLAN-S0.md)
// ---------------------------------------------------------------------------

/** GET {endpoint}/api/login-key — proxied by the core so the web UI can
 *  encrypt the password in the page without CORS. */
export interface SelfServiceLoginKey {
  publicKeyPem: string;
}

/**
 * Connect request. The web UI encrypts the password with the envelope public
 * key (WebCrypto RSA-OAEP/SHA-256); the core forwards the CIPHERTEXT only and
 * rejects a plaintext `password` field outright (PLAN-M1.md).
 */
export interface SelfServiceConnectInput {
  /** Self-service base URL, e.g. https://enter.ne1.dev (no /v1). */
  endpoint: string;
  email: string;
  passwordCipher: string;
}
