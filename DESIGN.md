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
| `--text-faint` | #5d636e | #9aa1ab | **disabled** text only (a disabled control also fades). NOT for placeholders: a placeholder is instructive text and follows the body floor (M20-B S7) |
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
Placeholders use `--text-muted` (M20-B S7: `--text-faint` is Lc 68.9 light /
48.0 dark on the input well, below the body floor) and disabled text uses
`--text-faint`. Theme saves are contrast-gated (M6).

M12 P0.3 note (gate pairs + usage rule): the light-mode `--accent` green
under-reaches the Lc 75 floor on tinted fills (`--surface` 72.6,
`--surface-2` 69.0), so the theme-save gate asserts the mode-split pairs
`accentHover`-text on `--surface` (light, Lc 80.5) and `accent`-text on
`--surface-2` (dark, Lc 78.2). **Usage rule:** in light mode accent-colored
text only ever sits on `--bg`/`--surface` (use `--accent-hover` on
surfaces); never on `--surface-2` wells — a well that must carry accent text
surfaces to `--surface`. Dark mode may carry `--accent` on `--surface-2`
wells.

M20.A note — **the same rule applies to `--danger`, which was never checked**:
light-mode `--danger` (#b42318) measures **Lc 80.9 on `--bg`**, **75.4 on
`--surface`** and **69.5 on `--surface-2`** — i.e. it *fails* the body floor on a
`--surface-2` well. This was a real defect in the Memory view, where
`--surface-2` entry rows carried a ghost Delete action (measured Lc 69.52;
now the control takes its own `--bg` ground at Lc 80.9). **Usage rule:** in
light mode danger text may sit on `--bg` or `--surface`, never directly on a
`--surface-2` well — give the control its own ground. Dark mode is fine
anywhere (Lc ≥ 78). Any `--danger` text placed on a well in a new component
must be checked against this, not assumed from the token name.

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

## Responsive & touch (M20.A)

Three tiers. A reader should be able to name the tier from any screenshot.

| Tier | Width | Shell | Navigation | Rails (conversations/notes/assets) |
|---|---|---|---|---|
| **phone** | ≤ 640 | single column: top bar, content, tab bar | bottom tab bar + More sheet (the sidebar is hidden) | conversations **overlay**; notes/assets columns collapse to overlays at ≤ 760 |
| **tablet** | 641–1150 | content column, icon rail (the **default** — the user may expand it to 200px) | icon rail; the toggle restores labels | conversations **under Personas** (M32); notes/assets columns below 900, overlays at ≤ 760 |
| **desktop** | > 1150 | sidebar (224px, drag-resizable 180–420) + content column | full sidebar with group labels; the toggle collapses it | conversations **under Personas** (M32); notes/assets columns |

**One left panel (M30).** The conversation list and its folder tree live in the
sidebar, under the Chat entry, instead of a second rail column beside the
transcript. The Chat destination button and its disclosure chevron are separate
controls (selecting the view vs. showing the tree); the folder tree, drag-to-move,
rename and delete are unchanged. Above the phone tier this is the only place the
tree appears, so the transcript gets the rail's width back; at the phone tier the
sidebar is hidden, so the tree is still the floating rail overlay opened from the
top bar. `ConversationRail` renders both (its `embedded` prop only drops the
fixed column width).

**Chat sessions live under Personas (M32).** The session list left the Chat
entry and now nests under each persona (`PersonaChatTree`): the Personas
destination and its disclosure chevron are separate controls, the tree is open
by default, and a chat whose persona is gone or absent stays visible under an
explicit **Unassigned** group. Chat is a destination plus a `New chat` action.
The tree is bounded and scrolls internally (the twelve-item menu already fills a
laptop-height sidebar). At the phone tier the sidebar is hidden, so the same
`ConversationRail` is still the floating overlay.

**The sidebar is drag-resizable (M32).** A `ColumnDivider` on the menu's right
edge adjusts the single `--side-w` knob (180–420px, keyboard arrows included)
and persists per session as `partner.sideWidth`. A dragged width applies only
while the menu is expanded, so it can never override the 60px icon rail.

The tier breakpoints are mirrored in code by `matchMedia` constants
(`App.tsx`, `web/src/lib/nav.ts`) used **only for state defaults** — never for
layout, which stays in CSS so there is one source of truth per form factor.

**The sidebar's icon rail is a state, not a breakpoint** (M20.A follow-up 10).
`.app.side-minimized` collapses it to 60px via the single `--side-w` knob; the
tablet tier only decides the *default* (collapsed below 1150), and the user's
toggle wins in both directions — an iPad in landscape reports >1150 CSS px, so
the tier alone would hand it a 224px sidebar with no way to reclaim it. Group
titles and labels leave (`display: none`); **the attention badge stays** (moved
to the button's corner, the phone tab bar's contract), because an icon rail that
hides "waiting on you" trades a blocked turn for 164px. The width snaps —
nothing to animate text with, and a half-slid rail reads as a glitch. The toggle
lives *inside* the sidebar, so the phone tier (which hides it) cannot show a dead
control.

Rules that hold on any touch tier:

- **Touch targets:** `--target-min` (44px) is a floor on the *hit area* of every
  control. A control may look small; it must never be touchable-small. Primary
  actions use `--target-comfortable` (48px).
- **No hover-only affordances.** Anything revealed by `:hover` must also be
  revealed under `@media (hover: none)` (and at the phone tier, because some
  phones report `hover: hover`). A destructive or essential action reachable
  only by hovering is unreachable on a phone.
- **Dynamic viewport.** The shell is sized with `100dvh` (with a `100vh`
  fallback declaration) so an open keyboard shrinks the layout instead of
  covering the composer. Never `100vh` alone.
- **Safe areas.** `viewport-fit=cover` in the viewport meta, then
  `--safe-top/right/bottom/left` (`env(safe-area-inset-*)`) on the top bar and
  tab bar. Zero on desktop, so the same rule needs no media query.
- **One nav per form factor.** Above the phone tier the tab bar is hidden by
  CSS, not unmounted, so no JS breakpoint can disagree with the paint.
- **A floating pane is dismissed by a tap outside it.** Where a rail/lane is an
  overlay (≤640 rail, ≤760 lanes), tapping the transcript puts it away: the
  scrim retires on the tap and the pane slides out to its own edge over
  `--motion-base`, so the exit matches the entrance. The scrim is the one
  overlay value (below), scoped to the workspace so the top-bar toggles that
  opened the pane stay live and undimmed, and it is decorative (`aria-hidden`,
  out of the tab order) with those toggles as the keyboard path. A pane that
  owns a column is **not** dismissable this way — geometry decides, not state.
  Two floating panes never coexist (they overlap at the phone tier); a reduced-
  motion preference closes at once instead of waiting for motion that is off.

Measured gates (a gate that only asserts “no horizontal overflow” is not
enough — at HEAD the phone layout never overflowed, it *crushed* content):
composer width ≥ 296px at 360px and ≥ 320px at 390px · zero controls under
44×44 · no horizontal overflow at 320/360/375/390/430 · tablet geometry
unchanged from the desktop column model.

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
| Sidebar nav | active item: accent text on surface-2 pill; icons 16–20px, no glow. Collapses to the 60px icon rail (one `--side-w` knob, `.app.side-minimized`); icon-only items carry the label as a `title`, and the badge sits in the button's corner rather than being hidden. Groups are **Workspace / Studio / Tools / Settings** (M31): Studio is what the partner is made of (personas, skills, playbooks), Tools is its working data (files, memory), and every configuration surface (providers, themes, audit, members) lives under the last group. The session tree nests under **Personas** (M32), and the menu's right edge is a drag divider. |
| Persona card (M31) | a “business card” in a responsive `auto-fill` grid: accent avatar, name, tagline, and a 3-fact row (independence / routing / temperature) over hairline rules. The card face is the edit affordance; **pause (the kill switch) and delete stay on the card**, because the destructive/urgent actions must not hide behind a click. A paused card drops to 0.72 opacity. |
| Drawer (M31) | a side panel (`position: fixed`, elevation-lg, the one scrim value) for editing a single record without leaving the wall — used by Personas and the Skills Catalog (M32). `role="dialog"` + `aria-modal`, a decorative scrim, focus into the first field on open, Escape to close, and the form’s own Save/Cancel are the exits. Full width on a phone; reduced-motion drops the slide. |
| Magazine layout (Notes & Plans, M31) | an editorial measure, not a card stack: masthead (folio → `--fs-xxl` title → deck), hairline section rules, and a river of entries with the newest as a full-width lead (`grid-column: 1 / -1`). Panel measure 1200px, 1360px at ≥1600px; lists are `auto-fill minmax(300px, 1fr)` grids, prose stays ≤68ch. The note editor and plan planner keep their card surface — they are documents you sit inside, not list entries. |
| Badge/chip | surface-2 with muted text; status tints from semantic tokens only.
            M12 P0.3: chips carrying accent-colored text use `--surface`
            (light) or `--surface-2` (dark) fills — see the usage rule under
            Colors. |
| Context label (kicker) | uppercase, `--fs-xs` / weight 600, `--track-label` 0.08em, `--text-muted`; sits only on `--bg`/`--surface` (APCA Lc ≥75 at 12px/600 in both modes, audited). One short word or phrase ("files", "providers", "live session") flush left above the page title. Never a sentence; never colour-tinted; never on `--surface-2`. |
| Page header | composition contract: [optional context label] + `--fs-xxl` title + actions row on the right. One per screen, flush left; no page headers inside cards. |
| Empty state | title + role-scoped reason + named primary action (+ numbered mini-guide ≤4 steps on true first runs). See the empty-state contract below. |
| Modal / popover | elevation-lg, the one scrim value — `color-mix(in srgb, var(--bg) 55%, transparent)`, scoped to what it covers (More sheet, phone persona sheet, a floating rail) — focus trapped. |
| Toast | surface + elevation-md + semantic left edge. |
| Toggle / checkbox / radio | accent when on, surface-2 when off; disabled = faint. |
| Segmented pill (view switch, Notes/Plans, Code/Preview) | one `--surface-2` well of `.btn` pills; the active pill carves back to `--surface` with `--text`, and its hover takes `--accent-hover` (never accent text on the well — the light-mode rule above). State is `aria-pressed`, the group carries the label. Panels stay mounted (`hidden` or a zero-height ghost) so a flip rebuilds nothing and never re-measures the container. Dense variants use `btn-sm`, which the coarse-pointer rule floors at `--target-min`. |
| Choice / form / scorecard card | transcript controls from `:::partner.*` containers: a choice is a radio/checkbox set, a form is one textarea per open-ended question, a scorecard is one radio row (scores `1..scale`) per rated item — each with a **single** submit. Confirm sends one labelled user turn; inert while a turn streams. Surface fill + `--radius-lg`, no border. |
| Grouped answers | **A reply that asks more than one question set offers exactly ONE submit.** Two containers in one message (e.g. a choice *and* a form) render as sections of one `--surface` panel with one button — never as two cards with two buttons, because pressing either would send only its own answer and silently discard the other's. The grouped cards drop their own surface and margin (nested `--surface` on `--surface` is the plane-stacking the system avoids) and their empty actions rows collapse via `:empty`. Submission is blocked until **every** part is complete, and the disabled state always states what it is waiting for ("2 answers still needed") — a disabled control with no reason is a dead end. Once sent the group is inert ("Answers sent"), so one prominent button cannot post a duplicate. |
| List rows | separators: space → surface shift → border (last resort). |
| Bottom tab bar (phone) | 4 primary destinations + **More**; every tab ≥ 44px and ≥ 72px wide at 360px. Active tab = the nav-active contract (filled `accent-emphasis` pill with `accent-contrast` text) — the one combination the theme gate guarantees in both modes. Labels `--fs-xs` in `--text-muted`; **never** `--text-faint` (Lc 49.5 on the dark surface, below the body floor; faint is exempt only for disabled/placeholder). |
| More sheet (phone) | `elevation-lg`, full width, anchored above the tab bar, `--radius-lg` top corners, ≤ 60dvh and scrollable. Rows are `--target-min` tall in a 2-column grid. Closes on select, on the Close control, and on Escape; the scrim is decorative (`aria-hidden`) so the keyboard path is explicit. |

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
- Don't: gate an affordance on `:hover` alone — on touch it simply does not
  exist. Don't size the shell with `100vh` alone (the keyboard covers the
  composer). Don't reserve a column for a rail on a phone: the transcript is
  the workspace, so rails overlay it.
- Don't: use `--text-faint` for a control label to "quiet it down" — it is
  exempt only for disabled/placeholder text.
