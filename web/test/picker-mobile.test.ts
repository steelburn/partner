/**
 * Phone persona picker — geometry guard (regression for the mobile fix).
 *
 * The bug this encodes, measured @390x844 at HEAD with the 9 demo personas:
 * the top bar is a horizontal scroller (`.app-topbar-right { overflow-x: auto }`
 * at the phone tier), and `overflow-x: auto` forces `overflow-y: auto`, so the
 * absolutely positioned `.picker-pop` was laid out 655px tall but painted only
 * inside the bar's 60px band. One persona of nine was visible; the focus move
 * on open scrolled the bar itself up 65px, so the trigger left the screen. The
 * list looked present, was reachable by scroll, and was unusable.
 *
 * Geometry cannot be asserted from CSS text alone, so this file guards the
 * INVARIANTS the fix depends on, and each guard names the change that breaks
 * it. The live measurements (viewport fit, row height, last option reachable)
 * were taken in a real browser at 360x640, 390x844, 844x390, 768x600 and
 * 1280x900 — see PLAN-M20.md, "Persona picker on a phone".
 *
 * Comments are stripped before asserting, so a comment that merely DESCRIBES
 * the fix cannot satisfy a guard (this file's own subject matter is prose-heavy
 * by convention, which is exactly why that stripping is not optional).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** The stylesheet with block comments removed (see the header note). */
