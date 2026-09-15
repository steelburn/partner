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
  /**
   * Model ids the user DECLARED image-capable for this profile, on top of what
   * the name heuristic recognises. Necessary because an OpenAI-compatible
   * gateway's model ids are operator-chosen aliases (LiteLLM's `model_name`),
   * so a model that can see may have a name nothing can recognise — and
   * without this the chat turn silently drops the photo. See `shared/vision.ts`.
   */
  visionModels: string[];
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
  /** Model ids to declare image-capable (see `ProviderSummary.visionModels`). */
  visionModels?: string[];
  enabled?: boolean;
  budgetCents?: number | null;
}

/**
 * The model ids a provider profile DECLARES it can see with — the input to
 * `isImageCapableModel`. Two sources, both explicit user decisions:
 *
 *  - `visionModels`: the per-model ticks on the profile.
 *  - every `defaultModels` entry when the profile's purpose is `vision`: the
 *    M13 purpose bundle asks the user to pin models to a purpose, so pinning
 *    a model to Vision *is* a declaration that it can see.
 *
 * Exported because core (handoff + chat gating) and web (picker suggestion,
 * capability chips) must read capability the same way.
 */
export function declaredVisionModels(
  provider:
    | {
        purpose?: ProviderPurpose | string;
        defaultModels?: readonly string[] | null;
        visionModels?: readonly string[] | null;
      }
    | null
    | undefined,
): string[] {
  if (!provider) return [];
  const declared = [...(provider.visionModels ?? [])];
  if (provider.purpose === 'vision') declared.push(...(provider.defaultModels ?? []));
  return [...new Set(declared.map((model) => model.trim()).filter((model) => model !== ''))];
}

/** PATCH body for an existing profile (M24: vision declarations are editable
 *  without deleting and re-adding the provider). Absent keys are untouched. */
export interface ProviderPatch {
  name?: string;
  purpose?: ProviderPurpose;
  endpoint?: string;
  enabled?: boolean;
  budgetCents?: number | null;
  defaultModels?: string[];
  /** Replace the declared image-capable ids (an empty array clears them). */
  visionModels?: string[];
}

// ---------------------------------------------------------------------------
// (removed in M22) The llm-self-service import contract — `SelfServiceLoginKey`
// and `SelfServiceConnectInput` — lived here. Provider setup is now always a
// base URL + key typed by the user; see PLAN-M22.md.
// ---------------------------------------------------------------------------
