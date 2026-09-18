# VERIFY-M37 — Memory library as responsive group cards

Date: 2026-09-19 · spec: `PLAN-M37.md` · demo core (`dev:core`, HTTP 4390) + web
dev server (5173), browser walk.

## What was verified, and how

The risk in this change is **layout**, which no text assertion can see: a card
grid can pass every gate and still crush a value into a one-character column
(the M20.A failure) or overflow a phone. So the primary evidence is a rendered
walk with measured geometry, plus the deterministic gates.

## 1. Gates

- `npm run typecheck` — 0 errors. `npm run build -w web` — green.
- `npx vitest run --root web` — **64 files / 1084 passed** (was 1070; +14:
  7 grouping unit tests, 7 M37 guards).
- `npm test` — **root 189 files / 1812 passed, 5 skipped**.
- `ux_audit` — **PASSED**. 20 explicit APCA pairs (10 light + 10 dark) covering
  every text/ground the new rules create, plus Tokens, States and Slop tells.
  Thinnest pair: light `Rule` head (`--danger` on `--surface`) **Lc 75.42** —
  thin but over the floor, and it is the value DESIGN.md already records for
  that combination. The kind head uses `--accent-hover` (**Lc 82.97**); plain
  `--accent` would measure 72.6 there and fail (M12 P0.3).
- The storage census (`web/test/security-guards.test.ts`) still passes: the new
  key is allowlisted **and** survives the content-key detector.

## 2. The walk

Seeded (then removed): 11 profile entries covering every bucket — 8 confirmed
(global ×3; scoped to one persona ×3; scoped to two personas ×1; scoped only to a
deleted persona ×1) plus 2 suggested and 1 rejected.

| Check | Observed |
|---|---|
| Kind mode | 4 cards — `Preference 2`, `Identity 2`, `Rule 2`, `Style 2`; no `style`-less/empty card; rows inside have **no kind chip** |
| Persona mode | 6 cards in order — `All personas 3`, `Shared 1`, `Researcher 1`, `Builder 1`, `Analyst 1`, `Removed persona 1` |
| Partition | 8 confirmed facts appear across the cards with none listed twice and none dropped (also pinned as a unit test in both modes) |
| Single-persona cards | `Researcher` / `Builder` / `Analyst` rows have **no scope item**; `All personas` / `Shared` / `Removed persona` rows keep theirs |
| Kind chips in persona mode | present in every row (the head does not name the kind) |
| Columns at 1440 | `391px 391px 391px` (3 columns) |
| Columns at 1100 / 900 | `328.7px 328.7px` (2 columns), **0 rows with a value column under 140px** |
| Columns at 390 | `295.3px` (1 column), `documentElement.scrollWidth === 390` (no overflow) |
| Persistence | after `Persona` was pressed, `localStorage['partner.factGrouping'] === 'persona'`, and a full page reload restored `Kind:false / Persona:true` with the same 6 heads |
| Switch semantics | `role="group"`, `aria-label="Group memory by"`, one button per option with `aria-pressed` |
| Status panels | `Suggestions (2)` and `Rejected (1)` still render as their own panels, untouched by the switch |
| Dark mode | all six heads, chips and rows render on the dark tokens; the light-mode `--accent-hover` choice holds |

All seeded entries were deleted afterwards (11 removed, 0 left) and the walk's
stored grouping preference was cleared, so the core and the browser profile are
back to their pre-walk state.

## Deviations / observations (accepted)

- **Grid rows are not balanced.** A tall card (e.g. `All personas` with three
  facts) leaves vertical space under its shorter neighbours in the same row,
  because CSS grid sizes a row to its tallest cell. Accepted: the alternatives
  (`columns`, or JS masonry) reorder content or add layout code for cosmetics.
- **The `Removed persona` card is a catch-all.** A fact whose persona was deleted
  is shown there with its scope item, so it is visible and actionable rather than
  silently missing from the library.

## Not verified

- **Where suggested facts should live.** The walk verifies the suggestions inbox
  is unchanged; it does not test the alternative design (suggested rows inside
  the kind/persona cards). That is an open design question flagged to the owner,
  not a verified property.
- **A library larger than ~11 facts.** Column count and wrapping were measured at
  8 confirmed facts; a 50-fact library was not walked (the grid is content-driven
  and has no fixed heights, so the risk is scroll length, not layout).
- **No core/schema change**, so there is no core-side verification to record.
