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
    }
  | {
      /**
       * M11 F2 native function calling: the model finished a turn with
       * tool calls. Emitted ONCE per turn (aggregated) by the adapter when
       * the upstream stream carried tool_calls deltas. The caller decides
       * whether to surface it to the client — plain chat never forwards it.
       */
      type: 'tool_calls';
      calls: ToolCall[];
    };

/** One aggregated native function call (arguments as a JSON string). */
export interface ToolCall {
  id?: string | null;
  name?: string | null;
  /** Raw JSON-string arguments as the model produced them. */
  arguments?: string | null;
}

/** OpenAI-compatible function-tool advertisement (native tool calls). */
export interface ChatToolSpec {
  type: 'function';
  function: {
    name: string;
    description?: string;
    /** JSON Schema for the arguments; loose when omitted. */
    parameters?: Record<string, unknown>;
  };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  /** Sampling temperature override (persona character); omitted = upstream default. */
  temperature?: number;
  /** M11 F2: advertise functions so the model can reply with native tool calls. */
  tools?: ChatToolSpec[];
  /** External cancellation (e.g. client disconnect / budget stop). When it
   *  fires the provider stream is aborted WITHOUT an error event. */
  signal?: AbortSignal;
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

export const SCHEMA_VERSION = 12;
export const WIRE_VERSION = 'v1';
