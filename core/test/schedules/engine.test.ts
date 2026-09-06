/**
 * M14 schedule engine (PLAN-M14.md S3) — pure next-fire math with fixed
 * anchors. Deterministic: all times computed in tz 'UTC' except the DST
 * case (America/New_York 2026 spring-forward), where civil times map through
 * Intl.
 */
import { describe, expect, it } from 'vitest';
import type { ScheduleWhen } from '@partner/shared';
import { epochOfCivil, nextFire, partsAt } from '../../src/schedules/engine.js';

const UTC = 'UTC';

describe('nextFire — daily', () => {
  it('fires at the next wall-clock time strictly after the anchor', () => {
    const when: ScheduleWhen = { kind: 'daily', hour: 8, minute: 0 };
    const before = Date.UTC(2026, 0, 12, 7, 59, 0);
    expect(nextFire(when, UTC, before)).toBe(Date.UTC(2026, 0, 12, 8, 0, 0));
  });

  it('rolls to the next day when the anchor is at/after the fire time', () => {
    const when: ScheduleWhen = { kind: 'daily', hour: 8, minute: 0 };
    const at = Date.UTC(2026, 0, 12, 8, 0, 0, 1);
    expect(nextFire(when, UTC, at)).toBe(Date.UTC(2026, 0, 13, 8, 0, 0));
    const after = Date.UTC(2026, 0, 12, 23, 59, 59);
    expect(nextFire(when, UTC, after)).toBe(Date.UTC(2026, 0, 13, 8, 0, 0));
  });

  it('crosses month boundaries (Feb -> Mar, non-leap 2026)', () => {
    const when: ScheduleWhen = { kind: 'daily', hour: 9, minute: 30 };
    expect(nextFire(when, UTC, Date.UTC(2026, 11, 31, 10, 0))).toBe(
      Date.UTC(2027, 0, 1, 9, 30, 0),
    );
    expect(nextFire(when, UTC, Date.UTC(2026, 1, 27, 10, 0))).toBe(
      Date.UTC(2026, 1, 28, 9, 30, 0),
    );
  });
});

describe('nextFire — weekly', () => {
  it('fires the same weekday later the same day when time allows', () => {
    // Wednesday 2026-01-07 08:00 UTC.
    const when: ScheduleWhen = { kind: 'weekly', weekday: 2, hour: 8, minute: 0 };
    expect(nextFire(when, UTC, Date.UTC(2026, 0, 7, 7, 0))).toBe(
      Date.UTC(2026, 0, 7, 8, 0, 0),
    );
  });

  it('rolls to next week when the anchor passed today\'s fire time', () => {
    const when: ScheduleWhen = { kind: 'weekly', weekday: 2, hour: 8, minute: 0 };
    // Wed 2026-01-07 09:00 — today's 08:00 already passed.
    expect(nextFire(when, UTC, Date.UTC(2026, 0, 7, 9, 0))).toBe(
      Date.UTC(2026, 0, 14, 8, 0, 0),
    );
  });

  it('finds the next matching weekday across the weekend', () => {
    // Friday 2026-01-09; schedule Monday.
    const when: ScheduleWhen = { kind: 'weekly', weekday: 0, hour: 6, minute: 0 };
    expect(nextFire(when, UTC, Date.UTC(2026, 0, 9, 12, 0))).toBe(
      Date.UTC(2026, 0, 12, 6, 0, 0),
    );
  });
});

describe('nextFire — interval', () => {
  it('fires every N minutes from the anchor', () => {
    const when: ScheduleWhen = { kind: 'interval', everyMinutes: 30 };
    expect(nextFire(when, UTC, Date.UTC(2026, 0, 1, 0, 0, 0))).toBe(
      Date.UTC(2026, 0, 1, 0, 30, 0),
    );
  });
});

describe('timezone handling', () => {
  it('keeps wall-clock semantics across timezones', () => {
    // 08:00 Berlin on Jan 12 2026 == 07:00 UTC.
    const when: ScheduleWhen = { kind: 'daily', hour: 8, minute: 0 };
    const anchor = Date.UTC(2026, 0, 11, 23, 0, 0); // Jan 12 00:00 Berlin
    const fire = nextFire(when, 'Europe/Berlin', anchor);
    expect(fire).toBe(Date.UTC(2026, 0, 12, 7, 0, 0));
    const parts = partsAt(fire, 'Europe/Berlin');
    expect([parts.hour, parts.minute]).toEqual([8, 0]);
  });

  it('maps spring-forward gap times deterministically (America/New_York 2026)', () => {
    // 2026-03-08 02:00 EST -> 03:00 EDT (clocks jump forward).
    const when: ScheduleWhen = { kind: 'daily', hour: 2, minute: 30 };
    const anchor = Date.UTC(2026, 2, 8, 5, 0, 0); // Mar 8 00:00 EST
    const fire = nextFire(when, 'America/New_York', anchor);
    // 02:30 EST does not exist; Intl maps civil 02:30 to 03:30 EDT == 07:30 UTC.
    expect(fire).toBe(Date.UTC(2026, 2, 8, 7, 30, 0));
  });
});

describe('epochOfCivil', () => {
  it('is the inverse of partsAt for normal times', () => {
    const probe = Date.UTC(2026, 6, 14, 12, 45, 0);
    const p = partsAt(probe, UTC);
    expect(epochOfCivil(p.year, p.month, p.day, p.hour, p.minute, UTC)).toBe(probe);
  });
});
