/**
 * M14 schedule validation (PLAN-M14.md S1) — pure shared rules.
 */
import { describe, expect, it } from 'vitest';
import type { PersonaSchedule } from '../src/schedules.js';
import {
  SCHEDULE_LIMITS,
  scheduleNextLabel,
  validateSchedule,
  validateSchedules,
} from '../src/schedules.js';

describe('validateSchedule', () => {
  const daily = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: 's-morning',
    label: 'Morning brief',
    when: { kind: 'daily', hour: 8, minute: 0 },
    prompt: 'Summarise yesterday and plan today.',
    ...overrides,
  });

  it('accepts a valid daily schedule with defaults applied', () => {
    const result = validateSchedule(daily(), 's');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.enabled).toBe(true);
    expect(result.value.tz).toBeUndefined();
    expect(result.value.maxRounds).toBeUndefined();
    expect(result.value.saveNote).toBeUndefined();
  });

  it('accepts weekly and interval kinds and trims strings', () => {
    const weekly = validateSchedule(
      { ...daily(), when: { kind: 'weekly', weekday: 0, hour: 18, minute: 30 } },
      's',
    );
    expect(weekly.ok).toBe(true);
    const interval = validateSchedule(
      { ...daily(), when: { kind: 'interval', everyMinutes: 120 } },
      's',
    );
    expect(interval.ok).toBe(true);
    const trimmed = validateSchedule({ ...daily({ label: '  x  ' }) }, 's');
    expect(trimmed.ok && trimmed.value.label).toBe('x');
  });

  it('rejects bad ids, labels, prompts, clocks, weekdays, intervals', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ ...daily({ id: 'bad id!' }) }, 'id'],
      [{ ...daily({ id: '' }) }, 'id'],
      [{ ...daily({ label: '' }) }, 'label'],
      [{ ...daily({ label: 'x'.repeat(SCHEDULE_LIMITS.labelMax + 1) }) }, 'label'],
      [{ ...daily({ prompt: '' }) }, 'prompt'],
      [{ ...daily({ prompt: 'x'.repeat(SCHEDULE_LIMITS.promptMax + 1) }) }, 'prompt'],
      [{ ...daily({ when: { kind: 'daily', hour: 24, minute: 0 } }) }, 'hour'],
      [{ ...daily({ when: { kind: 'daily', hour: 8, minute: 61 } }) }, 'minute'],
      [{ ...daily({ when: { kind: 'weekly', weekday: 7, hour: 8, minute: 0 } }) }, 'weekday'],
      [{ ...daily({ when: { kind: 'interval', everyMinutes: 1 } }) }, 'everyminutes'],
      [{ ...daily({ when: { kind: 'interval', everyMinutes: 20000 } }) }, 'everyminutes'],
      [{ ...daily({ when: { kind: 'cron', every: '*' } }) }, 'kind'],
      [{ ...daily({ tz: 'Not/AZone' }) }, 'tz'],
      [{ ...daily({ maxRounds: 0 }) }, 'rounds'],
      [{ ...daily({ maxRounds: 99 }) }, 'rounds'],
      [null, 'object'],
      ['x', 'object'],
    ];
    for (const [input, fragment] of cases) {
      const result = validateSchedule(input, 's');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('s');
      if (!result.ok && fragment !== 'kind' && fragment !== 'object') {
        expect(result.error.toLowerCase()).toContain(fragment);
      }
    }
  });

  it('clamps nothing silently — out-of-range rounds reject', () => {
    const result = validateSchedule({ ...daily({ maxRounds: 3 }) }, 's');
    expect(result.ok && result.value.maxRounds).toBe(3);
  });

  it('accepts a valid IANA tz and boolean flags', () => {
    const result = validateSchedule(
      { ...daily({ tz: 'Europe/Berlin', enabled: false, saveNote: true, maxRounds: 2 }) },
      's',
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.tz).toBe('Europe/Berlin');
    expect(result.value.enabled).toBe(false);
    expect(result.value.saveNote).toBe(true);
    expect(result.value.maxRounds).toBe(2);
  });
});

