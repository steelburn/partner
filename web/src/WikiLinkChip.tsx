/**
 * M16 chat wiki-link chip — the rendered form of a `[[Note Title]]` citation.
 *
 * A resolved citation is a real button that opens the note (the shell routes
 * the click to the Notes editor); the native `title` hint carries the note's
 * plain-text snippet so the reader can preview the content without leaving
 * the conversation. A citation with no matching note stays a muted, inert
 * chip but keeps the brackets' meaning visible (it is not an error — notes
 * are often written first as dangling links).
 */
import { memo } from 'react';
import { noteSnippet } from './lib/wiki-links.js';

export interface WikiNoteTarget {
  id: string;
  title: string;
  /** Plain-text preview from the note body (null/absent = none fetched). */
  snippet?: string | null;
}

export interface WikiLinkChipProps {
  /** The title exactly as cited between the brackets. */
  title: string;
  /** The matching note, or null when the citation dangles. */
  target: WikiNoteTarget | null;
  /** Chat is mid-stream: the chip stays inert until the turn ends. */
  busy?: boolean;
  /** Open the note in the Notes view. */
  onOpen?: (id: string) => void;
}

function hintFor(title: string, target: WikiNoteTarget | null): string {
  if (target === null) return `No note titled “${title}” yet`;
  const snippet = target.snippet != null ? noteSnippet(target.snippet, 200) : '';
  return snippet !== '' ? `${target.title} — ${snippet}` : `Open “${target.title}”`;
}

export const WikiLinkChip = memo(function WikiLinkChip({
  title,
  target,
  busy,
  onOpen,
}: WikiLinkChipProps) {
  const hint = hintFor(title, target);
  if (target === null) {
    return (
      <span className="md-wiki-link is-dangling" title={hint}>
        {title}
      </span>
    );
  }
  if (onOpen === undefined) {
    return (
      <span className="md-wiki-link is-static" title={hint}>
        {target.title}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="md-wiki-link"
      title={hint}
      aria-label={`Open note ${target.title}`}
      disabled={busy === true}
      onClick={() => onOpen(target.id)}
    >
      {target.title}
    </button>
  );
});
