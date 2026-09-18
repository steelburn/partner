/**
 * M32 — chat sessions under Personas.
 *
 * The request: "Submenu under Personas, chat sessions under personas."
 *
 * M30 had put the whole conversation/folder rail under the Chat destination;
 * that nested the session list inside the Chat menu as a second, internally
 * scrolling box. M32 moves the sessions to the persona they belong to:
 *
 *  1. **The Chat entry no longer owns a tree.** It stays a destination plus a
 *     `New chat` action; the session list lives under Personas.
 *  2. **Personas is a disclosure.** Selecting the view and expanding the tree
 *     are separate intents (the same contract the Chat tree used), and the
 *     tree is open by default.
 *  3. **One definition of the tree.** `PersonaChatTree` is mounted once from
 *     the shell; its grouping is pure (`groupConversations`) and unit-tested.
 *  4. **The phone overlay survives.** At ≤640 the sidebar is hidden, so
 *     `ConversationRail` still renders as the floating rail opened from the
 *     top bar.
 *  5. **The geometry is bounded.** The tree rides the `.side-chat-tree`
 *     wrapper's max-height + scroll, or it would crush the menu.
 *
 * The suite is node-only (no DOM), so the geometry claims are pinned against
 * app.css the way `sidebar-collapse.test.ts` does.
 */
import { describe, expect, it } from 'vitest';
import { SIDE_RAIL_MAX_WIDTH } from '../src/lib/nav.js';
import { atRuleBlocks, declarations, source, topLevelRules } from './helpers/css.js';

const APP = source('src/App.tsx');
const TREE = source('src/PersonaChatTree.tsx');
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

describe('the session tree lives under Personas', () => {
  it('the Personas destination and its disclosure are separate controls', () => {
    const nav = APP.slice(APP.indexOf('function SideNav'), APP.indexOf('function MobileNav'));
    expect(nav).toContain('className="side-chat-toggle"');
    expect(nav).toContain('aria-expanded={personaTreeOpen}');
    expect(nav).toContain('{personaTreeOpen && !minimized ? (');
    // Chat is a destination plus a New chat action; it owns no tree.
    expect(nav).toContain('className="btn btn-primary btn-sm side-new-chat"');
    expect(nav).not.toContain('side-chat-tree" id="side-chat-tree"');
  });

  it('the tree is open by default, and the shell owns the state', () => {
    expect(APP).toMatch(/const \[personaTreeOpen, setPersonaTreeOpen\] = useState<boolean>\(true\)/);
    expect(APP).toContain('onTogglePersonaTree={() => setPersonaTreeOpen((open) => !open)}');
  });

  it('there is exactly one definition of the session tree', () => {
    // Breaks if someone copies the tree JSX: the two surfaces would drift.
    expect((APP.match(/<PersonaChatTree/g) ?? []).length).toBe(1);
    expect(APP).toContain("import PersonaChatTree from './PersonaChatTree.js'");
  });

  it('the grouping is pure and keeps unassigned chats visible', () => {
    expect(TREE).toContain('export function groupConversations(');
    expect(TREE).toContain("unassigned.push(conversation)");
    // Every persona with a bucket, even when it has no chats.
    expect(TREE).toContain('for (const persona of personas) byPersona.set(persona.id, []);');
  });
});

describe('above the phone tier the transcript owns the width', () => {
  it('ConversationRail is the phone overlay only', () => {
    expect(APP).toContain('{phoneTier && railOpen ? conversationRail(false) : null}');
    // The sidebar gets the persona tree instead of the embedded rail.
    expect(APP).toContain('personaTree={');
    expect(APP).toContain('phoneTier ? null : (');
  });

  it('the phone overlay still opens from the top bar', () => {
    expect(APP).toMatch(
      /\{phoneTier \? \([\s\S]{0,400}onClick=\{toggleRail\}[\s\S]{0,200}\{railOpen \? 'Hide conversations' : 'Show conversations'\}/,
    );
    expect(APP).toMatch(/paired \? \(\s*<MobileNav/);
  });
});

describe('the sidebar geometry stays usable', () => {
  it('the tree is a bounded scroll region, not an unbounded menu eater', () => {
    expect(baseDeclarations('.side-chat-tree')).toMatch(/max-height:\s*min\(/);
    // M32: the persona tree has no inner rail, so the section itself scrolls.
    expect(baseDeclarations('.side-chat-tree')).toMatch(/overflow-y:\s*auto/);
    // … and the nav scrolls too, so the later groups stay reachable.
    expect(baseDeclarations('.side-nav')).toMatch(/overflow-y:\s*auto/);
  });

  it('the icon rail hides the tree and its disclosure, not just the labels', () => {
    expect(baseDeclarations('.app.side-minimized .side-chat-tree')).toMatch(/display:\s*none/);
    expect(baseDeclarations('.app.side-minimized .side-chat-toggle')).toMatch(/display:\s*none/);
    expect(baseDeclarations('.app.side-minimized .side-new-chat')).toMatch(/display:\s*none/);
  });

  it('the disclosure points right when closed and down when open', () => {
    expect(baseDeclarations('.side-persona-row[aria-expanded=\'false\'] .side-persona-caret')).toMatch(
      /transform:\s*rotate\(-90deg\)/,
    );
  });

  it('the disclosure keeps the touch floor on the tablet tier', () => {
    const floor = tierDeclarations(`(max-width: ${SIDE_RAIL_MAX_WIDTH}px)`, '.side-chat-toggle');
    expect(floor).toMatch(/min-height:\s*var\(--target-min\)/);
    expect(floor).toMatch(/min-width:\s*var\(--target-min\)/);
  });

  it('a session row is a button with an ellipsised title', () => {
    expect(baseDeclarations('.side-session')).toMatch(/width:\s*100%/);
    expect(baseDeclarations('.side-session-title')).toMatch(/text-overflow:\s*ellipsis/);
    expect(baseDeclarations('.side-session-title')).toMatch(/white-space:\s*nowrap/);
  });
});
