# PLAN-M35 — Folders as an Explorer (navigation pane + contents pane)

Status: **implemented + verified** · 2026-09-18 · no schema change (schema stays
**v24**) · no core route change.

The owner's request: *"Make Folders view somewhat similar to Windows Explorer
view. We should be able to have subfolders too, with this kind of
organization."* — followed by *"In Folders, indicate number of assets for a chat
session as well."*

Subfolders have existed in the data model since **M11** (`folders.parentId`,
arbitrary depth, cycle-free, manager-bounded to 16 levels), so this milestone is
a **view** change: the M34 Folders page rendered one tree, which made "inside
this folder" and "everything below it" the same picture. The Assets follow-up
adds the one wire field it needs (`ConversationSummary.assetCount`, derived) and
no schema.

## 1. What the page is now

```
Organize / Folders                                   [New chat]
Where chat sessions are filed …
2 folders · 1 chat (1 filed, 0 in Box)

[↑ Up]  All folders › Client work        2 items  [+ New subfolder]
┌────────────────────┬──────────────────────────────────────────────┐
│ All folders     1  │ Name                    Type  Items  Modified │
│ ▾ Client work   1  │ Q3 planning             Folder  1 chat  1m ago │
│     Q3 planning 1  │ how do I rotate …?      Chat    4 msgs   now   │
└────────────────────┴──────────────────────────────────────────────┘
   navigation pane                  contents pane
```

- **Navigation pane** — the folder tree. It is the SAME `ConversationRail`
  mounted in a new `nav` mode: folder rows only (no chat rows, no Inbox bucket),
  a selectable `All folders` root, every folder control unchanged (add
  subfolder, rename, delete, drag-a-chat-onto-it). Selecting a row is what the
  contents pane follows.
- **Contents pane** — `FolderContents`: the selected folder's **subfolders then
  chats** under Explorer's columns (Name · Type · Items · **Assets** · Modified),
  each with the shared row controls and an empty state that names the action
  which fills it. **Assets** answers the owner's follow-up: a chat row shows the
  assets saved in that session (M11 F10), a folder row sums its subtree, and a
  chat with none reads `0 assets` rather than blank — the column is a
  measurement, and 0 is the measurement.
- **Address bar** — `↑ Up`, a breadcrumb (`All folders › Client work › …`, each
  crumb a control, the current one `aria-current="page"`), the item count, and
  one `+ New folder` / `+ New subfolder` action scoped to the open folder.

## 2. Decisions (and why)

1. **One definition of the tree.** `web/src/lib/folder-tree.ts` owns the
   folder-shaped reads: `folderSubtreeIds`, `folderTreeRows` (moved from
   `note-helpers.ts`, which re-exports them so its callers do not churn),
   `folderPath` (the breadcrumb), `folderChats`, and `buildFolderTree` (nodes +
   chats + parent-and-descendant chat totals). The rail and the page both derive
   from it, so the two panes cannot disagree about order, nesting or which chats
   are filed where.
2. **One definition per control.** `FolderActions` (add subfolder / rename /
   two-step delete) and `ChatActions` (drag handle / move select / two-step
   delete) were extracted from `ConversationRail` and are now rendered by BOTH
   the rail and the contents pane. M32's regression was exactly a control that
   existed on one surface and not the other; hand-writing a second cluster for
   the new pane would have reintroduced it. The confirm timers live inside the
   components, so no caller tracks "which row is armed" any more.
3. **Items counts the subtree; the rail's badge does not.** A contents row says
   how many chats are in that folder *and everything under it* — that is what
   the column means to someone scanning it. The rail's per-folder badge keeps
   its direct-child meaning (M34 open end 2). Both are stated in the tree lib so
   the difference is deliberate, not drift.
4. **The selection is clamped, not trusted.** `App` derives the current folder
   from the live folder list, and `FoldersView` clamps again: a folder deleted
   while it was open falls back to the root instead of showing an empty page for
   something that does not exist (the same reading `folderStats` uses for a
   dangling chat `folderId`).
