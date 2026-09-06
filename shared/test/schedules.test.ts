/**
 * M14 schedule validation (PLAN-M14.md S1) — pure shared rules.
 */
import { describe, expect, it } from 'vitest';
import {
  SCHEDULE_LIMITS,
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
