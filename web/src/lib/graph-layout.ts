/**
 * M16 F1 (PLAN-M16.md): deterministic layered graph layout for the Notes
 * graph — pure, no layout library (dagre/elk stay out).
 *
 * Ranks follow link direction: a note that references others ranks BEFORE
 * its targets (who-calls-whom flows left → right). Cycles (mutual links)
 * fold into the same rank as their source side; user-dragged positions are
 * honoured and only null/unset nodes are auto-arranged.
 */

export interface LayoutNodeInput {
  id: string;
  title: string;
  /** Persisted user position; null = never arranged/dragged. */
  x: number | null;
  y: number | null;
}

export interface LayoutEdgeInput {
  source: string;
  target: string;
}

export interface LayoutPosition {
  id: string;
  x: number;
  y: number;
}

export const GRAPH_COLUMN_GAP = 300;
export const GRAPH_ROW_GAP = 92;

function estimateNodeWidth(title: string): number {
  return Math.min(300, 64 + title.length * 8);
}

/**
 * Compute stable positions for every node. Stored positions (x/y set) are
 * preserved; the rest get a layered left→right arrangement. Deterministic:
 * same inputs → same output (rank ties resolve by title, then id).
 */
export function layOutGraph(
  nodes: LayoutNodeInput[],
  edges: LayoutEdgeInput[],
): LayoutPosition[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const inbound = new Map<string, string[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const list = inbound.get(edge.target) ?? [];
    list.push(edge.source);
    inbound.set(edge.target, list);
  }

  // Rank = 1 + max(rank(source)) over inbound links; iterative until stable
  // (a reference cycle simply stops growing when no rank improves).
  const rank = new Map<string, number>();
  for (const node of nodes) rank.set(node.id, 0);
  let changed = true;
  let passes = 0;
  while (changed && passes < nodes.length + 2) {
    changed = false;
    passes += 1;
    for (const node of nodes) {
      let next = rank.get(node.id) ?? 0;
      for (const source of inbound.get(node.id) ?? []) {
        const candidate = (rank.get(source) ?? 0) + 1;
        if (candidate > next) next = candidate;
      }
      if (next !== (rank.get(node.id) ?? 0)) {
        rank.set(node.id, next);
        changed = true;
      }
    }
  }

  // Group by rank; deterministic intra-rank order: title asc, then id asc.
  const groups = new Map<number, string[]>();
  for (const node of nodes) {
    const r = rank.get(node.id) ?? 0;
    const list = groups.get(r) ?? [];
    list.push(node.id);
    groups.set(r, list);
  }
  const sortedRanks = [...groups.keys()].sort((a, b) => a - b);
  const result: LayoutPosition[] = [];
  for (const r of sortedRanks) {
    const ids = (groups.get(r) ?? []).sort((a, b) => {
      const ta = byId.get(a)?.title ?? '';
      const tb = byId.get(b)?.title ?? '';
      return ta < tb ? -1 : ta > tb ? 1 : a < b ? -1 : a > b ? 1 : 0;
    });
    ids.forEach((id, index) => {
      const node = byId.get(id)!;
      if (node.x !== null && node.y !== null) {
        result.push({ id, x: node.x, y: node.y });
        return;
      }
      const width = estimateNodeWidth(node.title);
      const y = (index - (ids.length - 1) / 2) * GRAPH_ROW_GAP;
      result.push({ id, x: r * GRAPH_COLUMN_GAP + width / 2, y });
    });
  }
  return result;
}
