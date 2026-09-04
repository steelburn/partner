/**
 * Budget tracker tests (PLAN-M1 "budget"): caps default OFF; a configured
 * money cap binds for EVERY model — unknown models fall back to the
 * conservative default price (DEFAULT_USD_PER_MT) so there is no silent
 * 'unpriceable model' that can never trip.
 */
import { describe, expect, it } from 'vitest';
import { createBudgetTracker } from '../../src/gateway/budget.js';
import { centsForTokens, DEFAULT_USD_PER_MT, priceForModel } from '../../src/gateway/pricing.js';

const PRICED = 'gpt-4o'; // in the bundled table (5 $/MT)
const UNKNOWN = 'custom-frontier-2000';

describe('pricing table', () => {
  it('resolves common models; longest matcher wins', () => {
    expect(priceForModel('gpt-4o-2024-11-20')).toEqual({ usdPerMToken: 5.0 });
    expect(priceForModel('gpt-4o-mini')).toEqual({ usdPerMToken: 0.6 }); // mini never falls through to gpt-4o
  });

  it('unknown models fall back to the conservative default (cap always binds)', () => {
    expect(priceForModel(UNKNOWN)).toEqual({ usdPerMToken: DEFAULT_USD_PER_MT });
    expect(DEFAULT_USD_PER_MT).toBeGreaterThan(0);
  });

  it('centsForTokens converts tokens to whole cents', () => {
    expect(centsForTokens(PRICED, 2_000)).toBe(1); // 2000 * 5 / 1e6 * 100
    expect(centsForTokens(UNKNOWN, 1_000_000)).toBe(200); // 1e6 * 2 / 1e6 * 100
    expect(centsForTokens(PRICED, 0)).toBe(0);
    expect(centsForTokens(PRICED, -5)).toBe(0);
  });
});

describe('default: caps off', () => {
  it('never reports over but still accumulates spend', () => {
    const tracker = createBudgetTracker();
    expect(tracker.limitCents).toBeNull();
    for (let i = 0; i < 50; i++) {
      const rec = tracker.charge({ model: PRICED, totalTokens: 2_000 }); // 1 cent each
      expect(rec.over).toBe(false);
    }
    expect(tracker.spentCents).toBe(50);
  });
});

describe('money cap (priced model)', () => {
  it('trips when cumulative spend reaches budgetCents', () => {
    const tracker = createBudgetTracker({ budgetCents: 3 });
    expect(tracker.charge({ model: PRICED, totalTokens: 2_000 })).toEqual({ over: false, spentCents: 1 });
    expect(tracker.charge({ model: PRICED, totalTokens: 2_000 })).toEqual({ over: false, spentCents: 2 });
    expect(tracker.charge({ model: PRICED, totalTokens: 2_000 })).toEqual({ over: true, spentCents: 3 });
  });
});

describe('unknown model money cap still binds (default price)', () => {
  it('accrues spend at the default rate and trips the cap', () => {
    const tracker = createBudgetTracker({ budgetCents: 100 });
    // 1M tokens at the 2 $/MT default = 200 cents > 100 cent cap -> over on the FIRST charge.
    expect(tracker.charge({ model: UNKNOWN, totalTokens: 1_000_000 })).toEqual({
      over: true,
      spentCents: 200,
    });
  });
});

describe('reset', () => {
  it('clears spend for a new session', () => {
    const tracker = createBudgetTracker({ budgetCents: 3 });
    tracker.charge({ model: PRICED, totalTokens: 2_000 });
    expect(tracker.spentCents).toBe(1);
    tracker.reset();
    expect(tracker.spentCents).toBe(0);
    expect(tracker.charge({ model: PRICED, totalTokens: 2_000 })).toEqual({ over: false, spentCents: 1 });
  });
});