function cssSource(): string {
  return readFileSync(join(SRC, 'app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** A component source with comments and line-comments removed. */
function componentSource(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

interface CssBlock {
  /** The full at-rule prelude, e.g. `@media (max-width: 640px)`. */
  prelude: string;
  /** Everything between the block's braces. */
  body: string;
}

/**
 * Every at-rule block that contains a nested block (`@media`, `@supports`),
 * including blocks nested inside other at-rules — the ≤640 tier contains a
 * nested reduced-motion query, so a non-nesting regex would either miss rules
 * or cut a block short at the first inner brace.
 */
function atRuleBlocks(css: string): CssBlock[] {
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
      prelude: match[0].slice(0, -1).trim(),
      body: css.slice(bodyStart, depth === 0 ? i - 1 : css.length),
    });
    match = re.exec(css);
  }
  return blocks;
}

/** Rules whose selector list contains `selector`, as [selector, declarations]. */
function rulesFor(body: string, selector: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match = re.exec(body);
  while (match !== null) {
    const selectors = match[1]
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (selectors.includes(selector)) out.push([selectors.join(', '), match[2]]);
    match = re.exec(body);
  }
  return out;
}

const CSS = cssSource();

/** Phone-tier blocks (`max-width: 640px`), at any nesting depth. */
const PHONE_BLOCKS = atRuleBlocks(CSS).filter((b) => b.prelude.includes('max-width: 640px'));

/** Rule text for `selector` inside the phone tier, or '' when absent. */
function phoneRule(selector: string): string {
  return PHONE_BLOCKS.flatMap((b) => rulesFor(b.body, selector))
    .map(([, declarations]) => declarations)
    .join('\n');
}

/**
 * Declarations of the FIRST rule for `selector` in file order.
 *
 * The base (desktop/tablet) rules are declared before any tier override, so
 * first-match is the base rule — pattern-matching `` rules inside a media
 * prelude cannot be used here: this file's first `max-width: 640px` block is
 * ~1500 lines before the picker section.
 */
function firstRule(selector: string): string {
  return rulesFor(CSS, selector)
    .map(([, declarations]) => declarations)
    .slice(0, 1)
    .join('\n');
}

/** Reduced-motion blocks, at any nesting depth. */
const MOTION_BLOCKS = atRuleBlocks(CSS).filter((b) =>
  b.prelude.includes('prefers-reduced-motion'),
);

describe('phone persona picker geometry guard', () => {
  it('the top bar really is a scroller at the phone tier (the cause)', () => {
    // If this ever stops being true the fix below is merely unnecessary, not
    // wrong — but the premise changed, so this guard should be re-read rather
    // than deleted silently.
    expect(phoneRule('.app-topbar-right')).toMatch(/overflow-x:\s*auto/);
  });

  it('the phone list is viewport-anchored, so the bar cannot clip it', () => {
    // Breaks if `.picker-pop` goes back to `position: absolute` (or `static`)
    // at ≤640: it re-enters the bar's scroll box and is clipped to ~60px again.
    expect(phoneRule('.picker-pop')).toMatch(/position:\s*fixed/);
  });

  it('the phone list is anchored on the tab bar, capped, and scrollable', () => {
    const rule = phoneRule('.picker-pop');
    // Anchored above the tab bar: `bottom` must be derived from the chrome
    // token, not a magic number that drifts when the bar's height changes.
    expect(rule).toMatch(/bottom:\s*calc\(var\(--bottom-nav-h\)[^)]*\)/);
    // Capped + scrollable, so a long persona list cannot run off the screen
    // and the last rows stay reachable.
    expect(rule).toMatch(/max-height:\s*60dvh/);
    expect(rule).toMatch(/overflow-y:\s*auto/);
  });

  it('the desktop/tablet popover is bounded by the space below the bar', () => {
    // Breaks if the base `max-height` is dropped: a landscape phone (844x390)
    // is outside the ≤640 tier, so its 655px list would overflow the 390px
    // viewport with 9 personas and the tail would be unreachable.
    const base = firstRule('.picker-pop');
    expect(base).toMatch(/position:\s*absolute/);
    expect(base).toMatch(/max-height:\s*calc\(100dvh -/);
    expect(base).toMatch(/overflow-y:\s*auto/);
  });

  it('rows keep their size instead of being squashed to fit', () => {
    // The popover is a scroll container with a bounded height; without
    // `flex: none` a flex child may shrink, taking rows under the 44px floor.
    expect(firstRule('.picker-option')).toMatch(/flex:\s*none/);
  });

  it('the sheet motion ships a reduced-motion fallback', () => {
    // Breaks if `.picker-pop` leaves the reduced-motion token list: the sheet
    // then animates for users who asked for no motion.
    const covered = MOTION_BLOCKS.some((b) =>
      rulesFor(b.body, '.picker-pop').some(([, d]) => /animation:\s*none/.test(d)),
    );
    expect(covered).toBe(true);
  });

  it('the phone scrim signals modality over the transcript', () => {
    // The desktop scrim stays transparent (the popover is a small well); the
    // phone sheet covers 60% of the screen, so it needs the same tint as the
    // More sheet it is modelled on.
    expect(phoneRule('.picker-scrim')).toMatch(/background:\s*color-mix\(in srgb, var\(--bg\) 55%, transparent\)/);
  });

  it('the phone bar drops the LEVEL chip but never the PAUSED chip', () => {
    // The phone top bar also carries three lane toggles, the per-conversation
    // theme select and the mode toggle. Measured @390×844: 348px of controls +
    // 40px of gaps in a 358px content box clipped the mode toggle by 14px, so
    // `picker-level` (31px + its 8px gap) gives way — it is the one control
    // whose information the picker sheet repeats for every persona.
    //
    // Breaks if: the level chip loses its own class (it merges back into
    // `.chip` and the rule hides Paused too), or the rule widens to all chips.
    // Hiding Paused would hide "this persona refuses chat" on the one form
    // factor where the sheet is the only other place to learn it.
    expect(componentSource('PersonaPicker.tsx')).toMatch(/className="chip picker-level"/);
    expect(componentSource('PersonaPicker.tsx')).toMatch(/className="chip">Paused</);
    expect(phoneRule('.picker-trigger .picker-level')).toMatch(/display:\s*none/);
    expect(phoneRule('.picker-trigger .chip')).not.toMatch(/display:\s*none/);
  });
});
