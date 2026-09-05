import { describe, expect, it } from 'vitest';
import {
  budgetLabel,
  describeHealth,
  normalizeEndpoint,
  parseBudgetDollars,
  parseModelList,
  remainingBudgetLabel,
  sourceLabel,
  validateEndpoint,
} from '../src/lib/providers.js';
import type { ProviderHealth } from '@partner/shared';

function health(overrides: Partial<ProviderHealth> = {}): ProviderHealth {
  return { ok: false, latencyMs: null, error: null, models: [], checkedAt: null, ...overrides };
}

describe('sourceLabel', () => {
  it('labels both wire sources', () => {
    expect(sourceLabel('manual')).toBe('Manual');
    expect(sourceLabel('llm-self-service')).toBe('llm-self-service');
  });
});

describe('parseModelList', () => {
  it('splits, trims and drops empty entries', () => {
    expect(parseModelList(' gpt-4o ,, gpt-4o-mini , ')).toEqual(['gpt-4o', 'gpt-4o-mini']);
    expect(parseModelList('gpt-4o')).toEqual(['gpt-4o']);
    expect(parseModelList('')).toEqual([]);
    expect(parseModelList('   , , ')).toEqual([]);
  });
});

describe('parseBudgetDollars', () => {
  it('returns null (off) for an empty input', () => {
    expect(parseBudgetDollars('')).toEqual({ ok: true, budgetCents: null });
    expect(parseBudgetDollars('   ')).toEqual({ ok: true, budgetCents: null });
  });

  it('parses dollar amounts into integer cents', () => {
    expect(parseBudgetDollars('2.5')).toEqual({ ok: true, budgetCents: 250 });
    expect(parseBudgetDollars('2.50')).toEqual({ ok: true, budgetCents: 250 });
    expect(parseBudgetDollars('0')).toEqual({ ok: true, budgetCents: 0 });
    expect(parseBudgetDollars(' 12 ')).toEqual({ ok: true, budgetCents: 1200 });
  });

  it('rejects malformed and negative amounts', () => {
    expect(parseBudgetDollars('abc').ok).toBe(false);
    expect(parseBudgetDollars('-1').ok).toBe(false);
    expect(parseBudgetDollars('1.234').ok).toBe(false);
    expect(parseBudgetDollars('$5').ok).toBe(false);
  });
});

describe('normalizeEndpoint / validateEndpoint', () => {
  it('trims and strips trailing slashes', () => {
    expect(normalizeEndpoint('  https://api.ne1.dev/v1///  ')).toBe('https://api.ne1.dev/v1');
  });

  it('requires an http(s) origin', () => {
    expect(validateEndpoint('')).toBeTruthy();
    expect(validateEndpoint('api.ne1.dev/v1')).toBeTruthy();
    expect(validateEndpoint('ftp://x/v1')).toBeTruthy();
    expect(validateEndpoint('https://api.ne1.dev/v1')).toBeNull();
    expect(validateEndpoint('http://127.0.0.1:4390/v1')).toBeNull();
  });
});

describe('budgetLabel', () => {
  it('renders cents as compact dollar text; null stays null', () => {
    expect(budgetLabel(null)).toBeNull();
    expect(budgetLabel(0)).toBe('$0 / session');
    expect(budgetLabel(200)).toBe('$2 / session');
    expect(budgetLabel(250)).toBe('$2.50 / session');
    expect(budgetLabel(255)).toBe('$2.55 / session');
  });
});

describe('remainingBudgetLabel', () => {
  it('renders remaining-of-cap only when both sides are known', () => {
    expect(remainingBudgetLabel(null, 10)).toBeNull();
    expect(remainingBudgetLabel(1000, undefined)).toBeNull();
    expect(remainingBudgetLabel(1000, null)).toBeNull();
    expect(remainingBudgetLabel(1000, 250)).toBe('$7.50 of $10 left this window');
    expect(remainingBudgetLabel(100, 100)).toBe('$0 of $1 left this window');
    expect(remainingBudgetLabel(100, 999)).toBe('$0 of $1 left this window');
  });
});

describe('describeHealth', () => {
  it('reports a healthy probe with latency and model count', () => {
    expect(
      describeHealth(health({ ok: true, latencyMs: 120, models: ['gpt-4o'] }), 1).text,
    ).toBe('Healthy · 120 ms · 1 model');
    expect(
      describeHealth(health({ ok: true, latencyMs: 120, models: ['a', 'b'] }), 2).text,
    ).toBe('Healthy · 120 ms · 2 models');
  });

  it('handles a healthy probe before latency is known', () => {
    const line = describeHealth(health({ ok: true, latencyMs: null }), 0);
    expect(line.tone).toBe('ok');
    expect(line.text).toBe('Healthy');
  });

  it('surfaces the last error verbatim (capped)', () => {
    const long = 'e'.repeat(300);
    const line = describeHealth(health({ error: long }), 0);
    expect(line.tone).toBe('error');
    expect(line.text.endsWith('…')).toBe(true);
    expect(line.text.length).toBeLessThanOrEqual(161);
  });

  it('says "Not tested yet" for a fresh profile (no error, not ok)', () => {
    const line = describeHealth(health(), 0);
    expect(line).toEqual({ tone: 'unknown', text: 'Not tested yet' });
  });
});
