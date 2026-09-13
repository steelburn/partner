/**
 * Chrome lives in the top bar — one control per concern (regression guard).
 *
 * History, because the direction of this guard was reversed once and the
 * numbers are why: the assets lane and the per-conversation theme select each
 * had TWO homes — the shell's top bar and a row directly above the composer.
 * Both copies were bound to the same handler/state and were on screen
 * simultaneously (measured @390×844: 49×44 at y 8–52 and 73×44 at y 631–675,
 * 579px apart). The resolution (2026-09-13, owner: "move Theme and Assets to
 * top") is the shell's own M14 intent — app.css: "a slim top bar (persona
 * picker + lane/theme controls)" — so BOTH controls live in the top bar and the
 * chat-bar row keeps only conversation-context (brainstorm state, save flash).
 *
 * Two invariants are load-bearing and each names what breaks it:
 *
 *  1. **One control per concern.** A second assets toggle re-creates the
 *     duplicate; a second theme select re-creates it for theme.
 *  2. **The assets toggle is gated on a conversation.** The lane is
 *     conversation-scoped (`listAssets(token, conversationId)`), so ungated it
 *     opens a 300px column that renders one line of copy — measured at 1280×900
 *     as the chat input going **682px → 366px** for nothing. That is why the
 *     `disabled` expression is asserted, not just the handler.
 *
 * Comments are stripped before matching, so prose DESCRIBING the decision
 * (including the rationale comments in `App.tsx`/`ChatStrip.tsx`) cannot satisfy
 * a guard. This is a source guard, not a render test — the web suite is
 * node-only — so the geometry above was verified in a browser and recorded in
 * `docs/VERIFY-MOBILE.md`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function read(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const APP = read('App.tsx');
const CHAT = read('ChatStrip.tsx');
const LANE = read('AssetsLane.tsx');

describe('top bar owns the assets toggle and the conversation theme', () => {
  it('the assets toggle exists exactly once, and it lives in the top bar', () => {
    // Breaks if the button is re-added to ChatStrip (the duplicate that made two
    // controls 579px apart) — or removed entirely (the lane becomes unreachable).
    const toggles = APP.match(/aria-label=\{assetsLaneOpen \? 'Hide assets panel' : 'Show assets panel'\}/g) ?? [];
    expect(toggles.length).toBe(1);
    expect(APP).toMatch(/onClick=\{toggleAssetsLane\}/);
    expect(CHAT).not.toMatch(/onToggleAssets/);
    expect(CHAT).not.toMatch(/assetsOpen/);
  });

  it('the assets toggle is gated on an active conversation', () => {
    // The gate is what stops the width theft: no conversation ⇒ disabled ⇒ the
    // pane (and its 300px column) cannot be opened for a one-line placeholder.
    expect(APP).toMatch(/disabled=\{activeConversationId === null\}/);
  });

  it('the conversation theme select exists exactly once, in the top bar', () => {
    const labels = APP.match(/aria-label="Theme for this conversation"/g) ?? [];
    expect(labels.length).toBe(1);
    // ChatStrip must not carry a second copy of the select or its options.
    expect(CHAT).not.toMatch(/Theme for this conversation/);
    expect(CHAT).not.toMatch(/onBindTheme/);
    expect(CHAT).not.toMatch(/themes/);
  });

  it('the pane keeps its own close control, so it is always closable', () => {
    expect(LANE).toMatch(/className="assets-lane-close"/);
    expect(LANE).toMatch(/onClick=\{onClose\}/);
  });

  it('the assets lane is opened from one handler only', () => {
    // `toggleAssetsLane` in App.tsx: its definition + the single onClick. It is
    // no longer passed down as a prop, so a third occurrence means a second
    // control was wired up again.
    expect(APP).toMatch(/const toggleAssetsLane = useCallback/);
    expect((APP.match(/toggleAssetsLane/g) ?? []).length).toBe(2);
  });
});
