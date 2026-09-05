/**
 * M11 C3 structured-response protocol (PLAN-M11.md).
 *
 * One zero-dependency parser for the `:::partner.*` container grammar used
 * by chat UI blocks. Containers are fenced, GFM-ish, and degrade to plain
 * text when unparsed. Only CLOSED containers are returned (a block whose
 * closing `:::` has not arrived yet is not materialized), so streaming
 * renderers can call this on every delta and only complete blocks appear.
 *
 * Grammar (v1):
 *
 *   :::partner.choice mode=single|multi
 *   An optional title line (first non-bullet line)
 *   - Option A
 *   - Option B
 *   :::
 *
 *   :::partner.asset kind=code title="Swap two numbers"
 *   ...raw markdown body (verbatim, trimmed at both ends)...
 *   :::
 *
 * Both parsers are strict about the fence (`:::` on its own line) and
 * tolerant of everything else; malformed containers are ignored and their
 * text simply renders as markdown prose.
 */

export type ChoiceMode = 'single' | 'multi';

export interface ChoiceOption {
  label: string;
}

export interface ChoiceBlock {
  kind: 'choice';
  mode: ChoiceMode;
  title: string | null;
  options: string[];
}

/** M11 F10 asset container (reserved grammar; consumers land in F10). */
export interface AssetBlock {
  kind: 'asset';
  assetKind: string;
  title: string | null;
  body: string;
}

export type StructuredBlock = ChoiceBlock | AssetBlock;

/** One complete container: the block + its absolute text range [start, end). */
export interface StructuredBlockHit<T extends StructuredBlock = StructuredBlock> {
  block: T;
  /** Index of the opening fence line start. */
  start: number;
  /** Index just past the closing fence line end. */
  end: number;
}

const OPEN_FENCE = /^:::\s*partner\.(\w+)(.*)$/i;
const CLOSE_FENCE = /^:::\s*$/;
const BULLET = /^\s*[-*]\s+(.+)$/;


/** Parse the attribute tail of an open fence line into a key/value map. */
export function parseFenceAttrs(tail: string): Map<string, string> {
  const attrs = new Map<string, string>();
  let rest = tail.trim();
  const attrRe = /^([a-zA-Z][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|(\S+))/;
  for (;;) {
    const match = attrRe.exec(rest);
    if (!match) break;
    const key = match[1] ?? '';
    const value = match[3] ?? match[4] ?? match[5] ?? '';
    const whole = match[0] ?? '';
    // The value must be followed by whitespace/end, else it is prose.
    const after = rest.slice(whole.length);
    if (after !== '' && !/^\s/.test(after)) break;
    if (!attrs.has(key)) attrs.set(key, value);
    rest = after.trim();
  }
  return attrs;
}

/** The leading text of a fence tail that is NOT part of k=v attributes. */
export function fenceTailTitle(tail: string): string | null {
  const trimmed = tail.trim();
  if (trimmed === '') return null;
  const re = new RegExp(`^\\s*(?:[a-zA-Z][\\w-]*\\s*=\\s*(?:"[^"]*"|'[^']*'|\\S+)\\s*)*`);
  const cleaned = trimmed.replace(re, '').trim();
  return cleaned === '' ? null : cleaned;
}

/**
 * Find the first COMPLETE partner container in `text`.
 *
 * Returns null when nothing is closed — streaming renderers re-call per
 * delta and materialize only closed blocks. The returned [start, end) range
 * covers the opening fence line through the closing fence line.
 */
export function findStructuredBlock(text: string): StructuredBlockHit | null {
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const open = OPEN_FENCE.exec(lines[index] ?? '');
    if (!open) continue;
    const kind = (open[1] ?? '').toLowerCase();
    if (kind !== 'choice' && kind !== 'asset') continue;

    // Find the closing fence; unclosed containers are invisible to parsers.
    let endLine = -1;
    for (let j = index + 1; j < lines.length; j += 1) {
      if (CLOSE_FENCE.test(lines[j] ?? '')) {
        endLine = j;
        break;
      }
    }
    if (endLine === -1) return null;

    const tail = open[2] ?? '';
    const body = lines.slice(index + 1, endLine);
    const bodyText = body.join('\n');

    let block: StructuredBlock | null = null;
    if (kind === 'choice') {
      const attrs = parseFenceAttrs(tail);
      const modeRaw = attrs.get('mode') ?? 'single';
      const mode: ChoiceMode = modeRaw === 'multi' ? 'multi' : 'single';
      const title = fenceTailTitle(tail);
      const options: string[] = [];
      let fallbackTitle: string | null = null;
      for (const line of body) {
        const bullet = BULLET.exec(line ?? '');
        if (bullet) {
          options.push((bullet[1] ?? '').trim());
          continue;
        }
        const trimmed = (line ?? '').trim();
        if (trimmed !== '' && fallbackTitle === null) fallbackTitle = trimmed;
      }
      if (options.length === 0) continue; // not a usable choice — leave as text
      block = {
        kind: 'choice',
        mode,
        title: attrs.get('title') ?? title ?? fallbackTitle,
        options,
      };
    } else if (kind === 'asset') {
      const attrs = parseFenceAttrs(tail);
      block = {
        kind: 'asset',
        assetKind: attrs.get('kind') ?? 'custom',
        title: attrs.get('title') ?? fenceTailTitle(tail),
        body: bodyText.trim(),
      };
    }
    if (block === null) continue;

    const start = lines.slice(0, index).join('\n').length + (index === 0 ? 0 : 1);
    const end = start + lines.slice(index, endLine + 1).join('\n').length;
    return { block, start, end };
  }
  return null;
}

/**
 * All complete containers in `text`, left to right. Non-container text is
 * deliberately NOT included — renderers slice it around the hits, so prose
 * and unknown containers stay untouched markdown.
 */
export function parseStructuredBlocks(text: string): StructuredBlockHit[] {
  const hits: StructuredBlockHit[] = [];
  let rest = text;
  let offset = 0;
  for (;;) {
    const hit = findStructuredBlock(rest);
    if (hit === null) break;
    hits.push({ block: hit.block, start: offset + hit.start, end: offset + hit.end });
    offset += hit.end;
    rest = rest.slice(hit.end);
  }
  return hits;
}
