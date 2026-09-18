/**
 * M36 — the Memory view's display pass.
 *
 * A review of the Memory screen (rendered light/dark, desktop/phone, on a demo
 * core with real confirmed/suggested/rejected entries and episodes) found the
 * view token-clean but noisy and partly unreachable. This guard pins the five
 * decisions that came out of it, in the established source + stylesheet style
 * (`memory-scope-picker.test.ts`, `m31-redesign.test.ts`) — the web suite is
 * node-only, so it pins intent, not pixels:
 *
 *  1. **One provenance token per row.** A suggestion stacked five tokens for
 *     three facts (an "Auto-detected" chip + a "Suggested" chip + the scope +
 *     a "▶ Change" word + "Partner · 5m ago"). The status chip restated the
 *     panel heading, and the auto-detected chip restated the provenance line.
 *  2. **The scope text IS the disclosure.** "Change" named nothing; the
 *     control now says what it changes.
 *  3. **An episode summary is readable.** Clamping at 220 chars with no way to
 *     see the rest made the row a teaser. Show more/less, and Open chat only
 *     when the shell actually has that conversation.
 *  4. **No dead end.** Demo summaries offered a disabled "Re-summarize" whose
 *     reason lived in a `title` (invisible on touch); "Forget before" was
 *     disabled with no visible reason at all.
 *  5. **A search hit does something.** Hits were read-only muted text: the
 *     match is marked and every hit carries one action.
 */

import { describe, expect, it } from 'vitest';
import { atRuleBlocks, declarations, source, topLevelRules } from './helpers/css.js';

const MEMORY = source('src/MemoryView.tsx');
const CSS = source('src/app.css');
const APP = source('src/App.tsx');
const SECURITY = source('test/security-guards.test.ts');

/** Base (non-media) declarations for the rules whose selector list holds `s`. */
function base(selector: string): string {
  return topLevelRules(CSS)
    .filter(([selectors]) => selectors.split(',').map((part) => part.trim()).includes(selector))
    .map(([, decls]) => decls)
    .join('\n');
}

/** Declarations for `s` inside every block with this exact media prelude. */
function tier(prelude: string, selector: string): string {
  return atRuleBlocks(CSS)
    .filter((block) => block.prelude === prelude)
    .map((block) => declarations(block.body, selector))
    .join('\n');
}

describe('M36 · a suggestion row says three facts, not five tokens', () => {
  it('carries provenance once, in the row meta line', () => {
    // The chips that restated the heading and the provenance line are gone.
    expect(MEMORY).not.toContain('Auto-detected');
    expect(MEMORY).not.toContain('statusLabel');
    // Provenance itself is still explicit AND still distinguishes the writer.
    expect(MEMORY).toContain("isAutoDetected(entry) ? 'Partner noticed' : 'You'");
    expect(MEMORY).toContain('Noticed by the partner from your chats, not typed by you');
  });

  it('makes the scope text the disclosure instead of the word "Change"', () => {
    expect(MEMORY).not.toMatch(/>\s*Change\s*</);
    expect(MEMORY).toContain('mem-scope-pick-caret');
    // The summary's accessible name still contains the visible scope text
    // (label-in-name), so the control is announced with what it shows.
    expect(MEMORY).toContain('aria-label={`Scope: ${personaScopeLabel}');
  });

  it('points the caret at the real disclosure direction, with no duplicate marker', () => {
    expect(base('.mem-scope-pick-summary')).toContain('list-style: none');
    expect(base('.mem-scope-pick-summary::-webkit-details-marker')).toContain('display: none');
    expect(base('.mem-scope-pick:not([open]) .mem-scope-pick-caret')).toContain('rotate(-90deg)');
  });
});

