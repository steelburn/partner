# VERIFY-M35 — Folders as an Explorer

Date: 2026-09-18 · Spec: `PLAN-M35.md` · Surface: the Folders destination
(`web/src/FoldersView.tsx`, `web/src/FolderContents.tsx`,
`web/src/ConversationRail.tsx` nav mode, `web/src/FolderActions.tsx`,
`web/src/ChatActions.tsx`, `web/src/lib/folder-tree.ts`, `web/src/app.css`).

Environment: demo core (`npm run dev:core`, `DEMO_MODE=1`) + the Vite dev server,
Chromium via the browser tool. No core route, no schema change.

## 1. Suites and build (measured)

| Gate | Result |
|---|---|
| Root suite | **189 files / 1812 passed**, 5 env-gated skips |
| Web suite | **63 files / 1048 passed** (was 62 / 1023 before M35) |
| Shared suite | **90 passed** |
| Typecheck | 0 errors (`npm run typecheck`, all workspaces) |
| Web build | green (`npm run build -w web`) |
| `ux_audit` | **PASSED** — Tokens · States · Slop tells, 36 contrast pairs (Explorer surface) + 24 pairs (Assets column), light + dark |

## 2. `ux_audit` — what it ran on

The whole-file run is not possible in one call (the stylesheet is 282 kB / ~10 600
lines, the payload limit is far below that), so the gate ran on a composed,
brace-balanced payload extracted verbatim from `web/src/app.css`:

- every rule whose selector touches the changed surface: `.explorer*`,
  `.folders*`, `.folder-*` (including `.folder-select`, `.folder-row-current`,
  `.folder-action-confirm`), the `.rail-item-move/-del/-drag` cluster and its
  reveal rules, `.rail-embedded/.rail-head/.rail-body/.rail-head[hidden]`;
- every interactive base/state they compose: `.btn`, `.btn-sm`, `.btn-primary`,
  `.btn-secondary`, `.btn-danger`, `.btn-link`, `.field` (+ `:hover`,
  `:focus-visible`, `:disabled`, `::placeholder`), `.kicker`, `.page-title`,
  `.page-copy`, `.page-head-titles`, `.page-actions`;
- the tier rules for those selectors: `@media (max-width: 1150px)`,
  `@media (pointer: coarse)`, `@media (hover: none)`,
  `@media (max-width: 1150px), (hover: none)`, the M35
  `@media (max-width: 640px)` block, and the stylesheet's own
  `prefers-reduced-motion` policy for the same selectors.

It was therefore NOT run against the whole stylesheet: the off-system-value and
slop gates cover the changed surface and what it composes, not the other ~9 000
lines. (Same method and caveat as `docs/VERIFY-M34.md`.)

**Contrast (18 pairs per mode, APCA primary / WCAG sidecar).** Light: body
104.6/99.1/93.2 on bg/surface/surface-2 · muted 92.8/87.3/81.4 · kicker+column
header 12px/600 92.8 · accent crumb 80.4 · accent-hover crumb/open 88.4/83.0 ·
danger delete 80.9/75.4 · secondary button + field text 93.2 · placeholder 81.4 ·
empty title 104.6 · count chip 81.4. Dark: body −93.5/−92.5/−91.1 · muted
−77.7/−76.7/−75.2 · headers −77.7 · accent crumb −81.3 · accent-hover −88.0/−87.1
· danger −80.5/−79.6 · field 12.6 · placeholder −75.2. Every pair cleared its
threshold (Lc 75 body / 60 large-bold / 45 by size-weight).

**One FAIL was found and fixed** — the armed folder-delete chip, pre-existing M11
CSS that M35 moved onto a page the owner looks at:

| Mode | Pair | Before | After |
|---|---|---|---|
| dark | armed confirm text on danger fill | `#eaf6ef` on `#ffc9b7` = **Lc −17.3 / WCAG 1.32:1** ❌ | `--danger` on `--bg` = Lc −80.5 / 12.77:1 ✅ |
| light | same rule | (legal by luck; the sibling hazard is `--danger` on `--surface-2`, DESIGN.md M20.A Lc 69.5) | `--danger` on `--bg` = Lc 80.9 / 6.57:1 ✅ |

The armed state now takes its own `--bg` ground with `--danger` text plus a 2px
`--danger` ring, so both modes pass without a new token.

**The Assets-column change (M35 follow-up) was audited again**, on a payload
composed of every `.explorer*` / `.folder-*` / `.rail-item-*` rule the change
touches plus the interactive bases it composes (`.btn`, `.btn-sm`,
`.btn-secondary`, `.btn-danger`, `.field` with their `:hover`/`:focus-visible`/
`:disabled`/`::placeholder` states) and the tier blocks (`≤1150`, `pointer:
coarse`, `hover: none`, the `≤640` stack, `prefers-reduced-motion`): **PASSED**,
24 pairs. The new cell (`.explorer-cell-assets`) joins the existing
`--text-muted` metadata rule, so its measured pairs are the metadata ones —
Lc 92.8 / 87.3 / 81.4 on `--bg` / `--surface` / `--surface-2` in light and
−77.7 / −76.7 / −75.2 in dark.

