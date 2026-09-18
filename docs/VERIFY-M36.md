# VERIFY-M36 — Memory view display pass

Date: 2026-09-19 · spec: `PLAN-M36.md` · demo core (`dev:core`, HTTP 4390) +
web dev server (5173), browser walk.

## What was verified, and how

Two layers, because they catch different things:

1. **Deterministic gates** on the stylesheet.
2. **A live walk** on a rendered screen with seeded data, asserting the *state*
   each change produces (not just that it looks different).

## 1. Gates

- `npm test` — **root 189 files / 1812 passed, 5 skipped**.
- `npx vitest run --root web` — **64 files / 1070 passed** (was 63 / 1048; +1
  file `test/memory-display.test.ts` and +22 tests).
- `npm run typecheck` — 0 errors. `npm run build -w web` — green.
- `ux_audit` — **PASSED** all four gates:
  - **Contrast**: 17 explicit pairs (9 light + 8 dark) for every text/ground the
    view renders, all ≥ the Lc 75 body floor. Notable: the new link-style
    controls (`--accent-hover` text) measure **Lc 77.08** on a `--surface-2`
    row well and **Lc 82.97** on the add-form `--surface`; hover signals with an
    underline rather than a colour that would drop below the floor (light-mode
    `--accent` on a surface measures 72.6, the M12 P0.3 rule). The marked match
    (`--text` on its own `--bg` ground) is **Lc 104.56 / −93.51**.
  - **Tokens**, **States**, **Slop tells**: pass.
  - The audit ran on the complete `.mem*`/`.memory*` rule slice (98 blocks
    including the phone-tier media blocks). **The whole 287 KB stylesheet was
    too large to pass inline**, so the four text-computable checks were run on
    it directly by script: **0 hardcoded hex**, **0 `rgba()`/`rgb()` literals**,
    **0 `backdrop-filter`**, **0 gradient orbs**, and all 28 `box-shadow`
    declarations are named elevations (`var(--elevation-*)`) or token rings.
    This pass added **no** transition or animation, so the existing
    `prefers-reduced-motion` blocks needed no change.

## 2. The walk

Seeded (then removed) on the demo core: 6 profile entries — 3 confirmed (2
global + 1 scoped to Researcher), 2 suggested (1 global, 1 scoped to Builder,
both with evidence), 1 rejected — 2 episodes (one demo/placeholder tied to a
conversation created for the walk with a **425-character** summary; one imported
with `model` set and `conversationId: conv-from-another-machine`), and 1 empty
conversation.

Asserted (observed values, not appearances):

| Check | Observed |
|---|---|
| Show more / less | 221 chars ending `…` ↔ **425** chars, no ellipsis; label `Show more` ↔ `Show less` |
| Suggestion scope disclosure | summary text `All personas`, aria-label `Scope: All personas. Change which personas honor this fact`; opens `Applies to` + **10** checkboxes + `Every persona honors this fact.` |
| Add-form grid toggle | `Scope to specific personas…` / `aria-expanded=false` → `Hide personas` / `true` + **9** persona checkboxes |
| M33 semantics after the collapse | ticking Researcher → hint `Only the selected persona honors this fact.`, `All personas` unchecked, grid stays; unticking → `Every persona honors this fact.` |
| Open chat guard | present on the episode with a real conversation; **absent** on the imported one (and absent before a reload refreshed the shell's list) |
| Search mark | `pricing` → 1 episode hit, `mark.mem-mark` text `pricing`, action `Show`, note **`1 hit.`** |
| Hit → Show | episode expanded (short → full summary) and scrolled into view |
| Hit → Edit | that entry's editor opened in view (Kind `preference`, Key `tone`, value `I prefer concise replies that start with the answer.`) |
| Forget-before reason | `Pick a date to enable this.` visible while the button is disabled |
| Phone 390×844 | no horizontal overflow (`documentElement.scrollWidth` 375 ≤ 390); rows stack as designed |

All seeded rows (6 entries, 2 episodes, 1 conversation) were deleted afterwards;
the core's profile, episodes and conversations are back to 0.

## Deviations / observations (accepted, not defects)

- At 390×844 an episode's action area stacks to three full-width lines
  (`Open chat` / the demo reason / `Delete`). That is the existing phone pattern
  for `.mem-actions` (`flex: 1 0 100%`), every control keeps its 44px floor, and
  it is strictly more usable than the previous single dead `Re-summarize`.
- The add-form grid's disclosure state is local to the picker and is not reset
  by a successful add. Harmless (the values do reset), and it avoids the picker
  fighting the user mid-form.

## Not verified

- **The streaming interaction with Open chat.** `handleOpenConversation` ignores
  the call while a turn streams on another conversation (`conversationOpenAction`
  → `'ignore'`). That is inherited shell behaviour, unchanged here; the walk had
  no streaming turn.
- **Real auto-remember suggestions.** The walk used seeded
  `source: 'partner_suggestion'` rows rather than driving a model to produce
  them, so the *display* of suggestions is verified and their *production* is
  not.
- **No core/schema surface changed**, so there is no core-side verification to
  record.
