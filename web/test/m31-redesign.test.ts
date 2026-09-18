/**
 * M31 — the redesign: a card-deck Personas view with a slide-out editor, and a
 * magazine layout for Notes & Plans.
 *
 * The web suite is node-only (no DOM), so these are source guards in the
 * established style: they pin the structure that makes the redesign what it is
 * (and that a later refactor could silently undo), not the pixels.
 *
 *  1. **Personas are cards; editing is a drawer.** The card face opens the
 *     editor; pause and delete stay on the card (the kill switch must not be
 *     behind a click). Exactly one `PersonaEditor` is mounted, and only inside
 *     the drawer — the old inline `row-form` editor is gone.
 *  2. **The drawer is a real dialog.** `role="dialog"` + `aria-modal`, a
 *     scrim, and Escape to close.
 *  3. **Notes & Plans is a magazine.** A masthead (folio → title → deck), a
 *     wider measure, hairline section rules, and a lead item spanning the
 *     full measure over a river of entries.
 */
import { describe, expect, it } from 'vitest';
import { atRuleBlocks, declarations, source, topLevelRules } from './helpers/css.js';

const PERSONAS = source('src/PersonaManagerView.tsx');
const NOTES = source('src/NotesView.tsx');
const CSS = source('src/app.css');
const BLOCKS = atRuleBlocks(CSS);

/** Base (non-media) declarations for `selector`. */
function baseDeclarations(selector: string): string {
  return topLevelRules(CSS)
    .filter(([s]) => s.split(',').map((part) => part.trim()).includes(selector))
    .map(([, d]) => d)
    .join('\n');
}

/** Declarations for `selector` in every block with this exact prelude. */
function tierDeclarations(prelude: string, selector: string): string {
  return BLOCKS.filter((b) => b.prelude === prelude)
    .map((b) => declarations(b.body, selector))
    .join('\n');
}

describe('Personas is a deck of cards with a slide-out editor', () => {
  it('renders the deck and the card face', () => {
    expect(PERSONAS).toContain('className="persona-deck"');
    expect(PERSONAS).toContain('className={paused ? \'persona-card is-paused\' : \'persona-card\'}');
    expect(PERSONAS).toContain('className="persona-card-open"');
    // The card face carries the facts; the footer carries the two actions.
    expect(PERSONAS).toContain('className="persona-card-facts"');
    expect(PERSONAS).toContain('className="persona-card-actions"');
    expect(PERSONAS).toContain('onClick={onEdit}');
  });

  it('mounts exactly one editor, inside the drawer', () => {
    expect((PERSONAS.match(/<PersonaEditor/g) ?? []).length).toBe(1);
    const drawer = PERSONAS.slice(PERSONAS.indexOf('className="persona-drawer-body"'));
    expect(drawer).toContain('<PersonaEditor');
    // The old inline editor is gone — no second editing path.
    expect(PERSONAS).not.toContain('className="row-form"');
    expect(PERSONAS).not.toContain('setEditing');
  });

  it('the drawer is a modal dialog with a scrim and an Escape close', () => {
    expect(PERSONAS).toContain('className="persona-drawer"');
    expect(PERSONAS).toContain('role="dialog"');
    expect(PERSONAS).toContain('aria-modal="true"');
    expect(PERSONAS).toContain('className="persona-drawer-scrim"');
    expect(PERSONAS).toMatch(/event\.key === 'Escape'[\s\S]{0,40}setDrawer\(null\)/);
    // Focus moves into the form on open.
    expect(PERSONAS).toContain('document.getElementById(nameId)?.focus()');
    // One editor state drives create and edit.
    expect(PERSONAS).toContain("useState<{ kind: 'new' } | { kind: 'edit'; id: string } | null>(null)");
  });

  it('the theme bind moved into the drawer, not the card', () => {
    // A bind select on every card was the old row layout; the drawer owns all
    // editable details now.
    const drawer = PERSONAS.slice(PERSONAS.indexOf('className="persona-drawer-body"'));
    expect(drawer).toContain('<PersonaThemeBind');
    expect(PERSONAS).not.toContain('className="persona-theme-bind"');
  });
});

