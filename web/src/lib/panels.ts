/**
 * Floating rails (M20.A follow-up) — which panes float over the transcript, and
 * what a tap outside them puts away.
 *
 * On a touch tier the conversation rail and the two right-hand lanes stop
 * owning a column and float over the transcript (app.css: ≤640 for the rail,
 * ≤760 for the lanes). A floating pane covers most of a phone viewport, and
 * before this module the only way back to the transcript was the toggle that
 * had opened it: measured @390×844 the open rail covers 320px of 390, and those
 * toggles live in a horizontally scrolling top bar. Touch has no Escape key, so
 * the gesture every touch user already knows — tap the content you can see —
 * did nothing. It means "put the pane away" now.
 *
 * Why this is a module: the tier widths are geometry (app.css) but the
 * *decision* is behaviour, and a source guard on a CSS string cannot prove that
 * a tap outside closes anything, or that a pane which owns a column is never
 * closed by one. `panels.test.ts` exercises the decisions here and re-reads
 * app.css plus `shared/src/theme.ts`, so the two copies of 640 / 760 and of the
 * motion duration cannot drift apart.
 */

/** A pane that can float over the transcript. */
export type OverlayPanel = 'rail' | 'notes' | 'assets';

/** Phone tier, ≤640 in app.css: the rail joins the overlays here (it floats
 *  later than the lanes, because a phone has one column and no width for
 *  either). */
export const PHONE_MAX_WIDTH = 640;

/** ≤760 in app.css: the two right-hand lanes float from here — they go over
 *  the transcript before the rail does, at widths that still keep a rail
 *  column. */
export const LANE_OVERLAY_MAX_WIDTH = 760;

/** Which panes float for the current form factor: the two `matchMedia`
 *  booleans the shell tracks. They are state defaults only — layout stays in
 *  CSS so there is one source of truth per form factor (DESIGN.md, M20.A). */
export interface OverlayTiers {
  /** Phone tier (`PHONE_MAX_WIDTH`). */
  rail: boolean;
  /** Lane tier (`LANE_OVERLAY_MAX_WIDTH`). */
  lanes: boolean;
}

/** Which panes are open — the shell's own state. */
export interface PanelOpenState {
  rail: boolean;
  notes: boolean;
  assets: boolean;
}

/**
 * How long a pane's exit animation runs: `--motion-base` (180ms), whose single
 * source of truth is `shared/src/theme.ts`. The pane's state closes this long
 * after the tap, so the slide-out finishes before the element leaves the tree.
 */
export const PANEL_EXIT_MS = 180;

/** True when `panel` floats over the transcript at these tiers — and is
 *  therefore dismissable by a tap on the transcript at all. */
export function floatsOverTranscript(panel: OverlayPanel, tiers: OverlayTiers): boolean {
  return panel === 'rail' ? tiers.rail : tiers.lanes;
}

/** The open panes that float right now, widest first (rail, then the lanes). */
export function floatingPanels(state: PanelOpenState, tiers: OverlayTiers): OverlayPanel[] {
  return (['rail', 'notes', 'assets'] as const).filter(
    (panel) => state[panel] && floatsOverTranscript(panel, tiers),
  );
}

/**
 * The pane a tap on the transcript puts away, or `null` when nothing floats.
 *
 * `null` is the desktop/tablet answer, and it is load-bearing: there the panes
 * are columns, and a tap on the transcript must never close one. Only one pane
 * can float at a time, because opening a floating pane dismisses its siblings
 * (the shell's toggles) — at the phone tier two of them overlap: measured
 * @390×844 the rail is 320px of 390 and the notes lane floats at 272px, burying
 * 202px of one pane under the other. So "the first entry" is the single open
 * pane; it orders widest-first if that ever stops being true.
 */
export function dismissTarget(state: PanelOpenState, tiers: OverlayTiers): OverlayPanel | null {
  return floatingPanels(state, tiers)[0] ?? null;
}
