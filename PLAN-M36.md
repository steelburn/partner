# PLAN-M36 — Memory view display pass

Status: **implemented + verified** · 2026-09-19 · no schema change (schema stays
**v24**) · no core route change.

The owner's request: *"review how we're displaying Memory section. Come out with
3-5 improvement suggestions."* — followed by *"apply all."*

The review was done on a rendered screen (light + dark, 1440 and 390×844, a demo
core seeded with real confirmed/suggested/rejected entries and episodes), not on
the source alone. Verdict: the view is **token-clean** (the M20.A/M33 passes saw
to that) but **noisy and partly unreachable**. Five findings became five changes.

## 1. A suggestion row stacked five tokens for three facts

Before (one pending suggestion, 4 lines):

```
[Identity]  Works in the EU (CET) timezone.
Why: Mentioned meeting times in CET three times in the last week.
[Auto-detected] [Suggested] All personas [▶ Change] Partner · 5m ago
                                          [Confirm] [Edit] [Reject]
```

Three of those five tokens restated something already on screen:

- `Suggested` — the row is inside the panel headed **Suggestions (2)**;
- `Auto-detected` — the provenance item says `Partner · 5m ago`, which *is* the
  difference between a fact the partner noticed and one you typed;
- `▶ Change` — names what it does to nothing; only opening it revealed that it
  was the scope picker, and the scope it controls was already printed next to it.

After:

```
[Identity]  Works in the EU (CET) timezone.
Why: Mentioned meeting times in CET three times in the last week.
[› All personas]  Partner noticed · 5m ago        [Confirm] [Edit] [Reject]
```

- Provenance is **one** item: `Partner noticed` (auto-detected, the tooltip still
  spells it out) or `You`, plus `timeAgo`.
- The status chip is dropped: the panel heading carries it, and a rejected fact
  lives in the **Rejected** panel that says the same thing.
- **The scope text IS the disclosure.** `All personas ▾` / `Builder ▾` replaces
  the `Change` word, so the control reads as what it changes. The chevron is
  `IconChevronDown` (the sidebar's disclosure icon) rotated closed/open, and the
  native `◀` marker is suppressed so there is only one indicator. The accessible
  name is `Scope: All personas. Change which personas honor this fact` — the
  visible text is inside it (label-in-name).

Sites that are *not* a suggestion keep the scope as plain meta text.

## 2. An episode was a teaser

`clampText(episode.summary, 220)` showed 220 characters plus `…` with nothing
behind it — the full text was already in the row's data. And an episode whose
source chat no longer exists (a conversation delete does **not** cascade to its
episode) or that arrived in a bundle **imported from another machine** had no
reliable way back to that chat.

- **Show more / Show less** on any summary over `EPISODE_SUMMARY_CLAMP` (220),
  `aria-expanded` + `aria-controls` on the paragraph's id, verified at 221
  (ellipsis) ↔ 425 characters.
- **Open chat** in the row actions — only when the shell actually has that
  conversation. The shell supplies `knownConversationIds` (derived from its live
  list, `null` while loading) and the row withholds the action otherwise: a
  button that can only fail is worse than no button. Verified both ways in one
  screen (one episode with a real chat → action present; one imported with a
  foreign `conversationId` → absent).

## 3. Disabled controls were dead ends

DESIGN.md: *"a disabled control with no reason is a dead end."* Two cases:

- A demo summary offered a greyed **Re-summarize** whose only explanation was a
  `title` tooltip — invisible on touch. The row now states the truth in the
  action's place: **"No provider behind a demo summary"**, and Delete stays.
  (The async guard `if (busy !== null || demo) return;` remains, so the disabled
  button is not the only thing preventing a provider call.)
- **Forget before a date** was disabled until a date was chosen, with no visible
  reason. It now prints **"Pick a date to enable this."** and the button points
  at that note with `aria-describedby` (only while it is disabled).

The new `.mem-hint` reason text uses `--text-muted` on its surface — audited.

## 4. A search hit was read-only

Hits rendered a `Profile`/`Episode` chip plus a muted snippet: the match was in
the text but unmarked, and there was nothing to do with a hit. PLAN-M4 called
the jump a placeholder; that is now closed.

- The matched term is **`<mark>`ed** (`highlightSegments`, pure + unit-tested:
  case-insensitive, every occurrence, original casing preserved, the whole query
  preferred over its terms, single characters ignored, and the query treated as
  **literal text** — `(` must not become a pattern). The mark takes the view's
  own `--bg`-on-a-well ground, the same contrast-safe move the chips make.
- Every hit carries **one** action: `Edit` for a fact (opens that entry's editor
  in place, opening the **Rejected** panel first if that is where it lives) or
  `Show` for an episode (expands the summary). A stale reveal is keyed on a
  nonce, so pressing the same hit twice works twice.
- The note states the **real** count (`1 hit.` / `4 hits.` / the cap only when
  reached) instead of the old always-on "Showing up to 50 hits.".

## 5. "Applies to" was heavy for the common answer

The picker is one checkbox per persona (9 on a default core, two rows). The add
form asks for a scope on **every** fact it creates, and the answer is almost
always *All personas*.

- The add form's grid starts behind one toggle: **"Scope to specific
  personas…"** → **"Hide personas"** (`aria-expanded`, `aria-controls`, 9
  checkboxes revealed). Keyboard-reachable, `min-height: var(--space-5)`.
- The edit form and a suggestion's opened disclosure show the grid outright —
  the user already opened a disclosure to get there, and the picker is the only
  place that says *which* personas a fact names.
- **M33 semantics are untouched**: `[]` is still "All personas" (ticking a
  persona clears it, unticking the last returns to it), a removed persona stays
  ticked, and the wire field is still `personaScopes`. Verified live: ticking a
  persona flips the hint to "Only the selected persona honors this fact." and
  unticking restores "Every persona honors this fact.".

## 6. Files

- `web/src/MemoryView.tsx` — the five changes; `onOpenConversation` +
  `knownConversationIds` props and the `MemoryFocus` reveal request.
- `web/src/lib/memory-helpers.ts` — `EPISODE_SUMMARY_CLAMP`, `isSummaryClamped`,
  `highlightSegments`, `SEARCH_HIT_CAP`, `hitCountLabel`.
- `web/src/app.css` — the M36 block (scope toggle + grid, summary toggle, hint,
  marked match, hit action) and two small additions to existing rules.
- `web/src/App.tsx` — pass `handleOpenConversation` and the derived
  `knownConversationIds` set.
- Tests: `web/test/memory-helpers.test.ts` (+7) and the new
  `web/test/memory-display.test.ts` (15 source + stylesheet guards).

## Exit

- [x] All five suggestions applied, each verified by asserting rendered state.
- [x] `web` 64 files / 1070 passed · root 189 files / 1812 passed (5 skipped) ·
      shared 90 · typecheck 0 · bundle green.
- [x] `ux_audit` PASSED (Tokens, States, Slop tells, and 17 explicit APCA pairs
      in light + dark — the slice covers every `.mem*`/`.memory*` rule; the
      whole 287 KB sheet was scanned separately for hardcoded colours, `rgba()`
      literals, glassmorphism, gradient orbs and ad-hoc shadow recipes, because
      it is too large to pass inline to the tool).
- [x] Walked live at 1440 and 390×844, light + dark, on a demo core
      (`docs/VERIFY-M36.md`).

## Out of scope

- No change to what memory **is**: no new field, route, table or schema.
- The `.mem-*` display rules for other views (the audit slice covers them, but
  only Memory was re-rendered).
- Auto-remember itself: this pass displays suggestions, it does not change how
  they are produced.
