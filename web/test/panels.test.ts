/**
 * Tap outside a floating pane to put it away — M20.A follow-up 9.
 *
 * The bug this encodes: on a touch tier the conversation rail (≤640) and the
 * two right-hand lanes (≤760) float over the transcript, and the ONLY way back
 * to the transcript was the toggle that had opened the pane. Measured @390×844
 * the open rail covers 320px of 390, and those toggles live in a horizontally
 * scrolling top bar. Touch has no Escape key, so a tap on the visible
 * transcript — the one gesture every touch user already knows — did nothing at
 * all.
 *
 * TWO KINDS OF ASSERTION, chosen deliberately:
 *
 *  - **Behavioural** for the decision (`lib/panels.ts`): which pane floats,
 *    which pane a tap puts away, and the load-bearing null — a pane that owns a
 *    column is never a target, so a stray tap on the desktop transcript cannot
 *    close it. That is real code, not a source grep.
 *  - **Source guards** for the wiring and the geometry, which no node test can
 *    render: the scrim exists in `App.tsx` and closes through `dismissPane`,
 *    the exit animation is declared AFTER the entry animation (equal
 *    specificity, so file order is what decides), and the reduced-motion
 *    fallback covers every selector that moves.
 *
 * The tier widths necessarily appear in three places (app.css, the lib, and
 * `App.tsx`'s `matchMedia` calls, which read the lib), so app.css is re-read
 * here and compared. Comments are stripped before matching, so prose describing
 * the fix cannot satisfy a guard.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LANE_OVERLAY_MAX_WIDTH,
  PANEL_EXIT_MS,
  PHONE_MAX_WIDTH,
  dismissTarget,
  floatingPanels,
  floatsOverTranscript,
  type OverlayTiers,
} from '../src/lib/panels.js';

const WEB = fileURLToPath(new URL('../', import.meta.url));

/** A source file with block comments and line comments removed. */
function source(relative: string): string {
  return readFileSync(join(WEB, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const APP = source('src/App.tsx');
const CSS = source('src/app.css');

interface CssBlock {
  /** The at-rule prelude, e.g. `(max-width: 640px)`. */
  prelude: string;
  /** Everything between the block's braces. */
  body: string;
}

/** Every nested at-rule block (`@media`) in file order, at any depth. */
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
      prelude: match[0].slice(0, -1).replace(/^@(media|supports|container)\s*/, '').trim(),
      body: css.slice(bodyStart, depth === 0 ? i - 1 : css.length),
    });
    match = re.exec(css);
  }
  return blocks;
}

