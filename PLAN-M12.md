# M12 — UI readability & polish pass (shell layout, nav order, contrast gate)

Status: **complete — implemented & verified 2026-09-06** · Repo: `~/apps/partner` · Master plan:
`PLAN.md` (§10, §15) · DESIGN.md is the token system; every change stays
token-only. Gates: same as M0–M11 — full suites stay green (core/shared/e2e
685 · web 440 · extension 57, typechecks 0), demo-mode parity, `ux_audit`
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

### P0 — Readability blockers (done; CSS-only, self-contained)

- [x] **P0.1 Responsive shell + nav shrink.** `.view-scroll` makes the grouped
      nav horizontally scrollable (thin token scrollbar, inset focus rings);
      workspace tiers: notes lane collapsible ≤1280 (default per D2), rails
      260/240/220px ≤1024/960/900, lane overlays ≤760; no horizontal
      overflow at 1024/900/780; composer 330px @900 (was 49px).
- [x] **P0.2 Header compression to one compact row.** Nav pills ~34px, brand
      inline (hidden ≤1150 per D5), persona picker + theme toggle in a right
      cluster; measured header **76px** across 780–1440px (was 236px).
- [x] **P0.3 Accent-on-surface-2 contrast (executed as option A — mode-split
      gate pairs + usage rule).** Light-mode accent green under-reaches Lc 75
      on every tinted fill (accent/surface 72.6, accent/surface-2 69.0,
      even accentHover/surface-2 74.9), so the theme-save gate now asserts
      mode-scoped pairs in `core/src/theming/gates.ts`: light
      `accentHover`-on-`surface` (Lc 80.5) and dark `accent`-on-`surface-2`
      (Lc 78.2, both presets). Usage rule (DESIGN.md): in light, accent text
      rests only on `--bg`/`--surface`; surface-2 wells never carry accent
      text (search rows, selected picker rows, pb-card pressed + secondary
      hover all surface-shift). Acceptance: `ux_audit` PASSED incl. both new
      pairs; +2 gate tests; presets gate green.

### P1 — Shell architecture & legibility (done)

- [x] **P1.1 16px icon system** — `web/src/icons.tsx`: 15 hand-authored
      stroke icons (`currentColor`, `aria-hidden`, no deps); nav destinations
      + Send/Save-to-Assets/Quick-note actions carry icon+label.
- [x] **P1.2 View grouping + lane control.** Nav grouped workspace · studio ·
      tools · system with separator pills and aria group labels (D3); Notes
      lane collapsible with per-session persistence, default open ≥1280 (D2).
      The quick-capture action reads as an action (“Quick note”, green +
      icon; accessible name “Quick note (Ctrl+K)”) — distinct from the
      “Notes” destination tab.
- [x] **P1.3 Dense-list floor.** `.btn-sm`, audit/persona/compare meta,
      chips + persona theme hints raised ≥13px; rendered ≤12px text leaves:
      Audit 77→4, Personas 49→0 (skills/playbooks residual are chips/help).
- [x] **P1.4 Quick capture stays in context (F6 follow-up).** … verified live;
      capture while the lane is collapsed reopens the lane and refocuses the
      composer (repeat-signal focus fix).

### P2 — Polish & aesthetics (done)

- [x] **P2.1 Active/selection states:** separation by surface shift before
      borders; hover = surface shift (never bigger shadow); accent reserved
      for surfaced/pressed rows per the option-A rule.
- [x] **P2.2 Empty states** say what to do next (Audit example; copy pass on
      the dense tool views).
- [x] **P2.3 Elevation:** `sm` now applied (pressed purpose filter, selected
      picker option, raised pb-card) alongside existing md/lg.

## Regression & verification (tick as done)

- [x] Typechecks 0; root (**685**) · web (**440**) · extension (**57**) suites
      green (+2 new gate tests).
- [x] `ux_audit` PASSED on all touched CSS + asserted/runtime pairs incl. the
      new mode-split pairs (light accentHover/surface 83.0, dark
      accent/surface-2 78.8); token/slop/state scans clean (1 documented
      `#ffffff`; 32 focus-visible / 36 disabled; elevations sm/md/lg only).
- [x] Light + dark + custom-theme walks of all ten views — zero console
      errors (headless browser).
- [x] Geometry gates: no horizontal overflow at 1440/1280/1024/900/780;
      header ≤76px; composer ≥330px @900; all nav destinations reachable
      (scroll + click verified at 1024/900).
- [x] Demo-mode parity + builds green (`web` build; core untouched);
      packaged-resources path unchanged.
- [x] Fresh-context review closed (2026-09-06): BLOCK findings 1–2 fixed
      (notes-lane-open class emitted so ≤760 overlays correctly; pb-card
      hover no longer rests accent on surface-2); nits 3–7 resolved
      (refocus-on-repeat capture, wordmark breakpoint → 1150 per D5, stale
      comments + gates docblock, btn-sm pass checked at 760–900).

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
