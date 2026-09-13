/**
 * Attention model tests.
 *
 * These guard the two failure modes that make a badge system actively worse
 * than none: counting one event twice, and badging something the user cannot
 * see.
 */
import { describe, expect, it } from 'vitest';
import {
  ATTENTION_VIEWS,
  aggregateAttention,
  attentionCounts,
  attentionLabel,
  formatBadge,
  FAILED_RUN_WINDOW_MS,
  failedRunsNeedingAttention,
  totalAttention,
} from '../src/lib/attention.js';
import { MOBILE_MORE, MOBILE_TABS } from '../src/lib/nav.js';

describe('attention counts', () => {
  it('maps each source to its destination', () => {
    expect(
      attentionCounts({ pendingApprovals: 2, memorySuggestions: 5, failedScheduleRuns: 1 }),
    ).toEqual({ files: 2, memory: 5, personas: 1 });
  });

  it('treats absent, negative and non-finite input as zero', () => {
    expect(
      attentionCounts({ pendingApprovals: -3, memorySuggestions: Number.NaN, failedScheduleRuns: 0 }),
    ).toEqual({ files: 0, memory: 0, personas: 0 });
  });

  it('floors fractional counts rather than showing a half a thing', () => {
    expect(
      attentionCounts({ pendingApprovals: 1.9, memorySuggestions: 0, failedScheduleRuns: 0 }).files,
    ).toBe(1);
  });

  it('does not count a queued scheduled run again as its own attention item', () => {
    // A run paused on an approval IS the pending approval (M14). The caller
    // only passes FAILED runs here; this asserts the model has no separate
    // "queued" channel that could double-report it.
    const counts = attentionCounts({
      pendingApprovals: 1,
      memorySuggestions: 0,
      failedScheduleRuns: 0,
    });
    expect(totalAttention(counts)).toBe(1);
  });

  it('sums across every destination', () => {
    expect(
      totalAttention(attentionCounts({ pendingApprovals: 2, memorySuggestions: 3, failedScheduleRuns: 4 })),
    ).toBe(9);
  });
});

describe('badge formatting', () => {
  it('renders nothing for zero so an empty destination is not badged', () => {
    expect(formatBadge(0)).toBeUndefined();
  });

  it('caps at 99+ so a slot cannot be stretched by a huge number', () => {
    expect(formatBadge(1)).toBe('1');
    expect(formatBadge(99)).toBe('99');
    expect(formatBadge(100)).toBe('99+');
    expect(formatBadge(4321)).toBe('99+');
  });
});

describe('phone More-sheet aggregate', () => {
  it('sums only the destinations the sheet hides', () => {
    const counts = attentionCounts({
      pendingApprovals: 7,
      memorySuggestions: 3,
      failedScheduleRuns: 0,
    });
    // 'memory' is in the More sheet; 'files' is a visible tab.
    expect(aggregateAttention(counts, MOBILE_MORE)).toBe(3);
  });

  it('never folds a visible tab into the More badge', () => {
    // Files is already on the tab bar, so folding its count into More would
    // show the same number twice and read as two separate problems.
    const filesOnly = attentionCounts({
      pendingApprovals: 5,
      memorySuggestions: 0,
      failedScheduleRuns: 0,
    });
    expect(aggregateAttention(filesOnly, MOBILE_MORE)).toBe(0);
  });

  it('keeps every attention destination reachable from the phone nav', () => {
    const reachable = new Set([...MOBILE_TABS, ...MOBILE_MORE]);
    for (const view of ATTENTION_VIEWS) {
      expect(reachable.has(view)).toBe(true);
    }
  });

  it('counts every attention view exactly once across tabs and the sheet', () => {
    const counts = attentionCounts({
      pendingApprovals: 1,
      memorySuggestions: 2,
      failedScheduleRuns: 3,
    });
    const onTabs = aggregateAttention(counts, MOBILE_TABS);
    const inSheet = aggregateAttention(counts, MOBILE_MORE);
    expect(onTabs + inSheet).toBe(totalAttention(counts));
  });
});

describe('accessible naming', () => {
  it('reads a bare count as a sentence, not a number', () => {
    expect(attentionLabel('Memory', '3')).toBe('Memory — 3 waiting');
  });

  it('leaves an unbadged label alone', () => {
    expect(attentionLabel('Memory', undefined)).toBe('Memory');
  });
});

describe('failed scheduled runs', () => {
  const now = 1_700_000_000_000;
  const run = (status: string, finishedAt: number | null, startedAt = finishedAt ?? now) => ({
    status,
    startedAt,
    finishedAt,
  });

  it('counts failures inside the window', () => {
    expect(
      failedRunsNeedingAttention(
        [run('error', now - 1000), run('loop_exhausted', now - 60_000), run('done', now - 1000)],
        now,
      ),
    ).toBe(2);
  });

  it('stops counting a failure once it falls out of the window', () => {
    // The badge has to be able to clear itself: a failure has no dismiss
    // action, so time is what clears it.
    expect(
      failedRunsNeedingAttention([run('error', now - FAILED_RUN_WINDOW_MS - 1)], now),
    ).toBe(0);
  });

  it('never counts a queued run — that is already the pending approval', () => {
    const pendingDecision = [run('queued', null), run('running', null)];
    expect(failedRunsNeedingAttention(pendingDecision, now)).toBe(0);
  });

  it('falls back to startedAt when a run never finished', () => {
    expect(failedRunsNeedingAttention([run('error', null, now - 5000)], now)).toBe(1);
  });

  it('ignores a run with no usable timestamp instead of dividing by nothing', () => {
    expect(failedRunsNeedingAttention([{ status: 'error', startedAt: Number.NaN, finishedAt: null }], now)).toBe(0);
  });
});
