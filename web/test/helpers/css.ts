/**
 * Minimal CSS-text helpers for the shell geometry guards.
 *
 * Why this exists at all: several guards in this suite assert on the *pinned*
 * properties of the real stylesheet (which tier a rule lives in, what a state
 * class carries, cascade order), because a node-only suite cannot render a
 * layout. Comments are stripped first, so prose describing a fix can never
 * satisfy a guard.
 *
 * Shared by `sidebar-collapse.test.ts`. The older `picker-mobile.test.ts` /
 * `panels.test.ts` still carry their own copies of `atRuleBlocks`; this module
 * exists so the next guard does not become a fourth copy.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = fileURLToPath(new URL('../../', import.meta.url));

/** A source file with block comments and line comments removed. */
export function source(relative: string): string {
  return readFileSync(join(WEB, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

export interface CssBlock {
  /** The at-rule prelude, e.g. `(max-width: 1150px)`. */
  prelude: string;
  /** Everything between the block's braces. */
  body: string;
  /** Start index of the whole block, including its prelude (cascade order). */
  at: number;
  /** End index, one past the block's closing brace. */
  end: number;
}

/** Every nested at-rule block (`@media`, `@supports`) in file order, any depth. */
export function atRuleBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  const re = /@(?:media|supports|container)\b[^{]*\{/g;
  let match = re.exec(css);
  while (match !== null) {
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < css.length && depth > 0) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') depth -= 1;
      i += 1;
    }
    blocks.push({
      prelude: match[0]
        .slice(0, -1)
        .replace(/^@(media|supports|container)\s*/, '')
        .trim(),
      body: css.slice(bodyStart, depth === 0 ? i - 1 : css.length),
      at: match.index,
      end: i,
    });
    match = re.exec(css);
  }
  return blocks;
}

/** Every rule in `body` whose selector list contains exactly `selector`. */
export function declarations(body: string, selector: string): string {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match = re.exec(body);
  while (match !== null) {
    const selectors = match[1].split(',').map((s) => s.trim());
    if (selectors.includes(selector)) out.push(match[2]);
    match = re.exec(body);
  }
  return out.join('\n');
}

/** The stylesheet with every at-rule block removed (spaces, so indices hold). */
export function withoutAtRules(css: string): string {
  let out = '';
  let cursor = 0;
  for (const block of atRuleBlocks(css)) {
    out += css.slice(cursor, block.at) + ' '.repeat(block.end - block.at);
    cursor = block.end;
  }
  return out + css.slice(cursor);
}

/** Base (non-media) rules as [selector, declarations] pairs, in file order. */
export function topLevelRules(css: string): Array<[string, string]> {
  const flat = withoutAtRules(css);
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match = re.exec(flat);
  while (match !== null) {
    out.push([match[1].trim(), match[2]]);
    match = re.exec(flat);
  }
  return out;
}
