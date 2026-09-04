/**
 * Budget tracker tests (PLAN-M1 "budget", TDD 6-7): caps default OFF; money
 * caps trip on priced models via the bundled table; request caps trip after N
 * requests; an unpriceable model falls back to the request cap ONLY.
 */
import { describe, expect, it } from 'vitest';
import { createBudgetTracker } from '../../src/gateway/budget.js';
import { priceForModel } from '../../src/gateway/pricing.js';

const PRICED = 'gpt-4o'; // in the bundled table
const UNKNOWN = 'custom-frontier-2000';

describe('pricing table', () => {
  it('resolves a common model and rejects unknowns', () => {
    expect(priceForModel('gpt-4o-2024-11-20')).toEqual({ usdPerMToken: 5.0 });
    // Longest matcher wins: a mini model must not fall through to gpt-4o.
    expect(priceForModel('gpt-4o-mini')).toEqual({ usdPerMToken: 0.6 });
    expect(priceForModel(UNKNOWN)).toBeNull();
  });
});

describe('default: caps off', () => {
  it('never reports over, but still accumulates spend + requests', () => {
    const tracker = createBudgetTracker();
    expect(tracker.limitCents).toBeNull();
    expect(tracker.limitRequests).toBeNull();
    for (let i = 0; i < 50; i++) {
      const rec = tracker.record({ model: PRICED, totalTokens: 2_000 }); // 1 cent each
      expect(rec.over).toBe(false);
    }
    expect(tracker.spentCents).toBe(50);
    expect(tracker.requests).toBe(50);
  });
});

describe('money cap (priced model)', () => {
  it('trips budget_reached when cumulative spend reaches budgetCents', () => {
    const tracker = createBudgetTracker({ budgetCents: 3 });
    expect(tracker.record({ model: PRICED, totalTokens: 2_000 })).toMatchObject({ over: false, spentCents: 1, requests: 1 });
    expect(tracker.record({ model: PRICED, totalTokens: 2_000 })).toMatchObject({ over: false, spentCents: 2, requests: 2 });
    const third = tracker.record({ model: PRICED, totalTokens: 2_000 });
    expect(third.over).toBe(true);
    expect(third.spentCents).toBe(3);
    expect(third.requests).toBe(3);
  });
});

describe('request cap', () => {
  it('trips after N requests even with no money cap', () => {
    const tracker = createBudgetTracker({ maxRequests: 2 });
    expect(tracker.record({ model: PRICED, totalTokens: 0 }).over).toBe(false);
    const second = tracker.record({ model: PRICED, totalTokens: 0 });
    expect(second.over).toBe(true);
    expect(second.requests).toBe(2);
  });
});

describe('unknown model -> request cap only', () => {
  it('accrues no spend and is stopped only by maxRequests', () => {
    const tracker = createBudgetTracker({ budgetCents: 100, maxRequests: 2 });
    const first = tracker.record({ model: UNKNOWN, totalTokens: 1_000_000 });
    expect(first.spentCents).toBe(0);
    expect(first.over).toBe(false);
    const second = tracker.record({ model: UNKNOWN, totalTokens: 1_000_000 });
    expect(second.spentCents).toBe(0);
    expect(second.over).toBe(true); // request cap, not money
  });

  it('an unpriceable model with only a money cap can never trip', () => {
    const tracker = createBudgetTracker({ budgetCents: 1 });
    for (let i = 0; i < 100; i++) {
      expect(tracker.record({ model: UNKNOWN, totalTokens: 1_000_000 }).over).toBe(false);
    }
    expect(tracker.spentCents).toBe(0);
  });
});

describe('reset', () => {
  it('clears counters for a new session', () => {
    const tracker = createBudgetTracker({ budgetCents: 3 });
    tracker.record({ model: PRICED, totalTokens: 2_000 });
    expect(tracker.spentCents).toBe(1);
    tracker.reset();
    expect(tracker.spentCents).toBe(0);
    expect(tracker.requests).toBe(0);
    expect(tracker.record({ model: PRICED, totalTokens: 2_000 })).toMatchObject({ over: false, requests: 1 });
  });
});
