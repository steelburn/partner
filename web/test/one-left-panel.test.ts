/**
 * M30 — one left panel: the conversation list + folder tree under the Chat
 * entry, not a second rail column.
 *
 * The request: "Instead of one panel for menu, and one panel dedicated for
 * Chat, organize them under Chat menu. Don't forget folders."
 *
 * What that has to mean in this shell, and why each part is guarded here:
 *
 *  1. **One definition of the tree.** `ConversationRail` is rendered from a
 *     single `conversationRail(embedded)` helper, so the sidebar section and
 *     the phone overlay cannot drift; only the wrapper class changes.
 *  2. **The Chat entry owns it.** The sidebar renders the tree directly under
 *     the Chat destination, with a separate disclosure control (selecting the
 *     view and showing the tree are different intents). Folders ride along
 *     because the whole rail moves, not a trimmed list.
 *  3. **The transcript gets its width back above the phone tier.** The
 *     workspace rail is rendered ONLY when the phone tier floats it; the
 *     resizable rail column and its divider are gone.
 *  4. **The phone overlay survives.** At ≤640 the sidebar is hidden, so the
 *     tree must still be the floating rail opened from the top bar.
 *  5. **The geometry is bounded.** The twelve-item menu already fills a
 *     laptop-height sidebar, so the tree needs a max-height (and its own
 *     scroll) or it would crush the menu or be crushed by it.
 *
 * The suite is node-only (no DOM), so the geometry claims are pinned against
 * app.css the way `sidebar-collapse.test.ts` does.
 */
import { describe, expect, it } from 'vitest';
import { SIDE_RAIL_MAX_WIDTH } from '../src/lib/nav.js';
import { atRuleBlocks, declarations, source, topLevelRules } from './helpers/css.js';

const APP = source('src/App.tsx');
const RAIL = source('src/ConversationRail.tsx');
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

describe('the conversation tree lives under the Chat entry', () => {
  it('the Chat destination and its disclosure are separate controls', () => {
    // The disclosure is what makes the tree fit inside the menu instead of
    // permanently spending the menu's height on conversations.
    const nav = APP.slice(APP.indexOf('function SideNav'), APP.indexOf('function MobileNav'));
    expect(nav).toContain("className=\"side-chat-toggle\"");
    expect(nav).toContain('aria-expanded={chatTreeOpen}');
    expect(nav).toContain('{chatTreeOpen && !minimized ? (');
    expect(nav).toContain("className=\"side-chat-tree\"");
    // A down-chevron is the disclosure; the destination keeps its own label.
    expect(nav).toContain('<IconChevronDown />');
  });

  it('the tree is open by default, and the shell owns the state', () => {
    // An explicit boolean (not persisted: it is layout, and a new key would
    // have to be justified to the storage guard).
    expect(APP).toMatch(/const \[chatTreeOpen, setChatTreeOpen\] = useState<boolean>\(true\)/);
    expect(APP).toContain('onToggleChatTree={() => setChatTreeOpen((open) => !open)}');
  });

  it('there is exactly one definition of the tree, used by both surfaces', () => {
    // Breaks if someone copies the rail JSX into the sidebar: the two surfaces
    // would drift (a folder action added to one, not the other).
    expect((APP.match(/<ConversationRail/g) ?? []).length).toBe(1);
    expect(APP).toContain('const conversationRail = (embedded: boolean): ReactNode => (');
    expect((APP.match(/conversationRail\(/g) ?? []).length).toBe(2);
  });

  it('ConversationRail drops its fixed column width only when embedded', () => {
    expect(RAIL).toMatch(/embedded\?: boolean/);
    expect(RAIL).toMatch(/embedded = false/);
    expect(RAIL).toMatch(/embedded \? 'rail rail-embedded' : 'rail'/);
  });
});

describe('above the phone tier the transcript owns the width', () => {
  it('the workspace rail is rendered only while the phone tier floats it', () => {
    expect(APP).toContain('{phoneTier && railOpen ? conversationRail(false) : null}');
    // The sidebar carries it everywhere else (and not on a phone, where the
    // sidebar is display:none).
    expect(APP).toContain('chatTree={phoneTier ? null : conversationRail(true)}');
  });

  it('the resizable rail column and its divider are gone', () => {
    // The point of the merge: no second column, so no drag width and no
    // `--rail-w` inline style.
    expect(APP).not.toContain('Resize conversations');
    expect(APP).not.toContain('RAIL_W_KEY');
    expect(APP).not.toMatch(/railW/);
    expect(APP).not.toContain("'--rail-w'");
  });

  it('the phone overlay still opens from the top bar', () => {
    // The only dead-control risk: the rail's toggle now exists on phone only,
    // because everywhere else the tree is in the sidebar.
    expect(APP).toMatch(
      /\{phoneTier \? \([\s\S]{0,400}onClick=\{toggleRail\}[\s\S]{0,200}\{railOpen \? 'Hide conversations' : 'Show conversations'\}/,
    );
    expect(APP).toMatch(/paired \? \(\s*<MobileNav/);
  });
});

describe('the sidebar geometry stays usable', () => {
  it('the embedded rail fills its section instead of the fixed 288px column', () => {
    // Equal specificity, so file order decides: `.rail-embedded` must come
    // after `.rail` or the fixed width wins.
    expect(baseDeclarations('.rail')).toMatch(/width:\s*288px/);
    expect(baseDeclarations('.rail-embedded')).toMatch(/width:\s*auto/);
    expect(baseDeclarations('.rail-embedded')).toMatch(/flex:\s*1/);
    expect(CSS.indexOf('.rail {')).toBeLessThan(CSS.indexOf('.rail-embedded'));
  });

  it('the tree is a bounded scroll region, not an unbounded menu eater', () => {
    expect(baseDeclarations('.side-chat-tree')).toMatch(/max-height:\s*min\(/);
    // The tree's content scrolls inside it …
    expect(baseDeclarations('.rail-body')).toMatch(/overflow-y:\s*auto/);
    expect(baseDeclarations('.rail-body')).toMatch(/scrollbar-width:\s*thin/);
    // … and the nav scrolls too, so the later groups stay reachable.
    expect(baseDeclarations('.side-nav')).toMatch(/overflow-y:\s*auto/);
  });

  it('the icon rail hides the tree and its disclosure, not just the labels', () => {
    // A tree left rendering inside a 60px rail would be a layout bug — and the
    // disclosure would be a dead 32px control.
    expect(baseDeclarations('.app.side-minimized .side-chat-tree')).toMatch(/display:\s*none/);
    expect(baseDeclarations('.app.side-minimized .side-chat-toggle')).toMatch(/display:\s*none/);
  });

  it('the disclosure points right when closed and down when open', () => {
    expect(baseDeclarations('.side-chat-toggle svg')).toMatch(/transform:\s*rotate\(-90deg\)/);
    expect(baseDeclarations(".side-chat-toggle[aria-expanded='true'] svg")).toMatch(
      /transform:\s*rotate\(0deg\)/,
    );
  });

  it('the disclosure keeps the touch floor on the tablet tier', () => {
    // Tablet is a touch surface (M20.A floor, ≤1150); the chevron is a control
    // like any other, even though it is desk-sized on wider tiers.
    const floor = tierDeclarations(`(max-width: ${SIDE_RAIL_MAX_WIDTH}px)`, '.side-chat-toggle');
    expect(floor).toMatch(/min-height:\s*var\(--target-min\)/);
    expect(floor).toMatch(/min-width:\s*var\(--target-min\)/);
  });
});
