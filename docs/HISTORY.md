# History — archived milestone & status narrative

**Archive. Do not update.** This is the long-form running log that used to live
inline in `README.md` (Status section) and `PLAN.md` §15. It was moved here on
2026-09-18 so the entry-point docs stay small enough to load in an agent
context. It is kept verbatim for provenance (measurements, decisions, "what was
not verified" notes).

Where to look instead:

- **Current status & suites** → `README.md`.
- **Release notes** → `CHANGELOG.md`.
- **Milestone index** → `PLAN.md` §15.
- **Per-milestone spec** → `PLAN-M<N>.md`.
- **Verification records** → `docs/VERIFY-*.md`.
- **What is left / env-gated walks** → `docs/UNFINISHED.md`.

---

## Part 1 — README.md status log (as of 2026-09-18)

> Verbatim copy of the old `README.md` from its `## Status` heading to EOF.

## Status (2026-09-18)

M0–M29 implemented (PLAN.md §15). The current root suite is **1783
passed** (5 env-gated skips) · shared **90** · web **999** · typechecks 0 · web
build green. **M33 makes Memory's scope multi-select** (`PLAN.md` §15): a fact
can now be shared by several personas instead of "All personas or exactly one"
— `personaScopes: string[]` (empty = every persona) on the wire,
`profile_entries.persona_scopes` in the DB (schema **v24**, legacy rows
backfilled once), and one `ScopePicker` checkbox set behind the edit form, the
add form and the suggestion re-scope. **M32 reshapes the shell and memory** (`PLAN.md` §15): chat
sessions now live under **Personas** (with an Unassigned group), the Skills
**Catalog** is a Personas-style card deck with a detail drawer, the left menu
is drag-resizable (`partner.sideWidth`), the chat transcript no longer renders
an inline HTML preview as a sandboxed iframe, and Memory ties a pending
suggestion to a persona in one step while showing rejected facts in a
**Rejected** panel (the extractor receives them too, so it does not re-ask). **M29 lands the multi-user lifecycle** (`PLAN-M29.md`,
`docs/VERIFY-M29.md`): **sign out** that closes the partition (not just the
session), **owner-minted invitations from the app** (roles `owner`/`member`, key
access `own`/`shared`), **shared AI access** so an invited member chats and
searches without configuring a provider, **per-user file roots** under the
deployment volume, and **note/asset sharing** as snapshot copies in the system DB.
Schema **v23**. The **Skill Studio fixup** (+6 tests) closes four findings from a
live review of the Build segment — a template/blank draft could invalidate
itself on its first save, `Edit in Studio`/`Fork` opened the wrong draft, a
draft could not be created once one existed, and a failing test run reported
only `skill_error` — see **Skill Studio fixup** below.
**M28 lands the Flow canvas end to end** (`PLAN-M28.md`,
`docs/VERIFY-M28.md`): the Studio's fourth surface is a **React Flow** graph of
ten typed nodes — `input` · `const` · `tool` · `template` · `filter` · `map` ·
`branch` · `merge` · `llm` · `output` — where the model can **build** the graph
from a description, the user can draw it, and the model can **refine** what the
user drew as a **proposal with an accept/reject diff**, never a silent rewrite.
The load-bearing constraint held: a flow is **not a second kind of skill**. It
compiles **deterministically to `entry.mjs`** (same artifact, same sandbox, same
hash check, no interpreter), so every M26 install gate is unchanged; the
vocabulary is deliberately not a programming language (no loops, no arbitrary
expressions, no imports) and expressions are a validated **path grammar plus
eight fixed operators**, so an AI-written graph cannot inject code.
`permissions.tools` **and** `permissions.llm` are derived from the graph — the
consent summary provably matches the code, and an `llm` flow no longer installs
a manifest that refuses every model call. The canvas ships with an equivalent
**Nodes table** over the same document (every field editable, keyboard
reachable), because React Flow has no keyboard path to creating an edge; the
palette omits a node type the build cannot compile (the core says which, via
`llmAvailable` on the flow read). `skills.draft` accepts a `flow` payload
instead of `code` — the same tool, not a third one — so a persona can build a
graph from chat and the Studio opens it on the canvas. Two decisions taken
beyond the spec's letter, both recorded in the verification doc: staleness now
checks **both** sides of the last compile (a canvas save never touches `code`,
so a graph edited after a compile used to read fresh — the Studio would offer no
Recompile and an edited graph would install the previous behaviour), and the
bounded model call was extracted so five callers share one cap and one timeout.
The canvas was also **looked at**: two defects the frames found (a full-size
danger-toned Remove button on every node, and an 88px Id column in the Nodes
table) are fixed and re-framed. What is NOT verified: a live model walk for the
four AI verbs — no endpoint is configured here, so the deterministic answers and
the stubbed-reply paths are what ran. **M27 S4 lands the two Studio templates
that needed M27's new reaches** (PLAN-M27.md): *Checklist from your notes* reads
your notes through the app-scoped `notes.list` / `notes.search` / `notes.read`
tools — with **no `projectId` and no root**, since the grant is the once-only
*App data* consent beside your roots — and returns the markdown task items it
finds; *Calls an MCP server tool* calls one tool on a server you configured and
enabled, as `partner.tools.exec('mcp:<server>/<tool>', args)`, at the `medium`
ceiling an MCP-calling manifest must declare. Each template carries the
capability it needs (`notes` / `mcp`), and the picker's list is derived from
that: a build with a reach unwired does not offer its template, asserted in both
directions — including through the drafts door the picker actually calls. Both
bundles were held to a real run rather than a lint: the notes template goes
through a Studio **dry-run** in the real sandbox against a real granted note
(and reports the coded `tool_denied` refusal — queueing nothing — before the
grant), and the MCP template runs against a **local stdio server**. One honest
limit worth knowing: MCP server ids are generated when you add a server, so no
template can name yours — the MCP manifest ships a placeholder id, the single
field you replace before installing. **M27 S2 lands MCP reach from the skill
sandbox** (PLAN-M27.md): a manifest may declare `permissions.mcpServers`, and
the skill reaches one of that server's tools as
`partner.tools.exec('mcp:<server>/<tool>', args)`. Reach is declared per
**server**, never per tool name — a server is configured later, so a manifest
must not be able to name a tool that does not exist yet. Because an MCP tool's
own risk cannot be known in advance, a manifest declaring MCP must declare at
least **medium** risk, and a `low` one is refused when the draft is validated
rather than when it runs. Every failure is a **coded refusal** the skill can
catch (`mcp_not_declared`, `mcp_disabled`, `upstream`, `capability_denied`), and
**no approval is ever queued** — a skill cannot be asked anything, so the server
has to be enabled before the run, exactly as a root has to be granted before it.
The `mcp.call` envelope is checked **first**, above the declaration, so a phone
session learns nothing about what is configured behind it; that closes the MCP
half of the class gap M20-B S4 recorded against itself. An MCP call made from a
skill is now **attributed to the skill** in the audit log (and a persona's
auto-call to the persona) instead of to a web request nobody made — the
manager's call path takes the actor as an argument and still defaults to `web`
for the user's own session, so nothing else moved. The authoring prompt, the
chat instructions and the install summary now describe the reach from the same
capability object the validator reads, so none of them can promise something the
sandbox would refuse. **M28 slice B makes the graph walkable** (PLAN-M28.md) —
schema **v22** and the three routes that turn a flow into an installed skill,
with no canvas needed. `PUT /v1/skills/drafts/:id/flow` saves the graph:
structurally validated (every offender named, nothing written on a refusal) and
touching **no code** — a save is not a compile, so a half-drawn graph is exactly
as inert as any other draft. `POST …/flow/compile` is the **only** writer of
code from a flow: it emits `entry.mjs`, records `flow_sha256` +
`flow_compiled_at`, rewrites the manifest's permissions from the graph (**both**
`permissions.tools` and `permissions.llm` — deriving only the tools would leave
a flow with an `llm` node installing a manifest that refuses every model call, a
bundle that can never run), and re-runs the M26 validation; a flow that cannot
compile answers with its named error list and writes nothing. `flowStale` is
**derived on every read** (`sha256(code) !== flow_sha256`), never stored — a
hand-edit that restores the compiled bytes clears it by itself — and a stale
draft still installs and runs, because install consumes the code: staleness is
UI honesty, not a security state, and the test says so out loud so nobody later
blocks it. The compile also holds the graph to the **draft manifest's own
ceiling**: a `files.edit` node under a `low` manifest is refused
`tool_requires_medium` and writes nothing, where it used to compile into a
bundle that could never run. Until slice D builds it, `mode:'generate-flow'` on
the create route is **refused by name** rather than silently downgraded to
`mode:'generate'`. Both writes need `skill.author`, which is desktop-only by the
client-class envelope. Next: M28 **C** (the canvas + Nodes table), then **D**
(AI build/refine/from-code). **M28 slice A lands the Flow compiler**
(PLAN-M28.md) — the pure half of "build a skill on a canvas", pure (no UI, no
route — slice B adds the routes, slice C the canvas). A flow is a graph of ten
typed nodes that compiles **deterministically to the one artifact the sandbox
already loads**: same graph, byte-identical `entry.mjs`, which is what makes the
later staleness check a hash comparison instead of a flag. The compiler is
**total** — a cycle, a dangling edge, a missing `output`, two `input`s, an
unknown tool, an `llm` node in a build with no model reach are all named errors
emitted before a single byte of code — and the emitted module is **executed in
the tests**, both against a fake `partner` and inside the real M8 sandbox, where
a compiled flow reads a real note through the broker with zero roots registered.
Expressions are a validated **path grammar plus eight fixed operators**, never
emitted text: `__proto__`, `constructor`, `a..b` and `a);process.exit(1);//` are
refused, a hostile string that is not path-shaped passes through as inert data,
and a backtick or `${` in a template stays prose. `permissions.tools` and
`permissions.llm` are **derived from the graph**, so the consent summary cannot
drift from the code. The Studio was split first (owner decision, before the
canvas work): the 2025-line `SkillStudio.tsx` is now a 468-line container with
rail / empty state / editor / validation / run / install+confirm / actions in
`web/src/studio/*`, re-exported from the original module so no importer or test
moved, and with no CSS change at all. **M27 S1 lands app-scoped notes reach**
(PLAN-M27.md): a skill can now read **your notes**, and it does so with **no
project root at all**. `ToolScope` is `{kind:'project'} | {kind:'app'}`; three
read-only app tools (`notes.list` / `notes.search` / `notes.read`) resolve
against a reserved `APP_SCOPE_ID='app'` instead of a filesystem root, which is
what made a notes skill inexpressible before. Grants live in a new **App data**
group beside your roots (the two pickers are scope-filtered, so a root is never
offered a notes tool and vice versa), `POST /v1/grants {projectId:'app'}` is
accepted only for an app-scoped manifest and **refused for `files.read`** —
`app` can never become a root alias, and an app tool never consults the roots
manager. The three ids ride the **existing** `file.read` capability
deliberately: a new name would be absent from mobile's allowlist and would deny
a phone its own notes by construction. Audit rows carry ids, counts and lengths
only — a note body never reaches one. Model reach stays as S5 left it: **a skill
can call a model** — declared, bounded and gated — with `permissions.llm`
enabling `partner.llm.complete`, the skill's own `budget.maxTokens` finally
*doing* something (declared and validated since M8 and never read — `runner.ts`
used only `timeMs`), a mid-run `budget_exceeded` with the worker killed rather
than partial output, the provider spend ledger charged per call, and `skill.llm`
desktop-only. Because a skill can send what it read to your provider, the
install summary says so in plain words — and it no longer claims a token ceiling
for a skill that has no model reach at all. S3 closed the gap **M20-B S4
recorded against itself**: the session **client class** now reaches the runner
from the session row, so an already-granted write can no longer walk a phone
through the envelope — proven with `files.edit`, because the case that note
described is the *write* one (mobile's envelope already permits `file.read`, and
a test asserts it executes). **M27 is complete**: its last slice built the two
Studio templates above, and the only thing outstanding is an env-gated walk
against a real MCP server you configure. Next: **M28** (the Flow canvas; slice C
is the canvas + Nodes table over the schema v22 API that slice B shipped). **M26
lands skill authoring** (PLAN-M26.md, `docs/VERIFY-M26.md`): a skill can now be
*made*, not only installed from the checked-in catalog. A **draft** is an inert,
editable bundle held in the user's own encrypted DB (`skill_drafts`, schema v21)
— manifest text + entry source + the deterministic result of validating them.
You can describe the skill in **chat** (the partner stages a draft with
`skills.draft` and may *ask* to install it with `skills.requestInstall`), or
build it in the **Skill Studio** (describe it and a model drafts it, start from
a template, or write it by hand), then read the code, test-run it in the
sandbox, and install it. The milestone's line is **a model may write code and
ask, but only the owner makes it executable**: drafting runs nothing, validation
is deterministic (shape + broker registry + an entry lint, never execution), a
single `promote` is the only door into the skills store and it re-validates
first, and an update that **widens** permissions is refused until it is
acknowledged. Because approving an ask EXECUTES, the approval path is
class-checked as `skill.install`. `fork` copies a skill under a new id, `edit`
opens the installed id in place, and an unsigned bundle can be exported/imported
— an import always lands as a draft. The two Studio templates that needed a
reach no skill had yet (*notes*, *MCP*) shipped with **M27**: S1 (the app-scoped
notes tools), S2 (the sandbox's MCP reach) and **S4** (the two templates
themselves, 2026-09-17). The picker is capability-filtered so it only offers
what the build can honour. **M25 lets you reconfigure existing providers**: the
setup card gains a *Reconfigure existing* mode that rediscovers an endpoint's
models through the key your OS keychain already holds and reassigns which models
each purpose profile carries — no key re-entry, no delete-and-recreate. **M24
fixes attached photos never reaching the model** — the partner replied "I didn't
receive an image" for a model that reads it fine when tested directly against
LiteLLM. Capability is now *declared* per provider (`providers.vision_models`,
click a model chip on the provider card, or any model on a `vision` profile)
instead of guessed from the model id, images are encoded to the inline budget (3
MiB, published as `maxInlineImageBytes`) rather than the upload cap (8 MiB) so a
stored photo is also a sent one, and a turn can carry several photos instead of
one. M24's locally-green exit is recorded; the live walk against a real gateway
is still open (§15). An **M11 F12 follow-up** shows a fenced ```html code block
as a tabbed Code/Preview viewer (source and sandboxed result one flip apart, so
the message never doubles in height, and the preview pane is sized like a real
screen) in chat, the assets read view and the new note-editor preview toggle. An
**M19 follow-up** makes global (all-personas) fact detection a user-level
setting independent of each persona's private-memory tick. An **M19 follow-up**
reviews existing memory and pending suggestions in the extraction payload (a
bounded `ALREADY KNOWN` listing) so an already-known fact is not re-proposed —
and never files the same suggestion twice. Latest release: **v0.1.21** (the Flow
canvas — build a skill as a graph of ten typed nodes, with the model drafting
it, the user drawing it, and the model's changes arriving as a proposal you
accept or reject; a flow compiles deterministically into the same `entry.mjs`
every other draft installs, and a Nodes table edits every field of the same
document from the keyboard). It builds on **v0.1.20** (a skill can reach an MCP
server, and a flow has routes), which builds on **v0.1.19** (a flow compiles to
the sandbox's own artifact), which builds on **v0.1.18** (a skill can read your
notes, with no root at all), which builds on **v0.1.15** (memory that reviews
what is already known and pending before proposing, so an already-known fact is
never re-proposed in fresh wording; a fenced ```html block as a tabbed
Code/Preview viewer whose preview pane is sized like a real screen). It builds
on v0.1.14 (reconfigure existing providers — rediscover an endpoint's models
through the stored keychain key and reassign them per purpose, no
delete-and-recreate), which builds on v0.1.13 (inline HTML code-block previews
in chat, assets and notes; global auto-remember independent of the per-persona
toggle; the turn-model fallback so extraction never silently no-ops), which
builds on v0.1.12 (per-provider search keys, global auto-remember, and scorecard
ratings — on top of the silent-bind fix, hosted sign-up by invite, tap-outside
pane dismissal, the sidebar minimize toggle, the mobile phone-tier UI, persona
picker, top-bar chrome, note projects, chat multi-question forms, persona-scoped
memory). **M20 is partly done**: **M20.A (mobile/tablet UI) is implemented and
measured**, **M20.B (server role) has landed through S7 + S9** (the capability
envelope, networked pairing, per-user partitions) with **S8 (Vault/Runner) not
started**, **M21 (container + Cloudflare Tunnel) is live-verified** and **M22
(hosted accounts + deployment-owned files) is container-verified** — see their
sections below.

**M20.A — mobile/tablet UI (2026-09-12, implemented + measured).** The phone
tier is now usable: a bottom tab bar (Chat · Notes · Files · Personas · More)
with a More sheet, rails as overlays instead of columns, and a full-width
transcript and composer. Measured at 390px: permanent chrome **252px→0**,
transcript **122→390px**, controls under 44×44 **11→0** (the conversation delete
action was a **1×19** target). Tablet (768/1024) geometry is byte-identical to
before, so the pass is additive. The phone nav is driven by a testable model
(`web/src/lib/nav.ts`) that asserts every view stays reachable, and the touch
profile adds `--target-min` / safe-area / `dvh` tokens **without changing any
existing token value**.

**M20.A follow-up (same session).** Measuring corrected an earlier claim of
mine: "composer 326px" was the *container* — the **message field** was still
**49px** because the `＋ Attach` and `Send` text buttons took 214px of the row.
It is now **222px (62%)** with icon-only 44px controls and a 16px phone gutter.
**Persona cards** fell from 584px to **340px** (~2.5 per screen) with the action
set on its own full-width row, and their sub-44px controls went **52→0**. And
**attention badges** ship: memory suggestions were previously visible only by
opening Memory and reading a header, so a suggestion could sit unconfirmed
indefinitely. `web/src/lib/attention.ts` (+18 tests) defines "waiting on you"
once across destinations, and the phone **More tab carries the aggregate** of
everything the sheet hides — a badge inside a closed sheet is invisible.
Verified end to end: badge `3` → reject one → `2`, immediately. Two rules
recorded: **a badge must be able to clear itself** (failed scheduled runs
self-clear on a 24h window, since they have no dismiss action), and `queued`
runs are excluded everywhere because a paused run *is* the pending approval.

**M20.A follow-up 2 — Memory view (same session).** The Memory view had the same
flex-crush bug in three places and had been **missed by M12's legibility pass**.
The Memory controls card ran **1483px** with the copy column crushed to **9–11px
— one character per line** (the Import row was 411px tall), because
`.mem-control-text` is `flex: 1; min-width: 0` and `min-width: 0` lets a flex
item shrink *below* min-content, so the row never wrapped. Entry rows were
worse: a 42-character entry rendered a **20px value column 399px tall**.
**Suggestions** failed for a different reason — **112px of nested padding per
side (57% of a 390px viewport)** left a 135px measure, which is also why
Confirm/Edit/Reject stacked into a 148px column per suggestion. Now one 16px
gutter per level: measure 135→**263px**, a suggestion 450-471→**293px**, copy
and chips 12→**14px**, and the whole view **5436→4075px (−25%)** while the text
measure nearly doubles. Sub-44px controls **12→0**.

Two things recorded rather than silently accepted: `--danger` on the light card
surface passes at **Lc 75.42** against a floor of 75 (thin — it fails first if
either token is retuned), and **"Forget everything" was the first row of the
controls card**, putting the most irreversible action in the most prominent
position above the Export a cautious user reaches for. The order is now **Export
→ Import → Forget before a date → Forget everything** (portability first,
destructive last, severity escalating, separated by space), verified rendered in
a browser.

**Applied recommendations (2026-09-12, same session).**

- **The live security hole is closed.** Core-served `text/html` executed on the
  SPA's own origin, where the session token lives — `nosniff` does not stop an
  explicitly declared `text/html`, and the realistic trigger is the partner
  generating an HTML/CSS prototype that the user opens. One exported policy
  (`attachmentContentHeaders()`) now keeps only images and PDF `inline` and
  forces everything else to `attachment` **plus `Content-Security-Policy:
  sandbox`**. HTML upload is unchanged (the model legitimately reads attached
  HTML) and `CodePreview`'s sandboxed path still previews it. No SPA regression:
  the app fetches attachment bytes with a Bearer header and `fetch()` ignores
  `Content-Disposition`, so only direct navigation changes. 8 new tests; root
  suite **893 → 901**.
- **`.preview-frame`'s `#ffffff` tokenised** as `--surface-doc`, so the
  stylesheet has **no raw hex in any declaration**. Deliberately mode-invariant:
  the sandboxed preview renders a document authored against a white canvas.
- **Two of my own claims corrected.** There was never a touch re-filing gap —
  `.rail-item-move` is a `<select aria-label="Move … to folder">`, measured
  66×44, so I built nothing for it. And the `--rail-action-w` token I suggested
  was a bad idea: that width is label-driven, so a token would be false
  systemisation rather than a fix.

**M20.A follow-up 6 — one submit per question set (grouped answers).** A
reported bug: a reply carrying a radio/choice **and** a set of free-text
questions rendered two cards with two independent submits — **"Confirm"** and
**"Submit answers"** — and pressing either sent only its own answer, silently
discarding the other. The cause was structural: each card owned its submit, and
nothing existed at the *message* level, the only level that can see two
containers were asked in one breath. `web/src/lib/answer-group.ts` (pure, 15
tests) now owns that rule, and `AnswerGroup.tsx` owns the single submit; the
cards render inputs only and report their answers upward. The composed message
joins each part with the exact string that card would have sent alone, so
nothing on the wire changes except that the answers arrive **together**. A
grouped form requires every question, the disabled state always names what it is
waiting for ("2 answers still needed"), and the group locks after sending so one
prominent button cannot double-post.

**Verified through the real chat path** — the demo provider cannot emit
containers, so a throwaway loopback OpenAI-compatible stub returned a choice +
form and was registered as a provider: **1 group · exactly 1 submit · 0 per-card
submits**, the gate walking disabled→disabled→disabled→enabled (hints `2 → 1 → 1
→ none`), and the single press producing **one** user turn containing **both**
the choice and the Q/A pairs.

*Open:* the answered-lock is now **transcript-derived**, so it survives a
reload, a different device and cleared storage — and, deliberately, a group in
an earlier reply is inert ("Closed") while only the newest is live. Scope note:
that lock applies to **grouped** answers only; a standalone card in history is
still clickable, which is a separate decision.

**The subagent wave (2026-09-12).** A scout + three writers + a fresh-context
reviewer ran against the M20.A follow-ups and M20.B's scoping. Verified
outcomes:

- **Answered-lock fix**: derives from **transcript position**
  (`isGroupLive(rowIndex, rows.length)`), so it is durable without persisting
  anything — proven in a browser: after a full reload the states are identical
  (`Closed` / `Send answers`) with only `partner.token` + the theme in storage.
