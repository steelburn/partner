# DESIGN.md — Partner default design system

Status: **v0.2 — design-review adoption (2026-09-06)** · Authoritative token
values: `shared/src/theme.ts` (this doc is the human rationale; the code is
the source of truth). Theme studio + user themes edit the token document,
never component structure.

v0.2 delta (review of steelburn/engage + teliti-team/teliti): new page-title
step `--fs-xxl` (32px) and tracking tokens; screens lead with a context
label (kicker) + sized title; empty states follow the four-part contract
below. History: v0.1 = M0 draft baseline.

## Overview

Partner is a personal AI workspace: chat, persona studio, plans/notes,
providers, skills. The UI is calm, legible, and token-only. It must feel like
a quiet instrument panel, not an art piece: neutral surfaces, one green
accent family, generous whitespace, named elevation, zero decorative effects.
Dark and light modes ship from day one via the same token set.

Design-review adoption (M12 review of steelburn/engage + teliti-team/teliti):
this system deliberately keeps one typeface and one neutral identity, but it
borrows two disciplines from those products so dense screens never read flat
or hollow:
1. **Visible type hierarchy** — every screen leads with a *context label*
   (kicker) above a sized page title (new 32px step below). Hierarchy comes
   from scale, weight, tracking and uppercase labels — never from colour,
   borders or decoration.
2. **Role-aware empty states** — an empty view states *whose* view it is,
   *why* it is empty for that role, and the exact next action (a named
   button), with a numbered mini-guide on true first runs.
