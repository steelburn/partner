import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../../src/http/rateLimit.js';
import type { RateLimitResult } from '../../src/http/rateLimit.js';

const T0 = 1_700_000_000_000;

function make(limit = 3, windowMs = 1_000, maxKeys?: number) {
  let now = T0;
  const limiter = createRateLimiter({
    limit,
    windowMs,
    ...(maxKeys === undefined ? {} : { maxKeys }),
    now: () => now,
  });
  return { limiter, at: (value: number) => (now = value), advance: (ms: number) => (now += ms) };
}

const denied = (result: RateLimitResult): result is Extract<RateLimitResult, { allowed: false }> =>
  !result.allowed;

describe('fixed-window per-IP limiter', () => {
  it('allows exactly `limit` calls in a window, then refuses', () => {
    const { limiter } = make(3, 1_000);

    expect(limiter.check('127.0.0.1')).toEqual({
      allowed: true,
      limit: 3,
      remaining: 2,
      resetAt: T0 + 1_000,
      retryAfterMs: 0,
    });
    expect(limiter.check('127.0.0.1').allowed).toBe(true);
    expect(limiter.check('127.0.0.1')).toEqual({
      allowed: true,
      limit: 3,
      remaining: 0,
      resetAt: T0 + 1_000,
      retryAfterMs: 0,
    });

    expect(limiter.check('127.0.0.1')).toEqual({
      allowed: false,
      reason: 'rate_limited',
      limit: 3,
      remaining: 0,
      resetAt: T0 + 1_000,
      retryAfterMs: 1_000,
    });
  });

  it('keeps one window per key: one exhausted key does not refuse another', () => {
    const { limiter } = make(1, 1_000);
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    expect(denied(limiter.check('10.0.0.1'))).toBe(true);
    expect(limiter.check('10.0.0.2')).toEqual({
      allowed: true,
      limit: 1,
      remaining: 0,
      resetAt: T0 + 1_000,
      retryAfterMs: 0,
    });
  });

  it('resets the counter when the window elapses', () => {
    const { limiter, at } = make(1, 1_000);
    expect(limiter.check('10.0.0.1').allowed).toBe(true);

    at(T0 + 999); // still inside the window
    expect(denied(limiter.check('10.0.0.1'))).toBe(true);

    at(T0 + 1_000); // window boundary: a new window starts
    expect(limiter.check('10.0.0.1')).toEqual({
      allowed: true,
      limit: 1,
      remaining: 0,
      resetAt: T0 + 2_000,
      retryAfterMs: 0,
    });
  });

  it('reset() clears a key, and unknown keys are a no-op', () => {
    const { limiter } = make(1, 1_000);
    limiter.check('10.0.0.1');
    expect(denied(limiter.check('10.0.0.1'))).toBe(true);

    limiter.reset('10.0.0.1');
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    expect(() => limiter.reset('never-seen')).not.toThrow();
  });

  it('refuses an unusable key instead of counting it against a shared bucket', () => {
    const { limiter } = make(1, 1_000);
    for (const key of ['', '   ', undefined, null, 7, {}]) {
      expect(limiter.check(key as unknown as string)).toEqual({
        allowed: false,
        reason: 'invalid_key',
        limit: 1,
        remaining: 0,
        resetAt: 0,
        retryAfterMs: 0,
      });
    }
    // The refusals did not consume the budget of any real key.
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
  });

  it('refuses when the clock is unusable rather than counting on it', () => {
    for (const broken of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const limiter = createRateLimiter({ limit: 1, windowMs: 1_000, now: () => broken });
      expect(limiter.check('10.0.0.1')).toEqual({
        allowed: false,
        reason: 'invalid_clock',
        limit: 1,
        remaining: 0,
        resetAt: 0,
        retryAfterMs: 0,
      });
    }
  });

  it('bounds its table, and eviction visibly loosens the limit for the evicted key', () => {
    // The honest cost of a bounded per-IP table: the oldest live window is
    // dropped, so a flood of distinct keys can retire a real client's counter.
    const { limiter } = make(1, 1_000, 1);
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    expect(denied(limiter.check('10.0.0.1'))).toBe(true);

    expect(limiter.check('10.0.0.2').allowed).toBe(true); // evicts 10.0.0.1
    expect(limiter.check('10.0.0.1').allowed).toBe(true); // counter is gone
  });

  it('keeps the table bounded under a flood of distinct keys', () => {
    const { limiter } = make(2, 1_000, 2);
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    expect(limiter.check('10.0.0.1').allowed).toBe(true);
    expect(denied(limiter.check('10.0.0.1'))).toBe(true);

    for (let i = 0; i < 50; i += 1) expect(limiter.check(`10.0.0.${i + 10}`).allowed).toBe(true);

    // Only the two newest windows can be live, so this key's exhausted counter
    // is gone and it gets a FULL budget back — the eviction cost, stated.
    expect(limiter.check('10.0.0.1')).toEqual({
      allowed: true,
      limit: 2,
      remaining: 1,
      resetAt: T0 + 1_000,
      retryAfterMs: 0,
    });
  });
});

describe('limiter configuration', () => {
  it('defaults to 10 per minute', () => {
    const limiter = createRateLimiter({ now: () => T0 });
    expect(limiter.limit).toBe(10);
    expect(limiter.windowMs).toBe(60_000);
  });

  it('refuses a config that would disable the limiter', () => {
    for (const options of [
      { limit: 0 },
      { limit: -1 },
      { limit: 1.5 },
      { limit: Number.NaN },
      { limit: Number.POSITIVE_INFINITY },
      { limit: '5' as unknown as number },
      { limit: null as unknown as number },
      { windowMs: 0 },
      { windowMs: -1000 },
      { windowMs: Number.NaN },
      { windowMs: '60000' as unknown as number },
      { maxKeys: 0 },
      { maxKeys: -1 },
      { maxKeys: Number.NaN },
    ]) {
      expect(() => createRateLimiter(options)).toThrow(RangeError);
    }
  });

  it('accepts an explicit usable config', () => {
    for (const options of [
      {},
      { limit: 1, windowMs: 1 },
      { limit: 100, windowMs: 3_600_000, maxKeys: 5 },
    ]) {
      expect(() => createRateLimiter(options)).not.toThrow();
    }
  });
});