describe('Notes & plans is a magazine', () => {
  it('opens with a masthead: folio, title, deck, segments', () => {
    expect(NOTES).toContain('className="mag-masthead"');
    expect(NOTES).toContain('className="mag-folio"');
    expect(NOTES).toContain('className="mag-title"');
    expect(NOTES).toContain('className="mag-deck"');
    // The segment switch belongs to the masthead, not a floating bar.
    expect(NOTES.indexOf('mag-masthead')).toBeLessThan(NOTES.indexOf('seg-tabs'));
  });

  it('widens the measure into a river with a full-width lead', () => {
    expect(baseDeclarations('.notes-panel')).toMatch(/max-width:\s*1200px/);
    // A second, wider step on a large display.
    const wide = tierDeclarations('(min-width: 1600px)', '.notes-panel');
    expect(wide).toMatch(/max-width:\s*1360px/);
    // The list becomes a grid …
    expect(baseDeclarations('.notes-panel .n-list')).toMatch(/grid-template-columns/);
    expect(baseDeclarations('.notes-panel .p-list')).toMatch(/grid-template-columns/);
    // … and the newest item spans it.
    expect(baseDeclarations('.notes-panel .n-list > li:first-child')).toMatch(
      /grid-column:\s*1\s*\/\s*-1/,
    );
    expect(baseDeclarations('.notes-panel .n-list > li:first-child .n-row-title')).toMatch(
      /font-size:\s*var\(--fs-xl\)/,
    );
  });

  it('edits sections with rules instead of card surfaces, but keeps the documents', () => {
    // List sections go flat and ruled …
    expect(baseDeclarations('.notes-panel .card:not(.n-editor):not(.p-planner)')).toMatch(
      /border-top:\s*1px solid var\(--border\)/,
    );
    // … while the note editor and the plan planner keep their surface.
    expect(baseDeclarations('.notes-panel .n-editor')).toMatch(/background:\s*var\(--surface\)/);
    expect(baseDeclarations('.notes-panel .p-planner')).toMatch(/background:\s*var\(--surface\)/);
  });
});

describe('the new geometry stays token-only and motion-safe', () => {
  it('the persona deck is a responsive card grid', () => {
    expect(baseDeclarations('.persona-deck')).toMatch(/display:\s*grid/);
    expect(baseDeclarations('.persona-deck')).toMatch(/repeat\(auto-fill, minmax\(280px, 1fr\)\)/);
    // The fact row keeps three fixed columns; the labels are short enough to
    // truncate rather than wrap on a narrow card.
    expect(baseDeclarations('.persona-card-facts')).toMatch(/repeat\(3, minmax\(0, 1fr\)\)/);
  });

  it('the drawer is fixed, above the panes, and reduced-motion safe', () => {
    const drawer = baseDeclarations('.persona-drawer');
    expect(drawer).toMatch(/position:\s*fixed/);
    expect(drawer).toMatch(/z-index:\s*41/);
    expect(baseDeclarations('.persona-drawer-scrim')).toMatch(/z-index:\s*40/);
    expect(tierDeclarations('(prefers-reduced-motion: reduce)', '.persona-drawer')).toMatch(
      /animation:\s*none/,
    );
  });

  it('the magazine uses only theme tokens for its type', () => {
    // No raw font sizes: the masthead graduates on the shared scale.
    const masthead = baseDeclarations('.mag-title');
    expect(masthead).toMatch(/font-size:\s*var\(--fs-xxl\)/);
    expect(masthead).toMatch(/letter-spacing:\s*var\(--track-head\)/);
    expect(baseDeclarations('.mag-kicker')).toMatch(/color:\s*var\(--accent\)/);
  });
});