Deliberately NOT adopted (they would break the quiet single-identity
instrument panel): a second display typeface (Engage's condensed Barlow),
per-surface palettes (stage/ticket/console), and decorative motion.

Non-negotiable discipline (see also the repo UX rules):
- **Tokens only.** No raw hex/px/shadow values in components. Consume
  `var(--…)` produced from `shared/src/theme.ts`.
- **One accent family** (green). No purple/indigo gradients, no glow, no
  glassmorphism (`backdrop-filter`), no gradient orbs.
- **Elevation:** the 3 named levels (`sm/md/lg`) only. A modal is nearer than
  a card; a dropdown nearer than the page — via level, never invented shadows.
- **Borders are the last resort** for separation: space → background shift →
  elevation before a border.
- **Spacing:** 8px grid via `--space-*`.
- **States:** every interactive element declares `default`, `hover`,
  `focus-visible` (2px `--focus` ring), `active`, `disabled`; plus
  `error`/`empty`/`loading` where relevant.

## Colors

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | #ffffff | #101214 | page background |
| `--surface` | #f6f6f4 | #191c1f | cards, panels, chat bubbles (own) |
| `--surface-2` | #ececea | #22262a | inputs, wells, nested rows |
| `--text` | #16181d | #e8eaed | primary text |
| `--text-muted` | #3f444c | #cbd1d8 | labels, captions |
| `--text-faint` | #5d636e | #9aa1ab | disabled/placeholder (exempt from body-text minimums) |
| `--accent` | #1f6f43 | #6aedb6 | links, active nav, focus emphasis on surfaces |
| `--accent-hover` | #195936 | #84f6cb | accent hover |
| `--accent-emphasis` | #1f6f43 | #1a5b37 | **filled** actions (primary buttons, user bubbles) |
| `--accent-emphasis-hover` | #195936 | #14502f | emphasis hover |
| `--accent-contrast` | #ffffff | #eaf6ef | text/icon on emphasis surfaces |
| `--danger` | #b42318 | #ffc9b7 | destructive, errors |
| `--warning` | #a15c00 | #f0ab41 | warnings |
| `--success` | #1f6f43 | #6aedb6 | success |
| `--focus` | #1f6f43 | #84f6cb | 2px focus ring |
| `--border` | #d9dbd7 | #30353b | input strokes / dividers (last resort) |

Contrast: all text pairs pass APCA Lc ≥ 75 (body) / ≥ 45 (large-bold) and the
WCAG sidecar (4.5 / 3.0). Dark-mode values above are tuned to those gates on
dark surfaces — secondary text is brighter than a naive palette requires.
Filled actions use `accent-emphasis` (dark green in dark mode) so
`accent-contrast` text passes while links keep the brighter `--accent`.
Placeholders/disabled use `--text-faint` and are exempt from body-text
minimums. Theme saves are contrast-gated (M6).

M12 P0.3 note (gate pairs + usage rule): the light-mode `--accent` green
under-reaches the Lc 75 floor on tinted fills (`--surface` 72.6,
`--surface-2` 69.0), so the theme-save gate asserts the mode-split pairs
`accentHover`-text on `--surface` (light, Lc 80.5) and `accent`-text on
`--surface-2` (dark, Lc 78.2). **Usage rule:** in light mode accent-colored
text only ever sits on `--bg`/`--surface` (use `--accent-hover` on
surfaces); never on `--surface-2` wells — a well that must carry accent text
surfaces to `--surface`. Dark mode may carry `--accent` on `--surface-2`
wells.

## Typography

- Family: Inter with system fallbacks (`--font-family`); UI and content share
  the family. Code, file paths and diffs use the fixed-width family
  (`--font-mono`) so artifacts read as machine text, never prose.
- Scale (modular, snapped): 12 / 14 / 16 / 20 / 25 / 32 px
  (`--fs-xs…xxl`); body default 16. Weights 400/500/600/700 (`--fw-*`).
  Line-height ~1.5 body, 1.25 headings. Flush-left text; no justified text,
  no mid-word caps.
- `--fs-xxl` (32px) is the **page-title step**: reserved for the lead title
  of a screen, above dense content. Never used inline or inside cards.
  `--fs-xl` (25px) stays as a section/intermediate step; new page titles use
  `--fs-xxl`.
- Tracking tokens only (`--track-label` 0.08em on uppercase context labels;
  `--track-head` −0.01em on `--fs-xl`/`--fs-xxl` headings). No ad-hoc
  letter-spacing in components.

## Layout & spacing

- 8px grid: `--space-0…7` = 0/8/16/24/32/40/48/64 px.
- Content column ≈ 720px for prose; wider for dense tool surfaces
  (chat, tables) with the same gutter rhythm.
- Density default is comfortable; no density override before M6.

## Shapes & elevation

- Radius: `--radius-sm/md/lg` (6/10/14) + `full` for chips/avatars. Applied
  to the whole surface, never random per-element.
- Elevation (only these):
  - `sm` — controls on surfaces, raised rows.
  - `md` — cards/panels that must separate from surface (prefer bg shift).
  - `lg` — modals, popovers, command palette.
  Hover on cards = surface shift, not a bigger shadow.

## Components (contracts)

v1 inventory (built from M3 onward; states are part of every component):

| Component | Key notes |
|---|---|
| Button | variants: primary (accent), secondary (surface-2), ghost, danger. All 5 states. Focus ring offset 2px. |
| Input / textarea | surface-2 fill, 1px border on hover/focus only, focus ring; error state pairs message w/ `--danger`. |
| Card | bg `--surface` or `--bg` + elevation-sm at most; separation first by bg. |
| Chat transcript | user bubbles on accent (contrast text), partner on surface; system/status rows muted. |
| Sidebar nav | active item: accent text on surface-2 pill; icons 16–20px, no glow. |
| Badge/chip | surface-2 with muted text; status tints from semantic tokens only.
            M12 P0.3: chips carrying accent-colored text use `--surface`
            (light) or `--surface-2` (dark) fills — see the usage rule under
            Colors. |
| Context label (kicker) | uppercase, `--fs-xs` / weight 600, `--track-label` 0.08em, `--text-muted`; sits only on `--bg`/`--surface` (APCA Lc ≥75 at 12px/600 in both modes, audited). One short word or phrase ("files", "providers", "live session") flush left above the page title. Never a sentence; never colour-tinted; never on `--surface-2`. |
| Page header | composition contract: [optional context label] + `--fs-xxl` title + actions row on the right. One per screen, flush left; no page headers inside cards. |
| Empty state | title + role-scoped reason + named primary action (+ numbered mini-guide ≤4 steps on true first runs). See the empty-state contract below. |
| Modal / popover | elevation-lg, scrim from a named overlay token, focus trapped. |
| Toast | surface + elevation-md + semantic left edge. |
| Toggle / checkbox / radio | accent when on, surface-2 when off; disabled = faint. |
| List rows | separators: space → surface shift → border (last resort). |

Empty/loading states: skeletons are surface-2 blocks (no spinners-only).
**Empty-state contract** (adopted from the design review): every empty view
carries 1) a short title naming the thing ("No providers yet" may be the
title only), 2) a reason line scoped to the viewer's role and active filters
("No conversations in this folder", "Ask an admin to assign you as a
moderator"), 3) a primary action that names the actual button to press
("+ Add your first provider"), and 4) on true first runs, a numbered
mini-guide of up to four steps. Banned: an empty state with no action, or
copy that merely restates the title.

## Motion

Fast 100ms / base 180ms / slow 280ms (`--motion-*`), ease curve constant.
Motion is for state feedback (appear/expand/focus), never decoration; respect
`prefers-reduced-motion`.

## Do's & Don'ts

- Do: reference tokens; use accent only for interactive/emphasis; separate
  with whitespace; make focus states obvious; keep dark+light in lockstep.
- Do: open dense screens with the context-label + page-title composition,
  and give every empty state a role-scoped reason plus a named next action.
- Don't: title two screens at the same size with no context label; apply
  letter-spacing by eye; ship an empty state with no action; use
  `--surface-2` as a context-label seat.
- Don't: invent colors/shadows/sizes; glassmorphism, gradient orbs, neon
  glow; 1px gray card borders as decoration; permanent-dark reflex; ship an
  interactive element without focus-visible and disabled states.
