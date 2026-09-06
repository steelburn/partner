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
import type { Persona, ProviderPurpose, ProviderSummary, TaskClass } from '@partner/shared';
import { isImageCapableModel } from './vision.js';
import type { ProviderManager } from '../providers/providerManager.js';

/**
 * M11 F4 (PLAN-M11.md): which purposes serve a task class, best first.
 * 'general' is the universal fallback and therefore never needs listing.
 */
const TASK_PURPOSE_ORDER: Record<TaskClass, ProviderPurpose[]> = {
  chat: ['general'],
  cheap: ['cheap', 'general'],
  deep: ['deep', 'general'],
  coding: ['coding', 'general'],
  vision: ['vision', 'general'],
};

/** Research-style flows (F2 search/playbooks) prefer a 'research' provider. */
export function purposeOrderForTaskClass(taskClass: TaskClass): ProviderPurpose[] {
  return TASK_PURPOSE_ORDER[taskClass] ?? ['general'];
}

/**
 * M13 image-turn vision upgrade (see PLAN-M13.md). When a turn carries an
 * inline image but routing landed on a model that cannot see it, find the
 * best vision-capable replacement: (1) the persona's own `vision` task-class
 * mapping when it resolves to an image-capable model, else (2) the first
 * image-capable model among the enabled providers' default model lists,
 * preferring the persona's pinned provider, then a purpose-'vision'
 * provider, then creation order. Returns null when nothing can see images.
 */
export interface ImageTurnUpgrade {
  provider: ProviderSummary;
  model: string;
}

export function resolveImageTurnUpgrade(options: {
  persona?: Persona | null;
  providers: ProviderSummary[];
}): ImageTurnUpgrade | null {
  const persona = options.persona ?? null;
  const enabled = options.providers.filter((p) => p.enabled);
  if (enabled.length === 0) return null;

  // (1) The persona's explicit vision mapping — the resolver already prefers
  // the pinned / vision-purpose provider for the 'vision' task class.
  const personaVision = persona?.model.taskClasses.vision;
  if (personaVision !== undefined && personaVision.trim() !== '') {
    const routed = resolveChatModel({ persona, providers: options.providers, taskClass: 'vision' });
    if (routed.provider !== null && isImageCapableModel(routed.model)) {
      return { provider: routed.provider, model: routed.model };
    }
  }

  // (2) Scan every enabled provider's default models for the first one that
  // can actually see images (pinned first, then vision-purpose, then order).
  const pinnedId = persona?.model.providerId;
  const rank = (p: ProviderSummary): number =>
    p.id === pinnedId ? 3 : p.purpose === 'vision' ? 2 : 1;
  const ordered = [...enabled].sort((a, b) => rank(b) - rank(a));
  for (const p of ordered) {
    const model = p.defaultModels.find((m) => isImageCapableModel(m));
    if (model !== undefined) return { provider: p, model };
  }
  return null;
}

/**
 * Best enabled provider for a preference list: first provider whose purpose
 * matches in order, else the first 'general', else the first enabled
 * provider (creation order preserved — same as the legacy resolver).
 */
export function pickProviderByPurpose(
  enabled: ProviderSummary[],
  preferences: ProviderPurpose[],
): ProviderSummary | null {
  for (const purpose of preferences) {
    const found = enabled.find((p) => p.purpose === purpose);
    if (found) return found;
  }
  const general = enabled.find((p) => p.purpose === 'general');
  return general ?? enabled[0] ?? null;
}

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
  /**
   * M13 explicit per-turn provider pin (the chat UI's model picker rides
   * this): when provided AND enabled it wins over the persona pin and the
   * purpose chain, so a model that only exists on another provider can be
   * used for one turn. Invalid/disabled ids are validated by the route.
   */
  providerId?: string;
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
  // M13 explicit per-turn provider pin wins over everything else (the chat
  // UI sends it alongside requestedModel when the user picks a model).
  const explicitProvider =
    options.providerId !== undefined
      ? enabled.find((p) => p.id === options.providerId) ?? null
      : null;
  // Purpose-aware provider for this task class (F4): an explicit request
  // provider wins, then an explicit persona pin, then the provider whose
  // purpose fits the task.
  const personaProvider =
    explicitProvider ?? pinned ?? pickProviderByPurpose(enabled, purposeOrderForTaskClass(taskClass));

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

  if (enabled.length > 0) {
    // No persona mapping: serve the task class from the best-purpose
    // provider's default model (F4), creation order when purposes tie.
    const purposeProvider = pickProviderByPurpose(enabled, purposeOrderForTaskClass(taskClass));
    const provider = purposeProvider ?? firstEnabled;
    const defaultModel = provider?.defaultModels[0] ?? '';
    return { provider, model: defaultModel };
  }

  // Typed "nothing configured": no enabled provider to route to at all.
  return { provider: null, model: '' };
}
