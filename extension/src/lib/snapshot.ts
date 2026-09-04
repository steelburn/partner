/**
 * Page-snapshot builder — PURE (no DOM). The classic content script cannot
 * import modules, so `src/content.ts` mirrors this logic inline — keep the
 * two in sync (constants live here as the tested source of truth).
 *
 * Page text is the user's own data (owner-facing only): a snapshot is built
 * to be sent to the local core over native messaging, never written to
 * extension logs/errors.
 */

export const MAX_BODY_TEXT = 100_000;
export const MAX_SELECTION_TEXT = 10_000;

export interface SnapshotSource {
  url: string;
  title: string;
  origin: string;
  /** Raw selection text before trim/truncation. */
  selectionText?: string;
  /** Raw document body innerText before truncation. */
  bodyText?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  origin: string;
  /** Trimmed selection text (≤ {@link MAX_SELECTION_TEXT}); omitted when empty. */
  selection?: string;
  /** Body innerText (≤ {@link MAX_BODY_TEXT}); omitted when the page has none. */
  text?: string;
}

export function truncateText(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/**
 * Build a capture snapshot from raw page strings. `selection` is included
 * only when it trims to a non-empty string (truncated after trim); `text` is
 * included only when the page provided body text (truncated).
 */
export function buildSnapshot(src: SnapshotSource): PageSnapshot {
  const out: PageSnapshot = { url: src.url, title: src.title, origin: src.origin };
  const selection = src.selectionText?.trim();
  if (selection) out.selection = truncateText(selection, MAX_SELECTION_TEXT);
  if (src.bodyText) out.text = truncateText(src.bodyText, MAX_BODY_TEXT);
  return out;
}
