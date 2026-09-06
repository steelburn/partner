/**
 * M13 purpose-provider card helpers (web/src/lib/providers.ts) — pure
 * logic for which purposes should be pre-ticked when adding purpose
 * providers for an endpoint.
 */
import { describe, expect, it } from 'vitest';
import type { ProviderPurpose, ProviderSummary } from '@partner/shared';
import { suggestPurposesForAdd } from '../src/lib/providers.js';

function provider(overrides: Partial<ProviderSummary> & { id: string; purpose: ProviderPurpose }): ProviderSummary {
  return {
    name: overrides.id,
    kind: 'openai-compatible',
    source: 'manual',
    endpoint: 'https://api.ne1.dev/v1',
    defaultModels: ['m1'],
    enabled: true,
    budgetCents: null,
    createdAt: 1,
    updatedAt: 1,
    health: { ok: true, latencyMs: 1, error: null, models: ['m1'], checkedAt: 1 },
    ...overrides,
  };
}

describe('suggestPurposesForAdd', () => {
  it('suggests all six purposes when no provider exists at all', () => {
    expect(suggestPurposesForAdd('https://api.ne1.dev/v1', [])).toEqual([
      'general',
      'cheap',
      'deep',
      'coding',
      'vision',
      'research',
    ]);
  });

  it('suggests only the purposes a SAME endpoint is missing', () => {
    const existing = [
      provider({ id: 'a', purpose: 'general' }),
      provider({ id: 'b', purpose: 'vision' }),
    ];
    expect(suggestPurposesForAdd('https://api.ne1.dev/v1/', existing)).toEqual([
      'cheap',
      'deep',
      'coding',
      'research',
    ]);
    expect(suggestPurposesForAdd('https://api.ne1.dev/v1', existing)).toEqual([
      'cheap',
      'deep',
      'coding',
      'research',
    ]);
  });

  it('suggests nothing when the endpoint is new but other providers exist', () => {
    const other = [provider({ id: 'a', purpose: 'general', endpoint: 'https://other.example/v1' })];
    expect(suggestPurposesForAdd('https://vision.example/v1', other)).toEqual([]);
  });

  it('suggests nothing when the same endpoint already has every purpose', () => {
    const full = (['general', 'cheap', 'deep', 'coding', 'vision', 'research'] as ProviderPurpose[]).map(
      (purpose, i) => provider({ id: `p${i}`, purpose }),
    );
    expect(suggestPurposesForAdd('https://api.ne1.dev/v1', full)).toEqual([]);
  });
});
