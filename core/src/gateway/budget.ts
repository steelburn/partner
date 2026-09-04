/**
 * Budget tracker (M1 defense-in-depth caps, PLAN-M1.md §11 / PLAN-M1 "budget").
 *
 * Defaults OFF: with no budgetCents and no maxRequests the tracker never
 * reports over. Money is charged against the bundled pricing table
 * ({@link priceForModel}); a model with no price entry accrues NO money and
 * can only be stopped by the request-count cap. Caps are per chat session —
 * callers create one tracker per session and reset() between sessions.
 */
import { priceForModel } from './pricing.js';

export interface BudgetOptions {
  /** Optional per-session spend cap in USD cents (null/undefined = off). */
  budgetCents?: number | null;
  /** Optional per-session request cap (null/undefined = off). */
  maxRequests?: number | null;
}

/** One usage report as charged by the chat route (see ChatEvent 'usage'). */
export interface UsageCharge {
  model: string;
  totalTokens: number;
}

export interface BudgetRecord {
  /** True when either configured cap has been reached/exceeded. */
  over: boolean;
  /** Cumulative charged spend in USD cents (0 for unpriceable models). */
  spentCents: number;
  /** Cumulative requests recorded. */
  requests: number;
}

export interface BudgetTracker {
  /** Charge one usage report; returns whether a cap has been hit. */
  record(usage: UsageCharge): BudgetRecord;
  /** Reset counters for a new session. */
  reset(): void;
  spentCents: number;
  requests: number;
  limitCents: number | null;
  limitRequests: number | null;
}

/** tokens * usdPerMToken / 1_000_000 tokens * 100 cents = cents. */
function centsFor(totalTokens: number, usdPerMToken: number): number {
  return Math.round((totalTokens * usdPerMToken) / 10_000);
}

export function createBudgetTracker(options: BudgetOptions = {}): BudgetTracker {
  const limitCents = options.budgetCents ?? null;
  const limitRequests = options.maxRequests ?? null;
  let spentCents = 0;
  let requests = 0;

  const record = (usage: UsageCharge): BudgetRecord => {
    requests += 1;
    const price = priceForModel(usage.model);
    if (price !== null && typeof usage.totalTokens === 'number' && usage.totalTokens > 0) {
      spentCents += centsFor(usage.totalTokens, price.usdPerMToken);
    }
    const moneyOver = limitCents !== null && spentCents >= limitCents;
    const requestOver = limitRequests !== null && requests >= limitRequests;
    return { over: moneyOver || requestOver, spentCents, requests };
  };

  return {
    record,
    reset(): void {
      spentCents = 0;
      requests = 0;
    },
    get spentCents(): number {
      return spentCents;
    },
    get requests(): number {
      return requests;
    },
    limitCents,
    limitRequests,
  };
}
