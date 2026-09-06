# M12 — UI readability & polish pass (shell layout, nav order, contrast gate)

Status: **spec — ready to execute** · Repo: `~/apps/partner` · Master plan:
`PLAN.md` (§10, §15) · DESIGN.md is the token system; every change stays
token-only. Gates: same as M0–M11 — full suites stay green (core/shared/e2e
683 · web 440 · extension 57, typechecks 0), demo-mode parity, `ux_audit`
gate on touched CSS, fresh-context review at the end.

## Why this milestone

M0–M11 shipped the full product surface on a **rigid desktop shell**. A
deterministic review (2026-09-06: browser geometry probes at real viewports
+ `ux_audit` on the token system) found the app **functional but unreadable
in places**: text is crowded out by oversized fixed chrome, and the nav
cannot shrink below ~1051px so tabs clip off-screen at common widths.
Nothing here adds features; it makes the existing UI legible, ordered and
defensible against the design system it already follows.

### Review evidence (measured, 2026-09-06)

| # | Finding | Evidence |
|---|---|---|
| E1 | Header consumes ~⅓ of the viewport | `.app-header` = **236px** (brand row + 68px nav-pill row + 57px persona/picker row) of a 720–800px viewport |
| E2 | Shell is a fixed ~1051px min-width, no breakpoints | `.view-switch` min content **1019px**; at 1024px wide the **Audit tab is clipped off-screen** (right 1051 > 1024), document overflows |
| E3 | Three fixed columns squeeze chat | `.rail` 288px + `.notes-mini` 232px always on → chat column 760/1280 (59%); reading area ≈ 337×557px @ 1280×800 |
| E4 | Middle column collapses below 1280 | composer textarea **49px wide at 780px viewport**; horizontal overflow ≤ ~1050px |
| E5 | Contrast-gate miss in the light theme | accent text `#1f6f43` on `surface-2` `#ececea` → **Lc 69 < 75** (WCAG 5.2:1 ok). DESIGN.md claims all pairs pass — this one doesn't (active-nav/chip/badge recipe) |
| E6 | Micro-text density in dense lists | Audit view 77 text nodes ≤12px; Personas 49 |
| E7 | No iconography | zero inline SVGs / icon set app-wide; DESIGN.md nav contract calls for 16–20px icons |
| E8 | Order/placement friction | 11 destinations in one unwrapped row (system views Memory/Audit between tool views); Notes lane has no collapse; per-conversation theme select buried in the composer strip |

Strengths to preserve (audited clean): 1,394 token refs / single raw hex
(documented `.preview-frame` exception); named elevations only (`md`/`lg` in
use; `sm` defined, unused); 29 `focus-visible` + 30 `disabled` rules; zero
glass/gradient/glow; dark-theme contrast passes every asserted pair.

## Scope & inventory

Touch list (components + required states — all changes stay on DESIGN.md
tokens, 8px grid, scale type, named elevation):

| Component | Files | Why |
|---|---|---|
| App header / nav row | `web/src/app.css` (`.app-header*`, `.view-switch*`) + header JSX in `web/src/App.tsx` | E1, E2, E8 |
| Chat workspace columns | `app.css` (`.chat-workspace`, `.rail`, `.notes-mini`, `.chat`, `.chat-form`) | E3, E4 |
| Notes lane collapse | `NotesMini`/`App` state + CSS | E3, E8 |
| Theme gate assertion set | `shared/src/theming.ts` + `DESIGN.md` | E5 |
| Nav icons (new, 16px token-styled) | shared icon module or inline SVG set + CSS | E7 |
| Dense lists floor | Audit + Personas CSS (row spacing / ≥13px meta) | E6 |
| View grouping labels/separators | header CSS/JSX | E8 |

## Work packages (tick as done)

### P0 — Readability blockers (do first; CSS-only, self-contained)

- [ ] **P0.1 Responsive shell + nav shrink.**
  - [ ] `.view-switch` may shrink gracefully: horizontal scroll (thin,
        token-styled, `focus-visible`) or wrap at a breakpoint ≈1150px.
  - [ ] New `@media` blocks for the workspace columns: notes lane →
        collapsible/overlay ≤1280; rails → stacked ≤960 (reuse existing
        ≤640 mobile pattern); no horizontal overflow at ≥1024.
  - [ ] Acceptance: no `document.scrollWidth > innerWidth` at 1024/900;
        composer ≥ ~320px at 900px width.
