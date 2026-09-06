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

Headless sweep run 2026-09-06 against the demo core (schema v12) with a
real local provider (llama.cpp gemma, purpose general) wired through the
app: light-mode walk, dark-mode walk (`--bg` flipped #ffffff → #101214 with
the custom theme active), plus a registered + globally activated custom
theme ("Sweep Custom", cloned preset tokens so the save/contrast gate stays
green by construction). Zero console/page errors and no rendered
`undefined`/`NaN` on any surface in any condition.

- [x] Chat transcript + composer (light/dark, custom theme) — real 542-token
      gemma reply streamed; meta line shows model + tokens + latency.
- [x] Chat attachments staged chips + per-message chips (F1) — per-message
      chip rendered after reload ("sweep.html · 135 B · Preview"). NOTE: the
      OS file-picker staging path (attach button) was env-blocked in the
      sweep (browser file-input sandbox); staging UI + bound chips exercised
      via the app's own upload API. Click-through staging = manual row.
- [x] Assets drawer + save dialog + asset rows (F10) — Save-to-Assets
      dialog listed heuristic candidates (document/table/code), saved 3
      assets (kinds document/code/table), drawer shows rows + "Saved to
      Assets ✓"; promote/copy affordances present.
- [x] Code preview overlay chrome (F12) — srcdoc sandbox verified: no
      `allow-same-origin`, scripts off, CSP meta (`default-src`/`style-src`)
      in-doc, overlay notice "sandboxed — no network, no same-origin access";
      canvas intentionally unthemed.
- [x] Choice cards (F9) and markdown blocks (F7) inside assistant bubbles —
      real reply rendered h1 + li + pre/code + table (GFM). Choice cards
      need a `:::partner.choice`-emitting model/persona — not exercised with
      the local model (manual row).
- [x] ConversationRail folder tree + move select (F11) — rail renders
      conversations with move select + drag handles + Inbox; folder create
      flow rendered (headless drag not exercised — manual row).
- [x] NotesMini lane in the chat workspace (F6) — Notes rail with ＋ Capture
      beside the transcript; capture composer opens.
- [x] Notes & Plans view, note editor, quick capture — ＋Note header opens
      the capture composer; empty states render cleanly.
- [x] Personas view incl. the capability-policy editor (F3) — list + A/B
      compare card rendered.
- [x] Providers view incl. purpose filter + badges (F4) — Local Gemma row
      (health ok, models), purpose select/badges, MCP panel + Internet-search
      card all rendered (purpose filter chips appear once providers exist).
- [x] Memory, Audit, Files, Skills, Playbooks, Themes, PairGate, session
      chat (regression) — all walked light + dark, zero errors; Audit shows
      real sweep rows.
- [x] Mode toggle persistence: reload keeps theme + mode (cache pair) —
      dark survived reload under the custom theme; conversations + chips
      intact after reload.

Still manual / desktop-only (not claimable headless): real-display walk of
the packaged app (light/dark/custom per surface, drag interactions, OS
file-picker attach staging, an alt-palette custom theme through the Theme
Studio save gate), and an F9 choice round against a model that emits
`:::partner.choice`.

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
