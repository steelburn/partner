/**
 * M1 provider wire contracts (PLAN-M1.md).
 *
 * Provider profiles live in the core's SQLite with ONLY a keyRef — the key
 * itself sits in the OS keychain (account `provider:<id>`). These shapes are
 * what crosses the loopback between core and web; keys never appear in any of
 * them.
 */

export type ProviderKind = 'openai-compatible';

/**
 * How a provider profile was created. `'llm-self-service'` is LEGACY (M1): the
 * integration that wrote it was removed in M22, but the value stays so provider
 * rows written by an older install keep reading. Nothing writes it any more.
 */
export type ProviderSource = 'manual' | 'llm-self-service';

/**
 * M11 F4 purpose tags (PLAN-M11.md). Providers advertise what they are for;
 * the resolver prefers the provider whose purpose matches the task class,
 * falling back to 'general'. 'general' remains the default + last resort.
 */
export type ProviderPurpose =
  | 'general'
  | 'cheap'
  | 'deep'
  | 'coding'
  | 'vision'
  | 'research';

export const PROVIDER_PURPOSES: readonly ProviderPurpose[] = [
  'general',
  'cheap',
  'deep',
  'coding',
  'vision',
  'research',
] as const;

export function isProviderPurpose(value: unknown): value is ProviderPurpose {
  return typeof value === 'string' && (PROVIDER_PURPOSES as readonly string[]).includes(value);
}

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
  /** Purpose tag — what this provider is best for (default 'general'). */
  purpose: ProviderPurpose;
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
  /** Optional purpose tag (default 'general'). */
  purpose?: ProviderPurpose;
  endpoint: string;
  defaultModels?: string[];
  enabled?: boolean;
  budgetCents?: number | null;
}

// ---------------------------------------------------------------------------
// (removed in M22) The llm-self-service import contract — `SelfServiceLoginKey`
// and `SelfServiceConnectInput` — lived here. Provider setup is now always a
// base URL + key typed by the user; see PLAN-M22.md.
// ---------------------------------------------------------------------------
