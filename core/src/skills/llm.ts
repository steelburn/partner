/**
 * Model reach for a skill (M27 S5, PLAN-M27.md + decisions D11/D12/D13).
 *
 * WHY this module exists: a skill could not call a model at all before this
 * slice — the worker's `partner` global was `log` + `tools.exec`, so the single
 * most useful thing a skill could do ("read these notes and summarise them")
 * was impossible. This is the ONE seam where that reach is resolved and
 * bounded, so the three surfaces that must agree about it cannot drift:
 *
 *   resolve   `resolveChatModel` + `providers.clientFor` — exactly the
 *             provider/model the chat path would pick, resolved ONCE per
 *             invocation. Nothing usable configured (no provider, no default
 *             model, no key) yields null, which the runner answers
 *             `no_provider`, matching chat.
 *   bound     {@link DEFAULT_SKILL_LLM_MAX_TOKENS} is the ceiling a manifest
 *             that declares `llm` without `budget.maxTokens` gets. It is a
 *             DOCUMENTED default, never "unbounded": `budget.maxTokens` has
 *             been declared and validated since M8 and never read, and
 *             `permissionSummary` (runtime.ts) prints this number to the owner
 *             before they install, so the install summary and the runner's
 *             arithmetic are the same figure.
 *   trace     the binding never grows a content channel: the runner records
 *             counts only (model id, token counts, ms), never the prompt or
 *             the completion.
 *
 * `llm` is refused for a session whose client class is mobile or extension
 * (`skill.llm` in http/capabilities.ts), so this file deliberately knows
 * nothing about the class — the runner checks it before a resolver is even
 * consulted.
 */
import type { ProviderClient, ProviderSummary } from '@partner/shared';
import { resolveChatModel } from '../gateway/resolver.js';

/**
 * Token ceiling for a skill that declares `permissions.llm` and no
 * `budget.maxTokens`. One completion's worth: enough for the summarise-class
 * skill this reach exists for, small enough that a mistaken declaration cannot
 * spend a metered window. Stated to the owner in `permissionSummary`.
 */
export const DEFAULT_SKILL_LLM_MAX_TOKENS = 4_096;

/**
 * Longest prompt a skill may send in ONE call. The prompt is where bulk data
 * lives (a skill that read a note and asks for a summary), so it is capped at
 * the same order as the 1 MiB result cap: a skill cannot hand the core an
 * unbounded string to keep in memory or ship upstream.
 */
export const MAX_SKILL_LLM_PROMPT_BYTES = 256 * 1024;

/**
 * Largest model reply the runner will collect for one call — the same bound
 * `generate.ts` puts on its one-shot authoring call (GENERATION_REPLY_CAP_BYTES),
 * for the same reason: streamed provider output is untrusted input.
 */
export const MAX_SKILL_LLM_REPLY_BYTES = 256 * 1024;

/** Token counts a call reported (the shared `usage` ChatEvent shape). */
export interface SkillLlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/**
 * The provider client + concrete model one skill call rides. `providerId` is
 * what the spend ledger is keyed by (spend_ledger holds one row per provider),
 * so it is optional only to keep a test's fake client simple — a target with
 * no id is simply not ledger-charged.
 */
export interface SkillLlmTarget {
  client: ProviderClient;
  model: string;
  providerId?: string;
}

/**
 * Resolve the target for the CURRENT invocation, or null when nothing usable
 * is configured (`no_provider`). Injected into the runner so tests drive the
 * whole reach with a fake client and never touch the network.
 */
export type SkillLlmResolver = () => Promise<SkillLlmTarget | null> | SkillLlmTarget | null;

/**
 * The slice of the provider manager this needs (structural, like
 * `GenerationProviderSource`) — the model resolution is the gateway's job, not
 * this module's.
 */
export interface SkillLlmProviderSource {
  list(): ProviderSummary[];
  clientFor(id: string): Promise<ProviderClient>;
}

/**
 * The production resolver `createCore` injects into the runner: the chat task
 * class's provider + default model, or null.
 *
 * A provider that exists but cannot serve a call (missing key, keychain down)
 * is `clientFor` throwing — that is also null, because a skill asking for a
 * model call cannot and must not fall back to a `no_provider`-shaped success.
 */
export function createSkillLlmResolver(providers: SkillLlmProviderSource): SkillLlmResolver {
  return async (): Promise<SkillLlmTarget | null> => {
    const resolved = resolveChatModel({ providers: providers.list(), taskClass: 'chat' });
    if (resolved.provider === null || resolved.model.trim() === '') return null;
    try {
      const client = await providers.clientFor(resolved.provider.id);
      return { client, model: resolved.model, providerId: resolved.provider.id };
    } catch {
      return null;
    }
  };
}
