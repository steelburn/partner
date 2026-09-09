/**
 * M16 F3 (PLAN-M16.md): pure line-diff shared between the core and the web
 * UI (zero runtime deps). LCS-based diff of two texts split into lines,
 * rendered as a sequence of same/remove/add runs so the Notes History panel
 * can show old→new changes. Operates on text only — never on audit rows.
 */

export type DiffRun =
  | { type: 'same'; text: string }
  | { type: 'remove'; text: string }
  | { type: 'add'; text: string };

/** Guard against quadratic blow-up on pathological inputs: beyond this many
 *  line-pairs we fall back to "everything changed" (still correct, coarse). */
const LCS_CELL_BUDGET = 4_000_000;

/** Split text into lines preserving empty lines; '' -> []. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Diff `before` against `after` (line granularity). Output is a sequence of
 * 'same' runs plus 'remove'/'add' runs (adjacent removes merge, adjacent adds
 * merge; a replaced line is one remove run followed by one add run).
 */
export function diffLines(before: string, after: string): DiffRun[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // LCS DP over line indices (n+1)x(m+1), bottom-up. Guarded: the fallback
  // below still produces a correct (coarse) diff for huge inputs.
  const cells = n * m;
  const dp = new Uint32Array((n + 1) * (m + 1));
  const at = (x: number, y: number): number => dp[x * (m + 1) + y] ?? 0;

  if (cells <= LCS_CELL_BUDGET) {
    for (let x = n - 1; x >= 0; x -= 1) {
      for (let y = m - 1; y >= 0; y -= 1) {
        if (a[x] === b[y]) {
          dp[x * (m + 1) + y] = at(x + 1, y + 1) + 1;
        } else {
          const down = at(x + 1, y);
          const right = at(x, y + 1);
          dp[x * (m + 1) + y] = down > right ? down : right;
        }
      }
    }
  }

  interface RawOp {
    kind: 'same' | 'del' | 'ins';
    line: string;
  }
  const raw: RawOp[] = [];
  if (cells <= LCS_CELL_BUDGET) {
    let x = 0;
    let y = 0;
    while (x < n && y < m) {
      if (a[x] === b[y]) {
        raw.push({ kind: 'same', line: a[x] as string });
        x += 1;
        y += 1;
      } else if (at(x + 1, y) >= at(x, y + 1)) {
        raw.push({ kind: 'del', line: a[x] as string });
        x += 1;
      } else {
        raw.push({ kind: 'ins', line: b[y] as string });
        y += 1;
      }
    }
    while (x < n) {
      raw.push({ kind: 'del', line: a[x] as string });
      x += 1;
    }
    while (y < m) {
      raw.push({ kind: 'ins', line: b[y] as string });
      y += 1;
    }
  } else {
    for (const line of a) raw.push({ kind: 'del', line });
    for (const line of b) raw.push({ kind: 'ins', line });
  }

  // Merge adjacent ops of the same kind into runs (a single 'same' run is
  // kept even when it contains newlines).
  const runs: DiffRun[] = [];
  for (const op of raw) {
    const last = runs[runs.length - 1];
    const kind =
      op.kind === 'same' ? 'same' : op.kind === 'del' ? 'remove' : 'add';
    if (last !== undefined && last.type === kind) {
      last.text = last.text === '' ? op.line : `${last.text}\n${op.line}`;
    } else {
      runs.push({ type: kind, text: op.line });
    }
  }
  // No changes at all (pure context) reads as an empty diff.
  if (runs.length > 0 && runs.every((r) => r.type === 'same')) return [];
  return runs;
}
