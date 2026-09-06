# M6 — Theming (token schema, presets, Theme Studio, contrast-gated saves)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§10, §15
M6) · Gates: same as M0–M5.

## Goal

The UI's "ownable look": a **`theme` record** = both modes of the design
tokens (shared `ThemeTokens` per mode) that components already consume via
`cssVars()`. Users pick a preset, tweak tokens in a **Theme Studio**, and save
only themes that pass a deterministic **contrast gate** (APCA ≥ body floors +
WCAG sidecar on a fixed assertion set) plus a token **lint** (all values
present/typed). Themes apply globally or per persona; the persona's
`colorTheme` field (already stored since M3) resolves the active tokens.

## Data (core SQLite schema v7 — additive)

```sql
CREATE TABLE IF NOT EXISTS themes (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL, -- preset|custom
  light_json TEXT NOT NULL, dark_json TEXT NOT NULL,             -- JSON ThemeTokens
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
```
Settings keys: `active_theme` (id; default = `preset-default`), per-persona
binding = `persona.colorTheme` (existing M3 column; resolves to a theme id or
preset id, else global active).

## Shared contracts (`shared/src/theming.ts`)

`ThemeTokens` per mode (reuse theme.ts); `ThemeProfile` {id,name,source,
light,dark}; `ThemeSaveInput` {name, light, dark}; `ActivationResult`;
`ThemeReport` {ok, warnings, errors:[{token, mode, message, apca?, wcag?}]};
preset registry id list. Server-side gates (pure, dependency-free):
- token lint: every ThemeTokens key present, strings parse as hex/oklch where
  required, semantic sanity (accent distinct from bg etc. lenient).
- contrast gate over a FIXED assertion set per mode (body, muted, filled
  button text, link/accent on bg, danger on bg — the same pairs DESIGN.md
  lists), computed with an embedded APCA implementation + WCAG ratio;
  failures → report (blocking save); the exemptions in DESIGN.md apply
  (faint/placeholder/disabled excluded).

## Core API (authed)

- `GET /v1/themes` → presets + saved (each with light/dark tokens, source)
- `POST /v1/themes` {name, light, dark} → 201 profile | 400 report (lint or
  contrast failure blocks with the full report body)
- `PUT /v1/themes/:id` (same gate) · `DELETE /v1/themes/:id` (not while
  active; not presets)
- `POST /v1/themes/:id/activate` → activation {id} (+ clears per-persona
  override when global)
- `GET /v1/theme/active?personaId=` → {themeId, source, light, dark} —
  persona.colorTheme → global active → preset-default
- `POST /v1/personas/:id/theme` {themeId|null} (bind/clear) — validates theme
  exists; reuses persona update path.
Seed: preset-default (current DESIGN tokens) + a second preset ('sage-dark'
variant) as immutable `preset` rows; seed only when table empty.

## Web (Theme Studio — seventh view, token-only)

- Theme list (presets grouped immutable + custom): name, source badge,
  current badge when active, Activate, Delete (two-step), Edit.
- Studio editor for a selected theme (copy of preset when customizing):
  grouped token inputs (colors light+dark, spacing/radius/elevation/type are
  read-only display from the shared fixed tokens for now — M6 edits COLOR
  tokens per mode only; report says which), each with hex input + validation
  hint; **live preview** = applying edited vars immediately to the current
  document via cssVars() overlay (mode toggle works against the draft).
- Save → server gate → render the returned report inline (per-token errors,
  e.g. 'dark: text on surface Lc 51 < 75'); success shows applied state.
- Export/import theme JSON; global Activate; per-persona bind dropdown on the
  persona manager rows (bind → activate that theme for that persona).
- Mode toggle unaffected; header remains.

## Tests

Core: embedded APCA/WCAG functions match known pairs (reuse the numbers the
design audit used: e.g. dark muted #cbd1d8 on #191c1f Lc ≈ 76.7); lint +
gate reject invalid/weak themes with a report; presets seeded idempotently;
CRUD + active + persona binding resolution precedence (persona → global →
preset) incl. clearing to global; not-while-active delete + preset delete
refused; routes 401/400-report. Web: helpers (validation parse of report,
token merge for preview overlay), api tests. E2E (spawned demo core): create
a dark theme with valid tokens → activate → GET /v1/theme/active returns it;
create an INVALID theme (muted equal to surface) → 400 with a report.

## Exit criteria (tick PLAN.md M6)

- [x] Theme store + presets + gates (lint + contrast) + activation +
      persona binding, test-covered; /v1/theme/active feeds the UI.
- [x] Theme Studio token-only with live preview + inline reports + export.
- [x] Typechecks, root + web suites green, e2e passes.

## Out of scope

Conversation-scoped themes (defer), editing non-color tokens (type/spacing/
radius/elevation editors — fixed system in M6, unlock in a later release),
per-window/OS-sync, DESIGN.md auto-regeneration from a theme.
