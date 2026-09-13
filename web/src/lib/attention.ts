/**
 * Attention model — what is waiting on the user, per destination.
 *
 * The problem: memory suggestions were only discoverable by opening the Memory
 * view and reading a header. Nothing anywhere told the user that something was
 * waiting, so a suggestion could sit unconfirmed indefinitely. Approvals
 * already had a badge (Files); this generalizes that to every surface that can
 * be waiting on the user, so the badge system has ONE definition instead of an
 * ad-hoc count per view.
 *
 * Two rules that are easy to get wrong, and are therefore asserted:
 *
 *  1. **No double counting.** A scheduled run waiting on an approval is
 *     *already* counted as a pending approval — M14 pauses the run and queues
 *     the tool, so both rows describe one event. Only FAILED runs count, on
 *     Personas. Counting `queued` runs as well would show the user "2 things
 *     need you" for one decision.
 *  2. **A badge inside a closed sheet is invisible.** On a phone most
 *     destinations live in the More sheet, so the More tab carries the
 *     aggregate of everything inside it — otherwise the badge that tells the
 *     user to open the sheet is the one badge they cannot see.
 *
 * Pure: no fetch, no React, so it is unit-testable in the node-only web suite.
 */

/** Destinations that can be waiting on the user. */
export const ATTENTION_VIEWS = ['files', 'memory', 'personas'] as const;

export type AttentionView = (typeof ATTENTION_VIEWS)[number];

export type AttentionCounts = Record<AttentionView, number>;

/** Narrowing guard so a nav destination can ask for its own badge safely. */
export function isAttentionView(view: string): view is AttentionView {
  return (ATTENTION_VIEWS as readonly string[]).includes(view);
}

export interface AttentionInput {
  /** Tool calls awaiting an approve/deny decision. */
  pendingApprovals: number;
  /** Profile entries the partner proposed that the user has not confirmed. */
  memorySuggestions: number;
  /** Scheduled runs that ended in `error` / `loop_exhausted` (not `queued`). */
  failedScheduleRuns: number;
}

/** Coerce anything to a non-negative integer count. */
function count(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

/**
 * How long a failed scheduled run keeps asking for attention.
 *
 * The rule this encodes: **a badge must be able to clear itself.** Approvals
 * clear by being decided and suggestions clear by being confirmed or rejected —
 * both are actions the user takes. A failed run has no such action (the runs
 * panel is a history, not an inbox), so counting every failure forever would
 * badge something the user can only dismiss by ignoring it. A window self-
 * clears instead.
 *
 * Cost, stated plainly: a failure nobody noticed inside the window stops
 * badging and can be missed. That is the deliberate price of not having an
 * acknowledgement model, and it is why the window is generous (24h).
 */
export const FAILED_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The shape this needs from a scheduled run (kept structural so `lib/schedules`
 *  does not have to be imported here). */
export interface AttentionRun {
  status: string;
  startedAt: number;
  finishedAt: number | null;
}

/**
 * Failed runs inside the window. `queued` is deliberately excluded: a run
 * paused on an approval is already the pending approval, so counting it here
 * would report one decision as two problems.
 */
export function failedRunsNeedingAttention(
  runs: readonly AttentionRun[],
  now: number,
  windowMs: number = FAILED_RUN_WINDOW_MS,
): number {
  return runs.filter((run) => {
    if (run.status !== 'error' && run.status !== 'loop_exhausted') return false;
    const at = run.finishedAt ?? run.startedAt;
    return typeof at === 'number' && Number.isFinite(at) && now - at <= windowMs;
  }).length;
}

export function attentionCounts(input: AttentionInput): AttentionCounts {
  return {
    files: count(input.pendingApprovals),
    memory: count(input.memorySuggestions),
    personas: count(input.failedScheduleRuns),
  };
}

/** Total number of things waiting on the user, across every destination. */
export function totalAttention(counts: AttentionCounts): number {
  return ATTENTION_VIEWS.reduce((sum, view) => sum + count(counts[view]), 0);
}

/**
 * Aggregate for a container that hides destinations (the phone More sheet):
 * the sum over whichever views it contains. Views outside the given list are
 * excluded, so the Files badge is never folded into More — it is already
 * visible on the tab bar, and double-showing a count reads as two problems.
 */
export function aggregateAttention(
  counts: AttentionCounts,
  views: readonly string[],
): number {
  return views.reduce(
    (sum, view) => sum + (isAttentionView(view) ? count(counts[view]) : 0),
    0,
  );
}

/** Badge text: nothing to show -> undefined; capped so a slot cannot stretch. */
export function formatBadge(value: number): string | undefined {
  const n = count(value);
  if (n === 0) return undefined;
  return n > 99 ? '99+' : String(n);
}

/**
 * Accessible name for a badged control. A bare count is not a label: "Memory"
 * plus "3" has to read as "Memory — 3 waiting" for a screen reader.
 */
export function attentionLabel(label: string, badge: string | undefined): string {
  return badge === undefined || badge === '' ? label : `${label} — ${badge} waiting`;
}
