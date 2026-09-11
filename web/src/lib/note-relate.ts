/**
 * M16 F1 follow-up — connectors on the Notes graph canvas.
 *
 * The canvas draws no relationship data of its own: an edge IS a note's
 * wiki-link (PLAN-M16 D1 — `note_links`). So "drag a connector from A to B"
 * means "write `[[B]]` into A": the arrow, the backlink panel, search and
 * export all agree because they read the same note body. These helpers keep
 * that edit pure and unit-testable — they build the exact content the canvas
 * saves, and they decide when a drag would duplicate an existing edge.
 *
 * Note bodies are the OWNER's content: nothing here logs, prints or embeds a
 * body in an error — callers only ever receive the transformed string.
 */

import type { NoteGraphEdge } from '@partner/shared';

/**
 * A title can be written as a wiki-link when it is non-empty and carries no
 * `]` — the core's `[[…]]` parser terminates on the first closing bracket, so
 * a title containing one can never resolve back to this note.
 */
export function isLinkableTitle(title: string): boolean {
  const trimmed = title.trim();
  return trimmed.length > 0 && !trimmed.includes(']');
}

/** Escape a literal title for use inside a RegExp. */
function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when the body already carries a `[[Title]]` link (case-insensitive). */
export function hasWikiLink(content: string, title: string): boolean {
  const trimmed = title.trim();
  if (trimmed.length === 0) return false;
  return new RegExp(`\\[\\[\\s*${escapeForRegExp(trimmed)}\\s*\\]\\]`, 'i').test(content);
}

/**
 * Append `[[Title]]` as its own trailing paragraph. An empty body gets the
 * link alone. The caller is expected to have checked `hasWikiLink` first;
 * this never inspects existing links, it only builds the new body.
 */
export function appendWikiLink(content: string, title: string): string {
  const link = `[[${title.trim()}]]`;
  const body = content.replace(/\s+$/, '');
  return body.length === 0 ? link : `${body}\n\n${link}`;
}

/**
 * True when an edge already covers this direction — the same arrow exists, or
 * a bidirectional edge spans the pair (both directions are already drawn).
 * A single reverse arrow is NOT already linked: adding the other direction
 * is a real edit that the core renders as one bidirectional edge.
 */
export function isLinkedAlready(
  edges: readonly NoteGraphEdge[],
  source: string,
  target: string,
): boolean {
  return edges.some((edge) => {
    if (edge.source === source && edge.target === target) return true;
    return (
      edge.bidirectional &&
      edge.source === target &&
      edge.target === source
    );
  });
}
