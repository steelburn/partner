/**
 * M16 chat wiki-links — render `[[Note Title]]` citations as note chips.
 *
 * The Brainstorming persona (and any persona) cites notes by title using the
 * same `[[Title]]` grammar notes use. Raw brackets are noise in a chat
 * bubble, so the renderer rewrites each citation into a markdown link with a
 * private `partner-note:` scheme; PartnerMarkdown intercepts that scheme and
 * renders a `WikiLinkChip` that can open the note.
 *
 * Rewriting happens OUTSIDE fenced code blocks and inline code spans so a
 * literal `[[x]]` in a code sample is never turned into a link. Pure and
 * deterministic (unit-tested in the node env).
 */

/** The `partner-note:` URL scheme used for rewritten citations. */
export const WIKI_LINK_SCHEME = 'partner-note:';

/** One wiki-link citation, as written between the brackets. */
const WIKI_LINK = /\[\[([^[\]\r\n]+)\]\]/;

/** A fence-open line (up to three leading spaces, ```/~~~ of length >= 3). */
const FENCE_OPEN = /^\s{0,3}(`{3,}|~{3,})/;

/** Escape markdown link-label metacharacters so the title cannot break out. */
function escapeLabel(title: string): string {
  return title.replace(/[\\[\]`]/g, (char) => `\\${char}`);
}

/** Rewrite `[[Title]]` on one line, skipping inline code spans. */
function linkifyLine(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const tick = line.indexOf('`', i);
    const open = line.indexOf('[[', i);
    // An inline-code span before the next citation is copied verbatim.
    if (tick !== -1 && (open === -1 || tick < open)) {
      let run = 1;
      while (line[tick + run] === '`') run += 1;
      const close = line.indexOf('`'.repeat(run), tick + run);
      if (close === -1) {
        out += line.slice(i);
        break;
      }
      out += line.slice(i, close + run);
      i = close + run;
      continue;
    }
    if (open === -1) {
      out += line.slice(i);
      break;
    }
    const match = WIKI_LINK.exec(line.slice(open));
    if (match === null) {
      out += line.slice(i);
      break;
    }
    const title = (match[1] ?? '').trim();
    out += line.slice(i, open);
    if (title === '') {
      out += match[0];
    } else {
      out += `[${escapeLabel(title)}](${WIKI_LINK_SCHEME}${encodeURIComponent(title)})`;
    }
    i = open + match[0].length;
  }
  return out;
}

/**
 * Rewrite every `[[Title]]` citation in markdown into a `partner-note:`
 * link. Fenced code blocks and inline code spans are left untouched.
 */
export function linkifyWikiLinks(text: string): string {
  const out: string[] = [];
  let fence: { char: string; length: number } | null = null;
  for (const line of text.split('\n')) {
    const open = FENCE_OPEN.exec(line);
    if (fence !== null) {
      out.push(line);
      if (open !== null) {
        const marker = open[1] ?? '';
        if ((marker[0] ?? '') === fence.char && marker.length >= fence.length) fence = null;
      }
      continue;
    }
    if (open !== null) {
      const marker = open[1] ?? '';
      fence = { char: marker[0] ?? '`', length: marker.length };
      out.push(line);
      continue;
    }
    out.push(linkifyLine(line));
  }
  return out.join('\n');
}

/** The cited title for a `partner-note:` href, or null for any other URL. */
export function wikiTitleFromHref(href: string): string | null {
  if (!href.startsWith(WIKI_LINK_SCHEME)) return null;
  const raw = href.slice(WIKI_LINK_SCHEME.length);
  try {
    const title = decodeURIComponent(raw).trim();
    return title === '' ? null : title;
  } catch {
    return null;
  }
}

/**
 * A one-line plain-text preview of a note body for a link hint: markdown
 * noise (fences, heading marks, emphasis, link syntax) is dropped and runs of
 * whitespace collapse to a single space. Empty when the note has no text.
 */
export function noteSnippet(content: string, max = 160): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_>~#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
