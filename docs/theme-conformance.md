# Theme conformance checklist — M11 F5 (PLAN-M11.md)

Every surface the user sees must honor the active theme + mode. This list is
the F5 regression gate: run it after any UI change, in **light and dark**,
and with a custom theme active (Theme Studio). All styling stays token-only
(no raw hex outside the two documented exceptions below).

## Token purity

- [x] `web/src/app.css` contains **one** raw color: `#ffffff` on
      `.preview-frame` — the F12 sandboxed preview canvas. Deliberate: it is
      the *user's document* (a browser viewport), not Partner chrome
      (PLAN-M11 F12 §5). Everything else references `var(--…)` tokens.
- [x] No `backdrop-filter` (glass), no gradients/orbs, no glow. The word
      "gradient"/"glow" appears only in code comments.
- [x] Shadows are the three named elevations only (`sm`/`md`/`lg`) — no
      ad-hoc blur/opacity recipes. `color-mix(in srgb, var(--bg) …)` is the
      allowed scrim derivation (derived from a token).
- [x] Spacing/type/radius come from the shared scale (8px grid, modular
      type, token radius).

## Surfaces

- [ ] Chat transcript + composer (light/dark, custom theme)
- [ ] Chat attachments staged chips + per-message chips (F1)
- [ ] Assets drawer + save dialog + asset rows (F10)
- [ ] Code preview overlay chrome (F12) — canvas itself intentionally white
- [ ] Choice cards (F9) and markdown blocks (F7) inside assistant bubbles
- [ ] ConversationRail folder tree + move select (F11)
- [ ] NotesMini lane in the chat workspace (F6)
- [ ] Notes & Plans view, note editor, quick capture
- [ ] Personas view incl. the capability-policy editor (F3)
- [ ] Providers view incl. purpose filter + badges (F4)
- [ ] Memory, Audit, Files, Skills, Playbooks, Themes, PairGate, session
      chat (regression: unchanged surfaces still consume tokens)
- [ ] Mode toggle persistence: reload keeps theme + mode (cache pair)

## Interaction states

Every interactive element above declares, via the shared `.btn`/`.field`/
component rules or explicit rules: `default`, `hover`, `focus-visible`
(2px `--focus` ring), `active`/`aria-pressed`, and `disabled`. New M11
components were built with explicit focus-visible + disabled rules
(`.folder-toggle`, `.choice-input`, `.attach-button-disabled`,
`.preview-actions` buttons, `.notes-mini-open`, assets action buttons…).

## Contrast gate (ux_audit)

Representative pairs, both modes, all APCA Lc ≥ 75 (WCAG sidecar ≥ AA):

- dark `#e8eaed` on `#101214` → Lc ≈ −93.5, 15.6:1
- dark muted `#cbd1d8` on `#101214` → Lc ≈ −77.7, 12.2:1
- `--accent-contrast` on `--accent-emphasis` → Lc ≈ −84.5, 7.3:1
- light `#16181d` on `#ffffff` → Lc ≈ 104.6, 17.8:1
- light muted `#3f444c` on `#ffffff` → Lc ≈ 92.8, 9.8:1

Custom themes are gated on save by the core (M6 Theme Studio gate).

## Known intentional exceptions

1. `.preview-frame` background `#ffffff` (unthemed document canvas, F12).
