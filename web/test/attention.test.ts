/**
 * Attention model tests.
 *
 * These guard the two failure modes that make a badge system actively worse
 * than none: counting one event twice, and badging something the user cannot
 * see.
 *
 * M26 D13 extends both: `skills` joins the destinations, and its count is the
 * READY drafts (validated ok, not installed) — with the model's own rule 1
 * applied rather than contradicted, because a draft whose install the persona
 * asked for is already an open approval counted under `files`.
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
  readyDraftsNeedingAttention,
  totalAttention,
  type AttentionDraft,
} from '../src/lib/attention.js';
import { MOBILE_MORE, MOBILE_TABS } from '../src/lib/nav.js';

describe('attention counts', () => {
  it('maps each source to its destination', () => {
    expect(
      attentionCounts({
        pendingApprovals: 2,
        memorySuggestions: 5,
        failedScheduleRuns: 1,
        readyDrafts: 3,
      }),
    ).toEqual({ files: 2, memory: 5, personas: 1, skills: 3 });
  });

  it('treats absent, negative and non-finite input as zero', () => {
    expect(
      attentionCounts({
        pendingApprovals: -3,
        memorySuggestions: Number.NaN,
        failedScheduleRuns: 0,
        readyDrafts: Number.POSITIVE_INFINITY,
      }),
    ).toEqual({ files: 0, memory: 0, personas: 0, skills: 0 });
  });

  it('floors fractional counts rather than showing a half a thing', () => {
    expect(
      attentionCounts({
        pendingApprovals: 1.9,
        memorySuggestions: 0,
        failedScheduleRuns: 0,
        readyDrafts: 2.9,
      }).skills,
    ).toBe(2);
  });

  it('does not count a queued scheduled run again as its own attention item', () => {
    // A run paused on an approval IS the pending approval (M14). The caller
    // only passes FAILED runs here; this asserts the model has no separate
    // "queued" channel that could double-report it.
    const counts = attentionCounts({
      pendingApprovals: 1,
      memorySuggestions: 0,
      failedScheduleRuns: 0,
      readyDrafts: 0,
    });
    expect(totalAttention(counts)).toBe(1);
  });

  it('sums across every destination', () => {
    expect(
      totalAttention(
        attentionCounts({
          pendingApprovals: 2,
          memorySuggestions: 3,
          failedScheduleRuns: 4,
          readyDrafts: 5,
        }),
      ),
    ).toBe(14);
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
      readyDrafts: 4,
    });
    // 'memory' and 'skills' are in the More sheet; 'files' is a visible tab.
    expect(aggregateAttention(counts, MOBILE_MORE)).toBe(7);
  });

  it('never folds a visible tab into the More badge', () => {
    // Files is already on the tab bar, so folding its count into More would
    // show the same number twice and read as two separate problems.
    const filesOnly = attentionCounts({
      pendingApprovals: 5,
      memorySuggestions: 0,
      failedScheduleRuns: 0,
      readyDrafts: 0,
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
      readyDrafts: 4,
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
    expect(
      failedRunsNeedingAttention([{ status: 'error', startedAt: Number.NaN, finishedAt: null }], now),
    ).toBe(0);
  });
});

describe('ready skill drafts (M26 D13)', () => {
  const draft = (overrides: Partial<AttentionDraft> = {}): AttentionDraft => ({
    status: 'draft',
    validation: { ok: true },
    pendingInstallId: null,
    ...overrides,
  });

  it('counts a validated, uninstalled draft', () => {
    expect(readyDraftsNeedingAttention([draft()])).toBe(1);
  });

  it('does not count a draft that still has validation problems', () => {
    // A broken draft is not something the user must act on for the badge to
    // clear: the model or the owner fixes it in the Studio.
    expect(readyDraftsNeedingAttention([draft({ validation: { ok: false } })])).toBe(0);
  });

  it('does not count an installed draft', () => {
    expect(readyDraftsNeedingAttention([draft({ status: 'installed' })])).toBe(0);
  });

  it('does NOT double count a draft whose install is already an open approval', () => {
    // Rule 1: that draft is a row in the approval queue, which Files already
    // badges. Counting it here would report one decision as two problems.
    const pending = draft({ pendingInstallId: 'pending-1' });
    expect(readyDraftsNeedingAttention([pending])).toBe(0);
    const counts = attentionCounts({
      pendingApprovals: 1,
      memorySuggestions: 0,
      failedScheduleRuns: 0,
      readyDrafts: readyDraftsNeedingAttention([pending]),
    });
    expect(counts.skills).toBe(0);
    expect(counts.files).toBe(1);
    expect(totalAttention(counts)).toBe(1);
  });

  it('counts the ready drafts and the open ask exactly once, in the right places', () => {
    const drafts = [
      draft(),
      draft({ pendingInstallId: 'pending-1' }),
      draft({ validation: { ok: false } }),
      draft({ status: 'installed' }),
    ];
    expect(readyDraftsNeedingAttention(drafts)).toBe(1);
  });

  it('handles an empty list', () => {
    expect(readyDraftsNeedingAttention([])).toBe(0);
  });
});