- **Contrast sweep**: **16 selectors** with light-mode `--danger` on a
  `--surface-2` well at **Lc 69.52** (below the 75 floor) now rest on `--bg` →
  **80.88**. The gate then found two more pre-existing chip defects, both fixed:
  `.attach-chip-preview` accent on a well (**69.02** → `--accent-hover`
  **77.08**) and `.attach-chip-meta` `--text-faint` (**68.86** → `--text-muted`
  **81.40**).
- **Two MAJOR defects the reviewer caught that I had missed**:
  `.answer-group-parts` had **no CSS rule** (question sets rendered with 0px
  separation), and **no test rendered `AnswerGroup`** — deleting
  `showSubmit={false}` would have restored the original two-submit bug with the
  whole suite green. Both fixed; the new render test was then **falsified** (2
  tests fail when the regression is injected).
- **A lane failed and is recorded as such**: the first danger sweep ran 50s and
  returned a review of a different lane, editing nothing — a forked worker
  continuing the parent's transcript. Retried with `context: 'fresh'`.
- Security regression guards: `web/test/security-guards.test.ts`, 19 guards with
  a non-vacuity proof.

`ux_audit` PASSED on all passes; root **901** · web **619** · typechecks 0 ·
build green. Lane outcomes, arbitration and the explicitly-unverified list:
`docs/VERIFY-MOBILE.md`.

**All M20 gates are closed (2026-09-12).** Every open decision now carries a
choice with its consequence stated — `PLAN-M20.md` §11 (D1–D5) + §12 (Q1–Q12),
execution detail in `PLAN-M20-B.md` §6. Four are marked ⚠ because their cost
lands on how the product is *used*, not just how it is built: **D5** the Runner
must be a machine the user owns (no shared VPS in v1 — the product assumes an
always-on device); **Q2** user creation is local-only (a remote owner cannot add
someone); **Q4** a mesh VPN is the supported path, with cert-fingerprint pinning
on the LAN fallback (which is explicitly lower-assurance); **Q11** un-drained
Runner results are expendable. Also decided: briefcases are tag-selected with
**enforced** caps (≤ 20 items / ≤ 256 KB / ≤ 24 h TTL); the drain is
**append-only** (a headless run can never rewrite your notes); the per-user
layout uses **N rails**, so cross-user reads are structurally impossible rather
than dependent on every call site; `users` + `pairings` + `sessions` live in a
**system DB** with today's `data/partner.db` treated as user #0 (existing
installs do not move); and the extension class is read + browser + chat only.

**The reviewer's deferred nits are cleared too**, not carried: the guards file's
duplicated allowlist (lifted behind a shared `declaredPartnerKeys()` — which
caught a `/^partner./` vs `/^partner\./` regex bug introduced during that very
edit), the unbounded `<ReactMarkdown` slice (now brace-depth-bounded, strictly
stronger), the wrong `strip`/`clobber` rationale, and two false "no DOM harness"
premises. The storage census's blind spot is narrowed and precisely stated:
inline key literals passed to storage calls are covered, a key held in a
*variable* is not, and the code says so.

**M20.A follow-up — the phone persona picker, and one home for the chrome
(2026-09-13).** Two reported defects, both measured before and after. **(1)**
The persona list was unusable on a phone while looking fine in the DOM: the top
bar is a horizontal scroller, and `overflow-x: auto` forces `overflow-y: auto`,
so the absolutely positioned popover laid out 655px tall but painted only inside
the bar's **60px** band (**1 of 9** personas), and the open-time focus scrolled
the bar itself up 65px, taking the trigger off screen. At ≤640 the list is now
the same bottom sheet as the More control (fixed, anchored on the tab bar,
capped and scrollable, 71px rows), and the base popover gained a height bound so
a landscape phone (844×390) can reach its tail. **(2)** "Assets" existed
**three** times and the per-conversation theme select twice; by the owner's
criterion (*maximise chat input width* — phone input is 222px either way,
desktop loses **316px of 682** when the pane opens, and only the ungated top-bar
icon could open it with nothing to show) and then by direct instruction, **both
controls now live in the top bar** and the row above the composer keeps only
brainstorm state and the save flash, rendering only when it has content.
Measured after: phone transcript **513 → 565px**, six top-bar controls in 358px
with **no scroll**, theme bind ("Midnight") surviving a reload. Guards in
`web/test/picker-mobile.test.ts` and `web/test/assets-lane-controls.test.ts`,
both falsified against a reverted fix. *Still open (measured, not started):* the
phone **Notes** view spends its whole first screen on controls (toolbar 235px in
5 wrapped rows, scope bar 128px, the search field **405px below the fold**, 3
controls under the 44px floor) — see `PLAN-M20.md`.

**M20.A follow-up 9 — tap outside a floating pane to put it away (2026-09-14).**
Reported as a product gap: on a touch tier the panes *are* overlays, so the only
way back to the transcript was the toggle that had opened them — measured, the
open rail covers **320 of 390px** and those toggles live in a horizontally
scrolling top bar. Touch has no Escape key, so tapping the content you can see
did nothing; now it dismisses the pane, and the pane **slides out to its own
edge** before its state closes (frame trace 0 → −83 → −204 → −273 → −306 →
−319px over 180ms = `--motion-base`). The scrim is scoped to the workspace so
the top-bar toggles stay live and undimmed, the desktop column model is
untouched (**0** scrims at 1280, a click closes nothing), floating panes can no
longer even overlap at the phone tier (they overlapped by **202px**), and a
reduced-motion preference closes at once. Decision + tiers in
`web/src/lib/panels.ts`; guards in `web/test/panels.test.ts` (+16), falsified.
Web suite **673 → 689**; `ux_audit` PASSED; measurements in
`docs/VERIFY-MOBILE.md`.

**M20.A follow-up 10 — the sidebar minimize toggle, tablet AND desktop
(2026-09-14).** Requested: *"for tablet view/desktop view, allow minimizing the
side menu to icons only, so that when toggled, we can maximize usable view."*
M12 already collapsed the sidebar automatically below 1150px, so the labelled
224px menu survived on every wider viewport with no control to recover the space
— and an iPad in landscape reports >1150 CSS px, which is why both tiers needed
it. The rail is now a **state** (`.app.side-minimized`, one `--side-w` knob)
that the tablet query only defaults: measured @1440×900 the sidebar goes **224 →
60px** and the content column **1216 → 1380px** (the 164px returned to the
view), and at 1024 the default is the rail with the toggle able to restore a
200px labelled menu. The **attention badge survives** collapse on the button's
corner (verified with a real attention item: 24×28, inside both the 44px button
and the 60px rail) — the old automatic rail hid badges at ≤1150, which is the
exact failure M20.A shipped badges to prevent. The toggle lives inside the
sidebar (the phone tier hides it, so it can never be a dead control), keeps the
44px touch floor, remembers the choice per session, and crossing into the tablet
tier collapses once instead of fighting the user. Guards in
`web/test/sidebar-collapse.test.ts` (+10), falsified four ways. Web suite **689
→ 699**; `ux_audit` PASSED; measurements in `docs/VERIFY-MOBILE.md`.

**M30 — one left panel: conversations under the Chat entry.** The conversation
list and its folder tree no longer occupy a second rail column beside the
transcript; they live in the sidebar, nested under the Chat destination, with a
disclosure chevron separating "open Chat" from "show/hide the tree". Above the
phone tier this is the only home for the tree, so the transcript reclaims the
rail's width; at the phone tier the sidebar is hidden, so the same
`ConversationRail` still renders as the floating overlay opened from the top
bar. Folder create/rename/delete and drag-to-move are unchanged — the new
`embedded` prop only drops the fixed 288px column width. `railWidth` is retired
from browser storage (the tree fills the sidebar); DESIGN.md's responsive table
was updated and `one-left-panel.test.ts` (+12) guards the one definition, the two
render sites and the phone overlay. Web suite green (57 files / 956 tests);
typecheck 0; bundle green.

**M31 — Settings, persona cards, and a magazine Notes & Plans.** Three requested
changes in one pass. The sidebar now groups the configuration surfaces
(Providers, Themes, Audit, Members) under a single **Settings** group, with
Studio recast as personas/skills/playbooks and Tools as files/memory. Personas
became a wall of business cards: the card face opens a slide-out editor drawer
holding every editable detail (including the theme bind), while Pause — the kill
switch — and Delete stay on the card; one editor instance, Escape and the scrim
to close. Notes & Plans got a magazine layout: a masthead (folio, `--fs-xxl`
title, deck), hairline section rules, a 1200px measure (1360px at ≥1600px), and a
river of entries with the newest as a full-width lead; the note editor and plan
planner keep their surface. `m31-redesign.test.ts` (+11) and a new `nav.test.ts`
case pin the structure and geometry. Web suite green (58 files / 967 tests);
typecheck 0; bundle green; checked in-browser at 1440 and 1024.

**M32 — persona-owned sessions, a resizable menu, a Catalog deck, and tracked
memory.** Four requested changes in one UI pass. The conversation/session tree
moved out of the Chat entry and under **Personas** — each persona is a
disclosure listing its chats (`PersonaChatTree`; a chat whose persona is gone
stays visible under **Unassigned**), while Chat stays a destination plus a
`New chat` action and the phone overlay keeps `ConversationRail`. The Skills
**Catalog** segment became a Personas-style card deck whose card face opens a
slide-out detail drawer (`CatalogDrawer`, reusing the persona deck/drawer
classes). The left menu is drag-resizable through the shared `ColumnDivider`
(180–420px, `partner.sideWidth` per session; a dragged width applies only while
the menu is expanded, so the 60px icon rail is never overridden). Memory now
ties a pending suggestion to a persona in one step, shows rejected facts in a
collapsed **Rejected** panel with Restore, and feeds the extractor a same-scope
`REJECTED` block alongside `ALREADY KNOWN` so a declined fact is not re-asked
even reworded. Finally, the chat transcript no longer flips a fenced HTML/CSS
block into an inline sandboxed iframe (Notes/Assets keep previews; chat renders
code). No schema change. New/updated guards: `one-left-panel.test.ts`,
`persona-chat-tree.test.ts`, `skills-catalog-view.test.tsx`,
`sidebar-collapse.test.ts`, `markdown.test.ts`, `remember.test.ts`. Web suite
green (60 files / 979 tests); core remember green; typecheck 0; bundle green;
checked in-browser at 1440.

**M33 — multi-persona memory scope (DONE).** Memory's "Applies to" offered All
personas **or exactly one** persona; it now offers All personas **or any set**.
`ProfileEntry.personaScopes: string[]` replaces `personaScope` (EMPTY = every
persona; one id = private; two or more = exactly those), and tailoring,
auto-remember's known/rejected/dedupe listing and
`GET /v1/memory/profile?personaScope=` all read it as membership — so a fact
shared by two personas is honored by each of them and by no one else. The
deprecated single field is still accepted on input (add/update/import, and a
pre-M33 `memory/v1` bundle), mapped to `[id]`/`[]`, so an upgrade never silently
widens a persona-private fact. Schema **v23 → v24** adds
`profile_entries.persona_scopes` (JSON id array, `NULL` = global); the one open
that crosses v24 backfills each legacy `persona_scope` into a one-element array
and never runs again. The three scope selects became ONE `ScopePicker` checkbox
set — "All personas" IS the empty set, unticking the last persona returns to it,
and a persona the local list no longer has stays ticked as **Removed persona** so
opening a fact cannot widen it; the pending suggestion's control is a `Change`
disclosure whose open state survives the write. Guards:
`memory-scope-picker.test.ts` (+12), `memory-helpers.test.ts` (+8),
`memory-api.test.ts` (+2), core `profile`/`tailor`/`transfer`/`remember`
`memoryRoutes`/`db-migrate` (+16). Web suite green (61 files / 999 tests); core
162 files / 1633 passed (5 env-gated skips); typecheck 0; bundle green;
`ux_audit` green (light + dark); checked in-browser against a demo core (a
shared scope saved and re-read after a full reload, the suggestion re-scoped in
place, widening back to All personas showing **In use**, and 10/10 options at
44px on a 390px viewport with zero overflow).

**M20.B is executable** — `PLAN-M20-B.md` §3–§5 has the slices, the tests to
write first, the parallelization waves, and a recommended first slice. **Its
first wave landed 2026-09-12:** S1 per-user partition, S2/S2a `users` +
`user_credentials` in a second encrypted system DB with scrypt credentials, S3
session widening + rotation/revoke, and the pure primitives for S4/S6/S7. Schema
v16 → **v18**; root suite 901 → **1066**. Record: `docs/VERIFY-M20-B.md`.