- [ ] **P0.2 Header compression to one compact row (≤ ~80px).**
  - [ ] Nav pills 68px row → ~36–40px (keep 8px-grid padding, states
        intact); brand collapses to the row; persona + theme cluster
        compact on the right.
  - [ ] Acceptance: header height ≤ 80px at 1280×800; reading area ≥ ~55%
        of viewport height.
- [ ] **P0.3 Accent-on-surface-2 contrast fix (light mode).**
  - [ ] Accent text on `--surface-2` uses `--accent-hover` (`#195936`) or
        weight 600 in light mode (chips/badges/active nav on wells).
  - [ ] Add `accent on surface-2` to the theme-save contrast assertion set
        in `shared/src/theming.ts`; note it in DESIGN.md (the pair becomes
        a documented gate pair).
  - [ ] Acceptance: `ux_audit` pair `#195936 on #ececea` (and the 
        surface-2 pair in both modes) ≥ Lc 75.

### P1 — Shell architecture & legibility

- [ ] **P1.1 16px icon system for nav + key actions** (token-styled,
      `currentColor`, no glow): Chat/Notes/Personas/Providers/Files/Memory/
      Themes/Skills/Playbooks/Audit + primary actions (Send, ＋Note,
      Capture, Save-to-Assets…). Labels stay; DESIGN.md nav contract met.
- [ ] **P1.2 View grouping + lane control.**
  - [ ] Group nav: workspace (Chat, Notes) · studio (Personas, Providers,
        Themes) · tools (Files, Skills, Playbooks) · system (Memory,
        Audit) with separators or a compact second level.
  - [ ] Notes lane collapsible (persist state per session).
- [ ] **P1.3 Dense-list floor.** Audit + Personas meta/row text ≥13px or
      row spacing such that ≤12px text nodes per view < 10.

### P2 — Polish & aesthetics (after P0/P1 gates pass)

- [ ] **P2.1 Active/selection states:** separation by surface shift before
      borders; hover = surface shift (never bigger shadow).
- [ ] **P2.2 Empty states** per DESIGN ("state what to do next") on the
      dense tool views; consistent icon+label primary buttons.
- [ ] **P2.3 Elevation:** put `sm` to work on raised rows/controls or
      retire it (document) — today only `md`/`lg` are applied.

## Regression & verification (tick as done)

- [ ] Typechecks 0; root (683) · web (440) · extension (57) suites green.
- [ ] `ux_audit` green on all touched CSS: token coverage, shadow recipes,
      APCA pairs (incl. new accent-on-surface-2 pair, light+dark), state
      coverage, slop tells.
- [ ] Light + dark + custom-theme walks of all ten views, zero console
      errors (headless browser, same method as the M11 F5 sweep).
- [ ] Geometry gates at 1440/1280/1024/900/780 (×720/800 tall):
      no horizontal overflow; composer ≥320px @900; header ≤80px;
      nav tabs all reachable (no clipped destination).
- [ ] Demo-mode parity + packaged-app resources build unchanged
      (`web` build + core bundle stages green).
- [ ] Fresh-context review; findings closed; exit boxes + PLAN.md §15 M12
      ticked.

## Decision log (✓ = locked at review; unmarked = adopted default, open)

| # | Question | Decision |
|---|---|---|
| D1 | Nav shrink mechanism | Scrollable segmented control with visible scroll affordance at ~1150 (wrap is second choice if scroll feels awkward on 11 items) |
| D2 | Notes-lane collapse default | Open ≥1280; collapsed by default below 1280 with a persistent toggle; state per session |
| D3 | Nav grouping labels | Visual separators only in v1 (no new labels); tooltips via aria only |
| D4 | Icon source | Hand-authored 16px inline SVG set (token `currentColor`, no dep) |
| D5 | Header budget | 64–80px at ≥1280 widths; brand text stays, shrinks to icon+wordmark at ≤1150 |

## Non-goals / out of scope

- No new features or view re-ordering of content beyond the grouped nav.
- No redesign of markdown/content surfaces (chat bubbles, note bodies).
- No mobile app: shell adaptation targets ≥ ~780px windows; ≤640 keeps the
  existing single-column pattern.
- No changes to the token set's *values* (only the gate assertion set +
  DESIGN.md pair documentation for P0.3); user themes stay user-controllable.
