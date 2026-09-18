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
    }
  | {
      /**
       * Tool-pass outcome note (server -> client, emitted AFTER `done`): the
       * pass persisted this as a system message AND streams it so the
       * transcript shows a search result / refusal immediately instead of
       * only after a history reload.
       */
      type: 'tool_note';
      content: string;
    }
  | {
      /**
       * The tool pass executed (or refused) a tool and the persona should
       * answer against the outcome now — the client runs ONE continuation
       * round (`continueTurn`) so the reply lands in the same interaction.
       * Never emitted for a `queued` approval (the user decides that first).
       */
      type: 'tool_continue';
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

/** One inline image carried to a provider for a single turn. */
export interface ChatImagePart {
  mime: string;
  /** Raw base64 (no `data:` prefix) — the adapter builds the data URL. */
  dataBase64: string;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /**
   * M11 multimodal: inline image payloads ride the message to the provider
   * ONLY (never persisted), in attach order. Adapters serialize them into an
   * OpenAI content array when the target model is image-capable; plain text
   * messages are untouched. A LIST because a turn can carry several photos —
   * serializing only the first silently dropped the rest.
   */
  images?: ChatImagePart[];
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

export const SCHEMA_VERSION = 23;
export const WIRE_VERSION = 'v1';

/**
 * The id of the user that OWNS the pre-partition layout (M20-B §4.1 / S2).
 *
 * M20-B's locked decision is that an existing install does not move: the
 * single-user database at `<dataRoot>/partner.db`, its `<dataRoot>/skills`
 * directory and its legacy `db-key` keychain account ARE this user's partition.
 *
 * It is the same value as the first user created on an empty core, and the two
 * must never drift — which is why one constant is exported and the other is
 * derived from it rather than spelled a second time.
 */
export const LEGACY_USER_ID = '0';

/**
 * M29: an account's role on this core.
 *
 * `owner` may mint invitations, publish shared provider/search access and see
 * every account; `member` reaches their OWN partition plus whatever has been
 * shared with them. The FIRST account on an empty core is always an owner, so a
 * deployment is never left without one.
 */
export const USER_ROLES = ['owner', 'member'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export function isUserRole(value: unknown): value is UserRole {
  return value === 'owner' || value === 'member';
}

/**
 * M29: where a member's model + search credentials come from.
 *
 * `own` — the account configures providers itself (the owner default, and every
 * pre-M29 account). `shared` — the account may use the deployment's published
 * provider/search configuration while it has none of its own, so an invited
 * person can chat immediately. Chosen at INVITE time; a redeemer cannot change
 * it.
 */
export const KEY_ACCESS_MODES = ['own', 'shared'] as const;
export type KeyAccess = (typeof KEY_ACCESS_MODES)[number];
export function isKeyAccess(value: unknown): value is KeyAccess {
  return value === 'own' || value === 'shared';
}

/** M29: what a share covers — a note or a saved asset. */
export const SHARE_KINDS = ['note', 'asset'] as const;
export type ShareKind = (typeof SHARE_KINDS)[number];
export function isShareKind(value: unknown): value is ShareKind {
  return value === 'note' || value === 'asset';
}