describe('validateSchedules', () => {
  const one = (id: string): Record<string, unknown> => ({
    id,
    label: `Label ${id}`,
    when: { kind: 'interval', everyMinutes: 60 },
    prompt: 'Check in.',
  });

  it('normalizes absent/empty to [] and rejects non-arrays', () => {
    expect(validateSchedules(undefined, 's').ok).toBe(true);
    expect(validateSchedules(null, 's').ok).toBe(true);
    expect(validateSchedules('x', 's').ok).toBe(false);
  });

  it('rejects duplicate ids and over-cap lists', () => {
    const dup = validateSchedules([one('a'), one('a')], 's');
    expect(dup.ok).toBe(false);
    const many = Array.from({ length: SCHEDULE_LIMITS.maxSchedules + 1 }, (_, i) =>
      one(`s${i}`),
    );
    expect(validateSchedules(many, 's').ok).toBe(false);
    const atCap = Array.from({ length: SCHEDULE_LIMITS.maxSchedules }, (_, i) =>
      one(`s${i}`),
    );
    expect(validateSchedules(atCap, 's').ok).toBe(true);
  });

  it('round-trips a valid list preserving order', () => {
    const result = validateSchedules([one('a'), one('b')], 's');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.values.map((s) => s.id)).toEqual(['a', 'b']);
  });
});

describe('scheduleNextLabel (display-only, web editor)', () => {
  const base = (overrides: Record<string, unknown> = {}): PersonaSchedule =>
    ({
      id: 's1',
      label: 'Brief',
      when: { kind: 'daily', hour: 9, minute: 15 },
      prompt: 'Do the thing.',
      enabled: true,
      tz: 'UTC',
      ...overrides,
    }) as PersonaSchedule;

  it('daily: labels today vs tomorrow from the schedule tz wall clock', () => {
    const schedule = base();
    // Monday 2026-01-05 08:00Z — before 09:15.
    expect(scheduleNextLabel(schedule, Date.UTC(2026, 0, 5, 8, 0, 0))).toBe(
      'Next: today at 09:15',
    );
    // Same day 20:00Z — already passed.
    expect(scheduleNextLabel(schedule, Date.UTC(2026, 0, 5, 20, 0, 0))).toBe(
      'Next: tomorrow at 09:15',
    );
    // Crosses a month boundary.
    expect(scheduleNextLabel(schedule, Date.UTC(2026, 11, 31, 12, 0, 0))).toBe(
      'Next: tomorrow at 09:15',
    );
  });

  it('daily: resolves against a non-UTC tz', () => {
    // 2026-07-05 12:00Z == 08:00 EDT in New York.
    const schedule = base({
      when: { kind: 'daily', hour: 9, minute: 0 },
      tz: 'America/New_York',
    });
    expect(scheduleNextLabel(schedule, Date.UTC(2026, 6, 5, 12, 0, 0))).toBe(
      'Next: today at 09:00',
    );
  });

  it('weekly: today, tomorrow and named weekdays', () => {
    // Monday 2026-01-05 07:00Z — before the 08:00 fire time.
    const before = Date.UTC(2026, 0, 5, 7, 0, 0);
    const mondayMorning = base({ when: { kind: 'weekly', weekday: 0, hour: 8, minute: 0 } });
    expect(scheduleNextLabel(mondayMorning, before)).toBe('Next: today at 08:00');
    // Monday time already passed -> rolls a full week (same weekday name).
    expect(scheduleNextLabel(mondayMorning, Date.UTC(2026, 0, 5, 20, 0, 0))).toBe(
      'Next: Monday at 08:00',
    );
    const thursday = base({ when: { kind: 'weekly', weekday: 3, hour: 9, minute: 15 } });
    expect(scheduleNextLabel(thursday, Date.UTC(2026, 0, 5, 12, 0, 0))).toBe(
      'Next: Thursday at 09:15',
    );
  });

  it('interval schedules and unknown tz return null', () => {
    expect(scheduleNextLabel(base({ when: { kind: 'interval', everyMinutes: 30 } }), 0)).toBeNull();
    expect(scheduleNextLabel(base({ tz: 'Not/AZone' }), Date.UTC(2026, 0, 5, 8, 0, 0))).toBeNull();
  });

  it('defaults to the machine timezone when tz is absent (UTC test env)', () => {
    const schedule = base({ tz: undefined });
    const now = Date.UTC(2026, 0, 5, 8, 0, 0);
    const label = scheduleNextLabel(schedule, now);
    // The label is timezone-relative; assert the shape, not the exact word.
    expect(label).toMatch(/^Next: (today|tomorrow|Monday) at 09:15$/);
  });
});