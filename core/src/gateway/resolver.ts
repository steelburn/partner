/**
 * Chat provider resolution (M1 skeleton, PLAN-M1.md "resolver").
 *
 * M1 semantics: pick the FIRST enabled provider by creation order when any
 * exist, else null (the caller falls back to the demo provider in demo mode).
 * Full persona/task-class routing and multi-provider fallback chains land in
 * M3 — `requestedModel` is accepted now so the call site stays stable, but it
 * does not influence resolution until then.
 */
import type { ProviderSummary } from '@partner/shared';
import type { ProviderManager } from '../providers/providerManager.js';

export function resolveChatProvider(
  manager: ProviderManager,
  _requestedModel?: string,
): ProviderSummary | null {
  const providers = manager.list().filter((p) => p.enabled);
  return providers[0] ?? null;
}
