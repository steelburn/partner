/**
 * Sidebar minimize toggle — icon rail on tablet AND desktop (M20.A follow-up 10).
 *
 * The request: "for tablet view/desktop view, allow minimizing the side menu to
 * icons only, so that when toggled, we can maximize usable view."
 *
 * What that has to mean in this shell, and why each part is guarded here:
 *
 *  1. **The icon rail is a STATE, not only a breakpoint.** M12 already collapsed
 *     the sidebar to icons *below 1150* automatically; that left the labelled
 *     224px sidebar on every wider viewport — including an iPad in landscape
 *     (>1150 CSS px), which is why "tablet" and "desktop" both need the control.
 *     So `.side-minimized` carries the rail, the breakpoint only sets the
 *     default, and the toggle wins in both directions.
 *  2. **One width knob.** `.app-side { width: var(--side-w) }` and each state
 *     sets `--side-w`, so the sidebar cannot be 60px wide with 224px of labels,
 *     or vice versa.
 *  3. **The attention badge survives collapse.** An icon rail that hides
 *     "waiting on you" trades a blocked turn for 164px of width. The badge moves
 *     to the button's corner instead of being dropped (the phone tab bar's
 *     contract).
 *  4. **It cannot be a dead control.** The toggle lives *inside* the sidebar, so
 *     the phone tier (which hides the sidebar) cannot render it.
 *  5. **Token-only, and no half-slid motion.** The rail's width snaps — the
 *     labels leave via `display: none`, so there is nothing to animate them
 *     with and a partly-slid rail reads as a glitch. This file pins the absence
 *     of a transition rather than trusting the intent.
 *
 * The web suite is node-only (no DOM), so the geometry claims are measured in a
 * browser and recorded in `docs/VERIFY-MOBILE.md`; these guards protect the
 * decisions and the wiring that the measurements depend on.
 */
import { describe, expect, it } from 'vitest';
import { SIDE_RAIL_MAX_WIDTH } from '../src/lib/nav.js';
import { atRuleBlocks, declarations, source, topLevelRules } from './helpers/css.js';

const APP = source('src/App.tsx');
const CSS = source('src/app.css');
const BLOCKS = atRuleBlocks(CSS);

/** Declarations for `selector` in every block with this exact prelude. */
function tierDeclarations(prelude: string, selector: string): string {
  return BLOCKS.filter((b) => b.prelude === prelude)
    .map((b) => declarations(b.body, selector))
    .join('\n');
}

/** Base (non-media) declarations for `selector`. */
function baseDeclarations(selector: string): string {
  return topLevelRules(CSS)
    .filter(([s]) => s.split(',').map((part) => part.trim()).includes(selector))
    .map(([, d]) => d)
    .join('\n');
}

describe('the icon rail is a state with one width knob', () => {
  it('the sidebar width comes from --side-w, and each state sets it', () => {
    // Breaks if a second `width: 224px`-style rule returns: the rail would then
    // be a different width from the one the state declares, and the labels
    // could be hidden while the column stays wide (or the reverse).
    expect(baseDeclarations('.app-side')).toMatch(/width:\s*var\(--side-w\)/);
    expect(baseDeclarations('.app')).toMatch(/--side-w:\s*224px/);
    expect(baseDeclarations('.app.side-minimized')).toMatch(/--side-w:\s*60px/);
    // No stray literal width on the sidebar itself, in any block.
    expect(CSS).not.toMatch(/\.app-side\s*\{[^}]*width:\s*\d+px/);
  });

  it('the tablet tier only changes the DEFAULT width, never the state', () => {
    // Breaks if the collapse goes back into a media query: the toggle then
    // fights the breakpoint (the user expands, CSS re-collapses on the next
    // resize) — which is exactly what a user-visible control must not do.
    expect(SIDE_RAIL_MAX_WIDTH).toBe(1150);
    const tier = tierDeclarations(`(max-width: ${SIDE_RAIL_MAX_WIDTH}px)`, '.app:not(.side-minimized)');
    expect(tier).toMatch(/--side-w:\s*200px/);
    // The media query must not restate the minimized geometry: that belongs to
    // the state (only the sub-760 refinement below is tier-specific).
    expect(tierDeclarations(`(max-width: ${SIDE_RAIL_MAX_WIDTH}px)`, '.app-side')).not.toMatch(
      /align-items|--side-w/,
    );
    // The narrow refinement of the *minimized* rail is tier-scoped, and only
    // the minimized one.
    expect(tierDeclarations('(max-width: 760px)', '.app.side-minimized')).toMatch(/--side-w:\s*52px/);
  });

  it('minimized hides the labels and group titles, and centres the icons', () => {
    // The three-quarters of the sidebar that are text must actually leave.
    for (const selector of [
      '.app.side-minimized .side-brand',
      '.app.side-minimized .side-group-title',
      '.app.side-minimized .side-label',
    ]) {
      expect(baseDeclarations(selector), selector).toMatch(/display:\s*none/);
    }
    expect(baseDeclarations('.app.side-minimized .side-tab')).toMatch(/justify-content:\s*center/);
    expect(baseDeclarations('.app.side-minimized .side-nav')).toMatch(/width:\s*100%/);
  });

  it('the attention badge survives collapse instead of being dropped', () => {
    // Measured regression guard: the old automatic rail hid badges entirely
    // (`.app-side .side-tab .tab-badge { display: none }` at ≤1150). A badge
    // that disappears when the menu is small is how a blocked turn goes
    // unnoticed, which is the bug M20.A shipped attention badges to fix.
    const badgeRules = [
      ...topLevelRules(CSS).filter(([s]) => s.includes('.tab-badge')).map(([s, d]) => [s, d] as const),
      ...BLOCKS.flatMap((b) =>
        [...b.body.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1].trim(), m[2]] as const),
      ).filter(([s]) => s.includes('.tab-badge')),
    ];
    const offenders = badgeRules.filter(
      ([s, d]) => s.includes('.side-tab') && /display:\s*none/.test(d),
    );
    expect(offenders.map(([s]) => s)).toEqual([]);
    // …and the minimized rail gives it a corner instead (absolute inside the
    // 44px button, so it cannot widen the 60px rail).
    const badge = baseDeclarations('.app.side-minimized .side-tab .tab-badge');
    expect(badge).toMatch(/position:\s*absolute/);
    expect(badge).toMatch(/margin-left:\s*0/);
  });

  it('the rail keeps the touch floor and never animates half-way', () => {
    // Tablet is a touch surface (M20.A floor, ≤1150): the collapse chevron is a
    // control like any other.
    const floor = tierDeclarations(`(max-width: ${SIDE_RAIL_MAX_WIDTH}px)`, '.side-collapse');
    expect(floor).toMatch(/min-height:\s*var\(--target-min\)/);
    expect(floor).toMatch(/min-width:\s*var\(--target-min\)/);
    // No width transition: with `display: none` labels there is nothing to
    // animate them with, so a transition would slide a bare column. (If this
    // ever gains one, it needs its own prefers-reduced-motion guarantee.)
    expect(baseDeclarations('.app-side')).not.toMatch(/transition/);
    expect(baseDeclarations('.app.side-minimized')).not.toMatch(/transition/);
  });
});

