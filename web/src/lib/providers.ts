/**
 * DOM-free logic for the Providers screen (M1). Kept out of the component so
 * it is unit-testable in the node vitest env (no jsdom). Rendering is
 * presentational only; every rule that decides labels, validation and
 * formatting lives here.
 */

import type { ProviderHealth, ProviderPurpose, ProviderSource, ProviderSummary } from '@partner/shared';
import { PROVIDER_PURPOSES } from '@partner/shared';

/** Display labels for the provider `source` wire field. */
export const SOURCE_LABELS: Record<ProviderSource, string> = {
  manual: 'Manual',
  'llm-self-service': 'llm-self-service',
};

/** One-line purpose tag for a provider (M11 F4). */
const PURPOSE_LABELS: Record<ProviderPurpose, string> = {
  general: 'General',
  cheap: 'Cheap',
  deep: 'Deep',
  coding: 'Coding',
  vision: 'Vision',
  research: 'Research',
};

export function purposeLabel(purpose: ProviderPurpose): string {
  return PURPOSE_LABELS[purpose] ?? 'General';
}

export function sourceLabel(source: ProviderSource): string {
  return SOURCE_LABELS[source];
}

/** Split a comma-separated model list; trims and drops empty entries. */
export function parseModelList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * M13: which purposes should be PRE-TICKED for the purpose-provider card.
 * Same endpoint already has profiles -> only the purposes it is missing;
 * no providers at all -> all six; providers exist but none for this
 * endpoint -> nothing (a dedicated endpoint such as a second Vision
 * provider usually adds one purpose, not a second full set).
 */
export function suggestPurposesForAdd(
  endpoint: string,
  providers: ProviderSummary[],
): ProviderPurpose[] {
  const key = normalizeEndpoint(endpoint);
  const sameEndpoint = providers.filter((p) => p.endpoint === key);
  if (sameEndpoint.length > 0) {
    const present = new Set(sameEndpoint.map((p) => p.purpose));
    return PROVIDER_PURPOSES.filter((p) => !present.has(p));
  }
  if (providers.length === 0) return [...PROVIDER_PURPOSES];
  return [];
}

export type BudgetParse =
  | { ok: true; budgetCents: number | null }
  | { ok: false; error: string };

/**
 * Parse an optional USD budget ("2.50") into integer cents. Empty input means
 * "no cap" (null); at most two decimal places are accepted.
 */
export function parseBudgetDollars(raw: string): BudgetParse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, budgetCents: null };
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    return { ok: false, error: 'Enter a dollar amount like 2.50, or leave it empty.' };
  }
  return { ok: true, budgetCents: Math.round(Number(trimmed) * 100) };
}

/** Strip surrounding whitespace and any trailing slashes from an endpoint. */
export function normalizeEndpoint(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Validate an OpenAI-compatible base URL. Returns an error message or null. */
export function validateEndpoint(raw: string): string | null {
  const endpoint = normalizeEndpoint(raw);
  if (endpoint.length === 0) return 'Endpoint is required.';
  if (!/^https?:\/\//.test(endpoint)) {
    return 'Endpoint must start with https:// or http://';
  }
  return null;
}

/**
 * Human label for a provider budget cap in cents. null when the cap is off.
 * 200 -> "$2 / 30-day window", 250 -> "$2.50 / 30-day window", 255 -> "$2.55 …".
 */
export function budgetLabel(budgetCents: number | null): string | null {
  if (budgetCents === null || !Number.isFinite(budgetCents)) return null;
  const dollars = (budgetCents / 100).toFixed(2).replace(/\.00$/, '');
  return `$${dollars} / 30-day window`;
}

/**
 * Remaining-budget fragment for a budgeted provider when the core reports
 * current window spend (M10 ledger). null when there is no cap or no spend
 * data. 1000/250 -> "$7.50 of $10 left this window".
 */
export function remainingBudgetLabel(
  budgetCents: number | null | undefined,
  spentCents: number | null | undefined,
): string | null {
  if (
    budgetCents === null ||
    budgetCents === undefined ||
    !Number.isFinite(budgetCents) ||
    spentCents === null ||
    spentCents === undefined ||
    !Number.isFinite(spentCents)
  ) {
    return null;
  }
  const left = Math.max(0, budgetCents - spentCents);
  const money = (cents: number): string =>
    `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`;
  return `${money(left)} of ${money(budgetCents)} left this window`;
}

export type HealthTone = 'ok' | 'error' | 'unknown';

export interface HealthLine {
  tone: HealthTone;
  /** Plain text for the provider's health line. */
  text: string;
}

/**
 * Render the ProviderHealth wire shape as one human line. `modelCount` is the
 * number of models the provider currently reports (stored defaultModels, with
 * the last probe's health.models as fallback — decided by the caller).
 */
export function describeHealth(health: ProviderHealth, modelCount: number): HealthLine {
  if (health.ok) {
    const parts = ['Healthy'];
    if (typeof health.latencyMs === 'number') parts.push(`${health.latencyMs} ms`);
    if (modelCount > 0) parts.push(`${modelCount} ${modelCount === 1 ? 'model' : 'models'}`);
    return { tone: 'ok', text: parts.join(' · ') };
  }
  if (health.error) {
    const message = health.error.length <= 160 ? health.error : `${health.error.slice(0, 160)}…`;
    return { tone: 'error', text: message };
  }
  // Never probed yet (fresh profile) — nothing to report as a failure.
  return { tone: 'unknown', text: 'Not tested yet' };
}
