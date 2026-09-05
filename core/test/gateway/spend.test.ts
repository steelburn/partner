/**
 * M10 spend ledger manager tests (PLAN-M10 W3): cumulative per-provider
 * spend with a lazy rolling 30-day window — charge settles cents into the
 * current window, an expired window rolls back to zero, totals persist
 * across manager instances over the same store, reset clears a provider.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase, createSpendLedgerStore } from '../../src/stores/db.js';
import type { SpendLedgerStore } from '../../src/stores/types.js';
import {
  SPEND_WINDOW_MS,
  createSpendLedgerManager,
  type SpendLedgerManager,
} from '../../src/gateway/spend.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function makeStore(): { store: SpendLedgerStore; close(): void } {
  const db = openDatabase(':memory:');
  return { store: createSpendLedgerStore(db), close: () => db.close() };
}

describe('spend ledger manager', () => {
  it('accumulates charges and persists them across manager instances', () => {
    const { store, close } = makeStore();
    try {
      let clock = 1_000_000;
      const a = createSpendLedgerManager({ store, now: () => clock });
      expect(a.spent('p-1')).toBe(0);
      const first = a.charge({ providerId: 'p-1', cents: 123 });
      expect(first.spentCents).toBe(123);

      clock += 1000;
      const b = createSpendLedgerManager({ store, now: () => clock });
      expect(b.spent('p-1')).toBe(123); // survives reload
      const second = b.charge({ providerId: 'p-1', cents: 77 });
      expect(second.spentCents).toBe(200);
    } finally {
      close();
    }
  });

  it('keeps providers independent and normalizes malformed charges', () => {
    const { store, close } = makeStore();
    try {
      const m = createSpendLedgerManager({ store });
      m.charge({ providerId: 'p-a', cents: 10 });
      m.charge({ providerId: 'p-b', cents: 5 });
      expect(m.spent('p-a')).toBe(10);
      expect(m.spent('p-b')).toBe(5);
      // Rounds fractional cents; never lets a negative charge reduce spend.
      m.charge({ providerId: 'p-a', cents: 0.6 });
      expect(m.spent('p-a')).toBe(11);
      m.charge({ providerId: 'p-a', cents: -999 });
      expect(m.spent('p-a')).toBe(11);
    } finally {
      close();
    }
  });

  it('rolls an expired window back to zero lazily (30-day boundary)', () => {
    const { store, close } = makeStore();
    try {
      const start = 5_000_000;
      let clock = start;
      const m = createSpendLedgerManager({ store, now: () => clock });
      m.charge({ providerId: 'p-1', cents: 999 });
      expect(m.spent('p-1')).toBe(999);

      // Just under the window: spend survives.
      clock = start + SPEND_WINDOW_MS - 1;
      expect(m.spent('p-1')).toBe(999);

      // At/after the window: rolled to zero, fresh window recorded.
      clock = start + SPEND_WINDOW_MS;
      expect(m.spent('p-1')).toBe(0);
      expect(store.find('p-1')?.windowStart).toBe(clock);
      const charged = m.charge({ providerId: 'p-1', cents: 50 });
      expect(charged.spentCents).toBe(50);
      expect(charged.windowStart).toBe(clock);
    } finally {
      close();
    }
  });

  it('reset clears the row (provider removed / budget turned off)', () => {
    const { store, close } = makeStore();
    try {
      const m = createSpendLedgerManager({ store });
      m.charge({ providerId: 'p-1', cents: 42 });
      expect(m.spent('p-1')).toBe(42);
      m.reset('p-1');
      expect(m.spent('p-1')).toBe(0);
      expect(store.find('p-1')).toBeUndefined();
      // A second window start is a FRESH timestamp, not the old one.
      const after = m.charge({ providerId: 'p-1', cents: 1 });
      expect(after.windowStart).not.toBeLessThan(Date.now() - DAY_MS);
    } finally {
      close();
    }
  });
});
