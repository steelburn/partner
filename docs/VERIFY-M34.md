# VERIFY-M34 — Folders as a first-class section, and the session title header

Date: 2026-09-18 · Spec: `PLAN.md` §15 (M34) · Open ends: `docs/UNFINISHED.md`
§0-M34.

This record says what was measured, what was only asserted, and what was not
checked at all. Nothing here is inferred from the code.

## Gate results (deterministic)

| Gate | Result |
|---|---|
| Root suite (`npm test`) | 189 files · **1807 passed**, 5 env-gated skipped |
| Shared suite | 8 files · **90 passed** |
| Web suite (`npx vitest run --root web`) | 62 files · **1023 passed** |
| `npm run typecheck` | 0 errors (shared · core · web · extension) |
| `npm run build -w web` | green (163.35 kB CSS / 1101.38 kB JS) |
| `ux_audit` | **PASSED** — Tokens · States · Slop tells, 21 contrast pairs, light + dark |

`ux_audit` was run against the changed surface: the new `.folders*` /
`.chat-session*` rules plus every shared rule they compose (`.btn*`,
`.btn-link*`, `.field*`, `.page-*`/`.kicker`, `.ic`, the embedded `.rail*` tree
and `.folder-*`), extracted verbatim from `web/src/app.css`, with the
stylesheet's own `prefers-reduced-motion` policy for those selectors. It was NOT
run against the whole 11 562-line stylesheet (273 kB), which is too large to pass
through the tool in one call — the off-system-value and slop gates therefore
cover the changed surface, not the file. The full-file gates were green at M33.

**One defect the gate found and this change fixed:** `.folder-count` and
`.rail-total` used `--text-faint` on `--surface-2` (APCA Lc 68.9 light / 48.0
dark — under the body floor). They now use `--text-muted` (Lc 81.4 / 75.2). The
Folders page is where those numbers are read, which is why they were fixed here.

## Browser walk — desktop 1440, demo core, light + dark

Run against a live demo core (`:4390`, `schemaVersion 24`) and the Vite dev SPA
(`:5173`), paired through the PairGate with the dev pairing code.

Verified by DOM read, not by eye alone:

| What | How it was checked | Result |
|---|---|---|
| Folders is a destination | `nav[aria-label="Partner views"]` → Workspace group | `Chat · Folders · Notes · Shared` |
| Page frame | `.page-title` / `.page-copy` | "Folders", kicker "Organize", 920px measure |
| Folder CRUD from the page | created "Client work" through `+ New folder` | row rendered; stats read `1 folder · 0 chats, none filed yet` |
| The tree with ZERO chats | count of `.folder-row` before/after the fix | was **0 rows** (empty note shown instead), now **1 row** — the fix is `list.length === 0 && !anyFolders` |
| Session header | `.chat-session-title` at 1440 | "how do I rotate the sqlite key without losing data?" above the transcript, `Rename` + `Suggest title` right-aligned |
| Threshold gate | `Suggest title` `disabled` after 1 user turn | **true** |
| Threshold gate | `Suggest title` `disabled` after 2 user turns | **false** |
| Suggestion round-trip | clicked `Suggest title` with no model configured | proposal rendered: `Suggested: …` + `Use title` + `Dismiss` + "No model named this — it is your opening message, shortened." |
| Dark mode | theme toggle, same state | title, accent links, proposal well and note all legible; no off-system colour introduced |

**Two defects the walk found and this change fixed** (neither was visible to
the gate):

1. The embedded rail's head rendered a full-width **primary "New chat"** bar at
   the top of the Folders page, reading as the page's primary action and
   duplicating the sidebar's. The rail head is now suppressed on the page and
   the action moved to the page header as a secondary button — which is also
   what makes the rail's empty note ("start with New chat") land on a control
   that is actually present.
2. A folder row's action cluster (add subfolder / rename / delete) is
   `:hover`/`:focus-within`-revealed, and the stylesheet's `(hover: none)`
   block did not reveal it — so the whole tree was read-only on a phone or
   tablet. Fixed to match the chat row's existing rule.

## NOT checked

- **Phone tier (360–430px).** No walk was run. Reachability is asserted only
  structurally (Folders is in `MOBILE_MORE`; `nav.test.ts` proves tabs + More
  cover every view), and the embedded rail is content-height inside the page's
  scroll container by CSS, not by measurement.
- **Tablet width (641–1150px).** Not measured.
- **A real model naming a session.** The demo core has no provider configured,
  so the `source: 'model'` path was exercised by unit tests with a scripted
  provider client, never by a live model.
- **Drag-to-move on the page.** Not exercised (the move `<select>` was not
  either); both are pre-existing behaviours of `ConversationRail`, unchanged by
  M34.
- **Long-title wrapping.** The header was only seen with a title that fits on
  one line; a 120-character title wrapping next to the two actions was not
  looked at.
