/**
 * Chat provider/model resolution.
 *
 * `resolveChatProvider` is the M1 contract (PLAN-M1.md "resolver"): the FIRST
 * enabled provider by creation order, or null (the caller falls back to the
 * demo provider in demo mode). It stays exported unchanged — M0/M2 call sites
 * and tests depend on it.
 *
 * `resolveChatModel` is the M3 per-persona router (PLAN-M3.md §"Resolver" +
 * PLAN.md §4.2 fallback chain). Precedence, highest first:
 *   1. `requestedModel` (explicit request always wins) — provider is the
 *      persona-pinned provider when enabled, else the first enabled one.
 *   2. persona.model.taskClasses[taskClass] (taskClass defaults to 'chat').
 *   3. persona.model.fallback.
 *   4. the first enabled provider's default model (no persona mapping).
 * No persona behaves exactly like M1/M2: provider default when a provider
 * exists, else `{provider: null}` and the caller falls back to demo / 501.
 *
 * The provider accompanying a persona model is the persona-pinned provider
 * (model.providerId) when it exists AND is enabled, otherwise the first
 * enabled provider. `provider: null` + `model: ''` is the typed "nothing
 * configured" result.
 */
import type { Persona, ProviderSummary, TaskClass } from '@partner/shared';
import type { ProviderManager } from '../providers/providerManager.js';

export function resolveChatProvider(
  manager: ProviderManager,
  _requestedModel?: string,
): ProviderSummary | null {
  const providers = manager.list().filter((p) => p.enabled);
  return providers[0] ?? null;
}

export interface ResolveChatModelOptions {
  /** Active persona (null/undefined = legacy one-shot routing). */
  persona?: Persona | null;
  /** Explicit model id from the request body. */
  requestedModel?: string;
  /** Every registered provider (enabled filtering happens here). */
  providers: ProviderSummary[];
  /** Task class to route (default 'chat'). */
  taskClass?: TaskClass;
}

export interface ResolvedChatModel {
  /** The provider that should serve the model, or null (demo/501 fallback). */
  provider: ProviderSummary | null;
  /** The concrete model id; '' means nothing usable was configured. */
  model: string;
}

export function resolveChatModel(options: ResolveChatModelOptions): ResolvedChatModel {
  const persona = options.persona ?? null;
  const requestedModel =
    typeof options.requestedModel === 'string' && options.requestedModel.trim() !== ''
      ? options.requestedModel.trim()
      : undefined;
  const taskClass: TaskClass = options.taskClass ?? 'chat';

  const enabled = options.providers.filter((p) => p.enabled);
  const firstEnabled: ProviderSummary | null = enabled[0] ?? null;
  const pinnedId = persona?.model.providerId;
  const pinned = pinnedId ? enabled.find((p) => p.id === pinnedId) ?? null : null;
  // A persona model rides the persona's pinned provider when usable, else the
  // first enabled provider.
  const personaProvider = pinned ?? firstEnabled;

  if (requestedModel !== undefined) {
    // An explicit model always wins — even with no usable provider, the
    // caller still learns which model was asked for.
    return { provider: personaProvider, model: requestedModel };
  }

  // Persona mappings are only usable when a provider can serve them (a model
  // id without any enabled provider is not "configured" — the caller falls
  // back to demo / 501).
  if (personaProvider !== null) {
    const taskClassModel = persona?.model.taskClasses[taskClass];
    if (taskClassModel !== undefined && taskClassModel !== '') {
      return { provider: personaProvider, model: taskClassModel };
    }
    const fallback = persona?.model.fallback;
    if (fallback !== undefined && fallback !== '') {
      return { provider: personaProvider, model: fallback };
    }
  }

  if (firstEnabled !== null) {
    const defaultModel = firstEnabled.defaultModels[0];
    return { provider: firstEnabled, model: defaultModel ?? '' };
  }

  // Typed "nothing configured": no enabled provider to route to at all.
  return { provider: null, model: '' };
}