describe('M36 · an episode summary is readable and its chat is real', () => {
  it('offers Show more/less for a clamped summary, wired to the paragraph', () => {
    expect(MEMORY).toContain('isSummaryClamped(episode.summary)');
    expect(MEMORY).toContain("expanded ? 'Show less' : 'Show more'");
    expect(MEMORY).toContain('aria-controls={summaryId}');
    expect(MEMORY).toContain('const summaryId = `mem-ep-summary-${episode.id}`');
  });

  it('offers Open chat only for a conversation the shell actually has', () => {
    expect(MEMORY).toContain('knownConversationIds.has(episode.conversationId)');
    expect(MEMORY).toContain('Open chat');
    // The shell supplies the set; a null list (still loading) withholds it.
    expect(APP).toContain('knownConversationIds={knownConversationIds}');
    expect(APP).toContain('new Set(conversations.map((chat) => chat.id))');
    expect(MEMORY).toContain('knownConversationIds !== undefined');
  });
});

describe('M36 · no disabled control without a visible reason', () => {
  it('replaces the impossible Re-summarize with the reason it is impossible', () => {
    expect(MEMORY).not.toContain('disabled={busy !== null || demo}');
    expect(MEMORY).toContain('No provider behind a demo summary');
    // The async guard stays: a disabled button must not be the only thing
    // standing between a demo episode and a provider call.
    expect(MEMORY).toContain('if (busy !== null || demo) return;');
  });

  it('states why Forget-before is disabled, and links the control to it', () => {
    expect(MEMORY).toContain('Pick a date to enable this.');
    expect(MEMORY).toContain("aria-describedby={dateValid ? undefined : 'mem-forget-before-hint'}");
    // A reason OUTSIDE the disabled control's own name, so it is announced.
    expect(MEMORY).toContain('<span className="mem-hint" id="mem-forget-before-hint">');
  });

  it('styles the inline reason from tokens', () => {
    const decls = base('.mem-hint');
    expect(decls).toContain('color: var(--text-muted)');
    expect(decls).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(decls).not.toMatch(/rgba?\(/);
  });
});

describe('M36 · a search hit is marked and actionable', () => {
  it('marks the match with the query as literal text', () => {
    expect(MEMORY).toContain('highlightSegments(hit.snippet, query)');
    expect(MEMORY).toContain('<mark className="mem-mark"');
  });

  it('gives every hit one action that reveals the row', () => {
    expect(MEMORY).toContain('onClick={() => onOpen(hit)}');
    expect(MEMORY).toContain("hit.kind === 'profile' ? 'Edit' : 'Show'");
    // The search card no longer states a cap it cannot know.
    expect(MEMORY).not.toContain('Showing up to 50 hits');
    expect(MEMORY).toContain('hitCountLabel(hits.length)');
  });

  it('scrolls to the row, opening the panel or editor that hides it', () => {
    // A rejected hit is inside a collapsed panel; a profile hit opens its editor.
    expect(MEMORY).toContain('rejectedRef.current.open = true');
    expect(MEMORY).toContain('scrollIntoView({ block: \'center\' })');
  });

  it('marks the match on the view\'s own chip ground, not a new tint', () => {
    const decls = base('.mem-mark');
    expect(decls).toContain('background: var(--bg)');
    expect(decls).toContain('color: var(--text)');
  });
});

describe('M36 · the Applies-to grid collapses for the common answer', () => {
  it('collapses only the add form, where the ask is unconditional', () => {
    // Exactly one of the three sites opts in; the other two are already behind
    // a disclosure the user opened deliberately.
    expect(MEMORY).toMatch(/idPrefix="mem-add"[\s\S]{0,200}?collapsible/);
    expect(MEMORY).not.toMatch(/idPrefix=\{`mem-tie-\$\{entry\.id\}`\}[\s\S]{0,200}?collapsible/);
    expect(MEMORY).not.toMatch(/idPrefix=\{`mem-edit-\$\{entry\.id\}`\}[\s\S]{0,200}?collapsible/);
    expect(MEMORY).toContain("expanded ? 'Hide personas' : 'Scope to specific personas…'");
  });

  it('keeps the checkbox set reachable and keyboard-operable', () => {
    expect(MEMORY).toContain('aria-expanded={expanded}');
    expect(base('.mem-scope-more')).toContain('min-height: var(--space-5)');
    expect(base('.mem-scope-more:focus-visible')).toContain('outline: 2px solid var(--focus)');
    expect(base('.mem-scope-more:disabled')).toContain('cursor: not-allowed');
  });

  it('still writes the array field and never the deprecated single one', () => {
    expect(MEMORY).toContain('personaScopes: [...scopes]');
    expect(MEMORY).not.toContain('personaScope:');
  });
});

describe('M37 · the library groups into responsive cards, one switch', () => {
  it('offers exactly one Kind | Persona switch, as an aria-pressed group', () => {
    expect(MEMORY).toContain('role="group" aria-label="Group memory by"');
    expect(MEMORY).toContain('className="seg-tabs mem-group-switch"');
    expect(MEMORY).toContain('aria-pressed={grouping === option}');
    expect(MEMORY).toContain('MEMORY_GROUPINGS.map((option) => (');
  });

  it('renders a card per group, labelled by its own head', () => {
    expect(MEMORY).toContain('aria-labelledby={`mem-group-${group.id}`}');
    expect(MEMORY).toContain('className="mem-group-head"');
    expect(MEMORY).toContain('{groupCountLabel(group.entries.length)}');
    // An empty bucket is not a card, so no group can render an empty list.
    expect(MEMORY).not.toContain('groups.length === 0');
  });

  it('stops a card head and its rows saying the same thing twice', () => {
    // The kind is in the card head, so the kind-grouped rows drop the chip…
    expect(MEMORY).toContain("showKind={grouping === 'persona'}");
    // …and a row in a one-persona card does not repeat that persona.
    expect(MEMORY).toContain('showScope={!group.single}');
    expect(MEMORY).toContain('showKind = true');
    expect(MEMORY).toContain('showScope = true');
  });

  it('groups the confirmed library and leaves the status panels status-first', () => {
    // The switch is inside the confirmed branch; suggestions and rejected facts
    // keep their own panels (an inbox is not a library).
    const confirmedBranch = MEMORY.slice(
      MEMORY.indexOf('No confirmed entries yet'),
      MEMORY.indexOf('mem-suggestions'),
    );
    expect(confirmedBranch).toContain('mem-groups');
    expect(confirmedBranch).not.toContain('mem-suggestions');
    expect(MEMORY).toContain('className="sub-panel mem-suggestions"');
    expect(MEMORY).toContain('className="sub-panel mem-rejected"');
    // `showKind` is never turned off in those panels, so a suggested/rejected
    // row always states its kind.
    expect(MEMORY).not.toContain('showKind={false}');
  });

  it('remember the choice as a view preference, with a sanctioned key', () => {
    expect(MEMORY).toContain("const FACT_GROUPING_KEY = 'partner.factGrouping'");
    expect(MEMORY).toContain('writeLocal(FACT_GROUPING_KEY, next)');
    expect(MEMORY).toContain('parseGrouping(readLocal(FACT_GROUPING_KEY))');
    // The storage census allowlists it — a key the app may persist is declared.
    expect(SECURITY).toContain("'partner.factGrouping'");
  });

  it('responds without a breakpoint, and pins one column on a phone', () => {
    expect(base('.mem-groups')).toContain(
      'grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))',
    );
    expect(base('.mem-groups')).toContain('align-items: start');
    expect(tier('(max-width: 640px)', '.mem-groups')).toContain('grid-template-columns: 1fr');
    // Space and the head label separate the cards — no third surface plane.
    expect(base('.mem-group')).not.toContain('background');
    expect(base('.mem-group')).not.toContain('box-shadow');
  });

  it('keeps the new card rules token-only, and the accent above the floor', () => {
    for (const selector of [
      '.mem-group-switch',
      '.mem-groups',
      '.mem-group',
      '.mem-group-head',
      '.mem-group-name',
      '.mem-group-name-accent',
      '.mem-group-name-danger',
    ]) {
      const decls = base(selector);
      expect(decls.length, selector).toBeGreaterThan(0);
      expect(decls, selector).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(decls, selector).not.toMatch(/rgba?\(/);
      expect(decls, selector).not.toMatch(/:\s*-?\d+(\.\d+)?px/);
    }
    // A kind head is 14px/600 on --surface: light --accent measures Lc 72.6
    // there, under the body floor, so the head uses the hover green (Lc 80.5).
    expect(base('.mem-group-name-accent')).toContain('color: var(--accent-hover)');
    expect(base('.mem-group-name')).not.toContain('color: var(--accent)');
  });
});
