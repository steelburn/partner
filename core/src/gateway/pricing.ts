/**
 * Bundled per-model USD price table (M1 budget caps, PLAN-M1.md).
 *
 * Defense-in-depth: Partner's optional per-session spend caps are charged
 * against this small static table so a runaway task cannot silently burn a
 * metered key. Prices are blended USD per 1M tokens (input+output averaged)
 * for common models. Models NOT in the table fall back to
 * {@link DEFAULT_USD_PER_MT} (a conservative blended default) so the money
 * cap always binds — never a silent 'unpriceable model'. The table is
 * deliberately static in v1 and is overridable later.
 */

export interface ModelPrice {
  /** Blended USD per 1M tokens. */
  usdPerMToken: number;
}

/** Conservative blended USD/1M for models absent from the table. */
export const DEFAULT_USD_PER_MT = 2.0;

/**
 * (match-substring, blended USD / 1M tokens). Longer matchers win so
 * `gpt-4.1-mini` never falls through to the `gpt-4`/`gpt-4.1` rows.
 */
const PRICE_TABLE: ReadonlyArray<{ match: string; usdPerMToken: number }> = [
  { match: 'claude-3-5-haiku', usdPerMToken: 1.0 },
  { match: 'claude-3-5-sonnet', usdPerMToken: 4.5 },
  { match: 'claude-opus', usdPerMToken: 40.0 },
  { match: 'claude-sonnet', usdPerMToken: 3.0 },
  { match: 'claude-haiku', usdPerMToken: 0.8 },
  { match: 'gpt-4.1-mini', usdPerMToken: 1.0 },
  { match: 'gpt-4.1-nano', usdPerMToken: 0.2 },
  { match: 'gpt-4.1', usdPerMToken: 4.0 },
  { match: 'gpt-4o-mini', usdPerMToken: 0.6 },
  { match: 'gpt-4o', usdPerMToken: 5.0 },
  { match: 'gpt-4', usdPerMToken: 30.0 },
  { match: 'gemini-1.5-pro', usdPerMToken: 7.0 },
  { match: 'gemini-1.5-flash', usdPerMToken: 0.6 },
  { match: 'gemini-2.0-flash', usdPerMToken: 1.0 },
].sort((a, b) => b.match.length - a.match.length);

/** Price for a model id; unknown models get the conservative default. */
export function priceForModel(model: string): ModelPrice {
  const needle = String(model ?? '').toLowerCase();
  if (needle === '') return { usdPerMToken: DEFAULT_USD_PER_MT };
  for (const row of PRICE_TABLE) {
    if (needle.includes(row.match)) return { usdPerMToken: row.usdPerMToken };
  }
  return { usdPerMToken: DEFAULT_USD_PER_MT };
}

/** tokens * usdPerMToken / 1_000_000 tokens * 100 cents = cents. */
export function centsForTokens(model: string, totalTokens: number): number {
  if (!Number.isFinite(totalTokens) || totalTokens <= 0) return 0;
  return Math.round((totalTokens * priceForModel(model).usdPerMToken) / 10_000);
}
