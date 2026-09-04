/**
 * Budget tracker (M1 defense-in-depth spend caps, PLAN-M1.md 'budget').
 *
 * Defaults OFF: with no budgetCents the tracker never reports over. Money is
 * charged against the bundled pricing table ({@link priceForModel}) which
 * FALLS BACK to a conservative default for unknown models — so a configured
 * cap always binds; there is no silent 'unpriceable model'.
 *
 * Semantics (M1): the cap is a hard stop WITHIN one chat response — the route
 * charges per delta chunk (estimated tokens) and aborts the upstream stream
 * as soon as the cap is exceeded, emitting one budget_reached event. Final
 * usage reconciles the estimate. Cumulative spend across separate turns
 * belongs to the conversation store (M3) — documented limitation.
 */
import { centsForTokens } from './pricing.js';

export interface BudgetOptions {
  /** Optional spend cap in USD cents (null/undefined = off). */
  budgetCents?: number | null;
}

export interface BudgetCharge {
  model: string;
  /** Actual token count from a usage event (or an estimate). */
  totalTokens: number;
}

export interface BudgetRecord {
  /** True when the configured cap has been reached/exceeded. */
  over: boolean;
  /** Cumulative charged spend in USD cents. */
  spentCents: number;
}

export interface BudgetTracker {
  /** Charge tokens for a model; returns whether the cap has been hit. */
  charge(usage: BudgetCharge): BudgetRecord;
  /** Reset counters. */
  reset(): void;
  spentCents: number;
  limitCents: number | null;
}

export function createBudgetTracker(options: BudgetOptions = {}): BudgetTracker {
  const limitCents = options.budgetCents ?? null;
  let spentCents = 0;

  const charge = (usage: BudgetCharge): BudgetRecord => {
    spentCents += centsForTokens(usage.model, usage.totalTokens);
    const over = limitCents !== null && spentCents >= limitCents;
    return { over, spentCents };
  };

  return {
    charge,
    reset(): void {
      spentCents = 0;
    },
    get spentCents(): number {
      return spentCents;
    },
    get limitCents(): number | null {
      return limitCents;
    },
  };
}