**The review caught a data-loss bug before anyone hit it.** The plan asserted
that an existing `data/partner.db` stays as user #0's partition, and no code did
it — an install booting with `USER_ID=0` would have opened an *empty* database
under a new key and orphaned the real data, silently. Now a single
`LEGACY_USER_ID` constant (which `FIRST_USER_ID` derives from, so they cannot
drift) maps that user to the legacy path, skills dir and `db-key` account. The
same pass also fixed wildcard SANs not matching (which would have refused every
real Let's Encrypt/mesh certificate), a fail-open host check, a mobile
capability set that held three indirect routes to denied powers, a credential
timing oracle, and a partition close/open race.

**Critical caveat: nothing from that wave is wired yet.** The users/credentials
work is not called by `createCore`, the six primitives are unused, and
`/v1/pair` mints exactly as before with `user_id` NULL — so **no new control is
in force**. Remaining: S4 wiring (the next recommended step), S5 devices, S6
wiring, S7 wiring, S8, S9.

**M20.B second wave — S4/S5/S6 WIRING (2026-09-12).** The envelope now
**enforces**: 21 route mounts, `clientClass` on the broker's `ExecContext`, and
the refusal ordered **before** the grant check; the device registry (list /
revoke / revoke-all, 404-not-403 across users, no token material on the wire);
and the transport matrix (`REMOTE_ACCESS` + TLS files + a named `ALLOWED_HOSTS`
and an https listener, with `startServer` re-asserting the refusal). Root suite
1066 → **1109**.

The adversarial review found **three blockers — the envelope was bypassable
three ways** — all fixed: the **approval queue** (`decide` took an actor label,
not a class, so a mobile session could approve a queued write and have it run);
the **persona/skill/playbook tool loops**, which reached the broker class-less
so a mobile *chat turn* executed with desktop authority; and **MCP server
CRUD**, which was ungated while an enabled MCP server is **spawned as a
process** — code execution, which I had underestimated. Also fixed: the S5
transitional rule let a user-less session read **and revoke a named user's
devices** (now scoped to `user_id IS NULL`).

**M20.B third wave — S7 WIRING (2026-09-13): a real phone can now obtain a
session.** The three S7 modules (`pairSecret.ts`, `rateLimit.ts`,
`pairPayload.ts`) were pure and unused; they are now wired. `POST
/v1/pair/payload` issues a 256-bit single-use secret **to a loopback caller
only** (and refuses without remote access + TLS, so no secret is ever carried
over plaintext); `POST /v1/pair` accepts `{secret}` from anywhere and mints a
**`mobile`** session — never `desktop` — while `{code}` is refused from a
non-loopback **socket peer** *before* it is verified, so a remote caller can
neither consume nor lock the code on the user's screen. Locality is the peer
address, not the `Host` header (§2.1 already reclassified that as a lookup key).
Both paths are rate-limited per peer, and a successful pair resets the bucket.

The client half ships too: the SPA reads a `#pair=…` fragment, **re-validates**
the payload itself (https only, canonical 32-byte base64url — the value arrives
from a QR code, i.e. from outside), confirms once, stores the token and clears
the fragment (the secret is in the fragment, never the query string, so it does
not reach the core's log or any proxy). The Providers screen has a **Phone &
tablet access** card that issues the link; it is action-driven, because minting
on mount would create a live secret on every render.

Root suite 1109 → **1131**, web 619 → **638**, typechecks 0, build green,
`ux_audit` **PASSED** (24 pairs, light + dark), geometry measured in a real
browser at 1280/390 in both modes (no overflow, 0 controls < 44px, copy 73
chars/line). **The audit also exposed a pre-existing defect, now fixed:**
`.field::placeholder` used `--text-faint` (Lc 68.86 light / 48.02 dark, below
the 75 floor) — placeholders are instructive text, so they now use
`--text-muted` and `DESIGN.md` reserves `--text-faint` for **disabled** text.

**Not done, stated rather than implied:** no QR encoder (the link is shown as
text); no real phone/TLS/mesh walk (env-gated); issuing a link is loopback-only,
so a deployment with remote access on needs a local loopback route to the
allowlisted host (a hosts-file alias keeps the certificate valid while making
the socket loopback — the UI says this in plain words); the shell-side "copy
pairing link" and the §12 Q1 consent screen are still to build. Remaining:
**S8** (Vault/Runner), **S9** (per-user unlock), plus the recorded vocabulary
gap (provider key writes and autonomous firing have no capability name — a
reviewed decision, not tidy-up). Record: `docs/VERIFY-M20-B.md`.

**M21 — container deployment + Cloudflare Tunnel (2026-09-13,
container-verified).** Partner now runs **headless in a container, in LIVE
mode**, reachable only through a Cloudflare Tunnel: no published port, no
inbound rule, no certificate to renew. `docker/server/` holds the live image
(non-root, S6 remote matrix: `REMOTE_ACCESS` + TLS + a named `ALLOWED_HOSTS`), a
two-service compose, stage scripts that also generate the origin certificate,
and three container-side Node tools (`healthcheck`, `pair-link`,
`partner-request`). The first-run flow is `docker compose exec partner node
tools/pair-link.mjs` → open the printed `https://…/#pair=…` link.

Two things had to change in the core. **(1) A `file` keychain kind**
(`KEYCHAIN_KIND=file` + `KEYCHAIN_FILE`): live mode refuses to run with the
in-memory fake keychain (the key would vanish on restart) and the native
keychain needs an OS keyring daemon a container does not have, so a container
had no way to keep a database at all. The file kind is JSON, 0600, atomic and
serialised writes, and a **malformed file refuses the boot** rather than minting
a fresh key beside an existing database. It co-locates the cipher key with the
volume it protects, so it is documented as protection against a copied DB or a
backup — not against a reader of the volume; `native` stays the default wherever
a keyring exists, and **one core per volume**. **(2) `KEYCHAIN_KIND` now
validates**: an unknown value used to silently mean `native`, which in a
container is a keyring-daemon error instead of a configuration error.

**The topology is a security property, not a wiring preference.** The tunnel
sidecar keeps its **own network namespace**, because the pairing routes decide
by *socket peer* (M20-B S7). Sharing the core's namespace would make every
internet request look loopback, and an anonymous visitor could then mint a
pairing secret via `/v1/pair/payload` and trade it for a session. So the compose
publishes no port, keeps two namespaces, and pairing runs through `compose exec`
— shell access to the container is the operator's proof of being "at the
machine". A consequence worth stating plainly: **a `desktop` session is
unreachable in this shape**, so the device pairs as **`mobile`**
(chat/read/notes/memory/personas/schedules/provider setup work; file write,
roots/grants, deploy and skill install are refused by class). Elevating an
operator-issued secret to `desktop` is the coherent follow-up and a reviewed
capability decision, deliberately not taken here.

Measured in a real container: LIVE boot (`demo=off`, schema v18), `healthy`, SPA
served, a non-loopback peer redeems a secret for a `mobile` session while
`/v1/pair/payload` and `{code}` stay `403 loopback_required`, the minted session
**survives a container restart** (volume + file key), the database's first bytes
are ciphertext, and `/data/keychain.json` is `0600`.

**Live deployment check (2026-09-13, `partner.teliti.app`) — and it found a
blocker the suite had certified.** Over the user's real tunnel: the SPA served,
the live gate rendered, a `compose exec`-minted link paired a browser, the
session came back `clientClass: "mobile"` (a `POST /v1/roots` probe was refused
by class), and an authenticated read (9 persona cards) worked. But the **first**
thing the check hit was `"This link is missing a valid certificate fingerprint"`
— for a payload the core had just built. `web/src/lib/pair-link.ts` validated
the fingerprint/secret by decoding to **text** and comparing the character count
to 32; the core issues 32 crypto-**random bytes**, which decode to ~28 UTF-8
characters, so *every* genuine pairing link was refused. The unit tests missed
it because their fixtures were ASCII filler (`'x'.repeat(32)`), which satisfies
both readings — 14 green tests proved nothing. Fixed to count **bytes**,
fixtures replaced with `randomBytes(32)`, and the missing seam test added:
`tests/pair-payload-agreement.test.ts` (core builds → browser accepts, 25 random
samples, plus agreement on refusals). Both fixes falsified by injection. A
second defect the same check found: a link pasted into an already-open tab did
nothing (fragment-only navigation does not remount the SPA) — `PairGate` now
re-reads on `hashchange`.

Root **1166** · web **639** · typechecks 0 · build green. The Cloudflare edge
leg is now verified too; a handset walk remains (`stage.ps1` was added to the
verified list on 2026-09-18 — it needed an encoding fix before it would parse on
Windows PowerShell 5.1). Record: `docs/VERIFY-M21.md`, spec `PLAN-M21.md`.

**M22 — remote-hosted accounts, deployment-owned files, no llm-self-service
(2026-09-13, container-verified).** Three changes for the hosted shape.

**(1) Pairing is replaced by user login.** `AUTH_MODE=login` makes `POST
/v1/auth/session` the only way in: a per-user passphrase (scrypt, in the system
DB, never stored) mints a session that **carries `user_id`**, so authorization
has an identity to work with instead of inferring one from proximity. A wrong
password and an unknown username are indistinguishable, three failures lock the
credential for five minutes, and a per-peer rate limit sits on top — behind a
tunnel every request shares one peer address, so the lockout alone would let one
actor lock the owner out. **The entire pairing lane answers 403 in this mode**
(`/v1/pair`, `/v1/pair/payload`, `/v1/device`, the demo seam). Accounts are
managed by the operator CLI — `docker compose exec partner node tools/user.mjs
add|passwd|list|lock-account|unlock-account` — because shell access to the
container is the "at the machine" proof, and **one user per core is enforced**
until per-user partitions (S1/S8/S9) land: two accounts would share one
database. The desktop pairing shape is untouched.

**(2) The deployment owns the file roots.** `FIXED_ROOTS=/files` registers the
mounted volume at boot (idempotently — grants reference a root by id, so a
second boot must reuse the row) and `POST`/`DELETE /v1/roots` answer `403
roots_fixed`; the Files view renders the list read-only. A configured path that
is not a directory fails the boot by name instead of leaving the tools with
nothing.

**(3) llm-self-service is gone** from core, web and `shared` — routes, the
page-side RSA envelope, the demo double, the Providers card. Provider setup is a
base URL + key. The `'llm-self-service'` `ProviderSource` value stays so
provider rows written by an older install still read; nothing creates one. That
also closes **S0** (the companion endpoints in the other repo) as obsolete.

**Verified in the user's own container through the tunnel:** the account was
created by the CLI, sign-in returned a `desktop` session, `/v1/roots` was
read-only, and a brokered write into `/files` completed proposal → approval →
file on the mounted volume. The login gate was walked in a browser (both fields,
submit disabled until filled, sign-in → workspace, only token/theme/authMode in
storage). Four defects surfaced and were fixed on the way — a container CLI that
started a second core, a reused certificate for the wrong hostname, "Pair again"
copy inside a login-mode app, and error responses showing machine codes
(`invalid_input`) instead of sentences. Root 1166 → **1184**, web 639 → **635**,
typechecks 0, build green. Record: `docs/VERIFY-M22.md`; spec `PLAN-M22.md`.

**M22 R-slice — the recommendations, built (R1–R4, R6–R9; R5 skipped by
request).** The headline is **R1, per-user partitions**: a partition IS a
single-user core (its own whole-file-encrypted database, its own cipher key
`db-key:<id>`, its own skills directory), built by `core/src/users/rails.ts` and
handed requests by a listening app that authenticates against the **shared**
system sessions and **delegates** everything else. That is why not one of the
~200 routes changed — and why "a query cannot cross users" is structural rather
than a filter someone has to remember. Two users are provably isolated in
`core/test/http/ userPartitions.test.ts` (real sign-ins, two encrypted files,
neither read containing the other's rows, separate keys, per-user audit). The
**first account owns the pre-partition database**, so an install that ran
single-user keeps its history, and a boot guard refuses to start when a legacy
database has no user to own it rather than orphaning it.

Also landed: **R2** rotation revokes that user's sessions; **R3**
`PARTITION_IDLE_MS` closes idle partitions (memory hygiene — the file keychain
still holds the key, and the docs say so); **R4** `CLIENT_IP_HEADER` +
`TRUSTED_PROXY_CIDRS` give per-client auth rate limiting, believed only from a
trusted peer and never used to decide locality; **R6** `FIXED_ROOTS_READ_ONLY`;
**R7** `MAX_UPLOAD_BYTES` / `MAX_JSON_BYTES` — with the upload cap now genuinely
reachable: the file bytes ARE the body (content type = mime, `x-attachment-name`
= name), `/v1/health` publishes `maxUploadBytes`, and the 413 names the file,
its size and the limit. Until 2026-09-14 uploads rode a base64 JSON envelope and
were really capped at ~768 KiB by the 1 MiB JSON limit, which refused iPhone
photos with a bare `payload_too_large` (`docs/VERIFY-M22.md`); **R8** a
**verified** backup tool (`tools/backup.mjs`: `VACUUM INTO` snapshots of the
system DB and every partition, re-opened with the copied keychain +
`integrity_check`, prunes to `--keep`, exits non-zero when it cannot verify — a
half-backup is never reported as one); and **R9**, the recorded vocabulary gap
closed (`provider.configure`, `persona.run`, both denied to mobile/extension by
the envelope table). Root **1204**, web 635, typechecks 0, build green.

**PLAN-M20-B S1 and S9 (same session).** **S1** (per-user partitions) is
verified end to end — the rails are the caller its modules were missing: two
users, two encrypted files, per-user keys, audit and skills, an LRU bound with
idle close, and the first user keeps the pre-partition database (a boot guard
refuses to orphan it). **S9** makes the hosted promise real: schema **v19** adds
`key_wraps` and `users.keep_unlocked`; at first sign-in the partition key is
**wrapped under the passphrase** — AES-256-GCM under a key with its own salt and
HKDF domain separation, so the stored credential verifier cannot unwrap it (that
attack is a test) — and the plaintext is **removed** from the keychain. A
signed-out user's partition then answers `401 unauthorized / partition_locked`
**even while their session is still valid**, signing in again re-opens it, and
closing a partition drops the SQLite handle (an open handle would keep decrypted
pages cached). The per-user, audited `keep-unlocked` opt-in is the stated
exception — their schedules may run with nobody signed in — and `passwd` refuses
to orphan a wrapped key unless `--reset` is passed. Root **1215**, web 635,
typechecks 0. Record: `docs/VERIFY-M22.md`.

**M22 sign-up — the invite lane (2026-09-14).** The operator CLI meant the
operator typed every account's passphrase, so a hosted core started with
credentials someone else had seen. `SIGNUP_MODE=invite` (default **off**; needs
`AUTH_MODE=login`) now lets a person create their OWN account: the operator
mints a 256-bit **single-use** invite on the machine (`docker compose exec
partner node tools/signup-link.mjs` → `https://<host>/#signup=<code>`) and sends
the link; the person picks their name and passphrase, lands signed in, and gets
their own encrypted partition. The mint route is **loopback-only** (the same
"shell access = at the machine" proof as pairing), the code is consumed by
exactly one account, the shape checks run **before** the code is spent (a typo
must not burn an invite), a taken name is a 409, and neither the name nor the
passphrase reaches a response or an audit row. Names and passphrases are
validated by one shared rule set (`shared/src/accounts.ts`), so the browser
cannot promise what the core refuses. **There is deliberately no `open` mode** —
a hostname the internet reaches is reachable by anyone, and the operator's
invite is the admission decision. The browser walk found and fixed a real bug on
the way: a link opened in a **fresh tab** rendered the form with an empty code
field (only the paste-into-an-open-tab path seeded it), so the person who
followed the instructions literally got a form that could never submit. Root
**1227 → 1254**, web **699 → 712**. Record: `docs/VERIFY-M22.md`; spec
`PLAN-M22.md`.

**S8 (Vault/Runner tier split) is NOT done** — deliberately. Role isolation and
briefcase caps are a boundary where a half-implementation is worse than none
(the slice's first test is "a runner bundle cannot open `vault.db`, asserted by
attempting every Tier C op"). The plan stands as written in `PLAN-M20-B.md` §S8.

**The Windows `userPartitions` failure was two real defects, both fixed
(2026-09-15).** Every `verify (windows)` run had been failing five partition
tests while `verify (linux)` passed, and the local suite reproduced it — the
symptom was `TypeError: Cannot read properties of null (reading 'port')` in the
test's own boot helper. The cause was **not** the isolation code:

1. **`listen()` resolved a core that was never listening.** On Windows,
   `app.listen(port, host, callback)` invokes that callback *even when the bind
   failed*, and readiness was taken from it — so a core whose port was taken
   resolved `startServer`, printed "up on …" and served nothing, while the real
   `EADDRINUSE` was swallowed (its `reject` arrived after the promise settled).
   Readiness now comes from the `listening` event and failure from `error`, so a
   taken port rejects the boot by name. Guarded by `core/test/listen.test.ts`.
2. **`PORT=0` silently became 4390.** `readInt` falls back to the default for
   anything out of range, and three test files (plus one 800-line core test)
   asked for an ephemeral port that way — so they only passed while 4390
   happened to be free. A leaked spawned-core from an earlier e2e run was
   holding it, which is why the failure appeared suddenly and then persisted.
   `loadConfig` now refuses a malformed or out-of-range `PORT` (0 included) with
   a message that says why an ephemeral port cannot be allowlisted, and those
   tests bind a **named free port** (`freePort()` in `core/test/helpers.ts`).

The second defect is what made the first invisible; fixing only one would have
left the other. Teardown in that file also drops keep-alive sockets before
waiting (`closeServer`), which is what turned a 10s hook timeout into an EPERM
on the temp dir. Root suite on Windows: **1254 passed / 5 failed → 1262 passed /
0 failed** (5 env-gated skips). Still open: S8, a device/sign-out UI, per-user
quotas — and unverified: a two-user browser walk, R4 against the real edge, an
R8 restore, R3's live timer, and S9's wrap roll-out on the live deployment.

**One gap the owner caught before any code was written: pairing is not
authentication.** Pairing answers *"may this device reach the core?"* by
proximity; a multi-user web version needs *"which user is this session acting
as?"* — and today the only mint site is `sessions.create('web', origin)`, which
carries **no user** at all, with no `user_id` anywhere in `SessionRow`. The two
are now separated into **enrollment → authentication → authorization**, and a
session may never carry a user without an authentication event. Two consequences
worth knowing: the **desktop copy is unchanged** — on a single-user install
enrollment implies the OS-profile user, so the PairGate stays as it is — and
**sign-in doubles as the unlock event**, which resolves the §4.4
operator-readable-store problem for a hosted multi-user core at a per-user,
explicit, audited cost to headless schedules. This added **S2a** (credentials)
and **S9** (per-user unlock) and raised **S6**: **TLS is a prerequisite for
multi-user**, not only for remote access. Design: `PLAN-M20-B.md` §2a.

**M20 — client-server, multi-user & mobile (decisions locked 2026-09-12).**
`PLAN-M20.md` now fixes the architecture that a mobile client needs. Partner
grows a remote, multi-device, multi-user server role: the core splits into a
**Vault** (the user's own machine — user key, Tier C: memory, notes, chat,
attachments, provider keys, roots) and an always-on **Runner** (job key only,
Tier W: schedules, briefcases, outputs), so scheduled work runs while the
desktop sleeps and the operator never holds a key to private data.
Pre-authorized, capped, expiring **briefcases** plus a one-way **drain** at
unlock replace sync; multi-user is by **partition**
(`data/users/<id>/partner.db`, own key + skills dir), generalizing today's
per-OS-user isolation, and device = session so multi-device is per-user for
free. No new crypto: `ensureDbKey` + `openEncryptedDatabase` applied twice.
Phases: **A** mobile/tablet/touch UI (no core change, in progress) · **B** the
server role · **C** PWA · **D** optional native shell · **E** system layer
(later). Note the sensitivity prerequisite in `PLAN-M20.md` §8.1: core-served
`text/html` can currently execute on the SPA's own origin.

**M15 — Live desktop mode (exit demo).** The packaged shell now boots the core
LIVE by default: persistent whole-file-encrypted DB + OS-keychain key and skills
under the per-user app-local data dir (`%LOCALAPPDATA%\dev.ne1.partner` on
Windows), a per-boot device secret enables the header-guarded `GET
/v1/pair/device` code channel, and the **tray** (Show pairing code… / Open
Partner / Quit) surfaces the live pairing code for the web PairGate (now
health-aware: live copy, no demo button). The core exits itself when its shell
dies by any path (stdin parent-watch). `PARTNER_DEMO_MODE=1` keeps the
historical in-memory demo boot. Remaining items are manual / env-gated: the
packaged live-boot walk on this desktop is executed in PLAN-M15; per-surface
theme walkthrough (`docs/theme-conformance.md`); the `docs/VERIFY-M10.md`
live-mode walk details; browser-actuator research capture; S0 companion API in
`~/apps/llm-self-service`. Read `HANDOFF-WINDOWS.md` first when picking up from
a Windows machine.

### Sample set + the update ask — a persona can propose, the owner grants (2026-09-18, implemented)

Two additive changes that answer "can chat modify a skill, and if so how does the
owner give permission?":

**A reference set in the catalog, mirrored by one template.** Three new
checked-in bundles — `file-inventory` (`files.list` only), `content-audit`
(`files.search` only) and `notes-digest` (`notes.list|search|read`) — plus
`skills-catalog/README.md` stating the three rules they follow: declare the
narrowest reach that does the job, report a broker refusal as a CODE rather than
an empty result, and bound every loop with an explicit `truncated`.
`content-audit` exists a second time as the Studio template `content-audit`
(no capability flag — the files tools are always wired), so "install it from the
Catalog" and "start it from a template" are two doors onto one worked example.
Both halves are held to a real RUN, not a lint:
`core/test/skills/catalogSet.test.ts` installs all three and invokes them through
the real sandbox and broker (including the no-grant `tool_denied` refusal, and
asserting that no note body or file content travels in a result), and
`templates.test.ts` dry-runs the template against a granted project root.

**A persona can propose an UPDATE to an installed skill — and the owner can grant
it where the ask appears.** `skills.draft` accepts an optional `skillId`:
`SkillDraftManager.openUpdate()` opens that skill's `edit` draft (the SAME row
"Edit in Studio" manages, so two competing drafts cannot exist) and the manifest
keeps the INSTALLED id, which is what makes promoting it an update rather than a
second skill. The tool result reports `mode: 'update'`, the installed version and
the before→after `changes`, and says plainly when the update WIDENS. The ask is
the existing `skills.requestInstall` → `pending_tools` row; approving it is still
the only thing that promotes anything.

On the web side `web/src/SkillInstallCard.tsx` is the surface that was missing:
the chat and the Files queue now render an install ask as a **skill card** —
draft name, the version it moves from → to, the plain-language permission chips,
and the before→after table for a widening — instead of the raw `skill.install`
id with no summary and an Approve button that could never acknowledge anything.
`skillInstallDecision()` is the whole consent rule (the acknowledgement travels
only when the table is on screen), and a `permission_change` refusal is rendered
as the next step *and* re-reads the draft, so the table it asks about is actually
displayed.

Walked live end to end (demo core, real browser): a widened update asked from the
queue was refused unacknowledged, the card re-read the draft and showed
`Tools — files.read` / `Risk low → medium` with "The core wants this widening
acknowledged: read the table above, then press Update now", and the confirming
press applied it in place — `Hello Skill · You@0.2.0`, one skill, queue back to
0 pending.

**Not changed:** a skill still cannot install or run itself; `skill.author` and
`skill.install` still gate both doors; `permissions.network: true` is still
refused (a network/exec reach would need the enforcement work described in the
review answer, and that decision is the owner's).

### Deploy fixup — the container can run a skill, and `stage.ps1` runs on Windows (2026-09-18, fix)

Refreshing the live container (`partner-server:local` at `partner.teliti.app`)
turned up two deployment defects, both fixed and measured:

1. **The image shipped no skill worker harness.** The runner forks
   `worker-runner.mjs` as its own process; in a bundled CJS artifact
   `import.meta.url` is empty, so it resolves `$PWD/worker-runner.mjs` — with
   `WORKDIR /app` that is `/app/worker-runner.mjs`, which the Dockerfile never
   copied (and neither stage script staged). Every skill invocation and Studio
   dry-run in the container therefore failed `no_worker`. `docker/server/Dockerfile`
   COPYs it now, `stage.sh`/`stage.ps1` copy it out of `core/src/skills/`, and
   `.gitignore` covers the staged copy. Verified by a real forked invocation
   inside the container: `ready` → `invoke` →
   `{"type":"result","ok":true,…}`, and pinned by `tests/deploy-files.test.ts`
   (both stage scripts + the Dockerfile + the ignore file, falsified by removing
   the three lines).
2. **`stage.ps1` could not parse on Windows PowerShell 5.1.** A UTF-8 em dash
   inside a double-quoted `Write-Host "… — regenerating"` is misread under the
   ANSI code page as a smart quote, which closes the string early — the script
   died with a cascade of parse errors before doing anything (which is why
   `docs/VERIFY-M21.md` recorded it as never executed on Windows). The script is
   ASCII-only now; the same one-line hazard in `shell/windows/build-windows.ps1`
   was fixed too. Run end to end on Windows: SPA build → core bundle → staging →
   certificate reuse → `docker compose build` → container recreated and healthy,
   with the public host answering 200 over the tunnel and the volume's account
   intact.

### Skill Studio fixup — four review findings closed (2026-09-18, fix)

A live review of the Build segment (walked in a real browser against the demo
core: template create → edit → dry-run → install → update → discard → uninstall)
found four defects, all fixed with tests that fail without the fix:

1. **A draft could invalidate itself on its first save.** The wire carries two
descriptions with one name — the draft's own (`description`: the skill's short
description, empty for a template or blank draft) and the MANIFEST's. The editor's Description field is seeded from the ROW but writes into the
MANIFEST, so `Save draft` on a freshly created template/blank draft wrote `""`
over a real description and returned `description is required and must be a
non-empty string` on a draft nobody had edited (the field then stopped affecting
the manifest at all, because a broken manifest is edited as raw JSON). Fixed on
both sides of the seam: the field is seeded from the MANIFEST
(`draftDescription()` in `web/src/lib/skill-studio-helpers.ts`, used for the
initial value, the re-seed and the dirty check in `studio/DraftEditor.tsx`), and
`create()`/`stageFromChat()` now write the manifest's own description into the
row (`rowDescriptionOf()`, `core/src/skills/drafts.ts`) so the two can never
start out different. `core/test/skills/drafts.test.ts` pins the
row-equals-manifest invariant for the template, blank and typed cases.
2. **`Edit in Studio` / `Fork` opened the wrong draft.** Both create the draft
server-side and hand the shell a focus intent; the Studio's rail only reloads
when the Skills VIEW becomes active, so the intent named a draft the loaded list
did not contain — `resolveSelectedDraft` fell through to `drafts[0]` and the
owner landed on an unrelated, read-only installed draft (the rail disagreed with
the nav badge until a reload). Fixed by holding the intent until its detail has
loaded (`pendingFocusId` in `web/src/SkillStudio.tsx`) and by re-reading the rail
when another surface created a draft (`reloadToken` from `web/src/SkillsView.tsx`).
3. **No way to create a draft once one existed.** The only door to a new draft
was the empty state, which renders at `drafts.length === 0`: with one draft
present, generate / start-blank / create-from-template were unreachable and the
only way back was to discard everything. The rail header now offers **New draft**
(reusing `.studio-pane-head`, no new CSS) and the form itself moved into
`web/src/studio/DraftComposer.tsx`, mounted by both the empty state and the new
action — one form, two doors, no duplicated ids.
4. **A failing test run named the code and nothing else.** A throw inside
`run()` returned `skill_error` with an empty Worker log, which is the opaque
answer the dry-run exists to remove. `finalizeError()` in
`core/src/skills/worker-runner.mjs` now emits the cause as an ordinary log line
(`skill error (skill_error): Error: …`), redacted by the parent exactly like any
other log — asserted, secret included, in
`core/test/skills/draftRun.test.ts`.

Suites after the 2026-09-18 fixups: root **1746** (5 env-gated skips) · shared **90** · web
**937** (+6 Studio, +1 deploy guard, +19 for the sample set and the install card)
typechecks 0 · web build green · `ux_audit` PASSED on the Studio
slice (no CSS was added — `web/src/app.css` is byte-identical, and the new rail
action reuses `.btn .btn-secondary .btn-sm`, whose focus/disabled/hover states
already exist). All five flows were re-walked live after the fix.

### M28 — Flow: build a skill on a canvas, with the model as a collaborator (2026-09-17, implemented)

The Studio's fourth surface, and the milestone's one constraint: **a flow is not
a second kind of skill.** A graph of ten typed nodes compiles
**deterministically to `entry.mjs`** — byte-identical for one flow, total
compiler, every failure a named error before a byte is emitted — so the
artifact, the sandbox, the hash check and every M26 install gate are unchanged.
There is no flow interpreter, no `flow.json` at install time and nothing new for
the runner to trust; **Code is the artifact, the Flow tab is an authoring
view.**

Why a graph is the better model surface, not just a nicer one: a model writing
free-form JavaScript has unbounded failure modes, while a model filling a typed
vocabulary has a small, checkable one. Expressions are a validated **path
grammar plus eight fixed operators**, never emitted text — `__proto__`,
`constructor`, `a..b` and `a); process.exit(1);//` are refused with tests, and a
backtick or `${` in a template stays prose — so an AI-written graph cannot
inject code, which is what allows the compiler to generate any. The graph's
`tool` nodes **derive** `permissions.tools` (and `permissions.llm`), so the
install summary provably matches the code.

Four AI verbs, and the line between them matters. `mode:'generate-flow'` builds
a graph from a description; **`/flow/refine` returns a proposal** — the diff
shows what was added, removed and changed, nothing is written until you accept
it, and Reject leaves the graph exactly as it was; `/flow/from-code` is
**declared lossy** (there is no decompiler — the model is guessing at what your
code meant); and `/flow/explain` is a walkthrough for your eyes only. Staleness
is **derived, never stored**: a flow is stale when its code is not what the
current graph compiles to, so a hand-edit that restores the compiled bytes
clears it by itself and an edited graph shows the Recompile banner. The palette
omits `llm` unless M27 S5 is wired, and the whole surface is keyboard-reachable
through the **Nodes table**, which edits every field of the same document —
including a `tool` node's arguments (a path reference or a literal, with the
`{"$literal": …}` escape the schema documents).

A persona can author a flow from chat too: `skills.draft` accepts a `flow`
payload **instead of** `code` — the same tool, not a third one — and the chat
instructions teach the same node vocabulary the canvas palette and the flow
prompts use (`flowContract`, one string). The full record, the looked-at frames
and what is NOT verified are in `docs/VERIFY-M28.md`.

### M29 — the multi-user lifecycle (2026-09-18, implemented + walked)

Five things a hosted (login-mode) Partner needs before a second person can
really use it, all in the gateway so they answer before per-user delegation.

**Sign out.** `POST /v1/auth/signout` revokes the presented session *and* closes
the user's partition (their scheduler stops, the database handle closes, the
key leaves memory), so signed out means unreadable rather than merely
unreachable. The SPA gets a sidebar-footer control, a card in Members, and the
Members view on the phone More sheet; a paired desktop's same button is an
unpair.

**Owner-minted invitations.** `users.role` (`owner`/`member`) and
`users.key_access` (`own`/`shared`) are additive columns, and `invites` stores a
code's SHA-256 plus the role/key-access the redeemer gains. An owner mints,
lists and revokes invitations in the **Members** view — no shell. Sign-up reads
the invite ROW, so a redeemer cannot escalate, redemption is one conditional
UPDATE (two concurrent uses cannot both win), and shape errors or a taken name
are refused **before** the invite is spent. `SIGNUP_MODE` still governs only the
loopback operator mint (the way to create the FIRST account); an owner's invite
redeems regardless.

**Shared AI access.** `PUT /v1/shared-access` (owner) publishes the owner's
provider list + search config into `shared_access`, with secrets in the
deployment keychain under `shared-*` accounts. A member invited with
`keyAccess:'shared'` sees those providers only while they have none of their own
— so they chat and search without a key, and their own setup always wins.
`DELETE` withdraws rows and keys together.

**Per-user file paths.** On a partitioned core each account's fixed root is
`<FIXED_ROOTS entry>/<userId>` (or `<partition>/files` without a volume), created
at boot, and the roots surface is read-only in login mode — one mounted volume
no longer means one shared directory. **Cost:** an existing deployment moves its
files at the volume root to `/files/<userId>` once.

**Sharing.** `shares` holds a **snapshot copy** in the system DB, so a grantee
reads what they were given without ever opening the owner's partition, can save
it into their own notes, and sees nothing else; the owner can push a current
edit or revoke. Assets are shared by conversation id and import as a
topic-tagged note (the grantee does not own the source conversation). Schema
**v22 → v23** (additive). The record — the browser walk against a real
login-mode core and what is NOT verified — is `docs/VERIFY-M29.md`.

### M27 S4 — the notes and MCP Studio templates (2026-09-17, implemented)

M27's last slice, and the reason the milestone existed: two of the four Studio
templates were *not expressible* before it. Both ship now, each carrying the
capability it needs.

**Checklist from your notes** declares `notes.list` / `notes.search` /
`notes.read` and reads your notes through them — with **no `projectId` and no
project root at all**. The grant is the once-only **App data** consent that sits
beside your roots, keyed on the reserved app scope; without it every call is
refused with `tool_denied`, which the template reports as a plain reason instead
of failing the run (a skill can never be asked to approve anything, so the
granting happens first). It lists or searches notes, reads **at most `limit` of
them, one read per note**, and returns the markdown task items it finds —
bounded by construction, so a large store cannot turn it into an unbounded loop
of tool calls.

**Calls an MCP server tool** declares one MCP server and calls one of its tools
as `partner.tools.exec('mcp:<server>/<tool>', args)`, at the **`medium`**
ceiling an MCP-calling manifest is required to present. Its docblock names the
codes the run reports — `mcp_not_declared`, `mcp_disabled`, `tool_denied`,
`upstream` — and asks for the server id and a tool it serves as arguments. One
honest limit: MCP server ids are generated when you add a server, so **no
template can name yours** — the shipped manifest carries a placeholder id, the
single field you replace before installing.

**The picker offers a template only when its reach is wired.**
`availableTemplates(capabilities)` is the one source of that decision (D9), so
the Studio picker, the authoring prompt, the drafts door and the validator
cannot disagree: with `notes` or `mcp` false the corresponding template is not
offered at all, and asking for it by name is refused with the reason. Both
directions are asserted, including through `POST /v1/skills/drafts` — the door
the picker actually calls.

**Both bundles were held to a RUN, not a lint.** The notes template goes through
a real Studio **dry-run** in the real sandbox — picker → draft → dry-run →
broker — against a real granted note, and is asserted to return exactly the
checklist items and to queue nothing before the grant; the MCP template runs
against a **real local stdio MCP server** (a small script, no network), where
the run test performs the same one-field manifest edit an author would. The
suite `core/test/skills/templates.test.ts` and the drafts-door gate in
`core/test/skills/drafts.test.ts` cover it.

Suites: root **1651 passed** (5 env-gated skips) · shared **90** · web **858**
(unchanged — the shared contracts did not move) · typechecks 0 · web build
green. The only thing outstanding in M27 is the env-gated walk against a real
MCP server you configure — the two live walks (M26 generation, M27 S5 model
reach) are **verified** against a local and a remote endpoint in
`docs/VERIFY-LIVE.md`, and the packaged-Studio walk needs a **rebuild** because
the installed artifact predates M26/M27.

### M27 S2 — MCP reach from the skill sandbox (2026-09-17, implemented)

**A skill can reach an MCP server you have enabled**, and it can only reach one
you have enabled.

The manifest declares `permissions.mcpServers` — server ids, not tool names,
because a server is configured later and a manifest must not be able to name a
tool that does not exist yet. The entry then calls it through the tool verb it
already has: `partner.tools.exec('mcp:<server-id>/<tool-name>', args)`.

The gate order is the control, and it is the same shape the broker uses: **class
envelope → declaration → ceiling → is the server configured and enabled → the
call**.

- **`mcp.call`, checked first.** Desktop keeps its reach; mobile and extension
  are allowlists that do not contain it, so a phone cannot reach an MCP server
  through a skill even holding a grant. Because it is checked above the
  declaration, a session that may not call MCP learns nothing about what is
  configured behind it. This closes the half of the M20-B S4 gap that S3 left
  open.
- **Declared, and at least `medium` risk.** An MCP tool's own risk is unknowable
  in advance, so the manifest must present the worst case and the owner consents
  to it at install. A `low`-risk manifest declaring MCP is refused **when the
  draft is validated**, so it never reaches an install card. Server ids are
  de-duplicated and capped at eight.
- **Never interactive.** An undeclared server, a disabled one, a server that
  cannot start, a tool that does not exist, a tool that reports an error — each
  is a **coded refusal** the skill can catch and act on (`mcp_not_declared`,
  `mcp_disabled`, `upstream`, `capability_denied`), and **no approval arrives on
  your queue**. A skill cannot be asked a question, so the order is: enable the
  server, then run the skill.
- **The reach is described where you read it.** The authoring prompt, the chat
  instructions and the install summary are all driven by the same capability
  object the validator consumes, so the model is never told about a reach this
  build cannot honour.
- **The audit log says who asked.** An MCP call made from a skill is recorded
  under the actor `skill`, not `web` — a row that said `web` for a skill's reach
  described a request the user never made. A persona's auto-call is recorded as
  `persona`, and the user's own session keeps `web` as before. The row still
  carries ids, a flag, a duration and a content-item **count** — never the
  server's command line and never your tool arguments.
- **A refused reach is audited too.** The skill catches the coded refusal and
  the RUN SUCCEEDS, so the invocation row alone would say nothing about the
  attempt — and a denial before the call never reaches the call record. Each
  refusal therefore writes one `mcp.call.denied` row naming the server and the
  code (actor `skill`, ids only), so "did this skill or phone try to reach MCP,
  and against which server" is answerable. A persona-driven or scheduled
  `skill.invoke` is likewise recorded under `persona`, with the skill id as the
  row's target.

One seam owns all of it (`core/src/mcp/skillReach.ts`) and the runner receives
it by injection, so `skills/` still never imports `mcp/`. The tests reach a
**real stdio MCP server** implemented as a small local script, so the whole path
is exercised with no network access.

### M27 S3+S5 — skill reach: the client class and the model (2026-09-16, implemented)

Two of M27's five slices. **A skill can now call a model** — and the class gap
M20-B S4 recorded against itself is closed for the broker.

`partner.llm.complete({prompt, maxTokens?})` is the new worker verb, and the
gate order in the runner is **declaration → class → request shape → provider →
ceiling**. `permissions.llm !== true` refuses `llm_not_declared` (absent means
no model access at all, the only honest default); `skill.llm` — a new capability
deliberately *not* in the mobile or extension allowlists — refuses
`capability_denied`, so a phone's skill run cannot send your data to a provider;
nothing configured refuses `no_provider`; and the **ceiling** is
`budget.maxTokens` when declared, otherwise a documented 4096 default, never
unbounded.

**`SkillBudget.maxTokens` finally does something.** It has been declared in the
shared contracts, validated by the manifest validator, and never read since M8 —
`runner.ts` used only `timeMs`. It is now the token ceiling it always claimed to
be, accumulated across every call in one invocation, and past it the invocation
fails `budget_exceeded` **mid-run** with the worker killed and no partial
success returned. The provider spend ledger is charged per accounted call (with
a byte/4 estimate when the stream reports no `usage`), and `permissionSummary`
states the binding ceiling so you read the number before installing — because a
skill that can call a model can send **anything it read** to that model, and the
install summary now says so in plain words.

Content never reaches the audit: one `skill.llm` row per accounted call carries
the model id, prompt/completion/total token counts, ms and cents — and neither
the prompt nor the completion (asserted by serializing the audit list).

**S3 — the class reaches the runner.** `broker.exec` called from a skill passed
no `clientClass`, which defaults to the desktop envelope: unobservable while a
skill could only reach `files.*`, and a real hole the moment it can reach more.
`SkillInvokeContext.clientClass` is now read from the **session row** by both
routes into the runner and forwarded to the broker, with an absent class keeping
its documented meaning (an internal persona or scheduled run is the desktop
owner's agent).

The implementation brief asked for this to be proven with a granted `files.read`
— and **that premise was wrong**: mobile's envelope *does* include `file.read`,
and an existing test asserts it executes through the broker. Forcing a refusal
would have meant weakening the envelope and breaking a passing test, so the case
is proven with **`files.edit`**, which is what M20-B S4 actually wrote down:
*"its grant for `files.edit` would walk the phone straight into a write."*
`files.read` is kept as the positive control, so the test proves the class is
per-capability rather than a blanket deny. The grant is verified **present**
before the refusal (or the refusal proves nothing), no pending row or proposal
is created, a request **body** cannot set or raise the class, and the same
assertions run against the dry-run route.

Suites: shared **90** · root **1495 passed** (5 env-gated skips) · web **851** ·
typechecks 0 · web build green (recorded at S5; S1 then took root to **1513**,
S2 to **1609**, S2's audit-actor attribution fix to **1614**, S4 to **1628**,
M28 B to **1645**, and the 2026-09-17 review fixup to **1651**, with web at
**858** — each slice updates this line's figure). Record: `docs/VERIFY-M27.md`.
One tripwire was updated deliberately: `capabilities.test.ts` pins the closed
vocabulary and the narrow per-class allowlists, and now records why `skill.llm`
joins the first and deliberately not the others.

### M26 — skill authoring: build a skill by talking to the partner (2026-09-16, implemented)

Until now a skill could only be **installed from the checked-in catalog**
(`skills-catalog/`). M26 adds the other half: making one. A skill can be
described in chat, generated by a model, drawn up from a template, written by
hand, edited, test-run in the sandbox, installed, forked, edited in place, and
exported/imported as an unsigned bundle.

The line the milestone draws: **a model may write code and ask, but only the
owner makes it executable.** A draft is a `skill_drafts` row (schema **v21**)
holding the manifest text, the entry source and the result of validating them.
Creating, editing and validating one writes no skill row, creates no code
directory, and executes nothing — a draft whose entry throws at import time
still *validates*, because validation reports shape and the dry-run reports
behaviour. Validation is deterministic and shared with the catalog path (one
`validateManifestShape`, extracted to `core/src/skills/manifest.ts`), plus a new
`lintEntry` that refuses the two failures which otherwise surface as an opaque
`crashed`: an entry that cannot export `run(args)` and a bare module specifier
the sandbox cannot resolve.

**Two surfaces, one install.** The Studio button and the approval card the
persona's ask opens in chat both call the same `promote()`, so they cannot
diverge. Because approving EXECUTES, the approval path is class-checked as
`skill.install` — the queue is not a way around the client-class table for the
act the table most cares about. An update that **widens** permissions is refused
with `409 permission_change` until it is acknowledged, and a narrowing one does
not nag. `fork` copies an installed skill under a new id (promote then creates a
second skill); `edit` opens a draft bound to the installed id so promoting it
updates that skill in place.

**Generation is bounded and honest.** One one-shot call per draft (256 KiB reply
cap, 60 s timeout) whose reply is parsed and *normalised*: the slug is forced (a
model returning a traversal id cannot escape), the budget is clamped to the
runner ceiling, unknown tool ids are dropped with an error naming them, and
`network: true` is refused. With no provider configured (or in demo mode) a
deterministic generator answers instead, and the Studio **labels** that draft
"canned example — no model configured" so "generated" never implies a model
wrote it. A capability the runtime cannot honour yet (`permissions.llm`,
`permissions.mcpServers`) is a named validation error rather than a permission
summary that promises nothing.

**The dry-run tells you why it failed.** A draft runs in the same worker sandbox
as an installed skill, and the run returns the worker's own redacted log lines —
so an import-time crash is a readable error in the Studio and in chat instead of
the opaque `crashed` code. It writes no invocation-history row (a dry-run is not
history) and one audit row carrying counts only.

Audit rows carry ids/counts/lengths/booleans only: the draft's code, manifest
text and description are the owner's own content, go to the owner's UI, and
never reach the audit log (asserted by serializing the whole audit list).
Authoring is gated by a new capability **`skill.author`**, separate from
`skill.install` (writing a draft is inert; installing is not) and denied to
mobile/extension by name.

Suites: shared **90** · root **1468 passed** (5 env-gated skips) · web **851** ·
typechecks 0 · web build green · `ux_audit` PASSED (16 token pairs, light +
dark). Seven pre-existing guard tests fired and were updated deliberately (six
pinned `SCHEMA_VERSION` to 20; one pins the closed capability vocabulary);
`web/test/attention.test.ts` was re-baselined for the new `skills` badge with
the no-double-count rule asserted. Record: `docs/VERIFY-M26.md`.

### M19 — persona-scoped memory & automatic remember (2026-09-12, implemented)

Personas gain **private memory**: a per-persona tick (`memory.personaMemory =
on|off`, off by default) makes a persona keep its OWN facts about the user and
recall them **only in chats with it** — the interactive `/v1/chat` route. A
persona-scoped entry is never injected into a different persona's prelude, and
the headless playbook/schedule/brainstorm loops never see it. Global confirmed
facts still tailor every persona (M4).

**Automatic remember.** Detection has two independent consents. A user-level
**global auto-remember** setting (`GET`/`PUT /v1/memory/settings`, default
**on**) covers facts that apply to every persona — name, role, language,
standing tone — regardless of which persona is speaking. Each persona's
**private-memory** tick (off by default) covers facts tied to that persona. The
core asks the persona's cheap-task-class model (out of band, AFTER the client's
response has ended, so the turn never waits) whether the finished exchange holds
anything durable about the user, and drops findings for a scope whose consent is
off. Findings are filed as `partner_suggestion` / `suggested` entries for the
user to confirm, edit or reject in the Memory view — alongside the existing
explicit add-a-fact path. Each finding is labeled **global** (filed
`personaScope: null` so it tailors **every** persona once confirmed) or
**persona** (filed scoped to the persona that heard it), so the partner learns a
universal fact once instead of per persona. The extractor prompt is fixed and
never user-derived; parsing is defensive (fence/JSON guard, kind + scope
whitelist with a persona default, caps, obvious-secret filter); before
suggesting, the extractor reviews a bounded `ALREADY KNOWN` listing of the
confirmed and still-pending facts the persona honors (global + its own scope) so
already-known facts are not re-proposed, and dedupe (punctuation/case/space-
insensitive) covers global + same-scope entries, rejected included, so a
rejected fact is never re-suggested and the same fact is never suggested twice;
demo/no-provider turns skip; if the persona's cheap/chat model cannot be
resolved on its own (a provider with no default models whose turn carried an
explicit model), extraction rides the exact provider + model that served the
turn, so a successful turn never silently skips remembering; audit rows carry
ids/counts/model only. No schema change (M4's
`profile_entries.persona_scope`/`source`, the `personas.memory_flags` JSON and
the `settings` key-value table were enough; M33 later replaced that single scope
field with the multi-select `persona_scopes` array — schema v24). Web: an “Automatic memory” card in
the Memory view, a Memory fieldset in the persona editor, a persona-aware “in
use” marker, and an “Auto-detected” provenance chip. Suites after the pass: core
**893 passed** (5 env-gated skips) · web **541 passed** · typechecks 0 · web
build green · `ux_audit` green; later follow-ups (turn-target fallback,
independent global consent) kept the suites green. Spec: `PLAN-M19.md`.

### M25 — reconfigure existing providers (2026-09-16, implemented)

The setup card could only ADD purpose providers. Once a profile existed, the
only way to change which models its purpose carried was to delete it and build
it again — which meant pasting the API key another time and discarding the
keychain item. The card now has two modes: **Add new** (the M13 bundle,
unchanged) and **Reconfigure existing**.

Reconfigure picks one of the endpoints already in the list, rediscovers its
current models through the key the keychain **already holds** (`GET
/v1/models?provider=<id>` — there is no key field, and the probe tries the
endpoint's profiles healthiest-first, so one profile whose key was never set
cannot block the rest of a group), then lets you tick which models each existing
purpose profile should carry. Saving writes only the profiles whose ordered list
changed, through the M24 `PUT /v1/providers/:id` route — and a `vision`-purpose
profile's new ticks become its image-capability declaration, so reassigning a
vision provider needs no second step. A profile emptied of all models is refused
before any request (the add flow refuses that shape too). Nothing is created,
deleted or re-keyed here.

The pure decisions live in `web/src/lib/providers.ts`
(`endpointGroups`/`reconfigureModelOptions`/`reconfigurePinsFor`/
`reconfigureChanges`) and the stored-key read is `listProviderModels` in
`web/src/lib/api.ts`; **no core route or schema change**. Suites after the
change: shared **90** · root **1328 passed** (5 env-gated skips) · web **758**
(742 + 16) · typechecks 0 · web build green · `ux_audit` PASSED (17 APCA pairs,
light + dark). The whole-file `ux_audit` run is still outstanding (payload
> 200 KB); the gate ran on a composed, brace-balanced payload of the new block
plus every interactive base/state it depends on.

### M24 — attached photos actually reach the model (2026-09-16, fix)

The bug: a photo attached in chat produced “I didn’t receive an image” from a
model that reads the same image fine when tested directly against LiteLLM. Three
independent causes, all silent:

1. **Capability was guessed from the model id.** A name list (`VISION_HINTS`)
   decided whether a turn attached an `image_url` part — so an operator-chosen
   gateway alias (`my-photo-model`, `pixtral-12b`, any LiteLLM `model_name`)
   counted as text-only. The persona was handed nothing but the descriptor line
   `[Image attachment: photo.jpg …]` and answered truthfully that no image
   arrived; the M13 reroute and the chat picker could not find a vision model
   either, because both applied the same name test. Capability is now
   **declared**: model ids ticked image-capable on their provider
   (`providers.vision_models`, schema **v20**), or any model on a `vision`
   purpose profile, read through one shared rule that the core gate, the
   resolver, the picker and the capability chips all use. Name hints stay as the
   zero-config default, and a declaration can only ever *add* capability — an
   upgrade never invents it (a pre-v20 row declares nothing).
2. **The two byte budgets were conflated.** Upload fits `maxUploadBytes` (8 MiB)
   but only `maxInlineImageBytes` (3 MiB, now shared and published on
   `/v1/health`) can ride a turn. A normal phone photo stored, thumbnailed and
   was then dropped from the request. The composer now re-encodes any
   over-budget image to the inline budget — so what you attach is what the model
   sees — and an image that still cannot ride is described to the model as **NOT
   sent** rather than reading like a successful attachment.

Declarations are editable on a working provider (`PUT /v1/providers/:id`, plus
clickable model chips on the provider card); a model the name already recognises
and a `vision`-purpose profile are not un-tickable, because clicking would do
nothing. A third, smaller silent loss went with it: the image part was singular,
so a turn attaching two photos sent one — it is now a list (up to 4 per message,
and the composer says outright when staged photos exceed that). Suiting after
the fix: shared **90** · root **1333 passed** · web **742 passed** · typechecks
0 · web build green.

### M23 — scorecard chat answers (2026-09-15, implemented)

A fourth answerable container joins clickable choices and free-text forms:
`:::partner.scorecard` rates several named items on one shared numeric scale, so
a multi-item review is answered in one pass. Grammar: one item per bullet line,
`scale=<2–10>` (default 5) sets the highest score with scores running 1..scale,
and an optional `labels="Low|High"` names the ends. Each item is its own radio
group, so one score per item is structural rather than a validation rule.
Submitting once sends a single labelled user turn (`Q: <item>` / `A:
<score>/<scale>`) through the normal chat path — nothing client-only, the
persisted text unchanged. The parser shares the `:::partner.*` grammar
(`shared/src/structured.ts`): closed-container-only materialization,
malformed/unclosed containers degrade to prose, and an out-of-range scale clamps
rather than dropping the card. Inside the M20.A one-submit group a scorecard
must have every item rated; standalone it accepts any non-empty rating set.
Pending ratings survive conversation switches (client-side per-conversation UI
memory). The `scorecards` guidance ships in the default structured feature set;
styles are token-only.

### M18 — chat multi-question forms (2026-09-11, implemented)

When a persona has **more than one open-ended question**, it now emits a
`:::partner.form` container instead of a prose list. Each question renders in
its own textarea and the user submits **once**; the answers become a single
labelled user turn through the normal chat path (nothing client-only, the
persisted text is unchanged). The parser shares the `:::partner.*` grammar
(`shared/src/structured.ts`): one question per bullet line, a title from the
`title=` attr / fence tail / lead line, closed-container-only materialization so
streaming stays safe, and malformed or unclosed blocks degrade to plain prose.
Pending drafts survive switching conversations (client-side per-conversation UI
memory). The `forms` guidance ships in the default structured feature set
alongside choices and assets; styles are token-only.

### M17 — note projects (2026-09-11, implemented)

Notes gain an organizational layer on the existing Projects/Folders tree (shared
with chats; many-to-many, no membership = Inbox). A single membership write path
(`setFolders`) backs both create-time `folderIds` and re-filing;
`list()`/`graph()` scope by folder subtree or Inbox; a scoped graph returns
one-hop, both-direction **ghost** nodes for out-of-scope references (marked
external, never persisted). Deleting a folder clears membership (notes survive);
deleting a note cascades its membership rows. New routes: `GET
/v1/notes?folderId=<id|none>`, `GET /v1/notes/graph?folderId=…`, `PUT
/v1/notes/:id/folders` (501 when folders are unwired). The Notes list and graph
get project scope selectors, project chips, an editor Projects multi-select,
dimmed ghost nodes + an "other projects" toggle, drag-to-ghost and a "Link to
note…" picker. Schema v15 → v16 (`note_folders`); audit stays membership counts
only.

### M16 — knowledge workspace (2026-09-09, implemented)

`PLAN-M16.md` ships six features (implemented; packaged walk env-gated): a React
Flow notes relationship graph (edges follow who references whom; mutual refs
render bidirectional; drag positions persist), **Brainstorm from notes &
captures** activating a seed-on-demand **Brainstorming** persona
(`p-brainstorm`), **versioning for notes & captures** (history, diff, undoable
restore), **Discuss in Assets** (branch/thread of the asset's own discussion, or
fork into a new one — schema v14 adds `conversations.parent_id` +
`source_asset_id`), **Assets → Export working in the packaged desktop app**
(native save-dialog path in the Tauri shell; blob fallback in browsers), and
**CSV assets rendered as tables** (pure shared parser). Schema v13 → v14. Root
suites: shared 51 · core 837 (2 pre-existing env cipher failures) · web 486 ·
typechecks 0 · web build green · `ux_audit` green.

**M16 follow-up — linked, reopenable brainstorms (schema v14 → v15).** A
brainstorm conversation is linked back to its source note/capture nodes
(`brainstorm_sessions` keyed by the deterministic source set + a
`brainstorm_sources` join); the graph badges those nodes and lists their
sessions. Clicking **Brainstorm (N)** over a set that already has an ACTIVE
session reopens it instead of starting a duplicate; once a path is **concluded**
a fresh brainstorm starts, and the concluded one stays listed in the graph with
**Reopen** to continue it. The open brainstorm chat also carries a `Brainstorm
active|concluded` chip with **Conclude**/**Reopen** in its action bar. Owner
actions, ids/counts only.

### M14 — scheduled & autonomous work (2026-09-06, core engine green)

Personas carry **schedule definitions** inside their independence bundle
(`independence.schedules[]` — daily/weekly wall-clock or a rolling interval,
prompt, optional IANA tz, per-run round bound, save-note flag). The core's
scheduler wakes on a heartbeat (`SCHEDULER_TICK_MS`, default 30 s;
`SCHEDULER_TZ` overrides the machine-local default; UTC in demo) and fires due
schedules for **unpaused auto/autonomous personas only**. Each fire is a
**headless bounded persona tool-loop run** on the same engine playbooks use: the
brief lands as a user turn in the schedule's own conversation thread
(auto-created, persona-bound, home-folder aware, reused across runs); tool use
keeps every existing gate (independence × risk matrix, persona bans,
default-deny broker grants); a queued tool pauses the run (row status `queued` +
`pendingId`); deciding that approval from the Files queue or the in-chat card
**auto-resumes the run in-process** — no UI click needed to continue; the final
answer appends to the thread on done (+ optional save-note); every attempt
writes a `scheduled_runs` row and audit
`schedule.run`/`schedule.resume`/`schedule.skip` rows (ids/counts only — prompts
and transcript text never cross audit). Pausing the persona is an instant kill
switch for its schedules (new runs AND resume). Missed windows fire at most one
catch-up run; windows never storm. Schedules are edited through the existing
persona surface; new routes: `POST
/v1/personas/:id/schedules/:scheduleId/run-now` (headless), `GET
/v1/schedules/runs` + `/v1/schedules/runs/:runId`. Schema v13 (additive:
`personas.schedules`, `scheduled_runs`). Spec: `PLAN-M14.md`. Web slice
(schedule editor + runs panel) is done: web/src/SchedulesSection.tsx renders in
the persona editor — list with enabled toggles, add/edit/remove,
daily/weekly/interval fields, timezone + round-cap, Run now for persisted
schedules with inline errors, and a Recent runs mini-panel (status dots, model,
queued-approval hint, auto-refresh after run-now). Token-only, ux_audit green,
web build + typechecks 0. live manual walk (env-gated) only; the decide-hook is
now proven end-to-end (core/test/http/schedulesApproval.test.ts — real broker
loop, approve + deny, headless auto-resume, transcript + audit assertions). Live
walk executed 2026-09-07 against https://api.ne1.dev/v1 (deepseek-v4-flash) +
Brave search: purpose provider healthy (1063 ms, 4 models), real Brave results
returned, scheduled run paused on a queued approval and auto-resumed headlessly
to done, final brief persisted in the conversation thread and as a note, audit
rows content-free, core log clean of key material. Walk bug found + fixed:
resume-completed runs now save-note (the resume path carried schedule=null) —
covered by a manager unit test. Remaining: packaged-app walk (shell/NSIS) only.

### M13 — purpose providers & in-session model switch (2026-09-06)

Providers can be set up **by purpose** (General · Cheap · Deep · Coding · Vision
· Research) from one endpoint + key: discover the endpoint's models, **assign
which model(s) each purpose uses** (first = default), optionally cap spend per
profile, then `POST /v1/providers/purposes` creates one profile per purpose with
those pins (no pins = heuristic: vision keeps image-capable models, others the
full list); the single key lands in each profile's keychain item. The standalone
single-provider add form is gone — the purpose card is the only add surface (the
single-provider create route stays for API clients and the llm-self-service
import). Chat has a **per-message model picker** (Auto = persona routing, or any
provider's models grouped by purpose, vision-marked), backed by a per-turn
`providerId` pin that wins over persona pinning and purpose routing. Attached
photos now reach a vision model: an implicit turn whose model can't see images
is rerouted to the best vision-capable model (`chat.vision_reroute` audit), an
explicit pick is never overridden, and vision capability lives in one shared
module (`shared/src/vision.ts`) used by core and web alike. Spec: `PLAN-M13.md`.
Suites after the pass: core 681 (5 env-gated skips) · web 470 · typechecks 0 ·
ux_audit green on the new picker + bundle card.

### M12 capability pass — personas can actually use web search (2026-09-06)

Chat personas now know what they may do: every persona turn declares its
independence level, and when the internet-search backend is enabled (Providers →
Internet search) the persona is told the tool exists with the exact directive
grammar to call it:

- **auto / autonomous** — run `search` directly (the enabled backend is the
  consent); results land as a system note for the next turn.
- **suggest** — every search request queues an approval in the Files queue
  (tagged with the persona, showing the truncated query); **Approve** runs the
  search once and posts the result note into the conversation, **Deny** posts a
  denial note. No grant is ever created (external tools have no project root).
- **assist** — chat/proposals only; never offered the tool and never asked to
  approve (approvals start at Suggest).

Providers → Internet search shows **two provider cards** (Tavily and Brave).
Each card stores its own keychain key and endpoint override, and a radio on the
card picks the active provider — so a user holding both keys can keep both and
switch without re-entering either.

### M12.6 — approvals live where the ask happened + the chat continues (2026-09-06)

Suggest-level asks now surface **on the chat screen itself**: pending rows carry
their `conversationId`, and while the active conversation has one, an "Approval
needed" card (Approve / Deny) renders above the composer with the same row
detail as the Files queue (tool, risk, truncated query, persona).

- **Approve / Deny in the card** decides the row exactly like the Files queue
  (search runs once / denial note) **and then continues the turn**: a new
  `/v1/chat` mode (`continueTurn: true`, conversation only, no user message)
  streams the persona's next round against the outcome note the decision just
  posted — no phantom user turns, no navigating away.
- The Files queue stays the global queue (badge count unchanged); decisions made
  there post their notes and the chat transcript refreshes when you return to
  the Chat view.
- Guarded: `continueTurn` requires a conversation, refuses request messages and
  `noPersist`, and every existing turn path is byte-identical unless the flag is
  sent. Audit stays query-free.

Suites after the pass: core 673 passed (5 env-gated skips) · web 461 passed —
typechecks 0, `ux_audit` green on the new chat-approval card.

Persona tool bans are respected everywhere; disabled/assist personas are never
even told the tool exists (default-deny). Audit rows stay query-free (query
length + hit count only). Suites after the pass: core 657 passed (5 env-gated
skips) · web 460 passed.

Dev note: `npm run dev:core` runs demo mode by default — an **in-memory DB +
fake keychain**, so personas/config/search keys reset on every restart. Use
`DEMO_MODE=0` (with a `DB_PATH`) for a persistent setup.

---

## Part 2 — PLAN.md §15 full milestone log (as of 2026-09-18)

> Verbatim copy of the old `PLAN.md` §15 milestone bodies (`S0`–`M29`), before it
> was reduced to a compact index. Includes the M20.A follow-up measurements and
> the M30–M33 detail that had been nested inside the M20 entry.

- [x] ~~**S0 — Self-service companion API**~~ **CLOSED as obsolete in M22** — the
      llm-self-service import it existed to unblock was removed (§2), so the
      companion endpoints are no longer wanted. Nothing was built in that repo.
      JSON route `GET /api/me/key` behind the existing cookie session,
      rate-limited, demo-mode path, plus exposing the login public key for
      the envelope. TDD in that repo. *Exit: curl with a demo-mode session
      returns the key JSON. Unblocks the M1 import wizard.*
- [x] **M0 — Scaffold, Tauri shell & security spine.** Repo layout, shared
      types, vitest, config/.env patterns, keychain access abstraction
      (fake keychain for tests), pairing code + session tokens, origin
      allowlist. **Tauri v2 shell scaffold + core-sidecar packaging spike**
      (Node SEA vs `bun build --compile` vs bundled runtime — resolves
      §17.1). *Exit: two processes (web, core) pair and echo a chat round
      with a demo fake provider; the packaged app opens and serves the UI on
      loopback.*
- [x] **M1 — Providers, gateway & key import.** Provider CRUD,
      OpenAI-compatible client (SSE streaming, header scrub for ne1 WAF,
      neutral UA), routing by task class + fallback, budget caps, usage
      surfacing. Integrated "Connect llm-self-service" wizard (org login via
      the envelope, S0 key fetch → keychain). *Exit: real chat against a
      user-supplied endpoint in demo mode; import pulls a demo key.*
- [x] **M2 — Tool broker & files.** Tool manifests, grant store, risk tiers,
      confirmation UX, project roots, read/search/write-preview/apply with
      backups, audit log. *Exit: user grants a root; partner proposes a diff
      in a temp file; UI review; apply.*
- [x] **M3 — Chat + persona engine v1.** Conversation UI (SSE), persona CRUD,
      independence levels + pause/kill, model routing per persona. *Exit:
      two personas with different characters/autonomy respond appropriately.*
- [x] **M4 — Memory & profile.** Profile facts w/ user confirmation, episode
      summaries, semantic index, tailoring loop, forgetting + export.
- [x] **M5 — Plans & notes.** Stores, editors, wiki-links, daily note
      summary, plan execution with approved diffs.
- [x] **M6 — Theming.** `theme/v1` schema, presets, Theme Studio, token lint +
      APCA/WCAG gate on save, DESIGN.md component compliance.
- [x] **M7 — Extension bridge & search actuator.** Native messaging host,
      pairing, page capture, per-site scopes, sensitive-site blocklist,
      "partner this page", search-engine capture for research. *Exit:
      research flow end-to-end into a note, search results captured from the
      user's engine with no API key.*
- [x] **M8 — Skills runtime.** Manifest + signing + hash verify, sandboxed
      workers, permission enforcement, audit, install/update/uninstall flows,
      local catalog + registry protocol.
- [x] **M9 — Capability playbooks.** Research, vibe-code, docgen, email
      draft, presentation, analysis, design-prototype flows wired to personas
      (depth per §6), plus the **Ship/deploy playbook** (deploy-target
      profiles, build → push → deploy → health check → URL) and the
      **API-key search adapter** (optional search backend).
- [x] **M10 — Hardening & alpha.** Encryption-at-rest, redaction sweep,
      budgets enforcement, audit UI, degrade-mode chat, packaging (NSIS on
      the self-hosted Windows runner; installer boots env-free; signed
      updates env-gated post-M10), demo mode + verification checklist + docs.
- [x] **M11 — Chat as the workspace (detailed spec: `PLAN-M11.md`).**
      Chat attachments + granted-root file references + multimodal image
      parts; chat tool execution (directive + native `tool_calls`), MCP
      stdio client with persona auto-calls, API-key internet search (core +
      chat tool + UI); persona skill/tool policy; purpose-based providers;
      clickable single/multi choices; markdown→HTML rendering; follow-latest;
      Assets (save/copy/promote-to-note); chat folders + drag-to-move +
      persona home folders; per-conversation themes (D6) + extension-chrome
      theme stream; Notes promoted (tab order, ＋Note/Ctrl+K, Notes lane);
      A/B persona studio; sandboxed HTML/CSS preview (F12 follow-up: an
      ```html code block in chat, the assets read view or the note-editor
      preview renders in ONE tabbed viewer — Code | Preview, the app's
      segmented pill — so source and sandboxed render are one flip apart
      and the message never doubles in height; the bubble keeps its width
      on a flip, and the iframe mounts once); schema v12. *Exit:
      core 683 · web 440 · extension 57 · typechecks 0 · NSIS packaged app
      boots env-free (demo, schema v12); live + packaged UI sweeps green.*
- [x] **M12 — UI readability & polish pass (detailed spec: `PLAN-M12.md`).**
      Responsive shell (header ≤ 80px, nav shrinkable, rails adapt below
      1280/960), accent-on-surface-2 contrast-gate fix (light), 16px
      token-styled nav icons, grouped view order + collapsible Notes lane,
      dense-list legibility floor. No new features; token-only; suites and
      ux_audit gates stay green. *Exit: PLAN-M12 P0–P2 ticked; geometry
      gates at 1440/1280/1024/900/780 (no overflow, composer ≥ 320px @900);
      light+dark+custom walks green; fresh-context review closed.*
- [ ] **M13 — Purpose providers & in-session model switch (detailed spec:
      `PLAN-M13.md`).** Image-turn vision handoff (implicit text-model
      turns with an attached photo reroute to a vision-capable model;
      explicit picks never overridden; shared vision capability in
      `shared/src/vision.ts` — NOTE: the capability RULE changed in M24,
      which made it declared-per-provider rather than name-matching only); per-message model picker in chat
      (`providerId` + `model` per turn); purpose-provider bundle with model
      assignment (`POST /v1/providers/discover` + `/v1/providers/purposes`
      `modelPins`: one endpoint + key → one profile per purpose carrying
      exactly the models you choose, first = default; key in each keychain
      item). *Exit: core 681 · web 470 ·
      typechecks 0 · ux_audit green on new UI · live manual walk
      (env-gated).*
      *State: implemented + verified (suites/typechecks/ux_audit per the
      README M13 note). Box left open: the exit list also records a live
      manual walk (env-gated) that has not yet been executed.*
- [ ] **M14 — Scheduled & autonomous work (detailed spec: `PLAN-M14.md`,
      implemented + live-walked 2026-09-07; packaged-app walk (shell/NSIS)
      env-gated remains).** Personas carry
      schedule definitions (`independence.schedules[]`: daily / weekly /
      interval + prompt + tz, JSON column on personas, schema v13); a
      scheduler driver fires due schedules (auto/autonomous, unpaused,
      enabled personas only) and drives each as a HEADLESS bounded persona
      tool-loop run (shared playbook engine): brief lands as a user turn in
      the schedule's own conversation thread, the answer appends on done
      (+ optional save-note), one `scheduled_runs` row per attempt (status
      running/done/queued/error/loop_exhausted + pendingId), audits
      `schedule.run`/`schedule.resume`/`schedule.skip` (ids+counts only).
      Queued tools pause the run; deciding the approval from the Files queue
      or the in-chat card auto-resumes it in-process; a paused persona is a
      kill switch for new runs AND resume. Routes: run-now (headless fire),
      run history + detail; schedules edit via the persona surface.
      *Exit: core 715 passed · typechecks 0 ·
      ux_audit green on the schedule editor + runs panel ·
      decide-hook e2e (real loop approve+deny auto-resume) · live walk
      executed 2026-09-07 (api.ne1.dev + Brave; approval pause → headless
      auto-resume → done + note; found/fixed resume save-note bug) ·
      packaged-app walk (shell/NSIS) env-gated.*

- [ ] **M15 — Live desktop mode (exit demo; detailed spec: `PLAN-M15.md`).**
      Packaged shell boots LIVE by default (persistent whole-file-encrypted
      DB + OS-keychain key + skills under the per-user app-local data dir,
      not the install dir); a per-boot device secret enables the
      header-guarded `GET /v1/pair/device` code channel; the tray (Show
      pairing code… / Open Partner / Quit) surfaces the live pairing code;
      the PairGate is health-aware (live copy + no demo button).
      `PARTNER_DEMO_MODE=1` keeps the demo boot.
      *Exit: core 726 passed · typechecks 0 · web tests + build green ·
      windows-build green · live packaged-boot walk (tray → pair → chat →
      restart-survives, ciphertext DB, demo override) · HANDOFF refreshed.*
- [ ] **M16 — Knowledge workspace (implemented + verified 2026-09-09;
      detailed spec: `PLAN-M16.md`).**
      Notes relationship graph (view notes + relationships; edge direction =
      who references whom, mutual refs render bidirectional; React Flow,
      `@xyflow/react`, drag positions persist; reuse for brainstorming and,
      later, doc building); **Brainstorm from notes & captures** (activates a
      new **Brainstorming** persona `p-brainstorm`, seed-created on demand if
      missing; bundle ≤ 20 note excerpts into a persona-bound conversation);
      **versioning for notes & captures** (snapshot every mutation at one
      choke point — covers quick captures, promote, summarize, restore —
      history + diff + undoable restore); **Discuss in Assets** (asset
      discussion becomes a branch/thread of the same discussion — origin
      conversation — or optionally **forks into a new discussion** via
      `conversations.parent_id`/`source_asset_id` lineage); **Assets →
      Export works in the Desktop app** (native save-dialog path in the
      Tauri shell + blob fallback for browsers); **CSV assets render as
      tables** (pure shared RFC-4180 parser + token-only table view). Schema
      v13 → v14 (additive). **Follow-up (v14 → v15):** brainstorm
      conversations link back to their source note/capture set
      (`brainstorm_sessions` + `brainstorm_sources`); the graph badges those
      nodes and reopens an ACTIVE session instead of duplicating it, while a
      concluded session stays listed with **Reopen**. *Exit: core + web + shared suites green ·
      typechecks 0 · web build green (React Flow) · windows-build green ·
      `ux_audit` green on new UI (light + dark) · manual walk (graph,
      brainstorm persona auto-create, versions/restore, discuss + fork,
      packaged export save dialog, CSV table) · HANDOFF refreshed.
      *State: shared 51 · core 837 passed (2 encryptedDb cipher failures
      pre-exist at HEAD — environment) · web 486 · typechecks 0 · web build
      green (@xyflow/react) · ux_audit green. Box open: shell
      windows-build (no local Rust; CI workflow) + the packaged live walk
      are env-gated, matching M13/M15 precedent.*
- [x] **M17 — Note projects (implemented + verified 2026-09-11).** An
      organizational layer over the shared Projects/Folders tree: notes join
      projects many-to-many, with **no membership = Inbox**. One membership
      write path (`setFolders`) backs both create-time `folderIds` and
      re-filing; `list()`/`graph()` scope by folder subtree or Inbox, and a
      scoped graph returns one-hop **ghost** nodes for out-of-scope
      references (marked external, never persisted). Deleting a folder clears
      membership (notes survive); deleting a note cascades its membership
      rows. Routes: `GET /v1/notes?folderId=<id|none>`,
      `GET /v1/notes/graph?folderId=…`, `PUT /v1/notes/:id/folders` (501 when
      folders are unwired). Notes list + graph gain project scope selectors,
      project chips, an editor Projects multi-select, dimmed ghost nodes with
      an “other projects” toggle, drag-to-ghost, and a “Link to note…” picker.
      Schema v15 → v16 (`note_folders`); audit stays membership counts only.
      *Exit: root + web suites green · typechecks 0 · web build green ·
      `ux_audit` green on the new UI.*
- [x] **M18 — Chat multi-question forms (implemented + verified
      2026-09-11).** When a persona has **more than one open-ended question**
      it emits a `:::partner.form` container instead of a prose list; each
      question renders in its own textarea and the user submits **once**. The
      answers become a single labelled user turn through the normal chat path
      (nothing client-only; the persisted text is unchanged). The parser
      shares the `:::partner.*` grammar (`shared/src/structured.ts`): one
      question per bullet line, a title from the `title=` attr / fence tail /
      lead line, closed-container-only materialization so streaming stays
      safe, and malformed or unclosed blocks degrade to plain prose. Pending
      drafts survive switching conversations (client-side per-conversation UI
      memory). The `forms` guidance ships in the default structured feature
      set alongside choices and assets; styles are token-only. *Exit: root
      suite 877 passed (1 pre-existing platform-specific MCP spawn case) ·
      web 539 passed · typechecks 0 · web build green · `ux_audit` green.*
- [x] **M19 — Persona-scoped memory & automatic remember (implemented +
      verified 2026-09-12; detailed spec: `PLAN-M19.md`).** Personas gain
      **private memory**: a per-persona tick (`memory.personaMemory = on|off`,
      off by default) makes a persona keep its OWN facts about the user and
      recall them **only while chatting with it** (the interactive `/v1/chat`
      route) — never in another persona's prelude, and never in the headless
      playbook/schedule/brainstorm loops. Global confirmed facts still tailor
      every persona (M4). **Automatic remember**: with private memory on, the
      core asks the persona's cheap-task-class model — out of band, AFTER the
      client's response has ended — whether the finished exchange holds
      anything durable about the user, and files findings as
      `partner_suggestion` / `suggested` entries **labeled global or
      persona-scoped** for confirmation in the Memory view (alongside the
      existing explicit add-a-fact path). The extractor prompt is fixed and
      never user-derived; parsing is defensive (fence/JSON guard, kind whitelist, caps,
      obvious-secret filter); dedupe covers global + same-scope entries,
      rejected included, so a rejected fact is never re-suggested;
      demo/no-provider turns skip; audit rows carry ids/counts/model only. Web:
      a Memory fieldset in the persona editor, a persona-aware “in use”
      marker, and an “Auto-detected” provenance chip. No schema change (M4's
      `profile_entries.persona_scope`/`source` and the `personas.memory_flags`
      JSON were enough). *Exit: core 893 passed (5 env-gated skips) · web 541
      passed · typechecks 0 · web build green · `ux_audit` green (APCA
      light + dark).*
      **Follow-up (global auto-remember):** the extractor now labels each
      finding `scope: "global"|"persona"` (missing/unknown → persona). Global
      findings file `personaScope: null` and, once confirmed, tailor **every**
      persona — so the partner learns a fact once (name, language, standing
      tone) instead of per persona; persona findings stay scoped. Dedupe
      covers both scopes and never files the same value twice. `memory.remember`
      audit gains `globals`/`personaScoped` counts (still content-free). Web
      copy (persona-editor Memory hint, Memory privacy note) explains the two
      scopes. *Exit: core suite green · web 712 passed · typechecks 0.*
      **Follow-up (turn-target fallback):** extraction no longer silently
      no-ops when the persona's cheap/chat resolver yields no model — it rides
      the provider client + model that actually served the turn
      (`RememberInput.fallbackTarget`), so a provider with no default models
      (per-message model picks) still remembers. Route test proves a
      default-model-less provider files a global suggestion from a turn's
      explicit model. **Follow-up (independent global consent):** global fact
      detection no longer rides the per-persona private-memory toggle. A
      user-level `memory.autoRemember.global` setting (settings table, default
      ON, `GET`/`PUT /v1/memory/settings`) governs facts that apply to every
      persona; the persona toggle governs only persona-scoped facts. The chat
      route enqueues extraction when either is on and passes a per-turn policy
      so only consented scopes are filed. Web: an “Automatic memory” card in
      the Memory view; persona-editor copy scoped to persona facts. No schema
      change. *Exit: core 1158 passed · web 733 passed · typechecks 0.*
      **Follow-up (review before suggest):** extraction reviews existing memory
      and pending suggestions before proposing — a bounded, value-capped
      `ALREADY KNOWN` listing (confirmed + still-pending, global + the
      persona's own scope; rejected withheld) rides the payload with a fixed
      “never return a listed fact, even reworded” instruction, and the
      normalized dedupe key ignores punctuation so a fact already known or
      already suggested is never filed twice. *Exit: core 1334 passed (5
      env-gated skips) · web 760 passed · typechecks 0.*
- [ ] **M20 — Client-server, multi-user & mobile (detailed spec:
      `PLAN-M20.md`; decisions locked 2026-09-12; M20.A in progress).**
      Partner grows a remote, multi-device, multi-user server role.
      **Model A′ (§3.1):** the core splits into two roles with two key
      scopes — a **Vault** on the user's own machine holding the user key and
      **Tier C** (memory, notes, chat, attachments, provider keys, project
      roots), and an always-on **Runner** holding only a job key and
      **Tier W** (schedules, briefcases, run outputs) — so scheduled work runs
      while the desktop sleeps while the operator never holds a key to private
      data. Pre-authorized, capped, expiring **briefcases** plus a one-way
      **drain** at unlock replace sync. **Multi-user by partition (D4):**
      `data/users/<id>/partner.db` with its own cipher key and skills dir
      (generalizing today's per-OS-user isolation, §2.3); user / device /
      client-class are three levels, and **device = session**, so multi-device
      is per-user for free. System-wide config gets a separate local/admin-only
      read path now (**M20.E deferred**). Sensitive-data prerequisites (D5,
      §8.1): close the core-served-`text/html` same-origin hole, keep content
      out of web storage, pin the cert via QR. Phases: **A** mobile/tablet/
      touch UI (no core change) · **B** the server role (TLS, named host
      allowlist, QR pairing, device registry + revoke, client-class capability
      envelopes, per-user partition) · **C** PWA · **D** optional Tauri v2
      native shell · **E** system layer (later).
      *Exit:* refusal matrix (live/remote/TLS) · two users provably isolated
      (DB, key, skills, audit; a query cannot cross) · the Runner cannot open
      `vault.db` · briefcase caps + idempotent drain · a mobile-class session
      denied file-write/deploy/skill-install · QR pairing single-use + expiry +
      lock · real phone pair → chat → approve → revoke · geometry gates at
      430/390/375/360 · `ux_audit` green.
      *State:* **M20.A (mobile/tablet/touch UI) implemented + measured
      2026-09-12** — composer 58→326px @390 and permanent chrome 252px→0 on
      phone, controls under 44×44 11→0, tablet geometry unchanged, `ux_audit`
      PASSED, web suite 547 (+6 nav tests), typechecks 0, build green.
      **M20.A follow-up (same session):** the *message field* (not the
      container) was still 49px — text buttons took 214px of the row — now
      **222px (62%)** with icon-only 44px controls; persona cards 584→**340px**
      (~2.5 per screen) with a full-width action row and **0** sub-44px
      controls (was 52); and new **attention badges** (`web/src/lib/attention.ts`
      +18 tests) so memory suggestions can no longer sit unnoticed — the phone
      **More tab carries the aggregate** of what the sheet hides, verified
      `3` → reject → `2`. Web suite now **565**. Rules recorded: a badge must
      be able to clear itself (failed runs self-clear on a 24h window) and
      `queued` runs are excluded everywhere (a paused run *is* the pending
      approval).
      **M20.A follow-up 2 (same session) — Memory view:** the same flex-crush bug
      in three places, plus a legibility floor this view was **missed by M12**.
      `.mem-control-text` is `flex: 1; min-width: 0`, and `min-width: 0` lets a
      flex item shrink *below* min-content, so the control-row copy collapsed to
      **9–11px (one character per line)** — the Import row 411px tall — and the
      Memory controls card ran 1483px. Entry rows were worse: a 42-character
      entry rendered a **20px value column 399px tall** (my first fix attempt
      targeted `.row-actions`, which only exists elsewhere; the real container
      is `.mem-actions` — found by re-measuring). **Suggestions** failed for a
      different reason: 32+32+24+24 = **112px nested padding per side (57% of a
      390px viewport)** left a 135px measure, which is also why Confirm/Edit/
      Reject stacked into a 148px column. Flattened to one 16px gutter per
      level: measure 135→**263px**, suggestion 450-471→**293px**. Copy/chips
      12→**14px**. Memory view total 5436→**4075px (−25%)** while the measure
      nearly doubles; sub-44px controls **12→0**. `ux_audit` PASSED (18 pairs).
      Recorded: `--danger` on the light card surface is **Lc 75.42** vs floor 75
      — thin, so it fails first if either token is retuned. **Recommended but
      NOT applied:** "Forget everything" is the *first* row of the controls
      card, putting the most irreversible action in the most prominent position;
      portability-first / destructive-last is the safer convention, but that is
      a product decision (see `PLAN-M20.md` §12).
      **Applied recommendations (2026-09-12, same session):**
      **(1) `PLAN-M20.md` §8.1.1 — the live security hole is CLOSED.** Core-served
      `text/html` executed on the SPA's own origin where the session token
      lives. One exported policy (`attachmentContentHeaders()`) now keeps only
      images and PDF `inline` and forces everything else to `attachment` +
      `Content-Security-Policy: sandbox`; HTML upload is unchanged (the model
      legitimately reads attached HTML) and `CodePreview`'s sandboxed path still
      previews it. Verified no SPA regression: the app fetches attachment bytes
      with a Bearer header, and `fetch()` ignores `Content-Disposition`, so only
      direct navigation changes. 8 new tests in
      `core/test/http/attachmentContentSafety.test.ts`; root suite **893→901**.
      **(2) Memory controls reordered** to Export → Import → Forget before a
      date → Forget everything (portability first, destructive last, severity
      escalating, 32px separation), verified rendered in a browser.
      **(3) `.preview-frame`'s `#ffffff` tokenised** as `--surface-doc` — the
      stylesheet now has **no raw hex in any declaration**.
      **Two of my own claims were corrected:** there was never a touch
      re-filing gap (`.rail-item-move` is a `<select aria-label="Move … to
      folder">`, measured 66×44 — I built nothing for it), and the
      `--rail-action-w` token I suggested was a bad idea (the width is
      label-driven, so a token would be false systemisation).
      **M20.A follow-up 6 (same session) — one submit per question set.**
      Fixes a reported bug: a reply carrying a choice **and** a set of free-text
      questions rendered two cards with two independent submits ("Confirm" /
      "Submit answers"), and pressing either sent only its own answer while the
      other was silently discarded. `web/src/lib/answer-group.ts` (pure, 15
      tests) owns the message-level rule — `answerableCount > 1` groups, so a
      single-container message keeps its existing button untouched — and
      `composeGroupedAnswer` joins each part with the exact string that card
      would have sent alone, so only the *arrival* changes. `AnswerGroup.tsx`
      owns the one submit; grouped forms require every question; the group locks
      after sending ("Answers sent") so one prominent button cannot double-post.
      **Verified through the real chat path** (a throwaway loopback
      OpenAI-compatible stub, since the demo provider cannot emit containers):
      1 group · **exactly 1 submit** · **0 per-card submits** · gate walks
      disabled→disabled→disabled→enabled with hints 2→1→1→none · the single press
      produced **one** user turn containing both the choice and the Q/A pairs.
      `ux_audit` PASSED. *Open:* the answered-lock is per page session (a reload
      makes an answered group answerable again — pre-existing behaviour, needs a
      message-level marker to fix properly).
      **M20.A follow-up 7 — danger-on-well sweep + chip contrast (DONE):** a
      subagent wave (scout + 3 writers + fresh-context reviewer) found the
      grouped-answer lock should derive from **transcript position** rather than
      client storage (no new key, and it survives reload, a different device and
      cleared storage), and swept **16 selectors** whose light-mode `--danger`
      text sat on a `--surface-2` well at **Lc 69.52** against a 75 floor
      (`.theme-row`/`.mcp-server-row`/`.p-milestone` ghost danger controls,
      `.attach-chip-remove`, and `.row-error`/`.chat-attach-error` copy) → now
      **80.88**. The gate also caught two pre-existing chip defects, both fixed:
      `.attach-chip-preview` accent on a well (**69.02** → `--accent-hover`
      **77.08**) and `.attach-chip-meta` `--text-faint` (**68.86** →
      `--text-muted` **81.40**). The reviewer found **2 MAJOR defects the parent
      had missed**: `.answer-group-parts` had **no CSS rule** (0px separation
      between question sets) and **no test rendered `AnswerGroup`** — deleting
      `showSubmit={false}` restored the original bug with the suite green; both
      fixed, the latter now falsified as non-vacuous. **Lane failure recorded:**
      the first danger sweep produced nothing (a forked worker continued the
      parent's reasoning); retried with `context: 'fresh'`. Verification +
      arbitration record: `docs/VERIFY-MOBILE.md`.
      **M20.A follow-up — phone persona picker (FIX, reported bug):** the list was
      unusable on a phone while looking fine in the DOM. The top bar is a
      horizontal scroller and `overflow-x: auto` forces `overflow-y: auto`, so
      the absolute `.picker-pop` sat inside a scroll box — measured @390×844
      with 9 personas it laid out **655px** tall but painted only the bar's
      **60px** band (**1 of 9** options), and the open-time focus scrolled the
      bar up **65px**, hiding the trigger. ≤640 now renders the list as the
      **same bottom sheet as the More control** (fixed, full width, anchored on
      the tab bar, `max-height: 60dvh`, scrollable, rows `flex: none`), and the
      base popover gained a `calc(100dvh - …)` bound because a **landscape
      phone (844×390) is outside the width-based tier** and its tail was
      unreachable too. Measured after: fully in-viewport with the last option
      reachable at 360×640, 390×844, 844×390, 768×600, 1280×900; rows ≥71px;
      bar `scrollHeight` 715→**60**; desktop popover unchanged. New guard
      `web/test/picker-mobile.test.ts` (**+7**), falsified against a reverted
      `position: fixed`. `ux_audit` PASSED (picker rules, 8 APCA pairs);
      web suite **635→642**.
      **M20.A follow-up — the top bar owns the chrome (Assets + Theme moved up):**
      reported as "Assets seems redundant … one at the top, and another near chat
      input." Verified worse than two: **three** controls for one action (top-bar
      icon, labelled chat-bar button, in-pane chevron), the first two bound to the
      same handler/state, on screen **579px apart**, disagreeing on enabled state.
      Then two owner criteria in sequence: **maximise chat input width** (measured:
      phone input **222px either way** — the lane is an absolute overlay; desktop
      **682 → 366px (−46%)** when it opens, and only the *ungated* top-bar icon
      could do that with nothing to show), and finally **"move Theme and Assets to
      top"** — which is also the shell's own M14 design ("a slim top bar (persona
      picker + lane/theme controls)"). Final state: top bar = persona ·
      conversations · notes · **assets** · **theme** · mode, with the assets toggle
      still gated on a conversation; the row above the composer keeps only
      brainstorm state and the save flash, and renders only when it has content.
      Measured after: desktop 6 controls / 523px in 1008px, no scroll; phone 6
      controls / **318px** in 358px, **no scroll**; phone transcript **513 → 565px**
      (a 52px row directly above the composer is gone); theme bind proven end to
      end ("Midnight" → `preset-midnight`, surviving a reload). One trade on the
      phone: the **level** chip yields its 31px (`Paused` never does). Guards in
      `assets-lane-controls.test.ts` (5) + `picker-mobile.test.ts` (+1), both
      falsified. Web suite now **648**.
      **M20.A follow-up 9 — tap outside a floating pane to put it away (DONE,
      measured in-browser @390×844 / 700×900 / 1280×900).** On a touch tier the
      rail (≤640) and the two right-hand lanes (≤760) float over the transcript,
      so until now the only way back was the toggle that had opened the pane:
      measured the open rail covers **320 of 390px** and those toggles live in a
      horizontally scrolling top bar — the one gesture a touch user knows (tap
      the content you can see) did nothing. It does now, and the pane **slides
      out to its own edge** before its state closes (frame trace 0 → −83 → −204
      → −273 → −306 → −319px over 180ms = `--motion-base`, then the pane
      closes), so leaving looks like arriving. The scrim is scoped to
      `.chat-workspace` (measured 390×728 from y=60 — the top bar's bottom
      edge), so the toggles that opened the pane stay live and undimmed, and the
      desktop column model is untouched (**0** scrims at 1280 and a click on the
      transcript closes nothing). Floating panes are mutually exclusive at the
      phone tier (they overlap by **202px** there), and a reduced-motion
      preference closes at once rather than waiting for motion that is disabled.
      Decision + tier numbers in `web/src/lib/panels.ts`; `panels.test.ts` (+16)
      anchors them to app.css, pins the cascade order (exit declared after
      entry), the one scrim value and the reduced-motion fallback — both
      falsified (a tier predicate returning `true` failed 2, swapping the
      animation order failed 2). Web suite **673 → 689**; typecheck 0;
      `ux_audit` PASSED; bundle green.
      **M20.A follow-up 10 — the sidebar minimize toggle, tablet AND desktop
      (DONE, measured in-browser @1440×900 / 1024×900).** M12 collapsed the
      sidebar to an icon rail automatically below 1150px, which left the
      labelled **224px** menu on every wider viewport with no control to reclaim
      it — and an iPad in landscape reports **>1150 CSS px**, so “tablet” and
      “desktop” both meant 224px. The rail is now a **state**
      (`.app.side-minimized`, one `--side-w` knob) that the tablet query only
      *defaults*: measured sidebar **224 → 60px** and content column
      **1216 → 1380px** (the 164px returned to the view), tabs 44px with a
      centred icon, and at 1024 the default is the rail with the toggle able to
      restore a 200px labelled menu. The **attention badge survives** collapse on
      the button's corner (verified with a real attention item: 24×28, inside the
      44px button and the 60px rail) — the old rail hid badges at ≤1150, the
      exact failure M20.A shipped badges to prevent. The toggle lives inside the
      sidebar (so the phone tier cannot show a dead control), is 44×44 on touch
      tiers, remembers the choice per session, and crossing into the tablet tier
      collapses once rather than fighting the user. Decision + tiers in
      `web/src/lib/nav.ts`; `sidebar-collapse.test.ts` (+10) pins the state/knob,
      the tier-only *default*, the badge, the touch floor and the absence of a
      width transition — falsified 4 ways. Web suite **689 → 699**; typecheck 0;
      `ux_audit` PASSED; bundle green.
      **M30 — one left panel: conversations under the Chat entry (DONE).** The
      conversation list and its folder tree moved out of the second “Chat” rail
      column and into the sidebar, nested under the Chat destination; a
      disclosure chevron separates “open Chat” from “show/hide the tree”
      (session-only state, no new storage key). Above the phone tier this is the
      only home for the tree, so the transcript reclaims the rail's width; at the
      phone tier the sidebar is hidden, so `ConversationRail` still renders as
      the floating overlay opened from the top bar. Folder create/rename/delete,
      drag-to-move and drag targets are otherwise unchanged — the `embedded`
      prop only drops the fixed 288px column width and fits the sidebar.
      `railWidth` is retired (the tree fills the sidebar), so
      `security-guards.test.ts`'s storage allowlist dropped
      `partner.railWidth`. DESIGN.md §Responsive updated.
      `one-left-panel.test.ts` (+12) pins the one definition, the two render
      sites, the bounded/sidebar geometry and the phone overlay. Web suite green
      (57 files / 956 tests); typecheck 0; bundle green.
      **M31 — Settings, persona cards, and a magazine Notes & Plans (DONE).**
      Three requested changes in one pass. (1) Sidebar IA: Providers, Themes,
      Audit and Members moved into a new **Settings** group; Studio is now
      personas/skills/playbooks and Tools is files/memory (`NAV_GROUPS`;
      `nav.test.ts` +1 pins the membership and that Settings is last).
      (2) Personas became a wall of business cards (`PersonaManagerView`): the
      card face opens a slide-out `role="dialog"` drawer holding the full
      editor plus the theme bind, while Pause (the kill switch) and Delete stay
      on the card. One editor instance; Escape and the scrim close it; dead
      inline-editor classes removed. (3) Notes & Plans got a magazine layout
      (`NotesView` masthead + scoped CSS): folio/kicker, `--fs-xxl` title and
      deck, hairline section rules, a 1200px measure (1360px ≥1600), and an
      `auto-fill` river with the newest item as a full-width lead; the note
      editor and plan planner keep their card surface. Token-only and
      reduced-motion safe. `m31-redesign.test.ts` (+11) pins the structure and
      the geometry. Web suite **58 files / 967 tests**; typecheck 0; bundle
      green; verified in-browser at 1440 and 1024.
      **M32 — persona-owned sessions, a resizable menu, a Catalog deck, and
      tracked memory (DONE).** Four requested changes in one UI pass. (1) The
      conversation/session tree moved out of the Chat entry and under
      **Personas**: each persona is a disclosure listing its chats
      (`PersonaChatTree`; grouping is the pure `groupConversations`, and a chat
      whose persona is gone stays visible under an explicit **Unassigned**
      group). Chat is a destination plus a `New chat` action, and the phone
      overlay still uses `ConversationRail`. (2) The Skills **Catalog** segment
      became a Personas-style card deck whose card face opens a slide-out
      detail drawer (`CatalogDrawer`) reusing the persona deck/drawer classes,
      so the two pages cannot drift. (3) The left menu is drag-resizable via
      the shared `ColumnDivider` (180–420px, `partner.sideWidth` per session);
      the inline `--side-w` applies only while expanded, so the 60px icon rail
      is never overridden. (4) Memory: a pending suggestion carries a one-step
      "applies to" persona select, rejected facts load into a collapsed
      **Rejected** panel with Restore, and the extractor receives a same-scope
      `REJECTED` block (`formatRejectedBlock`) alongside `ALREADY KNOWN`, so a
      declined fact is not re-asked even reworded. The chat transcript no
      longer flips a fenced HTML/CSS block into an inline sandboxed iframe
      (`allowInlineCodePreview` stays on for Notes/Assets; chat passes
      `false`). No schema change. `one-left-panel.test.ts` rewritten,
      `persona-chat-tree.test.ts` (+3), `skills-catalog-view.test.tsx` (+5),
      `sidebar-collapse.test.ts` (+3), `markdown.test.ts` (+1) and
      `remember.test.ts` (+2) pin the decisions. Web suite **60 files / 979
      tests**; core remember green; typecheck 0; bundle green; verified
      in-browser at 1440 (deck + drawer, rejected panel, scope select).
      **M33 — multi-persona memory scope (DONE).** Requested change: Memory's
      "Applies to" offered All personas **or exactly one** persona; it now
      offers All personas **or any set** of them. (1) **Wire + store:**
      `ProfileEntry.personaScopes: string[]` replaces `personaScope`, EMPTY =
      every persona; the deprecated single field is still accepted on input
      (add/update/import/bundle) and mapped to `[id]`/`[]`, so an old caller or
      an exported `memory/v1` file keeps its scope instead of silently widening
      it. Schema **v23 → v24** adds `profile_entries.persona_scopes` (JSON id
      array, `NULL` = global) and backfills each legacy `persona_scope` row into
      a one-element array exactly once — version-gated, so reopening can never
      resurrect a scope the user has since widened (`db-migrate.test.ts` +3, the
      seven SCHEMA_VERSION tripwires bumped to 24). (2) **Behavior:** tailoring,
      auto-remember's known/rejected/dedupe listing and
      `GET /v1/memory/profile?personaScope=` all read the set as membership, so
      a fact shared by two personas is honored by each of them (and only by
      them). (3) **UI:** the three scope selects (edit form, add form, and M32's
      one-step suggestion re-scope) became ONE `ScopePicker` checkbox set —
      "All personas" IS the empty set, unticking the last persona returns to it,
      and a persona the local list no longer has stays ticked as "Removed
      persona" so opening a fact cannot widen it; the suggestion's control is a
      `Change` disclosure whose open state survives the write. Token-only, 44px
      options at the phone tier, focus ring + disabled state declared.
      `memory-scope-picker.test.ts` (+12) pins the structure, tokens and states;
      `memory-helpers.test.ts` (+8), `memory-api.test.ts` (+2), core
      `profile/tailor/transfer/remember/memoryRoutes` (+13) pin the algebra and
      the wire. *Exit: core 162 files / 1633 passed (5 env-gated skips) · web 61
      files / 999 passed · typecheck 0 · bundle green · `ux_audit` green (APCA
      Lc ≥ 75 body + ≥ 30 non-text, light + dark, 0 hardcoded values) · verified
      in-browser against a demo core (two personas saved and re-read after a full
      reload; suggestion re-scoped in place; widening back to All personas shows
      "In use"; 10/10 options measure 44px at 390×844 with 0 overflow).*
      **M20.A follow-up — phone Notes view crowding (QUEUED, measured, NOT
      started).** Reported as "mobile view is too crowded"; a scan of all four
      phone tabs found Chat/Files/Personas clean and **Notes is the offender** —
      its chrome is deeper than the viewport (measured @390×844: toolbar 235px in
      **5 wrapped rows**, scope bar 128px in 3 rows, three stacked control
      cards, and the **search field 405px below the fold** at y 1249) with
      **3 controls under the 44px floor** (`Graph` 72×35, `Select` 71×35,
      `New project` 111×35). Proposed: hide the desktop explainer paragraph on
      phones (precedent: `.persona-theme-hint`), 2 toolbar rows with secondary
      actions behind a `⋯` overflow (precedent: the phone's More sheet), a
      one-row scope bar, and the 44px floor applied to the 35px controls. The
      only product call is moving 4 actions one tap deeper. Full measurements +
      *Exit:* in `PLAN-M20.md`.
      Verification record — plus the explicitly unverified list (no visual
      inspection; the `hover: none` branch not runtime-exercised; safe areas
      and keyboard unproven; no background/OS notification delivery; the two
      irreversible forget actions were **measured but never pressed**; whole-file
      `ux_audit` outstanding; geometry not a CI gate) — in
      `docs/VERIFY-MOBILE.md`. **All gates are now closed (D1–D5 + §12 Q1–Q12):**
      the owner directed that the blockers be cleared, and each now carries a
      decision with its consequence stated (`PLAN-M20-B.md` §6). Four are marked
      ⚠ because their cost lands on how the product is *used*, not just built:
      **D5** the Runner must be a machine the user owns (no shared/multi-tenant
      VPS in v1 — cost: the product assumes an always-on device); **Q2** user
      creation is local-only (cost: a remote owner cannot add a family member);
      **Q4** a mesh VPN is the supported path with cert-fingerprint pinning on the
      LAN fallback (cost: LAN-without-mesh is explicitly lower-assurance); **Q11**
      un-drained Runner results are expendable. Also decided: briefcases are
      tag-selected with **enforced** caps (≤ 20 items / ≤ 256 KB / ≤ 24 h TTL), the
      drain is **append-only**, the per-user layout uses **N rails** (so cross-user
      reads are structurally impossible rather than relying on every call site),
      `users`+`pairings`+`sessions` live in a **system DB** with today's
      `data/partner.db` treated as user #0, and the `extension` class is
      read+browser+chat only.
      **Deferred reviewer nits cleared, not deferred:** the guards file's
      duplicated allowlist (lifted to module scope behind a shared
      `declaredPartnerKeys()` — which surfaced a real `/^partner./` vs
      `/^partner\./` regex bug introduced during the edit), the unbounded
      `<ReactMarkdown` slice (now brace-depth-bounded, strictly stronger), the
      wrong `strip`/`clobber` rationale, and two false "no DOM harness"
      premises. The storage census's blind spot is narrowed: inline key literals
      passed to storage calls are now covered (with a non-vacuity proof); a key
      held in a *variable* remains invisible and is documented as such.
      Remaining: **M20.B (the server role) — scoped, every gate decided.** Slice
      plan in `PLAN-M20-B.md`; status table in its §3.0.
      **M20.B third wave (S7 WIRING) LANDED 2026-09-13 — a real phone can now
      obtain a mobile session.** `POST /v1/pair/payload` issues a 256-bit
      single-use secret to a **loopback** caller (and refuses without remote
      access + TLS, so no secret is ever carried over plaintext);
      `POST /v1/pair` accepts `{secret}` from anywhere and mints **`mobile`** —
      never `desktop` — while `{code}` is refused from a non-loopback **socket
      peer** *before* it is verified, so a remote caller can neither consume nor
      lock the code on the user's screen. Locality is the peer address, not the
      `Host` header (§2.1). Both paths are rate-limited per peer and a successful
      pair resets the bucket. Client half: the SPA reads `#pair=…`, re-validates
      the payload itself (https, canonical 32-byte base64url), confirms once and
      clears the fragment; the Providers screen issues links. Root suite
      1109 → **1131**, web 619 → **638**, typechecks 0, build green,
      `ux_audit` PASSED (24 pairs, light + dark), geometry measured at 1280/390
      in both modes (no overflow, 0 controls < 44px, copy 73 chars/line).
      **The audit also exposed a pre-existing defect, now fixed:**
      `.field::placeholder` used `--text-faint` (Lc 68.86 light / 48.02 dark,
      below the 75 floor) — placeholders are instructive text, so they now use
      `--text-muted` and `DESIGN.md` reserves `--text-faint` for disabled text.
      **Not done:** QR rendering (no encoder dependency — the link is shown as
      text), the shell-side "copy pairing link", and a real phone/TLS walk
      (env-gated). Issuing a link is loopback-only, so a deployment that turns
      remote access on needs a local loopback route to the allowlisted host
      (hosts-file alias) — stated in the UI copy and in
      `docs/VERIFY-M20-B.md`.
      **M20.B second wave (S4/S5/S6 WIRING) LANDED 2026-09-12:** the capability
      envelope now **enforces** — 21 route mounts, `ExecContext.clientClass`, and
      the refusal ordered **before** the grant check; the device registry
      (list/revoke/revoke-all, 404-not-403 across users, no token material on the
      wire); and the transport matrix (`REMOTE_ACCESS` + TLS files + a named
      `ALLOWED_HOSTS`, https listener, `startServer` re-asserting the refusal).
      Root suite 1066 → **1109**, typecheck 0, build green.
      **The review found three BLOCKERS — the envelope was bypassable three ways,
      all now fixed:** (1) the **approval queue** (`broker.decide` took an actor
      *label*, not a class, so a mobile session could approve a queued write and
      have it run, or acquire a grant via approve-and-remember); (2) the
      **persona/skill/playbook tool loops** reached the broker class-less, so a
      mobile *chat turn* executed with **desktop authority**; (3) **MCP server
      CRUD** was ungated while an enabled server is **spawned as a process** —
      code execution, which I had underestimated as configuration hygiene. Also
      fixed: the S5 transitional rule was keyed on the *caller* having no user, so
      a user-less session could read **and revoke a named user's devices** (now
      scoped to `user_id IS NULL` — identical today, hole closed for the future);
      `startServer` re-asserts the transport refusal; and an unmapped tool now
      fails closed for **every** class including desktop.
      **At the end of wave 2 enforcement was unreachable; the S7 wiring wave
      closed that.** As written at the time: **S7** (pairing secret +
      client-class delivery) was unwired, so a mobile session could only be
      minted in tests and `/v1/pair` minted `desktop` with `user_id` NULL.
      **Since the third wave (2026-09-13, above) a real phone can obtain a
      `mobile` session.** Remaining: **S8**, **S9**, plus the recorded
      vocabulary gap (provider key writes and autonomous firing have no capability
      name — a reviewed decision, not a tidy-up). Record:
      `docs/VERIFY-M20-B.md`.
      **Added after the gates closed — pairing is not authentication** (raised by
      the owner: the local desktop copy pairs, but a multi-user web version needs
      different handling). Verified: the only session mint site is
      `sessions.create('web', origin)` with **no user**, and `SessionRow` has no
      `user_id`, so pairing proves *device enrollment by proximity* and cannot
      answer *which user a session acts as*. Now separated into **enrollment →
      authentication → authorization**, with the rule that a session never carries
      a user without an authentication event. The **desktop copy is unchanged**
      (on a single-user install enrollment implies the OS-profile user #0, so the
      PairGate stays byte-identical); a multi-user core mints an acting session
      only after sign-in, and one device may hold sessions for several users, so
      revoke is per (device, user). Credential primitive: **per-user passphrase**
      (argon2id/scrypt in the system DB), passkey as a later adapter behind the
      same seam. **Sign-in doubles as the partition unlock event**, which resolves
      §4.4's operator-readable-store problem for a hosted multi-user core at a
      per-user, explicit, audited cost to headless schedules. This adds slices
      **S2a** (credentials) and **S9** (per-user unlock) and raises **S6**:
      **TLS is now a prerequisite for multi-user**, not only for remote access.
      Design: `PLAN-M20-B.md` §2a.
      **M20.B first wave LANDED 2026-09-12** (verification record:
      `docs/VERIFY-M20-B.md`). Built: **S1** per-user partition (incl. the
      legacy-user alias), **S2/S2a** `users` + `user_credentials` in a second
      encrypted **system DB** with scrypt credentials, **S3** session widening +
      rotation/revoke, and the **pure primitives** for S4/S6/S7. Schema v16 →
      **v18** (v17 tables, v18 session columns), each bumped once through the
      guarded-column migration surface. Root suite 901 → **1066**.
      **A MAJOR data-loss bug was caught by the review and fixed:** the plan
      asserted that the existing `data/partner.db` stays as user #0's partition
      while no code implemented it, so an install booting with `USER_ID=0` would
      have opened an **empty** DB under a new key and orphaned the real data.
      Fixed with a single `LEGACY_USER_ID` constant (`FIRST_USER_ID` derives from
      it, so they cannot drift) mapping that user to the legacy path, skills dir
      and `db-key` account. Also fixed from the same pass: Windows reserved
      **stem** names (`con.txt` etc.), a fail-OPEN `uncoveredHosts`, **wildcard
      SANs not matching** (which would have refused every real Let's Encrypt/mesh
      cert — now RFC 6125 single-label, with the `evil-example.com` suffix-attack
      as a test), the mobile envelope's three **indirect** routes to denied
      capabilities, a credential **timing oracle**, and a partition
      close-during-open race. `kind` was **not** widened.
      **CAVEAT as of wave 1 (superseded by the wave-2 entry below).** The
      users/credentials/system-DB work is not called by `createCore`; `/v1/pair`
      mints exactly as before with `user_id` NULL. So **no new control was in
      force after wave 1** — the envelope, TLS refusal, rate limiting and
      networked pairing were available, not active. Wave 2 (below) wired S4/S5/S6,
      and the third wave wired **S7**, so the delivery path now exists too.

- [x] **M21 — Container deployment + Cloudflare Tunnel (implemented + container-verified
      2026-09-13; detailed spec: `PLAN-M21.md`, record: `docs/VERIFY-M21.md`).**
      Partner runs headless in a container, in LIVE mode, and reaches the internet
      only through a Cloudflare Tunnel — no published port, no inbound rule, no
      cert to renew. Adds the one thing live mode was missing in a container: a
      **`file` keychain kind** (`KEYCHAIN_KIND=file` + `KEYCHAIN_FILE`; JSON,
      0600, atomic + serialised writes, malformed ⇒ refuse to boot, never
      re-key), plus one config hardening (an unknown `KEYCHAIN_KIND` is refused
      instead of silently meaning `native`). `docker/server/` ships the live
      image (non-root, S6 remote matrix: `REMOTE_ACCESS` + TLS + a named
      `ALLOWED_HOSTS`), the two-service compose, stage scripts that also generate
      the origin certificate, and three container-side tools (`healthcheck`,
      `pair-link`, `partner-request`). **Topology is a security property:** the
      tunnel sidecar keeps its OWN network namespace, because the pairing routes
      decide by socket peer (S7) and a shared namespace would make every internet
      request look loopback — an anonymous visitor could then mint a pairing
      secret. Pairing is therefore `compose exec partner node tools/pair-link.mjs`
      (operator shell access = the "at the machine" proof) and yields a
      **`mobile`** session; `desktop` class is unreachable in this shape (the
      coherent follow-up — letting a loopback-issued secret carry its intended
      class — is a reviewed capability decision, not taken here).
      *Exit: container boots LIVE (`demo=off`, schema v18) and reaches `healthy` ·
      a non-loopback peer redeems a secret for a `mobile` session while
      `/v1/pair/payload` and `{code}` stay 403 `loopback_required` · the session
      survives a container restart (volume + file key) and is refused
      `desktop`-only capabilities by class · both new test invariants falsified by
      injection · root 1131 → 1162 · web 638 · typechecks 0 · `ux_audit` n/a (no
      new UI).*
      *State: the Cloudflare edge leg, the dashboard's hostname settings and
      `stage.ps1` on Windows PowerShell were env-gated at the time of writing and
      are now **verified against a real tunnel** — the user deployed it at
      `partner.teliti.app` on 2026-09-13 and the whole path (edge → tunnel → core
      → pairing → mobile session → authenticated read) was checked in a browser.
      **2026-09-18:** `stage.ps1` now RUNS on Windows PowerShell 5.1 (it needed an
      encoding fix — a UTF-8 em dash parsed as a smart quote closed a string
      early), and the image ships the skill worker harness it was missing, so a
      skill can actually run in the container (measured by a real forked
      invocation inside it). The image was rebuilt and the container recreated
      against the same volume; see `docs/VERIFY-M21.md`.
      That live check found a **blocker the suite had certified**: the SPA's
      payload validator counted decoded CHARACTERS instead of BYTES, so every
      genuine pairing link was refused ("missing a valid certificate
      fingerprint") — the tests passed because their fixtures were ASCII filler.
      Fixed (byte-based canonical validation), fixtures replaced with
      `randomBytes(32)`, and the cross-module seam is now pinned by
      `tests/pair-payload-agreement.test.ts`; both fixes falsified by injection.
      A second defect of the same check: a pairing link pasted into an
      already-open tab did nothing (fragment-only navigation does not remount the
      SPA) — `PairGate` now listens for `hashchange`. Root **1166** · web **639**.
      Record: `docs/VERIFY-M21.md` ("Live deployment check").*

- [x] **M22 — Remote-hosted accounts, deployment-owned files, no llm-self-service
      (implemented + container-verified 2026-09-13; detailed spec: `PLAN-M22.md`,
      record: `docs/VERIFY-M22.md`).** Three changes for the hosted shape.
      **(1) Pairing → user login:** `AUTH_MODE=login` makes `POST
      /v1/auth/session` the only way in — a per-user passphrase (scrypt, system
      DB) mints a session that carries `user_id`, wrong-password and
      unknown-user are indistinguishable, 3 failures lock for 5 minutes, a
      per-peer limiter sits on top (behind a tunnel every request shares one peer
      address), and **the whole pairing lane answers 403**. Accounts are managed
      by the operator CLI `tools/user.mjs` (shell access = the "at the machine"
      proof); **one user per core is enforced** until per-user partitions (S1/S8/S9)
      land, because two accounts would share one database. The desktop pairing
      shape is unchanged. **(2) Deployment-owned roots:** `FIXED_ROOTS=/files`
      registers the mount at boot (idempotently — grants reference the root by id)
      and `POST`/`DELETE /v1/roots` answer `403 roots_fixed`; a non-directory root
      fails the boot; the Files view renders read-only. **(3) llm-self-service
      removed** from core, web and `shared` (the `ProviderSource` value stays so
      old rows read), which also closes **S0** as obsolete.
      *Exit: container-verified through the user's tunnel — account created by
      CLI, sign-in returns a `desktop` session, `/v1/roots` read-only, and a
      brokered write into `/files` completes proposal → approval → file on the
      volume · login gate walked in a browser (fields, disabled submit, sign-in →
      workspace, only token/theme/authMode stored) · root 1166 → 1184 · web 639 →
      635 · typechecks 0 · build green.*
      **R-slice (same session):** the recommendations were then built except R5
      (Cloudflare Access, skipped by request). **R1 per-user partitions** — a
      partition IS a single-user core (its own encrypted database, key and skills
      directory): the listening app authenticates against the shared system
      sessions and **delegates** every other `/v1` request to that user's app, so
      not one of the ~200 routes changed. Two users are provably isolated
      (`core/test/http/userPartitions.test.ts`: a read in one partition cannot
      contain the other's rows; separate `db-key:<id>` keys; per-user audit and
      skills), and the rails' LRU/idle/close semantics are unit-tested. **R2**
      rotation revokes that user's sessions. **R3** `PARTITION_IDLE_MS` closes idle
      partitions — memory hygiene, documented as exactly that. **R4**
      `CLIENT_IP_HEADER` + `TRUSTED_PROXY_CIDRS` give per-client auth rate limiting,
      believed only from a trusted peer and never used for a locality decision.
      **R6** `FIXED_ROOTS_READ_ONLY=1`. **R7** `MAX_UPLOAD_BYTES` /
      `MAX_JSON_BYTES` — and the upload cap is now the *upload* cap: the file
      bytes are the request body (`express.raw`, content type = mime,
      `x-attachment-name` = the name), so 8 MiB is reachable. Until 2026-09-14
      uploads rode a base64 JSON envelope and were really capped at ~768 KiB by
      the 1 MiB JSON limit, which is what refused iPhone photos; the 413 now
      names the file, its size and the limit, and `/v1/health` publishes
      `maxUploadBytes` so the SPA refuses before uploading
      (`docs/VERIFY-M22.md`, `core/test/http/attachmentUploadLimit.test.ts`).
      **R8** a verified backup tool (`VACUUM INTO` +
      `integrity_check`, exits non-zero when it cannot verify, prunes to `--keep`).
      **R9** the vocabulary gap is closed (`provider.configure`, `persona.run`).
      Root 1184 → **1204**, web 635, typechecks 0.
      **S1/S9 (PLAN-M20-B):** S1 verified end to end (the rails are its missing
      caller) and **S9 landed** — schema v19 wraps the partition key under the
      passphrase (own salt + HKDF, so the stored verifier cannot unwrap it),
      removes the plaintext at first sign-in, refuses a locked partition with
      `401 partition_locked`, closes the handle with the key, and offers the
      per-user AUDITED `keep-unlocked` opt-in. **S8 (Vault/Runner) NOT done** —
      deliberately not half-landed. Root 1204 → **1215**.
      **Sign-up (invite lane, 2026-09-14):** a hosted person can now create their
      OWN account, so the operator never types their passphrase — the one thing
      `tools/user.mjs add` could not avoid. `SIGNUP_MODE=invite` (default `off`,
      needs `AUTH_MODE=login`) enables it: the operator mints a 256-bit single-use
      invite on the machine (`tools/signup-link.mjs` → `POST /v1/signup/code`,
      loopback-only, the same secret primitive as the pairing link) and sends
      `https://<host>/#signup=<code>`; `POST /v1/auth/signup` consumes it and
      creates the users row + scrypt credential exactly as the CLI would (`0` for
      the first account), returning **no session** — sign-in stays the single
      authority path. Validation is shared (`shared/src/accounts.ts`), the shape
      checks run BEFORE the code is spent (a typo must not burn a one-time
      invite), a taken name is a 409, and neither the name nor the passphrase
      reaches a response or an audit row. **There is deliberately no `open`
      mode:** a hostname the internet reaches is reachable by anyone, and "who may
      reach it" is not "who may create an account" — the operator's invite is the
      decision. Root 1215 → **1229**, web 699 → **712** (a container-shaped walk
      found the fresh-tab invite path rendering an empty code field; seeded from
      one shared helper now, with the invariant pinned in `web/test/signup.test.ts`).
      Record: `docs/VERIFY-M22.md`.
      **The Windows `userPartitions` failure — two real defects, both fixed
      (2026-09-15).** Five partition tests failed on every `verify (windows)` run
      while linux passed, with `Cannot read properties of null (reading 'port')`
      in the test's own boot helper. **(1) `listen()` resolved a core that was
      never listening:** `app.listen(port, host, cb)` calls `cb` even when the bind
      FAILED (Windows/Node 25), so a taken port resolved the boot, printed "up on
      …" and served nobody, and the real `EADDRINUSE` was discarded (its `reject`
      ran after the promise had settled). Readiness now comes from the `listening`
      event and failure from `error`, so a taken port rejects the boot by name
      (`core/test/listen.test.ts`). **(2) `PORT=0` silently became 4390**
      (`readInt` falls back to the default for anything out of range), which is why
      three core test files depended on 4390 being free — a leak from an earlier
      e2e run, or a dev core, broke them. `loadConfig` now REFUSES a malformed or
      out-of-range `PORT` (0 included) with the reason a caller must name the port
      (the loopback allowlist is derived from it), and those tests bind a **named
      free port** (`freePort()`); teardown drops keep-alive sockets before waiting
      (`closeServer`), which also removed the `EPERM` on the temp dir. Windows root
      suite **1254 passed / 5 failed → 1262 passed / 0 failed** (5 env-gated
      skips); no assertion was weakened.
      *State: still open — S8, a device/sign-out UI, per-user quotas; unverified — a two-user browser walk,
      R4 against the real Cloudflare edge, an R8 restore, and R3's live timer. See
      `docs/VERIFY-M22.md`.*

- [x] **M23 — Scorecard chat answers (implemented + verified 2026-09-15).**
      A fourth answerable container joins choices and free-text forms:
      `:::partner.scorecard` rates several named items on one shared numeric
      scale so the user answers a multi-item review in a single pass. Grammar:
      one item per bullet line, `scale=<2–10>` (default 5) is the highest score
      with scores running 1..scale, and an optional `labels="Low|High"` names
      the ends. One radio group per item makes one-score-per-item structural.
      Submitting once sends a single labelled user turn
      (`Q: <item>` / `A: <score>/<scale>`) through the normal chat path —
      nothing client-only, persisted text unchanged. The parser lives in
      `shared/src/structured.ts` beside the other containers
      (closed-container-only materialization; malformed or unclosed blocks
      degrade to prose; a bad scale clamps rather than dropping the card).
      `ScorecardCard` is answerable in the M20.A one-submit group — grouped
      scorecards require every item rated, while a standalone card accepts any
      non-empty rating set — and pending ratings survive conversation switches
      via the existing per-conversation UI memory. The `scorecards` guidance
      ships in the default structured feature set; styles are token-only
      (`accent-emphasis`/`accent-contrast` selected state, `--target-min`
      targets, one column on phones). *Exit: shared 16 · web
      722 · core `instructions.test.ts` green · typechecks 0 · web build
      green. (The root suite's scrypt-heavy auth/partition files time out under
      parallel CPU load both at HEAD and here — a pre-existing environment
      flake, green in isolation with a raised timeout.)*

- [ ] **M24 — Make attached photos actually reach the model (fix; 2026-09-16).**
      Fixes the reported failure "the partner says it never received the image"
      while the same model reads the image fine when tested directly against
      LiteLLM. Three independent causes, all silent:
      **(1) capability was guessed from the model name.** `VISION_HINTS` decided
      whether a turn attached an `image_url` part, so an operator-chosen gateway
      alias (`my-photo-model`, `pixtral-12b`, any LiteLLM `model_name`) counted
      as text-only: the persona was handed just the descriptor line
      `[Image attachment: …]` and correctly answered that no image arrived — and
      neither the M13 reroute nor the chat picker could find a vision model, both
      applying the same name test. Capability is now DECLARED: `providers.vision_models`
      (schema **v20**) plus every model on a `vision`-purpose profile, read through
      one shared function (`declaredVisionModels` + `isImageCapableModel(model,
      declared)`) used by the core's gate, the reroute resolver, the chat picker
      and the capability chips; hints remain the zero-config default and a
      declaration can only ADD capability. Edited in place via
      `PUT /v1/providers/:id` and model chips on the provider card (a
      name-recognised model and a vision-purpose profile are not un-tickable —
      clicking would be a no-op). **(2) the two byte budgets were conflated.**
      Upload fits `maxUploadBytes` (8 MiB) but only `MAX_INLINE_IMAGE_BYTES`
      (3 MiB, now shared + published on `/v1/health` as `maxInlineImageBytes`)
      can ride a turn, so a normal phone photo stored, thumbnailed and was then
      dropped from the request; the composer now re-encodes any over-budget image
      (ladder extended to 6 rungs) to the inline budget, and an image that still
      cannot ride is described to the model as **NOT sent** rather than reading
      like a success. **(3) a multi-photo turn sent only one image.** The part
      was singular (`ChatMessage.image`, `metas[0]`), so a second attached photo
      was silently withheld; it is now `ChatMessage.images`, serialized as one
      `image_url` per photo in attach order and bounded by
      `MAX_INLINE_IMAGES_PER_TURN` (4) — with the composer stating outright when
      staged photos exceed that. Also closes a latent trap:
      `isImageCapableModel` is used as a bare `filter` callback, so it must
      ignore the extra index/array arguments.
      *Exit: shared 90 · root 1333 · web 742 · typechecks 0 · web build green
      (6 new route-level image cases, incl. alias-on-vision-provider,
      declared-alias-on-general, handoff-to-alias, no-invented-capability,
      both-photos-ride, and the over-budget NOT-sent descriptor). Env-gated
      remains: a real api.ne1.dev walk attaching a photo to a turn and reading it
      back.*
      *State: implemented + locally green (suites/typechecks/build above). The
      live packaged walk against the user's own LiteLLM endpoint is env-gated and
      has not been executed — that is the case this fix was written for, so it is
      the one worth walking.*

- [x] **M25 — Reconfigure existing providers (implemented + locally green 2026-09-16).**
      The provider setup card could only ADD purpose profiles; once created, the
      only way to change which models a purpose carried was to delete the profile
      and build it again, which meant re-typing the API key and losing the
      keychain item. The card now has two modes over the same endpoint/key idea:
      **Add new** (the unchanged M13 bundle) and **Reconfigure existing**, which
      operates on profiles that already exist. Pick one of the endpoints in the
      list, rediscover its current model list through the key the keychain
      ALREADY holds (`GET /v1/models?provider=<id>` — no key field, tried across
      the endpoint's profiles healthiest-first so one keyless sibling cannot block
      the rest), then tick the models each purpose profile should carry and save.
      Writes reuse the existing `PUT /v1/providers/:id` (M24) per changed profile,
      so a `vision`-purpose profile's new pins are also its image-capability
      declaration (M24 semantics), while other profiles keep their existing
      declarations. The pane never creates, deletes or re-keys anything; a profile
      emptied of models is refused before any request (the add flow refuses the
      same shape), and only profiles whose ordered list actually changed are sent,
      so order still picks each purpose's default. Pure decisions live in
      `web/src/lib/providers.ts` (`endpointGroups`, `reconfigureModelOptions`,
      `reconfigurePinsFor`, `reconfigureChanges`), with the stored-key read as
      `listProviderModels` in `web/src/lib/api.ts`. The mode toggle and the
      reassignment rows reuse the token-only `.btn`/`.field`/`.bundle-*` styles
      plus one `.bundle-mode` selection rule (surface + elevation-sm, the
      purpose-filter contract). No core route or schema change.
      *Exit: shared 90 · root 1328 passed (5 env-gated skips) · web 758 (742 + 16)
      · typechecks 0 · web build green · `ux_audit` PASSED (17 APCA pairs, light
      + dark; tokens, states, slop tells). The complete-stylesheet whole-file
      `ux_audit` run remains outstanding (payload > 200 KB); the gate ran on a
      composed, brace-balanced payload of the new block plus every interactive
      base/state it depends on, and a full-file slop-tell scan (`backdrop-filter`
      0 · gradients 0 · blur 0 · text-shadow 0).*

- [x] **M26 — Skill authoring: build a skill by talking to the partner
      (detailed spec: `PLAN-M26.md`).** M8 could only install from the
      checked-in catalog; M26 adds the missing half. A **draft** is an inert,
      editable bundle held as a `skill_drafts` row (schema **v21**) in the
      user's own encrypted DB: describe the skill in **chat** (the
      `skills.draft` external tool, advertised only when the session is
      desktop, the persona may act, and `skill.author` is granted) or in a new
      **Build** segment of the Skills view (AI-assisted generation from the
      configured provider, or a template, so it works with no provider too).
      The line the milestone draws: **a model may write code and ask, but only
      the owner makes it executable.** Drafting is inert, validation is
      deterministic (never executes), the sandboxed **dry-run** returns the
      worker's own logs so chat iteration is possible, and install is a
      `skill.install` act on **both** surfaces — the Studio button, or the
      approval card the persona's `skills.requestInstall` opens in the
      conversation it asked from (`pending_tools.kind='skill_install'`,
      decided by the same `promote()`); the plain-language permission summary
      is shown either way, and a widened permission set forces re-consent
      (`permission_change` 409). Drafts are re-draftable across turns so a
      lint error is fixable in place, export/import moves an unsigned bundle
      that always lands as a draft (signing deferred), and the `skills` nav
      badge counts ready drafts without double counting an open approval. New
      capability `skill.author` (desktop-only by the existing envelope table);
      `network: true` stays refused; audits carry ids/counts/lengths only —
      never code, description, prompt or bundle body. Slices A drafts core ·
      B generator + the pure/reads-files templates · C chat authoring + install
      approval · D Studio + deep link + badge · E export/import · F docs/verify.
      *Exit: schema v21 additive (a v20 DB opens unchanged) ·
      create → validate → dry-run → install/update + re-consent → discard,
      fork and bundle round-trip green · deterministic validation covers
      shape/registry/import lint/caps · chat stages and asks but never runs or
      installs, and both install paths produce identical rows · `skill.author`
      denied for mobile + extension · no draft code/description/prompt/args/
      result/log/bundle in any audit row · Studio usable with and without a
      provider · typechecks 0 · web build green · `ux_audit` PASSED.*
      *State: **COMPLETE** (2026-09-16) — including the two templates that
      needed M27, which landed with M27 S4 (2026-09-17).
      **Review fixup 2026-09-18:** the Studio's four live-walk findings (draft
      description, the Edit/Fork deep link, creating a draft when one exists,
      the failing run's reason) are fixed — see `docs/UNFINISHED.md` §0 and
      `README.md` “Skill Studio fixup”.
      Measured: root **1468 passed / 5 env-gated skips** · shared **90** ·
      web **851** · typechecks 0 · web build green · `ux_audit` PASSED (16 token
      pairs, light + dark) · record `docs/VERIFY-M26.md`. All slices landed:
      A drafts core (+ schema v21) · B generator + demo fallback · C chat
      `skills.draft`/`skills.requestInstall` + the install approval (which
      promotes through the SAME `promote()` the Studio calls, and is
      class-checked as `skill.install` because approving EXECUTES) · D the
      Studio Build segment (editor, validation, sandboxed dry-run, two-step
      install with the consent table, fork/edit, export/import, deep link,
      `skills` badge, and a label on the canned non-model draft) · E dry-run +
      unsigned bundles · F docs. The *notes* and *MCP* templates landed with
      **M27 S4** (2026-09-17); the picker is capability-filtered, so it offers
      only what the build can honour. NOT walked: a live-endpoint generation run
      and a packaged-app Studio run.*
- [ ] **M27 — What a skill may reach: app-scoped tools + MCP from the sandbox
      (detailed spec: `PLAN-M27.md`).** Exists because two of the four Studio
      templates are not implementable on today's skill reach. **S1** widens
      `ToolScope` to `{kind:'project'} | {kind:'app'}` and adds three read-only
      app tools (`notes.list`/`notes.search`/`notes.read`, `low` risk, mapped
      to the existing `file.read` capability — no new capability name) that
      resolve against a reserved `APP_SCOPE_ID='app'` instead of a project root,
      with rootless app grants beside the roots in the same grant surface.
      **S2** adds `permissions.mcpServers` so a skill may reach an **enabled**
      MCP server's tools through the runner, a **medium-or-higher ceiling**
      (an MCP tool's own risk is unknowable in advance), and coded denials
      (`mcp_not_declared`/`mcp_disabled`) with **no interactive pending row** —
      consistent with skills being non-interactive. **S3** propagates the
      session **client class** into the runner for broker *and* MCP calls,
      which closes the gap M20-B S4 recorded against itself (nothing in
      `skills/` or `mcp/` consulted the class). **S4** adds the notes + MCP
      templates and points the Studio picker at a single "what can a skill
      reach" source so a template can never produce a bundle the sandbox
      refuses. **S5** adds **model reach**:
      `permissions.llm` enables a new `partner.llm.complete` worker verb, the
      skill's own `budget.maxTokens` is finally **enforced and ledger-charged**
      (it has been declared and validated since M8 and never read — `runner.ts`
      uses only `timeMs`), and `skill.llm` is a desktop-only capability. A
      skill can therefore send the data it read to the configured provider —
      **declared, ceiling-bounded and audited as counts**, not ambient. S5 is
      independent of S1–S4 and can land as its own M27-B; `PLAN-M28.md`'s `llm`
      node needs it.
      *Exit (all locally green; the last line is env-gated): a zero-root broker
      grants and runs `notes.read` ·
      `POST /v1/grants {projectId:'app'}` accepted only for an app-scoped
      manifest and refused for `files.read` · app tools audit ids/counts/
      lengths only · an enabled server's tool runs, undeclared/disabled/unknown/
      over-ceiling refused with no pending row and ONE `mcp.call.denied` row
      naming the server and the code · **mobile-with-a-grant refused**
      at the broker and the MCP path, class read from the session row · both
      templates validate *and* run.*
      *State: **S1 + S2 + S3 + S4 + S5 landed** (S3+S5 2026-09-16, S1 2026-09-17,
      S2 2026-09-17, S4 2026-09-17; record `docs/VERIFY-M27.md`) —
      root **1651 passed / 5 env-gated skips** · shared **90** · web **858** ·
      typechecks 0 · web build green; the S3/S5-era figures were
      root **1495** · web **851** (1614 at S1+S2 — that figure includes the S2
      audit-actor attribution fix above; 1628 at S4; 1645 after M28 B; and 1651
      after the 2026-09-17 independent-review fixup recorded at the end of this
      entry). **S3:** the session client class now reaches the runner
      from the SESSION ROW (both routes in) and is forwarded to `broker.exec`,
      so an already-granted write can no longer walk a phone through the
      envelope — the case proven with `files.edit`, because the brief's
      `files.read` premise was wrong (mobile's envelope includes it and an
      existing test asserts it executes); the grant is verified present before
      the refusal, and a request body cannot set or raise the class.
      **S5:** `partner.llm.complete` — declared (`permissions.llm`, else
      `llm_not_declared`), class-gated by a new `skill.llm` capability that is
      deliberately absent from the mobile/extension allowlists, and bounded by
      `budget.maxTokens` (else a documented 4096 default) accumulated across the
      invocation, failing `budget_exceeded` MID-RUN with the worker killed. That
      finally gives `SkillBudget.maxTokens` a runtime meaning (declared since M8,
      never read), the provider spend ledger is charged per accounted call, and
      one `skill.llm` audit row carries the model id + token counts only — never
      the prompt or the completion. **S1 (2026-09-17):** the app-scoped notes
      tools — `notes.list`/`notes.search`/`notes.read` are manifests with
      `scope:{kind:'app'}`, the broker branches on the manifest's scope (the app
      path keys the grant and the pending row on `APP_SCOPE_ID` and **never
      calls `roots.getById`**, so a notes skill works with ZERO roots), a
      sanctioned file tool asked for `projectId:'app'` is refused, and
      `defaultToolRegistry()` is now DERIVED from the broker's manifest set so
      installer and dispatcher cannot drift. The three ids map to the EXISTING
      `file.read` capability on purpose — a new name would be absent from
      mobile's allowlist and deny a phone its own notes by construction. Audit
      rows carry ids/counts/lengths only (a note body never reaches one). Web:
      an **App data** grant group (scope-filtered pickers on both sides) and a
      dry-run `tool_denied` that names WHERE the grant goes. **S2 (2026-09-17):**
      MCP reach from the sandbox — `permissions.mcpServers` (server ids, never
      tool names) is declared, de-duplicated and capped at 8, and a `low`-risk
      manifest declaring it is refused at **validate** time because an MCP
      tool's own risk is unknowable in advance (D6). The runner routes
      `partner.tools.exec('mcp:<server>/<tool>')` to an INJECTED seam
      (`core/src/mcp/skillReach.ts`) instead of the broker, so `skills/` still
      never imports `mcp/`; the seam checks the class envelope FIRST
      (`mcp.call`), then the declaration, then the ceiling, then whether the
      server is configured and enabled — closing **D7's MCP half**. Every
      failure is a coded refusal the skill can catch (`mcp_not_declared` /
      `mcp_disabled` / `upstream` / `capability_denied` / `tool_denied`) and NO
      pending row is ever created: skills are non-interactive, so a server is
      enabled BEFORE the run, exactly as a root is granted before it. The
      authoring prompt, the chat instructions and the install summary now
      describe that reach from the SAME capability object the validator uses
      (D9; the chat instructions also gained the `llm` description they had
      been missing since S5). S2 also fixed a pre-existing attribution defect it
      surfaced: `McpManager.call()` hardcoded the audit actor `web`, so a skill's
      reach read as a web request nobody made — the call path now takes an
      optional actor (`skill` from this seam, `persona` from the chat
      auto-call), and the `web` default keeps every existing caller unchanged.
      **S4 (2026-09-17):** the last slice — `notes-checklist` and `mcp-call` in
      `core/src/skills/templates.ts`, each with the `requires` key the picker
      gates on, so a build without the reach does not offer them (both
      directions asserted, including through the drafts door). The notes
      template reads through the app-scoped tools with no `projectId` and no
      root, and its bundle was proven by a real Studio DRY-RUN against a real
      granted note — plus the coded `tool_denied` refusal and NO queued row
      before the grant. The MCP template was proven against a **local stdio
      server**: one declared server, `mcp:<server>/<tool>`, and its docblock's
      codes (`mcp_not_declared` / `mcp_disabled`) asserted. Its manifest ships a
      PLACEHOLDER server id — ids are generated when a server is added, so no
      template can name the owner's — and the run test performs the same
      one-field edit the author does.
      **Independent-review fixup (2026-09-17, no version bump):** a REFUSED MCP
      call wrote no audit row at all, so a skill that caught the coded denial
      recorded `skill.invoke` ok:true with no trace of the attempt — the seam
      now takes the core's `AuditService` and writes exactly ONE
      `mcp.call.denied` row per refusal (actor `skill`, the server id as the
      target, the code + tool id as details; never tool arguments or the command
      line), asserted per code AND driven through the runner with a
      multi-segment `mcp:<server>/a/b` id so the runner's duplicated id regex
      is held to the seam's. The D8 assertions now count the WHOLE
      `pending_tools` table (open rows alone could not see a
      closed-by-denial regression), the oversized-result test now crosses the
      real MCP seam instead of exercising a skill that ignores it, and a
      persona-driven run's `skill.invoke` row names actor `persona` rather than
      `web`.`
- [x] **M28 — Skill Studio Flow: build a skill on a canvas, with the model as a
      collaborator (detailed spec: `PLAN-M28.md`, verification record:
      `docs/VERIFY-M28.md`).** **Slices A–F landed 2026-09-17.** The Studio (M26)
      gains a **fourth surface**: a **React Flow** canvas — the dependency is
      already in `web/` (used by `NotesGraph.tsx`), so **no new package** — where
      a skill is a graph of ten typed nodes. The model can **build** the graph from a
      description (`mode:'generate-flow'`), the user can draw it, and the model
      can **refine** what the user drew as a **proposal with an
      accept/reject diff** — never a silent rewrite. The load-bearing
      constraint: a flow is **not a second kind of skill**. It compiles
      **deterministically to `entry.mjs`** (byte-identical for one flow, total
      compiler: a cycle is a named error, not an exception), so the artifact,
      the sandbox, the hash check and every M26 install gate are unchanged and
      there is no flow interpreter to trust. The vocabulary is deliberately not
      a programming language — no loops, no arbitrary expressions, no imports —
      and expressions are a validated **path grammar + fixed operators**, so an
      AI-written graph **cannot inject code**; the emitted code is then held to
      the unmodified gates. Two properties fall out for free: `permissions.tools`
      is **derived from the graph's `tool` nodes** (the install summary provably
      matches the code), and flow/code coherence is a **derived hash
      comparison**, not a boolean (a hand-edit that restores the compiled bytes
      clears it). Because React Flow has no keyboard path to creating an edge,
      the Flow tab ships a second, equivalent **Nodes table** view over the same
      document; the palette omits `llm` unless M27 S5 is wired. Schema **v22**
      adds `flow_json`/`flow_sha256`/`flow_compiled_at`. Slices A compiler
      (pure) · B routes + staleness · C canvas + nodes table · D AI
      build/refine/from-code · E chat `flow` payload · F docs/verify.
      *Exit (planned): v22 additive (a v21 DB opens unchanged) — **done** ·
      compiler total
      and deterministic, cycle/dangling/missing-output/unknown-tool named —
      **done** ·
      injection refused by the path grammar + template escaping, asserted —
      **done** ·
      derived `permissions.tools` equal to the graph's tool nodes both ways —
      **done, and now written into the manifest on `/compile` together with
      `permissions.llm`** ·
      the compile is held to the DRAFT manifest's own risk ceiling (D5) —
      **done: the compile path supplies `riskCeiling`/`riskOf` from the broker
      registry, so a `files.edit` node under a `low` manifest is refused
      `tool_requires_medium` and nothing is written** ·
      install from a stale draft allowed and documented (install consumes code) —
      **done (asserted by installing AND RUNNING a stale draft)** ·
      refine writes nothing until accepted — **done** · `llm` only with M27 S5 —
      **done (the palette gate is `llmAvailable` on the flow read, and a compiled
      `llm` node reaches a provider under the manifest's token ceiling)** ·
      canvas and nodes views edit one document, both keyboard-reachable —
      **done** · `ux_audit` PASSED
      on the new token-only styles **plus a looked-at canvas frame** (a passing
      audit is the floor, not the evidence, for a visual surface) — **done,
      `docs/m28/`** · suites
      root + Δ / web + Δ / shared + Δ, zero regressions · typechecks 0 · web
      build green · both demo e2e flows green — **done: root 1724, shared 90,
      web 918, typechecks 0, build green, `tests/e2e-skill-flow.test.ts`.***
      *State: **slices A–F landed 2026-09-17** — root
      **1746** (5 env-gated skips) · shared **90** · web **937** · typechecks 0 ·
      web build
      green. **Review fixup 2026-09-18** (M26/M28 Studio surfaces: draft
      description, the Edit/Fork deep link, creating a draft when one exists,
      the failing run's reason — `docs/UNFINISHED.md` §0) lives in
      `web/src/studio/DraftComposer.tsx` + `DraftRail`/`SkillStudio`, not in the
      canvas. **Slice A (the compiler)** is `core/src/skills/flow/schema.ts` +
      `flow/compile.ts`, both pure (no fs, no db, no routes). Determinism is
      asserted against
      shuffled `nodes`/`edges` ARRAYS, not just a repeated call; the failures are
      named before any byte is emitted (cycle, dangling edge, missing output,
      duplicate input, unknown tool, `llm_not_available`, `tool_requires_medium`,
      >1 inbound edge on a non-merge); and the emitted module is **executed**
      against a fake `partner` and, in `flowRun.test.ts`, in the REAL M8 sandbox
      via `runner.invoke({dirOverride})` — a compiled flow reads a real note
      through the broker with zero roots, and fails `tool_denied` without a
      grant. The injection boundary is proven: the path grammar refuses
      `__proto__`/`constructor`/`a..b`/`a);process.exit(1);//`, a hostile string
      that is NOT path-shaped round-trips as inert data, and template text is
      escaped so a backtick or `${` in prose stays prose. Two additions beyond
      the spec's letter, both recorded: `FlowValidationCode` gained `bad_node`
      (a recognised type with malformed data had no name), and the compile result
      gained `usesLlm` — without it a flow with an `llm` node installs a manifest
      that refuses every call with `llm_not_declared`, a bundle that can never
      run. **The Studio split** (owner decision: before C/D) turned the
      2025-line `web/src/SkillStudio.tsx` into a 468-line container plus
      `web/src/studio/{DraftRail,DraftEmptyState,DraftEditor,ValidationPanel,
      RunPanel,InstallPanel,InstallConfirm,DraftActions}.tsx` + `shared.ts`,
      re-exported from the original module so no importer or test moved. No CSS
      changed (`app.css` byte-identical). **Slice B** is schema **v22**
      (`skill_drafts.flow_json` / `flow_sha256` / `flow_compiled_at`, guarded
      `ensureColumn`, so a v21 DB opens unchanged) plus the three routes
      `GET|PUT /v1/skills/drafts/:id/flow` and
      `POST /v1/skills/drafts/:id/flow/compile`, with the lifecycle in
      `core/src/skills/drafts.ts`: a save is structurally validated and touches
      no code, a compile writes `code` + `flow_sha256` + `flow_compiled_at` and
      rewrites the manifest's derived permissions (`tools` AND `llm`, so a flow
      with an `llm` node cannot install a manifest that refuses every model
      call), a compile that cannot succeed answers `{ok:false, errors}` and
      writes nothing, and `flowStale` is recomputed on every read
      (`sha256(code) !== flow_sha256`) — a hand-edit that restores the compiled
      bytes clears it by itself, and install from a stale draft is **allowed and
      asserted** (install consumes code; staleness is UI honesty, not a security
      state). Audit rows carry counts and tool ids only. **Independent-review
      fixup (2026-09-17, no version bump):** the compile path never passed
      `riskCeiling`/`riskOf`, so D5's `tool_requires_medium` was dead in
      production — a `low` manifest whose graph held a `files.edit` node
      compiled, wrote `permissions.tools:['files.edit']`, re-validated ok and
      INSTALLED, a bundle guaranteed to refuse at run time. The draft manager
      now takes the registry's risks (`riskOf`, required) and hands them to the
      compiler with the manifest's own tier, so that compile fails NAMED and
      writes nothing; and `mode:'generate-flow'` — advertised on the wire but
      unimplemented (slice D) — is now refused BY NAME instead of being silently
      downgraded to `mode:'generate'`, which had handed a caller asking for a
      graph a code bundle with `flow: null` and no error. Tests:
      `core/test/skills/flowStale.test.ts` ·
      `core/test/http/skillFlowRoutes.test.ts` (+2 in `db-migrate.test.ts` for
      the v21 → v22 upgrade; the six SCHEMA_VERSION tripwires were bumped to 22).
      **Slices C–F landed 2026-09-17.** **C** is the canvas
      (`web/src/SkillFlow.tsx`) + its DOM-free helper layer
      (`web/src/lib/flow-helpers.ts`) + the Flow tab in `web/src/studio/*`: the
      palette rail, the typed inspector, per-node error decoration,
      Auto-arrange, and the **Nodes table** that edits every field of the same
      document (D9's answer to React Flow having no keyboard path to an edge) —
      the ten node types register under prefixed React Flow ids because
      `input`/`output`/`default`/`group` are reserved by the library, while the
      DOCUMENT keeps D2's spelling. **D** is the four AI verbs
      (`core/src/skills/flow/refine.ts` pure prompts/parse/diff,
      `flow/ai.ts` the model seam, `core/src/skills/model.ts` the ONE bounded
      call extracted from M26's generator so five callers share one cap and one
      timeout): `mode:'generate-flow'`, `/flow/refine`, `/flow/from-code`,
      `/flow/explain` — and **both proposal routes write nothing**, asserted
      byte-identical at the manager level and over HTTP. **E** is the same
      `skills.draft` tool accepting a `flow` payload instead of `code`, with the
      node vocabulary (`flowContract`) joining the shared reach vocabulary the
      authoring prompt, the chat instructions and the palette all mirror. **F**
      is `docs/VERIFY-M28.md` (+ the looked-at frames in `docs/m28/`), which is
      also where the four decisions taken beyond the spec's letter are recorded:
      staleness now checks BOTH sides of the last compile (an edited graph used
      to read fresh), the shared bounded call, `SkillDraftOrigin` gaining
      `'flow'`, `llmAvailable` riding the flow read for the palette gate, and
      `explain` auditing nothing. Gates: root **1724** (5 env-gated skips) ·
      shared **90** · web **918** · typechecks 0 · web build green · `ux_audit`
      PASSED · `tests/e2e-skill-flow.test.ts` green. Not verified: a LIVE model
      walk for the four verbs (no endpoint in this workspace — the deterministic
      answers and the stubbed-reply paths are what ran).*

Demo mode mirrors llm-self-service: `DEMO_MODE=1` swaps in fake providers /
fake keychain / in-memory stores so the whole product is exercisable with no
credentials. Never in production builds.

- [x] **M29 — The multi-user lifecycle: sign out, in-app invitations, shared AI
      access, per-user files and note/asset sharing (detailed spec:
      `PLAN-M29.md`, verification record: `docs/VERIFY-M29.md`).** Five things a
      hosted (login-mode) Partner needs before a second person can really use it.
      **(1) Sign out** — `POST /v1/auth/signout` revokes the presented session
      AND (on a login core) closes the user's partition and drops its key, so
      signed out means unreadable rather than merely unreachable; the SPA gains a
      sidebar-footer control, a Members card and a phone-reachable route.
      **(2) Owner-minted invitations, no shell** — `users.role`
      (`owner`/`member`) plus an `invites` table; an owner mints, lists and
      revokes single-use invitations from the Members view, and only the code's
      hash is stored. `SIGNUP_MODE` keeps governing the loopback operator mint
      (the way to create the FIRST account) while an owner-minted invite redeems
      regardless — an explicit admission decision needs no deployment switch, and
      the redeemer cannot escalate because `role`/`key_access` are read from the
      invite ROW.
      **(3) Shared AI access** — a member invited with `keyAccess:'shared'`
      reaches the deployment's published provider + search configuration while
      they have none of their own, so they can chat without being handed a key;
      the owner publishes from the Members view (`shared_access` rows +
      `shared-*` keychain accounts), and their own setup always wins.
      **(4) Per-user file paths** — a partitioned core derives each account's
      fixed roots as `<FIXED_ROOTS entry>/<userId>` (or `<partition>/files` with
      no deployment volume), creates them at boot, and keeps the roots surface
      read-only in login mode, so one mounted volume no longer means one shared
      directory.
      **(5) Note & asset sharing** — `shares` holds a SNAPSHOT copy in the system
      DB, so a grantee reads what they were given without ever opening the
      owner's partition, can save it into their own notes, and sees nothing else;
      the owner can push a current edit or revoke. Schema **v22 → v23**
      (additive: `users.role`/`users.key_access`, `invites`, `shares`,
      `shared_access`).
      *Exit: root 1766 passed (5 env-gated skips) · shared 90 · web 944 ·
      typechecks 0 · web build green · `ux_audit` PASSED on the new surfaces ·
      walked live in a browser against a real login-mode core (owner sign-in →
      Members → mint an invitation link → Shared; the desktop pairing shape also
      walked) · container refreshed, `partner-server:local` healthy · Windows
      NSIS package built green.*
