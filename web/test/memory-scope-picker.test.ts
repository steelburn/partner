/**
 * M33 — "Applies to" is a multi-select, not an All-personas-or-one select.
 *
 * The web suite is node-only (no DOM), so this is a source + stylesheet guard
 * in the established style (`m31-redesign.test.ts`, `picker-mobile.test.ts`):
 * it pins the decisions a later refactor could silently undo, not the pixels.
 *
 *  1. **One picker, three call sites.** The edit form, the one-step suggestion
 *     re-scope and the add-entry form all render the same `ScopePicker`, so
 *     they cannot drift into three different scope models.
 *  2. **No scope `<select>` anywhere.** A single-choice control cannot express
 *     "these two personas and no others" — the model that made the old UI
 *     wrong. Only the kind select remains in the view.
 *  3. **"All personas" IS the empty set.** It is a checkbox beside the others:
 *     ticking a persona clears it, unticking the last one returns to it, so
 *     there is never a ticked-nothing state with no meaning.
 *  4. **A removed persona stays ticked.** Opening a fact whose persona was
 *     deleted must not silently widen it to every persona.
 *  5. **The wire field is the array.** `personaScopes` is what the view sends;
 *     the deprecated single `personaScope` is never written by the UI.
 *  6. **Token-only, stated states.** The picker's rules use `var(--…)` only,
 *     its checkboxes carry a `:focus-visible` ring, and the phone tier lifts
 *     each option to the 44px `--target-min` hit area.
 *
 * The pure scope algebra (`toggleScope`, `sameScopes`, `scopesOf`,
 * `removedScopes`, `scopedLabel`/`scopedSummary`) is covered by
 * `memory-helpers.test.ts`; the wire contract by `memory-api.test.ts` and
 * `core/test/http/memoryRoutes.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { atRuleBlocks, declarations, source, topLevelRules } from './helpers/css.js';

const MEMORY = source('src/MemoryView.tsx');
const CSS = source('src/app.css');

/** Base (non-media) declarations for the rules whose selector list holds `s`. */
function base(s: string): string {
  return topLevelRules(CSS)
    .filter(([selector]) => selector.split(',').map((part) => part.trim()).includes(s))
    .map(([, decls]) => decls)
    .join('\n');
}

/** Declarations for `s` inside every block with this exact media prelude. */
function tier(prelude: string, s: string): string {
  return atRuleBlocks(CSS)
    .filter((block) => block.prelude === prelude)
    .map((block) => declarations(block.body, s))
    .join('\n');
}

describe('the Applies-to picker is a checkbox set', () => {
  it('is one component rendered at all three scope sites', () => {
    expect((MEMORY.match(/<ScopePicker/g) ?? []).length).toBe(3);
    // Edit form, suggestion quick-tie, add form — each with its own id prefix.
    expect(MEMORY).toContain('idPrefix={`mem-edit-${entry.id}`}');
    expect(MEMORY).toContain('idPrefix={`mem-tie-${entry.id}`}');
    expect(MEMORY).toContain('idPrefix="mem-add"');
  });

  it('keeps no single-choice scope control anywhere in the view', () => {
    // The only <select>s left are the two Kind pickers (edit + add).
    expect((MEMORY.match(/<select/g) ?? []).length).toBe(2);
    expect(MEMORY).toContain('mem-kind-');
    expect(MEMORY).not.toContain('mem-add-scope');
    expect(MEMORY).not.toContain('mem-scope-select');
    expect(MEMORY).not.toContain('unknownScope');
  });

  it('offers All personas as a checkbox bound to the empty set', () => {
    expect(MEMORY).toContain('All personas');
    expect(MEMORY).toContain('checked={all}');
    expect(MEMORY).toContain('onChange={() => onChange([])}');
    // `all` is derived, never stored: the empty array IS the global scope.
    expect(MEMORY).toContain('const all = scopes.length === 0');
  });

  it('renders one checkbox per persona and toggles through toggleScope', () => {
    expect(MEMORY).toContain('personas.map((persona) => (');
    expect(MEMORY).toContain('checked={scopes.includes(persona.id)}');
    expect(MEMORY).toContain('onChange={() => onChange(toggleScope(scopes, persona.id))}');
    expect(MEMORY).toContain('type="checkbox"');
  });

  it('keeps a removed persona ticked so editing cannot widen the fact', () => {
    expect(MEMORY).toContain('const removed = removedScopes(scopes, personas);');
    expect(MEMORY).toContain('{removed.map((id) => (');
    expect(MEMORY).toContain('Removed persona');
    // Ticking is the only way out — it stays checked until the user unticks.
    expect(MEMORY).toContain('onChange={() => onChange(toggleScope(scopes, id))}');
  });

  it('says what the current set means, in the user’s terms', () => {
    expect(MEMORY).toContain("'Every persona honors this fact.'");
    expect(MEMORY).toContain("'Only the selected persona honors this fact.'");
    expect(MEMORY).toContain('selected personas honor this fact.');
  });

  it('writes the array field and never the deprecated single one', () => {
    expect(MEMORY).toContain('personaScopes: [...fields.scopes]');
    expect(MEMORY).toContain('personaScopes: [...scopes]');
    expect(MEMORY).not.toContain('personaScope:');
  });
});

describe('the scope picker is token-only and states its states', () => {
  it('uses design tokens, never raw colours or magic pixels', () => {
    for (const selector of [
      '.mem-scope-picker',
      '.mem-scope-options',
      '.mem-scope-option',
      '.mem-scope-option > input[type=\'checkbox\']',
      '.mem-scope-pick-summary',
    ]) {
      const decls = base(selector);
      expect(decls.length, selector).toBeGreaterThan(0);
      expect(decls, selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(decls, selector).not.toMatch(/rgba?\(/);
      expect(decls, selector).not.toMatch(/:\s*-?\d+(\.\d+)?px/);
    }
  });

  it('gives every checkbox a visible focus ring and a disabled state', () => {
    expect(base(".mem-scope-option > input[type='checkbox']:focus-visible")).toContain(
      'outline: 2px solid var(--focus)',
    );
    expect(base(".mem-scope-option > input[type='checkbox']:disabled")).toContain('cursor');
    // A disabled fieldset fades; the option rows already said not-allowed.
    expect(base('.mem-scope-picker:disabled')).toContain('opacity');
  });

  it('carries the accent on the native control and the picker copy', () => {
    expect(base(".mem-scope-option > input[type='checkbox']")).toContain(
      'accent-color: var(--accent)',
    );
    expect(base('.mem-scope-option')).toContain('color: var(--text)');
  });

  it('lifts the option hit area to the 44px floor on the phone tier', () => {
    expect(base('.mem-scope-option')).toContain('min-height: var(--space-5)');
    expect(tier('(max-width: 640px)', '.mem-scope-option')).toContain(
      'min-height: var(--target-min)',
    );
  });

  it('lets the open disclosure take the row width instead of squeezing', () => {
    expect(base('.mem-scope-pick[open]')).toContain('flex-basis: 100%');
    expect(base('.mem-scope-options')).toContain('flex-wrap: wrap');
  });
});