describe('the shell wires the toggle', () => {
  it('the rail state is on the shell root, so one class drives the CSS', () => {
    expect(APP).toMatch(/className=\{sideMin \? 'app side-minimized' : 'app'\}/);
  });

  it('the toggle lives inside the sidebar, where the phone tier cannot show it', () => {
    // The phone tier hides `.app-side` outright (≤640), so a toggle placed in
    // the top bar would be a dead control there — and one more control in a
    // horizontally scrolling bar that M20.A already trimmed.
    const head = APP.slice(APP.indexOf('<div className="side-head">'), APP.indexOf('</aside>'));
    expect(head).toMatch(/className="btn btn-secondary btn-sm side-collapse"/);
    expect(head).toMatch(/aria-pressed=\{sideMin\}/);
    expect(head).toMatch(/aria-label=\{sideMin \? 'Expand menu' : 'Minimize menu'\}/);
    // Icon-only rail ⇒ the chevron points the way the sidebar will move.
    expect(head).toMatch(/\{sideMin \? <IconChevronRight \/> : <IconChevronLeft \/>\}/);
  });

  it('the tier decides the initial default, and the user overrides it', () => {
    // Breaks if the initializer stops reading the tablet boundary (a phone… a
    // 1024px tablet would open with 200px of labels) — or if the stored choice
    // stops being read (the toggle would reset on every reload).
    expect(APP).toMatch(/const SIDE_MIN_KEY = 'partner\.sideMinimized'/);
    expect(APP).toMatch(
      /readSession\(SIDE_MIN_KEY\)[\s\S]{0,200}matchMedia\(maxWidthQuery\(SIDE_RAIL_MAX_WIDTH\)\)\.matches/,
    );
    expect(APP).toMatch(/writeSession\(SIDE_MIN_KEY, minimized \? '0' : '1'\)/);
  });

  it('crossing into the tablet tier collapses it, and the crossing is not a fight', () => {
    // M12's rule (no menu may clip a smaller viewport) is preserved as a
    // *crossing* action: the effect depends on the tier boolean alone, so a
    // user who expands the rail at that width keeps it expanded.
    expect(APP).toMatch(
      /if \(!sideRailTier\) return;\s*setSideMin\(true\);\s*writeSession\(SIDE_MIN_KEY, '1'\);/,
    );
    expect(APP).toMatch(/window\.matchMedia\(maxWidthQuery\(SIDE_RAIL_MAX_WIDTH\)\)/);
  });

  it('the labels become tooltips exactly while they are off screen', () => {
    // The `aria-label` is the button's name at every tier; the tooltip only
    // exists to recover what `display: none` took away.
    expect(APP).toMatch(/title=\{minimized \? item\.label : undefined\}/);
    expect(APP).toMatch(/minimized=\{sideMin\}/);
  });
});
