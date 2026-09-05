/**
 * Spend ledger manager (M10 W3, PLAN-M10.md) — cumulative spend per provider
 * across turns, closing the M1 gap (the per-response tracker is capped
 * within one chat response; cumulative spend was never tracked).
 *
 * One row per provider in spend_ledger holds the CURRENT rolling budget
 * window (default 30 days). Semantics:
 *   - spent(providerId)        — cents in the current window (rolls an
 *                                 expired window back to zero lazily).
 *   - charge(providerId, cents) — persist a settlement for the window;
 *                                 returns the new total + whether a
 *                                 configured cap (checked by the caller) is
 *                                 now over.
 *   - reset(providerId)         — clear the window (budget changed to off).
 *
 * The manager holds no secrets and never sees model/usage details beyond
 * cents. Over-budget refusal happens BEFORE a turn streams (route layer);
 * mid-stream hard stops remain the M1 per-response tracker's job.
 */
import type { SpendLedgerStore } from '../stores/types.js';

export const SPEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // rolling 30 days

export interface SpendLedgerOptions {
  store: SpendLedgerStore;
  /** Rolling window length; default {@link SPEND_WINDOW_MS}. */
  windowMs?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface SpendCharge {
  providerId: string;
  /** Cents to add to the current window. */
  cents: number;
}

export interface SpendChargeResult {
  /** Cents spent in the current window AFTER this charge. */
  spentCents: number;
  /** Epoch ms the current window started. */
  windowStart: number;
}

export interface SpendLedgerManager {
  /** Cents spent in the provider's CURRENT window (lazily rolls expired). */
  spent(providerId: string): number;
  /** Settle cents into the current window; returns the new total + start. */
  charge(input: SpendCharge): SpendChargeResult;
  /** Drop the ledger row (provider removed / budget turned off). */
  reset(providerId: string): void;
}

export function createSpendLedgerManager(options: SpendLedgerOptions): SpendLedgerManager {
  const { store } = options;
  const windowMs = options.windowMs ?? SPEND_WINDOW_MS;
  const now = options.now ?? Date.now;

  /** Current-window row for a provider; rolls an expired window to zero. */
  function currentRow(providerId: string): { windowStart: number; cents: number } {
    const row = store.find(providerId);
    const at = now();
    if (row === undefined) {
      return { windowStart: at, cents: 0 };
    }
    if (at - row.windowStart >= windowMs) {
      // Window rolled: record the fresh window so the next read is cheap.
      store.upsert({ providerId, windowStart: at, cents: 0, updatedAt: at });
      return { windowStart: at, cents: 0 };
    }
    return { windowStart: row.windowStart, cents: row.cents };
  }

  return {
    spent(providerId: string): number {
      return currentRow(providerId).cents;
    },
    charge(input: SpendCharge): SpendChargeResult {
      const at = now();
      const { windowStart, cents } = currentRow(input.providerId);
      const spentCents = cents + Math.max(0, Math.round(input.cents));
      store.upsert({
        providerId: input.providerId,
        windowStart,
        cents: spentCents,
        updatedAt: at,
      });
      return { spentCents, windowStart };
    },
    reset(providerId: string): void {
      store.remove(providerId);
    },
  };
}