5. **One Create field.** The toolbar opens it; a row's `+` first *enters* that
   folder and then opens it, so the field always sits in the folder the new
   folder will appear in. `FolderContents` is keyed by folder id, so a
   half-typed name never follows the user into another folder.
6. **Subfolders get their own nesting, on every tier.** `@media (max-width:
   640px)` stacks the two panes and drops Type/Items/Modified (the Name cell is
   the control that opens the row), and the item count yields its width so the
   breadcrumb is not ellipsised to `All fol…` on a 390px screen.
7. **No new tokens, no new elevation.** Panes carry no card: separation is space
   and the row's own hover/selection fill (DESIGN.md: space → background shift →
   elevation before a border). The measure widens from 920px to the system's
   widest, 1200px, because this is a dense tool surface rather than prose.
8. **The asset count is derived, and it is one query.**
   `ConversationSummary.assetCount` is not a column: `AssetStore` gained
   `countsByConversation()` (one grouped `SELECT`, mirroring
   `MessageStore.countsByConversation`) and `ConversationManager.list()` reads it
   once per list; `get()`/`create()`/`update()` count their single chat. The
   manager's `assetStore` is optional, so a harness without assets reports 0 —
   the honest reading of "not counted". A folder row's number sums the subtree
   in `buildFolderTree` (`assetTotal`), next to the chat total it already
   computed, so the two columns cannot disagree about which chats they cover.
   Absent counts read as 0 in the client (`assetCountOf`), because a web bundle
   can meet a core that predates the field in dev mode.

## 3. Defect found and fixed by the gate

`ux_audit` on the new surface **failed** on the existing armed-delete chip:
`.folder-action-confirm` was `color: var(--accent-contrast)` on
`background: var(--danger)` — in dark mode that is `#eaf6ef` on `#ffc9b7`,
**APCA Lc −17.3 / WCAG 1.32:1**, an unreadable confirm. (Light mode was legal by
luck; the light-mode hazard is the documented `--danger`-on-`--surface-2` case,
Lc 69.5.) The armed state now takes its own `--bg` ground with `--danger` text
and a 2px `--danger` ring: Lc 80.9 light / 80.5 dark. It was pre-existing M11
CSS that M35 moved onto a page the owner actually looks at.

## 4. Tests

`web/test/folders-explorer.test.ts` (25 cases):

- **pure** — `buildFolderTree` nesting/order/`chatTotal`/**`assetTotal`**/dangling-
  folder handling/loading state; `folderPath` (root → folder, unknown, corrupt
  cycle); `folderChats`; the label helpers (`assetCountLabel`, `assetCountOf`).
- **structure** — the folder reads live in one module and `note-helpers`
  re-exports `folderTreeRows`; the rail and the contents pane both import the
  shared control components and neither hand-writes a cluster; the page derives
  its panes from one tree and clamps the selection; the rail's `nav` mode is
  folders-only; the row `+` enters then creates.
- **geometry** — two-pane grid, the page as the only scroll container, the phone
  stack and dropped columns, the touch floors for every new control, and the
  hover/focus-visible/disabled/fill states with no invented border.

`web/test/session-title.test.ts` (M34) was updated where it pinned the old
structure: the Folders page still renders ONE folder tree, now via
`conversationRail(true, { nav })`.

## 5. Exit

- root **189 files / 1812 passed** (5 env-gated skips) · web **63 files / 1048
  passed** · shared **90** · typecheck 0 · web build green.
- `ux_audit` **PASSED** on the changed surface (36 contrast pairs, light + dark;
  Tokens · States · Slop tells green) and again on the Assets-column change (24
  pairs) — see `docs/VERIFY-M35.md` for what each payload contained.
- Live walk on a demo core at 1440 (light) and 390×844 (phone tier), including
  the walk that closed the M34 phone open end: create a subfolder, file a chat
  into it, navigate by crumb/Up/selection, and the four columns.
- Live asset walk: 2 saved assets on a chat (`GET /v1/conversations` →
  `assetCount: 2`), 1 on a chat inside a subfolder, and the Folders page showing
  `2 assets` on the chat row and `1 asset` on the folder row.