/** Declarations of every rule whose selector list contains exactly `selector`. */
function declarations(body: string, selector: string): string {
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

const BLOCKS = atRuleBlocks(CSS);

/** Declarations for `selector` inside every block with this exact prelude. */
function tierDeclarations(prelude: string, selector: string): string {
  return BLOCKS.filter((b) => b.prelude === prelude)
    .map((b) => declarations(b.body, selector))
    .join('\n');
}

const DESKTOP: OverlayTiers = { rail: false, lanes: false };
/** Tablet: the lanes float, the rail is still a column. */
const LANES_ONLY: OverlayTiers = { rail: false, lanes: true };
/** Phone: both float. */
const PHONE: OverlayTiers = { rail: true, lanes: true };

describe('floating panes are a function of the tier, not the viewport', () => {
  it('the rail floats at the phone tier and the lanes float before it does', () => {
    // The order is the point: a tablet still has room for a rail column, so the
    // rail must not be treated as floating one tier early (that would make a
    // tap on the transcript close a column).
    expect(floatsOverTranscript('rail', PHONE)).toBe(true);
    expect(floatsOverTranscript('rail', LANES_ONLY)).toBe(false);
    expect(floatsOverTranscript('rail', DESKTOP)).toBe(false);
    for (const lane of ['notes', 'assets'] as const) {
      expect(floatsOverTranscript(lane, LANES_ONLY)).toBe(true);
      expect(floatsOverTranscript(lane, PHONE)).toBe(true);
      expect(floatsOverTranscript(lane, DESKTOP)).toBe(false);
    }
  });

  it('the tier widths are the ones app.css actually uses', () => {
    // Breaks if either number is edited on one side only — the failure mode is
    // silent: the shell renders a scrim at a width where the pane is a column
    // (or keeps a floating pane with no way to dismiss it by touch).
    expect(PHONE_MAX_WIDTH).toBe(640);
    expect(LANE_OVERLAY_MAX_WIDTH).toBe(760);

    // The rail is an overlay at the phone tier …
    expect(tierDeclarations(`(max-width: ${PHONE_MAX_WIDTH}px)`, '.chat-workspace .rail')).toMatch(
      /position:\s*absolute/,
    );
    // … and the lanes are overlays one tier earlier, which is why they float
    // first.
    expect(
      tierDeclarations(
        `(max-width: ${LANE_OVERLAY_MAX_WIDTH}px)`,
        '.chat-workspace.notes-lane-open .notes-mini',
      ),
    ).toMatch(/position:\s*absolute/);
    expect(
      tierDeclarations(
        `(max-width: ${LANE_OVERLAY_MAX_WIDTH}px)`,
        '.chat-workspace.assets-pane-open:not(.assets-expanded) .assets-lane',
      ),
    ).toMatch(/position:\s*absolute/);
  });

  it('the scrim is positioned against the workspace at the lane tier', () => {
    // The scrim is `inset: 0` inside `.chat-workspace`; without a positioned
    // containing block it would resolve against the viewport and cover (and
    // dim) the top bar whose toggles dismissed it.
    expect(tierDeclarations(`(max-width: ${LANE_OVERLAY_MAX_WIDTH}px)`, '.chat-workspace')).toMatch(
      /position:\s*relative/,
    );
  });

  it('the exit duration is the design system’s --motion-base, not a new number', () => {
    // The pane's state closes PANEL_EXIT_MS after the tap, so this must match
    // the animation it waits for (app.css) and the token behind it.
    const tokens = source('../shared/src/theme.ts');
    const base = /base:\s*'(\d+)ms'/.exec(tokens);
    expect(base, 'motion.base in shared/src/theme.ts').not.toBeNull();
    expect(PANEL_EXIT_MS).toBe(Number(base?.[1]));

    // …and app.css animates the panes with that token, not with a literal.
    expect(CSS).toMatch(
      /animation:\s*pane-out-right var\(--motion-base\) var\(--motion-ease\) forwards/,
    );
  });
});

describe('dismissTarget — what a tap on the transcript puts away', () => {
  it('is null when the panes are columns, whatever their state', () => {
    // The load-bearing case: on desktop/tablet the rail and lanes are columns,
    // so a tap on the transcript must never close one. Breaks if the tier is
    // read as "anything open" instead of "this pane floats".
    expect(dismissTarget({ rail: true, notes: true, assets: true }, DESKTOP)).toBeNull();
    expect(dismissTarget({ rail: true, notes: false, assets: false }, LANES_ONLY)).toBeNull();
  });

  it('is null when nothing is open, and the open pane otherwise', () => {
    expect(dismissTarget({ rail: false, notes: false, assets: false }, PHONE)).toBeNull();
    expect(dismissTarget({ rail: true, notes: false, assets: false }, PHONE)).toBe('rail');
    expect(dismissTarget({ rail: false, notes: true, assets: false }, PHONE)).toBe('notes');
    expect(dismissTarget({ rail: false, notes: false, assets: true }, PHONE)).toBe('assets');
    expect(dismissTarget({ rail: false, notes: false, assets: true }, LANES_ONLY)).toBe('assets');
  });

  it('a floating pane is the only floating pane (the shell’s own invariant)', () => {
    // The toggles dismiss a floating sibling before opening (App.tsx), because
    // at the phone tier two floating panes overlap: measured @390×844 the rail
    // is 320px of 390 and the notes lane floats at 272px — 202px of one pane
    // buried under the other. If two ever float, the target is the widest, so
    // the tap remains deterministic instead of order-dependent.
    const overlap = { rail: true, notes: true, assets: false };
    expect(floatingPanels(overlap, PHONE)).toEqual(['rail', 'notes']);
    expect(dismissTarget(overlap, PHONE)).toBe('rail');
  });

  it('the shell asks it with the two real tiers and its own pane state', () => {
    // Guards the wiring: `scrimPane` is derived from `dismissTarget`, not from
    // "some pane is open" — that difference is the whole desktop behaviour.
    expect(APP).toMatch(/const scrimPane =/);
    expect(APP).toMatch(
      /dismissTarget\(\s*\{ rail: railOpen, notes: notesLaneOpen, assets: assetsLaneOpen \},\s*\{ rail: phoneTier, lanes: laneOverlayTier \},?\s*\)/,
    );
  });
});

describe('the shell wires the scrim to every pane', () => {
  it('renders exactly one decorative scrim, closing the derived pane', () => {
    const scrims = APP.match(/className="panel-scrim"/g) ?? [];
    expect(scrims.length).toBe(1);
    // Decorative, like the More sheet's scrim: the keyboard path is the top
    // bar's toggles (plus each pane's own close control), which is why this
    // carries no role and stays out of the tab order.
    expect(APP).toMatch(/onClick=\{\(\) => dismissPane\(scrimPane\)\}/);
    expect(APP).toMatch(/<div\s+className="panel-scrim"\s+aria-hidden="true"/);
    expect(APP).not.toMatch(/className="panel-scrim"[^>]*tabIndex/);
  });

  it('every pane close path goes through dismissPane', () => {
    // Each occurrence is a pane the user can close; a direct
    // `setAssetsLaneOpen(false)` here would pop the pane instead of sliding it.
    for (const call of ["dismissPane('rail')", "dismissPane('notes')", "dismissPane('assets')"]) {
      expect(APP, call).toContain(call);
    }
    expect(APP).toMatch(/onClose=\{\(\) => dismissPane\('assets'\)\}/);
  });

  it('the exit class is on the workspace while a pane leaves', () => {
    expect(APP).toMatch(/exiting === null \? '' : PANEL_EXIT_CLASS\[exiting\]/);
    expect(APP).toMatch(/rail: 'rail-exiting'/);
    expect(APP).toMatch(/notes: 'notes-lane-exiting'/);
    expect(APP).toMatch(/assets: 'assets-pane-exiting'/);
  });

  it('a reduced-motion preference closes at once instead of waiting for a slide', () => {
    // app.css disables the animation under the same query, so waiting
    // PANEL_EXIT_MS would be a 180ms dead tap with nothing on screen moving.
    expect(APP).toMatch(/reduceMotion \|\|/);
    expect(APP).toMatch(/usePrefersReducedMotion/);
    expect(APP).toMatch(/prefers-reduced-motion: reduce/);
  });
});

describe('the scrim and the pane motion are the system’s, not new ones', () => {
  it('the scrim uses the same overlay value as the other two scrims', () => {
    // One scrim value in the system (More sheet, phone persona sheet, panes).
    // Breaks if the pane scrim invents its own tint or a border/glass panel.
    const scrim = declarations(CSS, '.panel-scrim');
    expect(scrim).toMatch(/position:\s*absolute/);
    expect(scrim).toMatch(/inset:\s*0/);
    expect(scrim).toMatch(/background:\s*color-mix\(in srgb, var\(--bg\) 55%, transparent\)/);
    const zIndex = Number(/z-index:\s*(\d+)/.exec(scrim)?.[1]);
    // Under the panes' 30: the scrim is the tap target for the space a pane
    // does NOT cover, never a cover over the pane.
    expect(zIndex).toBeLessThan(30);
  });

  it('the exit animation is declared after the entry animation', () => {
    // Both rules match while a pane is leaving (its "open" class is still on
    // the workspace) and they have equal specificity, so file order decides.
    // Breaks if the exit rule is moved above the entry rule: the pane then
    // animates IN while it is being closed and the tap looks ignored.
    for (const [entry, exit] of [
      ['animation: pane-in-right', 'animation: pane-out-right'],
      ['animation: pane-in-left', 'animation: pane-out-left'],
    ] as const) {
      expect(CSS.indexOf(entry), entry).toBeGreaterThan(-1);
      expect(CSS.indexOf(exit), exit).toBeGreaterThan(CSS.indexOf(entry));
    }
  });

  it('the entry animation runs only where the pane is an overlay', () => {
    // The rail animates in at the phone tier (where it is an overlay) …
    expect(
      tierDeclarations(`(max-width: ${PHONE_MAX_WIDTH}px)`, '.chat-workspace .rail'),
    ).toMatch(/animation:\s*pane-in-left/);
    // … and the lanes at the lane tier.
    expect(
      tierDeclarations(
        `(max-width: ${LANE_OVERLAY_MAX_WIDTH}px)`,
        '.chat-workspace.notes-lane-open .notes-mini',
      ),
    ).toMatch(/animation:\s*pane-in-right/);
  });

  it('every moving selector ships a reduced-motion fallback', () => {
    const motion = BLOCKS.filter((b) => b.prelude.includes('prefers-reduced-motion'))
      .map((b) => b.body)
      .join('\n');
    for (const selector of [
      '.panel-scrim',
      '.chat-workspace .rail',
      '.chat-workspace .notes-mini',
      '.chat-workspace .assets-lane',
    ]) {
      expect(declarations(motion, selector), selector).toMatch(/animation:\s*none\s*!important/);
    }
  });
});
