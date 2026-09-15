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
 *   :::partner.form title="A few questions"
 *   - What problem are you solving?
 *   - Who is the primary user?
 *   :::
 *
 *   :::partner.scorecard title="Rate these" scale=5
 *   - Onboarding flow
 *   - Pricing clarity
 *   :::
 *
 *   :::partner.asset kind=code title="Swap two numbers"
 *   ...raw markdown body (verbatim, trimmed at both ends)...
 *   :::
 *
 * Every parser is strict about the fence (`:::` on its own line) and
 * tolerant of everything else; malformed containers are ignored and their
 * text simply renders as markdown prose.
 */

export type ChoiceMode = 'single' | 'multi';

export interface ChoiceOption {
  label: string;
}

/**
 * M23 scorecard container: several named items the user rates on one shared
 * numeric scale (one score per item). `scale` is the highest score and is
 * always at least 2; scores run from 1..scale. `labels` optionally names the
 * low/high ends (e.g. ["Poor", "Excellent"]) for display only.
 */
export interface ScorecardBlock {
  kind: 'scorecard';
  title: string | null;
  items: string[];
  /** Highest score; scores run 1..scale. */
  scale: number;
  /** Optional [low, high] end labels, or null. */
  labels: [string, string] | null;
}

export interface ChoiceBlock {
  kind: 'choice';
  mode: ChoiceMode;
  title: string | null;
  options: string[];
}

/**
 * M18 multi-question form container: several open-ended questions the user
 * answers one by one in separate fields and submits once. One question per
 * bullet line; a form must carry at least one question to materialize.
 */
export interface FormBlock {
  kind: 'form';
  title: string | null;
  questions: string[];
}

/** M11 F10 asset container (reserved grammar; consumers land in F10). */
export interface AssetBlock {
  kind: 'asset';
  assetKind: string;
  title: string | null;
  body: string;
}

export type StructuredBlock = ChoiceBlock | FormBlock | ScorecardBlock | AssetBlock;

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

/** Bounds and default for a scorecard's 1..scale rating range. */
export const SCORECARD_MIN_SCALE = 2;
export const SCORECARD_MAX_SCALE = 10;
export const SCORECARD_DEFAULT_SCALE = 5;

/**
 * Parse a scorecard `scale=` attribute into an integer rating ceiling.
 * Invalid or out-of-range values fall back to the default / nearest bound so
 * a malformed attribute degrades to a usable control rather than losing the
 * whole container. Scores always run 1..scale.
 */
export function parseScorecardScale(raw: string | undefined): number {
  if (raw === undefined) return SCORECARD_DEFAULT_SCALE;
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) return SCORECARD_DEFAULT_SCALE;
  return Math.min(SCORECARD_MAX_SCALE, Math.max(SCORECARD_MIN_SCALE, parsed));
}

/**
 * Parse a scorecard `labels=` attribute into exactly two end labels. The
 * separator is `|` (labels may themselves contain commas); anything that is
 * not two non-empty labels is dropped, since the labels are presentation only.
 */
export function parseScorecardLabels(raw: string | undefined): [string, string] | null {
  if (raw === undefined) return null;
  const parts = raw.split('|').map((part) => part.trim());
  if (parts.length !== 2) return null;
  const [low, high] = parts;
  if (low === undefined || high === undefined || low === '' || high === '') return null;
  return [low, high];
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
    if (kind !== 'choice' && kind !== 'asset' && kind !== 'form' && kind !== 'scorecard') {
      continue;
    }

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
    } else if (kind === 'form') {
      const attrs = parseFenceAttrs(tail);
      const questions: string[] = [];
      let fallbackTitle: string | null = null;
      for (const line of body) {
        const bullet = BULLET.exec(line ?? '');
        if (bullet) {
          const question = (bullet[1] ?? '').trim();
          if (question !== '') questions.push(question);
          continue;
        }
        const trimmed = (line ?? '').trim();
        if (trimmed !== '' && fallbackTitle === null) fallbackTitle = trimmed;
      }
      if (questions.length === 0) continue; // not a usable form — leave as text
      block = {
        kind: 'form',
        title: attrs.get('title') ?? fenceTailTitle(tail) ?? fallbackTitle,
        questions,
      };
    } else if (kind === 'scorecard') {
      const attrs = parseFenceAttrs(tail);
      const items: string[] = [];
      let fallbackTitle: string | null = null;
      for (const line of body) {
        const bullet = BULLET.exec(line ?? '');
        if (bullet) {
          const item = (bullet[1] ?? '').trim();
          if (item !== '') items.push(item);
          continue;
        }
        const trimmed = (line ?? '').trim();
        if (trimmed !== '' && fallbackTitle === null) fallbackTitle = trimmed;
      }
      if (items.length === 0) continue; // not a usable scorecard — leave as text
      block = {
        kind: 'scorecard',
        title: attrs.get('title') ?? fenceTailTitle(tail) ?? fallbackTitle,
        items,
        scale: parseScorecardScale(attrs.get('scale')),
        labels: parseScorecardLabels(attrs.get('labels')),
      };
    } else if (kind === 'asset') {
      const attrs = parseFenceAttrs(tail);
      // Kind values are machine tokens, not prose: normalize case + spacing so
      // `kind=Code` / `kind=" decision "` still render with the typed surface.
      const rawKind = (attrs.get('kind') ?? 'custom').trim().toLowerCase();
      block = {
        kind: 'asset',
        assetKind: rawKind === '' ? 'custom' : rawKind,
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
