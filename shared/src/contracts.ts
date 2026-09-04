/**
 * Cross-package contracts (M0 scope).
 *
 * Core implements these; web/extension and tests consume them. Anything that
 * crosses a package boundary belongs here first.
 */

// ---------------------------------------------------------------------------
// Secret storage (implemented by core/keychain, consumed by core/config)
// ---------------------------------------------------------------------------

/**
 * OS-keychain-backed secret storage. Implementations:
 *  - native: @napi-rs/keyring (macOS Keychain / Windows DPAPI / libsecret).
 *    On Linux without a keyring daemon, setSecret must surface a clear error.
 *  - fake: in-memory (tests / DEMO_MODE).
 */
export interface Keychain {
  /** Read a secret; returns null when the account does not exist. */
  get(service: string, account: string): Promise<string | null>;
  /** Create or replace a secret. */
  set(service: string, account: string, value: string): Promise<void>;
  /** Remove a secret; no-op when absent. */
  delete(service: string, account: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Model gateway seam (M0: demo provider only; real providers land in M1)
// ---------------------------------------------------------------------------

export type ChatEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; promptTokens: number; completionTokens: number; totalTokens: number }
  | { type: 'done'; model: string; latencyMs: number }
  | { type: 'error'; message: string }
  | {
      type: 'budget_reached';
      message: string;
      spentCents: number;
      limitCents: number | null;
      requests: number;
      limitRequests: number | null;
    };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
}

export interface HealthReport {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * A single model provider. M0 ships a demo implementation; M1 adds the
 * OpenAI-compatible client behind the same seam (PLAN-M1.md).
 */
export interface ProviderClient {
  chatStream(req: ChatRequest): AsyncGenerator<ChatEvent>;
  health(): Promise<HealthReport>;
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = 2;
export const WIRE_VERSION = 'v1';
