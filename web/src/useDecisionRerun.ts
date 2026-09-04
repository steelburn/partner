import { useEffect, useRef } from 'react';
import type { PendingToolCall } from '@partner/shared/src/tools.js';

/**
 * Re-run a flow once its pending-approval row leaves the queue.
 *
 * Used by the try-a-tool and edit-preview panels: after the user approves a
 * row in the queue, the broker does not auto-execute — the caller re-runs
 * (PLAN-M2 "the caller who owns the pending row can poll + re-exec"). The
 * hook fires `onResolved` exactly once per pendingId, and only after at least
 * one queue refresh has happened since the wait began (so a freshly enqueued
 * row that the local list has not observed yet cannot trigger a premature
 * re-run).
 */
export function useDecisionRerun(
  pending: PendingToolCall[],
  pendingId: string | null,
  onResolved: () => void,
): void {
  const refreshSeq = useRef(0);
  const waitStartSeq = useRef(0);
  const fired = useRef<string | null>(null);

  // Every time the queue list arrives (poll or manual refresh) counts a tick.
  useEffect(() => {
    refreshSeq.current += 1;
  }, [pending]);

  // Record the tick at which a new wait began.
  useEffect(() => {
    if (pendingId !== null) waitStartSeq.current = refreshSeq.current;
  }, [pendingId]);

  useEffect(() => {
    if (pendingId === null) return;
    if (fired.current === pendingId) return;
    if (pending.some((item) => item.id === pendingId)) return;
    if (refreshSeq.current <= waitStartSeq.current) return;
    fired.current = pendingId;
    onResolved();
  }, [pending, pendingId, onResolved]);
}
