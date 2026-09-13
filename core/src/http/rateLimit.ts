/**
 * Fixed-window rate limiter (PLAN-M20-B S7) — PURE, no imports.
 *
 * HONESTLY PER-PROCESS: counters live in this process's memory only. Running
 * two cores behind a proxy, or behind a load balancer, gives each process its
 * own budget — it is NOT a distributed limiter and must not be described as
 * one. It is the cheap first line in front of `POST /v1/pair` (a per-IP limit
 * plus the pairing/secret attempt lock), not a quota system.
 *
 * One window per key, started by that key's first call: `check()` counts up
 * until `limit`, then refuses with `retryAfterMs` until the window elapses,
 * when the counter starts again. `now` is injectable so the window boundary is
 * testable without sleeping.
 *
 * Fail-closed rules (an over-permissive limiter is a vulnerability):
 *  - a key we cannot attribute (missing/blank/non-string — e.g. an undefined
 *    `req.ip`) is REFUSED with `reason: 'invalid_key'` rather than sharing one
 *    anonymous bucket;
 *  - a non-finite clock reading REFUSES with `reason: 'invalid_clock'` instead
 *    of counting against a window that will never elapse;
 *  - a configuration that cannot limit anything (limit/windowMs/maxKeys not a
 *    positive integer) THROWS at construction, so a typo cannot silently ship
 *    an unlimited limiter.
 *
 * `maxKeys` bounds the table so a flood of distinct (e.g. spoofed) keys cannot
 * exhaust memory: the oldest live window is evicted first. That eviction
 * LOSES a counter, so a flood can retire a real client's budget — set
 * `maxKeys` above the number of distinct clients you expect per window. The
 * alternative (refusing new keys when the table is full) turns an IP flood
 * into an outage for everyone.
 */

export interface RateLimitOptions {
  /** Calls allowed per key per window (default 10). */
  limit?: number;
  /** Window length in ms (default 60_000). */
  windowMs?: number;
  /** Buckets kept in memory (default 10_000). */
  maxKeys?: number;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export interface RateLimitAllowed {
  allowed: true;
  /** Configured limit, echoed so the caller can advertise it. */
  limit: number;
  remaining: number;
  /** Epoch ms when this key's window ends and the counter resets. */
  resetAt: number;
  retryAfterMs: 0;
}

export interface RateLimitDenied {
  allowed: false;
  reason: 'rate_limited' | 'invalid_key' | 'invalid_clock';
  limit: number;
  remaining: 0;
  /** Epoch ms when the window ends (0 when there is no window to report). */
  resetAt: number;
  retryAfterMs: number;
}

export type RateLimitResult = RateLimitAllowed | RateLimitDenied;

export interface RateLimiter {
  readonly limit: number;
  readonly windowMs: number;
  /** Count one call for `key`; never throws, always answers allow/deny. */
  check(key: string): RateLimitResult;
  /** Forget a key's window (e.g. after a successful verification). */
  reset(key: string): void;
}

const DEFAULT_LIMIT = 10;
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_KEYS = 10_000;

function positiveIntOption(name: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new RangeError(`rate limit: ${name} must be a positive integer (got ${String(value)})`);
  }
  return value;
}

export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const limit = positiveIntOption('limit', options.limit, DEFAULT_LIMIT);
  const windowMs = positiveIntOption('windowMs', options.windowMs, DEFAULT_WINDOW_MS);
  const maxKeys = positiveIntOption('maxKeys', options.maxKeys, DEFAULT_MAX_KEYS);
  const now = options.now ?? Date.now;

  const buckets = new Map<string, { count: number; resetAt: number }>();

  const refuse = (reason: RateLimitDenied['reason'], resetAt = 0, retryAfterMs = 0): RateLimitDenied => ({
    allowed: false,
    reason,
    limit,
    remaining: 0,
    resetAt,
    retryAfterMs,
  });

  /** Drop the window that ends soonest (a stale window ends soonest). */
  const evictOldest = (): void => {
    let oldestKey: string | null = null;
    let oldestReset = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt < oldestReset) {
        oldestReset = bucket.resetAt;
        oldestKey = key;
      }
    }
    if (oldestKey !== null) buckets.delete(oldestKey);
  };

  return {
    limit,
    windowMs,

    check(key: string): RateLimitResult {
      const at = now();
      if (!Number.isFinite(at)) return refuse('invalid_clock');
      if (typeof key !== 'string' || key.trim().length === 0) return refuse('invalid_key');

      const bucket = buckets.get(key);
      if (!bucket || at >= bucket.resetAt) {
        buckets.set(key, { count: 1, resetAt: at + windowMs });
        while (buckets.size > maxKeys) evictOldest();
        return { allowed: true, limit, remaining: limit - 1, resetAt: at + windowMs, retryAfterMs: 0 };
      }

      if (bucket.count >= limit) {
        return refuse('rate_limited', bucket.resetAt, bucket.resetAt - at);
      }

      bucket.count += 1;
      return { allowed: true, limit, remaining: limit - bucket.count, resetAt: bucket.resetAt, retryAfterMs: 0 };
    },

    reset(key: string): void {
      buckets.delete(key);
    },
  };
}