## 3. Live walk (demo core, Chromium)

**Desktop, 1440×900, light (`#ffffff`/`#f6f6f4` confirmed applied).** Folders
opens with the two panes: navigation pane at x=272 w=260, contents pane at x=564
w=844, same row. Read back from the DOM at each step:

1. Root: crumbs `All folders`, `↑ Up` **disabled**, count `2 items`, header
   `Name · Type · Items · Modified`, rows `Client work | Folder | 0 chats | 46m
   ago` and the one chat `… | Chat | 4 msgs | 45m ago`.
2. Created a subfolder inside `Client work` from the toolbar field (its
   `aria-label` read `Name for the new folder in Client work`): the navigation
   pane then held `All folders 1` → `▾ Client work 1` → `Q3 planning 1` (depth 1,
   indented, `--folder-depth: 1`) and the contents pane row read
   `Q3 planning | Folder | 0 chats | now`.
3. Selected `Q3 planning`: crumbs became `All folders › Client work › Q3
   planning` with the last one `aria-current="page"`, `↑ Up` **enabled**; `Up`
   returned to `Client work`.
4. Filed the demo chat into `Q3 planning` with the row's move select: the nav
   badge for `Q3 planning` read 1, `Client work` read 1 (subtree), the page stats
   read `2 folders · 1 chat (1 filed, 0 in Box)`; the contents pane for `Client
   work` read `Q3 planning | Folder | 1 chat | now`.
5. Filed the chat directly into `Client work`: its contents pane then listed BOTH
   kinds of item — `Q3 planning | Folder | 0 chats | 1m ago` and the chat
   `| Chat | 4 msgs | now` — with the address bar reading `2 items`. (This frame
   is the requirement proof for the columns claim.)
6. The rail in `nav` mode rendered no chat rows and no Inbox bucket; `All
   folders` counted all chats (1) rather than the Inbox bucket (0) after a first
   filing attempt read as "0", which contradicted the pane beside it.

**Phone, 390×844 (dark).** Panes stack (`.explorer-body` one column; nav pane at
y=423 h≈204, contents at y=627), Type/Items/Modified are `display: none`, the row
height is 60px, `document.documentElement.scrollWidth === clientWidth` (no
horizontal overflow), and no interactive element measured under 44px
(`.explorer-crumb`, `.explorer-open`, `.folder-select`, `.folder-action`,
`.explorer-up`, `.explorer-new-folder`). The item count is hidden at this tier so
the breadcrumb is not ellipsised. **This closes the M34 open end 1** (the phone
tier of the Folders page had never been measured).

## 4. Not verified

- The packaged Tauri shell and the container/hosted walk (`PLAN-M21/M22`) were
  not run for this milestone — the change is web-only and both remain apart.
- Drag-and-drop from the contents pane onto a navigation row was exercised only
  as the pre-existing gesture (the payload contract moved into `ChatActions`); no
  touch-tier drag is offered, and the move select remains the accessible path
  (M34 open end 4, unchanged).
- No empty/error-path walk of the folders API (offline, 401) was repeated: the
  page reuses the M34 rail error banner and `folderStats`'s dangling-id reading,
  both covered by the existing suites.
- The Assets column was NOT re-measured on the phone tier as a live frame: the
  tier hides every metadata cell including the new one, and the `≤640` rule that
  does it is pinned by `folders-explorer.test.ts` (`tier('(max-width: 640px)',
  '.explorer-cell-assets')` → `display: none`) rather than by a screenshot.
- Assets are counted, not listed: the column answers "how many", and the assets
  themselves remain the Assets lane / `GET /v1/conversations/:id/assets`.

## 5. The asset count (M35 follow-up, measured live)

Wired at three levels and each one checked against the running demo core:

1. **Store** — `AssetStore.countsByConversation()` (one grouped `SELECT`), used by
   `ConversationManager.list()`; `get()`/`create()`/`update()` count their single
   chat, and a manager created without an asset store reports 0.
2. **Wire** — `ConversationSummary.assetCount`, required on the shared type and
   always present on the response. Live check on the demo core: two chats, one
   with two saved assets (`POST /v1/conversations/:id/assets`) and one with none,
   `GET /v1/conversations` → `assetCount` 2 and 0; `GET /v1/conversations/:id` →
   `assetCount` 2. Pinned in `core/test/conversations/manager.test.ts` (4 cases)
   and `core/test/http/foldersRoutes.test.ts` (the end-to-end one).
3. **Render** — the contents pane's Assets cell, read from the DOM with `Client
   work` open: `Q3 planning | Folder | 1 chat | 1 asset | 1m ago` (the asset
   belongs to the chat *inside* it) and `how do I rotate the sqlite key without
   losing data? | Chat | — | 2 assets | now`. Header row read back as
   `Name · Type · Items · Assets · Modified`.

A dev-flow detail the implementation defends against: the running web bundle can
meet a core started before this field existed, so `assetCountOf()` reads an
absent count as 0 — the page renders `0 assets`, never `undefined assets`.
