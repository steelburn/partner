# Partner — a personal AI partner workspace

User-owned AI partner: your own LLM endpoints + keys (see
`~/apps/llm-self-service`), local-first core, browser web UI, browser
extension. See the plans:

- `PLAN.md` — master plan (vision, personas, memory, skills, theming,
  security, milestones).
- `PLAN-M0.md` — M0 spec: scaffold, Tauri shell + sidecar spike, security
  spine.
- `HANDOFF-WINDOWS.md` — Windows CI handoff + full project state (read this
  first if picking up from GitHub on a Windows machine).
- `PLAN-M1.md` — M1 spec: providers, model gateway, integrated key import.
- `PLAN-M11.md` — M11 spec: chat as the workspace.
- `PLAN-M12.md` — M12 spec: UI readability & polish pass.
- `PLAN-M13.md` — M13 spec: purpose providers & in-session model switch.
- `PLAN-M14.md` — M14 spec: scheduled & autonomous work.
- `PLAN-M15.md` — M15 spec: live desktop mode (exit demo).
- `PLAN-M16.md` — M16 spec: knowledge workspace — notes graph,
  brainstorming, versioning & asset depth.
- `PLAN-M19.md` — M19 spec: persona-scoped memory & automatic remember.
- `PLAN-M20.md` — M20 spec: client-server + multi-user + mobile (Model A′
  vault/runner split, per-user partition, mobile/tablet UI, PWA, native shell).
- `PLAN-M20-B.md` — M20.B execution breakdown: slices S1–S8 with exact files,
  tests-first, dependencies, parallelization waves, the locked decisions and a
  status table (§3.0).
- `PLAN-M21.md` — M21 spec: container deployment + Cloudflare Tunnel (the
  `file` keychain kind, the two-namespace topology, pairing via `compose exec`).
- `docs/VERIFY-M21.md` — M21 record: what was measured in a real container
  (LIVE boot, healthcheck, remote pair refusals, `mobile` session, restart
  persistence, ciphertext-at-rest) and what still needs a real tunnel token.
- `PLAN-M22.md` — M22 spec: remote-hosted accounts (`AUTH_MODE=login`),
  deployment-owned project roots (`FIXED_ROOTS`), and the llm-self-service
  removal, with the recommended next steps for the hosted shape.
- `docs/VERIFY-M22.md` — M22 record: the container walks (sign-in, refusals,
  the fixed-root write path), the four defects found and fixed, and an
  operational mistake from validating against the live deployment.
- `docs/VERIFY-MOBILE.md` — M20.A verification record: measured phone/tablet
  geometry before/after, the `ux_audit` results, the subagent wave's lane
  outcomes, and what was NOT verified.
- `docs/VERIFY-M20-B.md` — M20.B records: wave 1 (the MAJOR data-loss finding
  and its fix), wave 2 (three blockers where the capability envelope was
  bypassable, and their fixes) and wave 3 (S7 networked pairing wired: a real
  phone can mint a `mobile` session), the gates, and an explicit "what is NOT
  done" (no QR encoder, no real phone/TLS walk).
- `DESIGN.md` — default design system (tokens live in `shared/src/theme.ts`).

## Layout

```
shell/      Tauri v2 app (tray, window, autostart, updater)   [M0 · packaged M10/11]
core/       Node core = Tauri sidecar (spine → workspace)     [M0–M13]
web/        SPA (Vite + React)                                [M0–M13]
extension/  MV3 (native-messaging bridge, theme stream)      [M7–M11]
shared/     types: tokens, contracts, redaction (no runtime deps)
tests/      cross-cutting integration tests
```

## Dev

```bash
npm install          # workspaces at repo root
npm test             # vitest (TDD)
npm run typecheck    # tsc per package
npm run dev:core     # core on http://127.0.0.1:4390 (demo mode by default)
npm run dev:web      # SPA dev server on :5173 (standalone dev)
```

`dev:core` binds the desktop's own port. A packaged Partner window is now
owned by its core: it mints a per-boot nonce, hands it to the sidecar it
spawns, and requires the listener on :4390 to echo it (`GET /v1/boot`) before
the window treats it as its own. So a leftover dev core no longer hijacks the
app invisibly — the desktop reports the conflict and refuses to use it. Stop
the dev core (Ctrl-C) before launching the desktop app; if the desktop shows
“already serving …”, something else still holds :4390.

## Status (2026-09-16)

M0–M25 implemented (PLAN.md §15): schema **v20**; current root
suite **1334 passed** (5 env-gated skips) · web **760 passed** · typechecks 0 ·
web build green. **M25 lets you reconfigure existing providers**: the setup card
gains a *Reconfigure existing* mode that rediscovers an endpoint's models
through the key your OS keychain already holds and reassigns which models each
purpose profile carries — no key re-entry, no delete-and-recreate. **M24 fixes
attached photos never reaching the model** — the
partner replied "I didn't receive an image" for a model that reads it fine when
tested directly against LiteLLM. Capability is now *declared* per provider
(`providers.vision_models`, click a model chip on the provider card, or any model
on a `vision` profile) instead of guessed from the model id, images are encoded to
the inline budget (3 MiB, published as `maxInlineImageBytes`) rather than the
upload cap (8 MiB) so a stored photo is also a sent one, and a turn can carry
several photos instead of one. M24's locally-green exit is recorded; the live
walk against a real gateway is still open (§15). An **M11 F12 follow-up**
shows a fenced ```html code block as a tabbed Code/Preview viewer (source and
sandboxed result one flip apart, so the message never doubles in height, and
the preview pane is sized like a real screen) in chat, the assets read view and
the new note-editor preview toggle. An **M19 follow-up** makes global (all-personas)
fact detection a user-level setting independent of each persona's private-memory
tick. An **M19 follow-up** reviews existing memory and pending suggestions in
the extraction payload (a bounded `ALREADY KNOWN` listing) so an already-known
fact is not re-proposed — and never files the same suggestion twice. Latest
release: **v0.1.15** (memory that reviews what is already known and pending
before proposing, so an already-known fact is never re-proposed in fresh
wording; a fenced ```html block as a tabbed Code/Preview viewer whose preview
pane is sized like a real screen). It builds on v0.1.14 (reconfigure existing
providers — rediscover an endpoint's models through the stored keychain key
and reassign them per purpose, no delete-and-recreate), which builds on v0.1.13 (inline HTML code-block
previews in chat, assets and notes; global auto-remember independent of the
per-persona toggle; the turn-model fallback so extraction never silently
no-ops), which builds on v0.1.12 (per-provider search keys, global
auto-remember, and scorecard ratings — on top of the silent-bind fix, hosted
sign-up by invite, tap-outside pane dismissal, the sidebar minimize toggle, the
mobile phone-tier UI, persona picker, top-bar chrome, note projects, chat
multi-question forms, persona-scoped memory). **M20 is partly done**: **M20.A
(mobile/tablet UI) is implemented and measured**, **M20.B (server role) has
landed through S7 + S9**
(the capability envelope, networked pairing, per-user partitions) with **S8
(Vault/Runner) not started**, **M21 (container + Cloudflare Tunnel) is
live-verified** and **M22 (hosted accounts + deployment-owned files) is
container-verified** — see their sections below.

**M20.A — mobile/tablet UI (2026-09-12, implemented + measured).** The phone
tier is now usable: a bottom tab bar (Chat · Notes · Files · Personas · More)
with a More sheet, rails as overlays instead of columns, and a full-width
transcript and composer. Measured at 390px: permanent chrome **252px→0**,
transcript **122→390px**, controls under 44×44 **11→0** (the conversation
delete action was a **1×19** target). Tablet (768/1024) geometry is
byte-identical to before, so the pass is additive. The phone nav is driven by
a testable model (`web/src/lib/nav.ts`) that asserts every view stays
reachable, and the touch profile adds `--target-min` / safe-area / `dvh`
tokens **without changing any existing token value**.

**M20.A follow-up (same session).** Measuring corrected an earlier claim of
mine: "composer 326px" was the *container* — the **message field** was still
**49px** because the `＋ Attach` and `Send` text buttons took 214px of the row.
It is now **222px (62%)** with icon-only 44px controls and a 16px phone
gutter. **Persona cards** fell from 584px to **340px** (~2.5 per screen) with
the action set on its own full-width row, and their sub-44px controls went
**52→0**. And **attention badges** ship: memory suggestions were previously
visible only by opening Memory and reading a header, so a suggestion could sit
unconfirmed indefinitely. `web/src/lib/attention.ts` (+18 tests) defines "waiting
on you" once across destinations, and the phone **More tab carries the
aggregate** of everything the sheet hides — a badge inside a closed sheet is
invisible. Verified end to end: badge `3` → reject one → `2`, immediately.
Two rules recorded: **a badge must be able to clear itself** (failed scheduled
runs self-clear on a 24h window, since they have no dismiss action), and
`queued` runs are excluded everywhere because a paused run *is* the pending
approval.

**M20.A follow-up 2 — Memory view (same session).** The Memory view had the
same flex-crush bug in three places and had been **missed by M12's legibility
pass**. The Memory controls card ran **1483px** with the copy column crushed to
**9–11px — one character per line** (the Import row was 411px tall), because
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
position above the Export a cautious user reaches for. The order is now
**Export → Import → Forget before a date → Forget everything** (portability
first, destructive last, severity escalating, separated by space), verified
rendered in a browser.

**Applied recommendations (2026-09-12, same session).**

- **The live security hole is closed.** Core-served `text/html` executed on the
  SPA's own origin, where the session token lives — `nosniff` does not stop an
  explicitly declared `text/html`, and the realistic trigger is the partner
  generating an HTML/CSS prototype that the user opens. One exported policy
  (`attachmentContentHeaders()`) now keeps only images and PDF `inline` and
  forces everything else to `attachment` **plus
  `Content-Security-Policy: sandbox`**. HTML upload is unchanged (the model
  legitimately reads attached HTML) and `CodePreview`'s sandboxed path still
  previews it. No SPA regression: the app fetches attachment bytes with a Bearer
  header and `fetch()` ignores `Content-Disposition`, so only direct navigation
  changes. 8 new tests; root suite **893 → 901**.
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
grouped form requires every question, the disabled state always names what it
is waiting for ("2 answers still needed"), and the group locks after sending so
one prominent button cannot double-post.

**Verified through the real chat path** — the demo provider cannot emit
containers, so a throwaway loopback OpenAI-compatible stub returned a choice +
form and was registered as a provider: **1 group · exactly 1 submit · 0 per-card
submits**, the gate walking disabled→disabled→disabled→enabled (hints
`2 → 1 → 1 → none`), and the single press producing **one** user turn containing
**both** the choice and the Q/A pairs.

*Open:* the answered-lock is now **transcript-derived**, so it survives a reload,
  a different device and cleared storage — and, deliberately, a group in an
  earlier reply is inert ("Closed") while only the newest is live. Scope note:
  that lock applies to **grouped** answers only; a standalone card in history is
  still clickable, which is a separate decision.

**The subagent wave (2026-09-12).** A scout + three writers + a fresh-context
reviewer ran against the M20.A follow-ups and M20.B's scoping. Verified outcomes:

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
- **Two MAJOR defects the reviewer caught that I had missed**: `.answer-group-parts`
  had **no CSS rule** (question sets rendered with 0px separation), and **no test
  rendered `AnswerGroup`** — deleting `showSubmit={false}` would have restored the
  original two-submit bug with the whole suite green. Both fixed; the new render
  test was then **falsified** (2 tests fail when the regression is injected).
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
(2026-09-13).** Two reported defects, both measured before and after. **(1)** The
persona list was unusable on a phone while looking fine in the DOM: the top bar
is a horizontal scroller, and `overflow-x: auto` forces `overflow-y: auto`, so the
absolutely positioned popover laid out 655px tall but painted only inside the
bar's **60px** band (**1 of 9** personas), and the open-time focus scrolled the
bar itself up 65px, taking the trigger off screen. At ≤640 the list is now the
same bottom sheet as the More control (fixed, anchored on the tab bar, capped and
scrollable, 71px rows), and the base popover gained a height bound so a landscape
phone (844×390) can reach its tail. **(2)** "Assets" existed **three** times and
the per-conversation theme select twice; by the owner's criterion (*maximise chat
input width* — phone input is 222px either way, desktop loses **316px of 682**
when the pane opens, and only the ungated top-bar icon could open it with nothing
to show) and then by direct instruction, **both controls now live in the top bar**
and the row above the composer keeps only brainstorm state and the save flash,
rendering only when it has content. Measured after: phone transcript
**513 → 565px**, six top-bar controls in 358px with **no scroll**, theme bind
("Midnight") surviving a reload. Guards in `web/test/picker-mobile.test.ts` and
`web/test/assets-lane-controls.test.ts`, both falsified against a reverted fix.
*Still open (measured, not started):* the phone **Notes** view spends its whole
first screen on controls (toolbar 235px in 5 wrapped rows, scope bar 128px, the
search field **405px below the fold**, 3 controls under the 44px floor) — see
`PLAN-M20.md`.

**M20.A follow-up 9 — tap outside a floating pane to put it away (2026-09-14).**
Reported as a product gap: on a touch tier the panes *are* overlays, so the only
way back to the transcript was the toggle that had opened them — measured, the
open rail covers **320 of 390px** and those toggles live in a horizontally
scrolling top bar. Touch has no Escape key, so tapping the content you can see
did nothing; now it dismisses the pane, and the pane **slides out to its own
edge** before its state closes (frame trace 0 → −83 → −204 → −273 → −306 →
−319px over 180ms = `--motion-base`). The scrim is scoped to the workspace so the
top-bar toggles stay live and undimmed, the desktop column model is untouched
(**0** scrims at 1280, a click closes nothing), floating panes can no longer
even overlap at the phone tier (they overlapped by **202px**), and a
reduced-motion preference closes at once. Decision + tiers in
`web/src/lib/panels.ts`; guards in `web/test/panels.test.ts` (+16), falsified.
Web suite **673 → 689**; `ux_audit` PASSED; measurements in
`docs/VERIFY-MOBILE.md`.

**M20.A follow-up 10 — the sidebar minimize toggle, tablet AND desktop
(2026-09-14).** Requested: *"for tablet view/desktop view, allow minimizing the
side menu to icons only, so that when toggled, we can maximize usable view."* M12
already collapsed the sidebar automatically below 1150px, so the labelled 224px
menu survived on every wider viewport with no control to recover the space — and
an iPad in landscape reports >1150 CSS px, which is why both tiers needed it. The
rail is now a **state** (`.app.side-minimized`, one `--side-w` knob) that the
tablet query only defaults: measured @1440×900 the sidebar goes **224 → 60px** and
the content column **1216 → 1380px** (the 164px returned to the view), and at 1024
the default is the rail with the toggle able to restore a 200px labelled menu.
The **attention badge survives** collapse on the button's corner (verified with a
real attention item: 24×28, inside both the 44px button and the 60px rail) — the
old automatic rail hid badges at ≤1150, which is the exact failure M20.A shipped
badges to prevent. The toggle lives inside the sidebar (the phone tier hides it,
so it can never be a dead control), keeps the 44px touch floor, remembers the
choice per session, and crossing into the tablet tier collapses once instead of
fighting the user. Guards in `web/test/sidebar-collapse.test.ts` (+10), falsified
four ways. Web suite **689 → 699**; `ux_audit` PASSED; measurements in
`docs/VERIFY-MOBILE.md`.

**M20.B is executable** — `PLAN-M20-B.md` §3–§5 has the slices, the tests to
write first, the parallelization waves, and a recommended first slice. **Its first
wave landed 2026-09-12:** S1 per-user partition, S2/S2a `users` +
`user_credentials` in a second encrypted system DB with scrypt credentials, S3
session widening + rotation/revoke, and the pure primitives for S4/S6/S7. Schema
v16 → **v18**; root suite 901 → **1066**. Record: `docs/VERIFY-M20-B.md`.

**The review caught a data-loss bug before anyone hit it.** The plan asserted that
an existing `data/partner.db` stays as user #0's partition, and no code did it —
an install booting with `USER_ID=0` would have opened an *empty* database under a
new key and orphaned the real data, silently. Now a single `LEGACY_USER_ID`
constant (which `FIRST_USER_ID` derives from, so they cannot drift) maps that user
to the legacy path, skills dir and `db-key` account. The same pass also fixed
wildcard SANs not matching (which would have refused every real Let's
Encrypt/mesh certificate), a fail-open host check, a mobile capability set that
held three indirect routes to denied powers, a credential timing oracle, and a
partition close/open race.

**Critical caveat: nothing from that wave is wired yet.** The users/credentials
work is not called by `createCore`, the six primitives are unused, and `/v1/pair`
mints exactly as before with `user_id` NULL — so **no new control is in force**.
Remaining: S4 wiring (the next recommended step), S5 devices, S6 wiring, S7
wiring, S8, S9.

**M20.B second wave — S4/S5/S6 WIRING (2026-09-12).** The envelope now
**enforces**: 21 route mounts, `clientClass` on the broker's `ExecContext`, and the
refusal ordered **before** the grant check; the device registry (list / revoke /
revoke-all, 404-not-403 across users, no token material on the wire); and the
transport matrix (`REMOTE_ACCESS` + TLS files + a named `ALLOWED_HOSTS` and an
https listener, with `startServer` re-asserting the refusal). Root suite
1066 → **1109**.

The adversarial review found **three blockers — the envelope was bypassable three
ways** — all fixed: the **approval queue** (`decide` took an actor label, not a
class, so a mobile session could approve a queued write and have it run); the
**persona/skill/playbook tool loops**, which reached the broker class-less so a
mobile *chat turn* executed with desktop authority; and **MCP server CRUD**, which
was ungated while an enabled MCP server is **spawned as a process** — code
execution, which I had underestimated. Also fixed: the S5 transitional rule let a
user-less session read **and revoke a named user's devices** (now scoped to
`user_id IS NULL`).

**M20.B third wave — S7 WIRING (2026-09-13): a real phone can now obtain a
session.** The three S7 modules (`pairSecret.ts`, `rateLimit.ts`,
`pairPayload.ts`) were pure and unused; they are now wired. `POST
/v1/pair/payload` issues a 256-bit single-use secret **to a loopback caller
only** (and refuses without remote access + TLS, so no secret is ever carried
over plaintext); `POST /v1/pair` accepts `{secret}` from anywhere and mints a
**`mobile`** session — never `desktop` — while `{code}` is refused from a
non-loopback **socket peer** *before* it is verified, so a remote caller can
neither consume nor lock the code on the user's screen. Locality is the peer
address, not the `Host` header (§2.1 already reclassified that as a lookup
key). Both paths are rate-limited per peer, and a successful pair resets the
bucket.

The client half ships too: the SPA reads a `#pair=…` fragment,
**re-validates** the payload itself (https only, canonical 32-byte base64url —
the value arrives from a QR code, i.e. from outside), confirms once, stores the
token and clears the fragment (the secret is in the fragment, never the query
string, so it does not reach the core's log or any proxy). The Providers screen
has a **Phone & tablet access** card that issues the link; it is action-driven,
because minting on mount would create a live secret on every render.

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

**M21 — container deployment + Cloudflare Tunnel (2026-09-13, container-verified).**
Partner now runs **headless in a container, in LIVE mode**, reachable only
through a Cloudflare Tunnel: no published port, no inbound rule, no certificate
to renew. `docker/server/` holds the live image (non-root, S6 remote matrix:
`REMOTE_ACCESS` + TLS + a named `ALLOWED_HOSTS`), a two-service compose, stage
scripts that also generate the origin certificate, and three container-side
Node tools (`healthcheck`, `pair-link`, `partner-request`). The first-run flow is
`docker compose exec partner node tools/pair-link.mjs` → open the printed
`https://…/#pair=…` link.

Two things had to change in the core. **(1) A `file` keychain kind**
(`KEYCHAIN_KIND=file` + `KEYCHAIN_FILE`): live mode refuses to run with the
in-memory fake keychain (the key would vanish on restart) and the native
keychain needs an OS keyring daemon a container does not have, so a container
had no way to keep a database at all. The file kind is JSON, 0600, atomic and
serialised writes, and a **malformed file refuses the boot** rather than
minting a fresh key beside an existing database. It co-locates the cipher key
with the volume it protects, so it is documented as protection against a copied
DB or a backup — not against a reader of the volume; `native` stays the default
wherever a keyring exists, and **one core per volume**. **(2) `KEYCHAIN_KIND`
now validates**: an unknown value used to silently mean `native`, which in a
container is a keyring-daemon error instead of a configuration error.

**The topology is a security property, not a wiring preference.** The tunnel
sidecar keeps its **own network namespace**, because the pairing routes decide
by *socket peer* (M20-B S7). Sharing the core's namespace would make every
internet request look loopback, and an anonymous visitor could then mint a
pairing secret via `/v1/pair/payload` and trade it for a session. So the
compose publishes no port, keeps two namespaces, and pairing runs through
`compose exec` — shell access to the container is the operator's proof of being
"at the machine". A consequence worth stating plainly: **a `desktop` session is
unreachable in this shape**, so the device pairs as **`mobile`**
(chat/read/notes/memory/personas/schedules/provider setup work; file write,
roots/grants, deploy and skill install are refused by class). Elevating an
operator-issued secret to `desktop` is the coherent follow-up and a reviewed
capability decision, deliberately not taken here.

Measured in a real container: LIVE boot (`demo=off`, schema v18), `healthy`,
SPA served, a non-loopback peer redeems a secret for a `mobile` session while
`/v1/pair/payload` and `{code}` stay `403 loopback_required`, the minted session
**survives a container restart** (volume + file key), the database's first bytes
are ciphertext, and `/data/keychain.json` is `0600`.

**Live deployment check (2026-09-13, `partner.teliti.app`) — and it found a
blocker the suite had certified.** Over the user's real tunnel: the SPA served,
the live gate rendered, a `compose exec`-minted link paired a browser, the session
came back `clientClass: "mobile"` (a `POST /v1/roots` probe was refused by
class), and an authenticated read (9 persona cards) worked. But the **first**
thing the check hit was `"This link is missing a valid certificate fingerprint"`
— for a payload the core had just built. `web/src/lib/pair-link.ts` validated the
fingerprint/secret by decoding to **text** and comparing the character count to
32; the core issues 32 crypto-**random bytes**, which decode to ~28 UTF-8
characters, so *every* genuine pairing link was refused. The unit tests missed it
because their fixtures were ASCII filler (`'x'.repeat(32)`), which satisfies both
readings — 14 green tests proved nothing. Fixed to count **bytes**, fixtures
replaced with `randomBytes(32)`, and the missing seam test added:
`tests/pair-payload-agreement.test.ts` (core builds → browser accepts, 25 random
samples, plus agreement on refusals). Both fixes falsified by injection. A second
defect the same check found: a link pasted into an already-open tab did nothing
(fragment-only navigation does not remount the SPA) — `PairGate` now re-reads on
`hashchange`.

Root **1166** · web **639** · typechecks 0 · build green. The Cloudflare edge leg
is now verified too; `stage.ps1` and a handset walk remain. Record:
`docs/VERIFY-M21.md`, spec `PLAN-M21.md`.

**M22 — remote-hosted accounts, deployment-owned files, no llm-self-service
(2026-09-13, container-verified).** Three changes for the hosted shape.

**(1) Pairing is replaced by user login.** `AUTH_MODE=login` makes `POST
/v1/auth/session` the only way in: a per-user passphrase (scrypt, in the system
DB, never stored) mints a session that **carries `user_id`**, so authorization has
an identity to work with instead of inferring one from proximity. A wrong
password and an unknown username are indistinguishable, three failures lock the
credential for five minutes, and a per-peer rate limit sits on top — behind a
tunnel every request shares one peer address, so the lockout alone would let one
actor lock the owner out. **The entire pairing lane answers 403 in this mode**
(`/v1/pair`, `/v1/pair/payload`, `/v1/device`, the demo seam). Accounts are
managed by the operator CLI — `docker compose exec partner node tools/user.mjs
add|passwd|list|lock-account|unlock-account` — because shell access to the
container is the "at the machine" proof, and **one user per core is enforced**
until per-user partitions (S1/S8/S9) land: two accounts would share one database.
The desktop pairing shape is untouched.

**(2) The deployment owns the file roots.** `FIXED_ROOTS=/files` registers the
mounted volume at boot (idempotently — grants reference a root by id, so a second
boot must reuse the row) and `POST`/`DELETE /v1/roots` answer `403 roots_fixed`;
the Files view renders the list read-only. A configured path that is not a
directory fails the boot by name instead of leaving the tools with nothing.

**(3) llm-self-service is gone** from core, web and `shared` — routes, the
page-side RSA envelope, the demo double, the Providers card. Provider setup is a
base URL + key. The `'llm-self-service'` `ProviderSource` value stays so provider
rows written by an older install still read; nothing creates one. That also
closes **S0** (the companion endpoints in the other repo) as obsolete.

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

**M22 R-slice — the recommendations, built (R1–R4, R6–R9; R5 skipped by request).**
The headline is **R1, per-user partitions**: a partition IS a single-user core
(its own whole-file-encrypted database, its own cipher key `db-key:<id>`, its own
skills directory), built by `core/src/users/rails.ts` and handed requests by a
listening app that authenticates against the **shared** system sessions and
**delegates** everything else. That is why not one of the ~200 routes changed —
and why "a query cannot cross users" is structural rather than a filter someone
has to remember. Two users are provably isolated in `core/test/http/
userPartitions.test.ts` (real sign-ins, two encrypted files, neither read
containing the other's rows, separate keys, per-user audit). The **first account
owns the pre-partition database**, so an install that ran single-user keeps its
history, and a boot guard refuses to start when a legacy database has no user to
own it rather than orphaning it.

Also landed: **R2** rotation revokes that user's sessions; **R3**
`PARTITION_IDLE_MS` closes idle partitions (memory hygiene — the file keychain
still holds the key, and the docs say so); **R4** `CLIENT_IP_HEADER` +
`TRUSTED_PROXY_CIDRS` give per-client auth rate limiting, believed only from a
trusted peer and never used to decide locality; **R6** `FIXED_ROOTS_READ_ONLY`;
**R7** `MAX_UPLOAD_BYTES` / `MAX_JSON_BYTES` — with the upload cap now genuinely
reachable: the file bytes ARE the body (content type = mime,
`x-attachment-name` = name), `/v1/health` publishes `maxUploadBytes`, and the 413
names the file, its size and the limit. Until 2026-09-14 uploads rode a base64
JSON envelope and were really capped at ~768 KiB by the 1 MiB JSON limit, which
refused iPhone photos with a bare `payload_too_large`
(`docs/VERIFY-M22.md`); **R8** a **verified** backup tool
(`tools/backup.mjs`: `VACUUM INTO` snapshots of the system DB and every partition,
re-opened with the copied keychain + `integrity_check`, prunes to `--keep`, exits
non-zero when it cannot verify — a half-backup is never reported as one); and
**R9**, the recorded vocabulary gap closed (`provider.configure`, `persona.run`,
both denied to mobile/extension by the envelope table). Root **1204**, web 635,
typechecks 0, build green.

**PLAN-M20-B S1 and S9 (same session).** **S1** (per-user partitions) is verified
end to end — the rails are the caller its modules were missing: two users, two
encrypted files, per-user keys, audit and skills, an LRU bound with idle close,
and the first user keeps the pre-partition database (a boot guard refuses to
orphan it). **S9** makes the hosted promise real: schema **v19** adds `key_wraps`
and `users.keep_unlocked`; at first sign-in the partition key is **wrapped under
the passphrase** — AES-256-GCM under a key with its own salt and HKDF domain
separation, so the stored credential verifier cannot unwrap it (that attack is a
test) — and the plaintext is **removed** from the keychain. A signed-out user's
partition then answers `401 unauthorized / partition_locked` **even while their
session is still valid**, signing in again re-opens it, and closing a partition
drops the SQLite handle (an open handle would keep decrypted pages cached). The
per-user, audited `keep-unlocked` opt-in is the stated exception — their
schedules may run with nobody signed in — and `passwd` refuses to orphan a
wrapped key unless `--reset` is passed. Root **1215**, web 635, typechecks 0.
Record: `docs/VERIFY-M22.md`.

**M22 sign-up — the invite lane (2026-09-14).** The operator CLI meant the operator
typed every account's passphrase, so a hosted core started with credentials someone
else had seen. `SIGNUP_MODE=invite` (default **off**; needs `AUTH_MODE=login`) now
lets a person create their OWN account: the operator mints a 256-bit **single-use**
invite on the machine (`docker compose exec partner node tools/signup-link.mjs` →
`https://<host>/#signup=<code>`) and sends the link; the person picks their name and
passphrase, lands signed in, and gets their own encrypted partition. The mint route
is **loopback-only** (the same "shell access = at the machine" proof as pairing),
the code is consumed by exactly one account, the shape checks run **before** the
code is spent (a typo must not burn an invite), a taken name is a 409, and neither
the name nor the passphrase reaches a response or an audit row. Names and
passphrases are validated by one shared rule set (`shared/src/accounts.ts`), so the
browser cannot promise what the core refuses. **There is deliberately no `open`
mode** — a hostname the internet reaches is reachable by anyone, and the operator's
invite is the admission decision. The browser walk found and fixed a real bug on the
way: a link opened in a **fresh tab** rendered the form with an empty code field
(only the paste-into-an-open-tab path seeded it), so the person who followed the
instructions literally got a form that could never submit. Root **1227 → 1254**, web
**699 → 712**. Record: `docs/VERIFY-M22.md`; spec `PLAN-M22.md`.

**S8 (Vault/Runner tier split) is NOT done** — deliberately. Role isolation and
briefcase caps are a boundary where a half-implementation is worse than none (the
slice's first test is "a runner bundle cannot open `vault.db`, asserted by
attempting every Tier C op"). The plan stands as written in `PLAN-M20-B.md` §S8.

**The Windows `userPartitions` failure was two real defects, both fixed
(2026-09-15).** Every `verify (windows)` run had been failing five partition tests
while `verify (linux)` passed, and the local suite reproduced it — the symptom was
`TypeError: Cannot read properties of null (reading 'port')` in the test's own boot
helper. The cause was **not** the isolation code:

1. **`listen()` resolved a core that was never listening.** On Windows,
   `app.listen(port, host, callback)` invokes that callback *even when the bind
   failed*, and readiness was taken from it — so a core whose port was taken
   resolved `startServer`, printed "up on …" and served nothing, while the real
   `EADDRINUSE` was swallowed (its `reject` arrived after the promise settled).
   Readiness now comes from the `listening` event and failure from `error`, so a
   taken port rejects the boot by name. Guarded by `core/test/listen.test.ts`.
2. **`PORT=0` silently became 4390.** `readInt` falls back to the default for
   anything out of range, and three test files (plus one 800-line core test) asked
   for an ephemeral port that way — so they only passed while 4390 happened to be
   free. A leaked spawned-core from an earlier e2e run was holding it, which is
   why the failure appeared suddenly and then persisted. `loadConfig` now refuses a
   malformed or out-of-range `PORT` (0 included) with a message that says why an
   ephemeral port cannot be allowlisted, and those tests bind a **named free port**
   (`freePort()` in `core/test/helpers.ts`).

The second defect is what made the first invisible; fixing only one would have
left the other. Teardown in that file also drops keep-alive sockets before waiting
(`closeServer`), which is what turned a 10s hook timeout into an EPERM on the temp
dir. Root suite on Windows: **1254 passed / 5 failed → 1262 passed / 0 failed**
(5 env-gated skips).
Still open: S8, a device/sign-out UI, per-user quotas — and unverified: a two-user
browser walk, R4 against the real edge, an R8 restore, R3's live timer, and S9's
wrap roll-out on the live deployment.

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

**M15 — Live desktop mode (exit demo).** The packaged shell now boots the
core LIVE by default: persistent whole-file-encrypted DB + OS-keychain key
and skills under the per-user app-local data dir (`%LOCALAPPDATA%\dev.ne1.partner`
on Windows), a per-boot device secret enables the header-guarded
`GET /v1/pair/device` code channel, and the **tray** (Show pairing code… /
Open Partner / Quit) surfaces the live pairing code for the web PairGate
(now health-aware: live copy, no demo button). The core exits itself when
its shell dies by any path (stdin parent-watch). `PARTNER_DEMO_MODE=1`
keeps the historical in-memory demo boot. Remaining items are manual /
env-gated: the packaged live-boot walk on this desktop is executed in
PLAN-M15; per-surface theme walkthrough (`docs/theme-conformance.md`); the
`docs/VERIFY-M10.md` live-mode walk details; browser-actuator research
capture; S0 companion API in `~/apps/llm-self-service`. Read
`HANDOFF-WINDOWS.md` first when picking up from a Windows machine.

### M19 — persona-scoped memory & automatic remember (2026-09-12, implemented)

Personas gain **private memory**: a per-persona tick
(`memory.personaMemory = on|off`, off by default) makes a persona keep its
OWN facts about the user and recall them **only in chats with it** — the
interactive `/v1/chat` route. A persona-scoped entry is never injected into a
different persona's prelude, and the headless playbook/schedule/brainstorm
loops never see it. Global confirmed facts still tailor every persona (M4).

**Automatic remember.** Detection has two independent consents. A user-level
**global auto-remember** setting (`GET`/`PUT /v1/memory/settings`, default
**on**) covers facts that apply to every persona — name, role, language,
standing tone — regardless of which persona is speaking. Each persona's
**private-memory** tick (off by default) covers facts tied to that persona.
The core asks the persona's cheap-task-class model (out of band, AFTER the
client's response has ended, so the turn never waits) whether the finished
exchange holds anything durable about the user, and drops findings for a
scope whose consent is off. Findings are filed as `partner_suggestion` /
`suggested` entries for the user to confirm, edit or reject in the Memory
view — alongside the existing explicit add-a-fact path. Each finding is
labeled **global** (filed `personaScope: null` so it tailors **every** persona
once confirmed) or **persona** (filed scoped to the persona that heard it),
so the partner learns a universal fact once instead of per persona. The
extractor prompt is fixed and
never user-derived; parsing is defensive (fence/JSON guard, kind + scope
whitelist with a persona default, caps, obvious-secret filter); before
suggesting, the extractor reviews a bounded `ALREADY KNOWN` listing of the
confirmed and still-pending facts the persona honors (global + its own scope)
so already-known facts are not re-proposed, and dedupe (punctuation/case/space-
insensitive) covers global + same-scope entries, rejected included, so a
rejected fact is never re-suggested and the same fact is never suggested
twice; demo/no-provider turns skip; if the persona's cheap/chat model
cannot be resolved on its own (a provider with no default models whose turn
carried an explicit model), extraction rides the exact provider + model that
served the turn, so a successful turn never silently skips remembering; audit
rows carry ids/counts/model
only. No schema change (M4's `profile_entries.persona_scope`/`source`, the
`personas.memory_flags` JSON and the `settings` key-value table were enough).
Web: an “Automatic memory” card in the Memory view, a Memory fieldset in the
persona editor, a persona-aware “in use” marker, and an “Auto-detected”
provenance chip. Suites after the pass: core **893 passed** (5 env-gated
skips) · web **541 passed** · typechecks 0 · web build green · `ux_audit`
green; later follow-ups (turn-target fallback, independent global consent)
kept the suites green. Spec: `PLAN-M19.md`.

### M25 — reconfigure existing providers (2026-09-16, implemented)

The setup card could only ADD purpose providers. Once a profile existed, the
only way to change which models its purpose carried was to delete it and build
it again — which meant pasting the API key another time and discarding the
keychain item. The card now has two modes: **Add new** (the M13 bundle,
unchanged) and **Reconfigure existing**.

Reconfigure picks one of the endpoints already in the list, rediscovers its
current models through the key the keychain **already holds**
(`GET /v1/models?provider=<id>` — there is no key field, and the probe tries the
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
   sees — and an image that still cannot ride is described to the model as
   **NOT sent** rather than reading like a successful attachment.

Declarations are editable on a working provider (`PUT /v1/providers/:id`, plus
clickable model chips on the provider card); a model the name already recognises
and a `vision`-purpose profile are not un-tickable, because clicking would do
nothing. A third, smaller silent loss went with it: the image part was singular,
so a turn attaching two photos sent one — it is now a list (up to 4 per message,
and the composer says outright when staged photos exceed that).
Suiting after the fix: shared **90** · root **1333 passed** · web **742 passed**
· typechecks 0 · web build green.

### M23 — scorecard chat answers (2026-09-15, implemented)

A fourth answerable container joins clickable choices and free-text forms:
`:::partner.scorecard` rates several named items on one shared numeric scale, so
a multi-item review is answered in one pass. Grammar: one item per bullet line,
`scale=<2–10>` (default 5) sets the highest score with scores running 1..scale,
and an optional `labels="Low|High"` names the ends. Each item is its own radio
group, so one score per item is structural rather than a validation rule.
Submitting once sends a single labelled user turn (`Q: <item>` /
`A: <score>/<scale>`) through the normal chat path — nothing client-only, the
persisted text unchanged. The parser shares the `:::partner.*` grammar
(`shared/src/structured.ts`): closed-container-only materialization,
malformed/unclosed containers degrade to prose, and an out-of-range scale
clamps rather than dropping the card. Inside the M20.A one-submit group a
scorecard must have every item rated; standalone it accepts any non-empty
rating set. Pending ratings survive conversation switches (client-side
per-conversation UI memory). The `scorecards` guidance ships in the default
structured feature set; styles are token-only.

### M18 — chat multi-question forms (2026-09-11, implemented)

When a persona has **more than one open-ended question**, it now emits a
`:::partner.form` container instead of a prose list. Each question renders in
its own textarea and the user submits **once**; the answers become a single
labelled user turn through the normal chat path (nothing client-only, the
persisted text is unchanged). The parser shares the `:::partner.*` grammar
(`shared/src/structured.ts`): one question per bullet line, a title from the
`title=` attr / fence tail / lead line, closed-container-only materialization
so streaming stays safe, and malformed or unclosed blocks degrade to plain
prose. Pending drafts survive switching conversations (client-side
per-conversation UI memory). The `forms` guidance ships in the default
structured feature set alongside choices and assets; styles are token-only.

### M17 — note projects (2026-09-11, implemented)

Notes gain an organizational layer on the existing Projects/Folders tree
(shared with chats; many-to-many, no membership = Inbox). A single membership
write path (`setFolders`) backs both create-time `folderIds` and re-filing;
`list()`/`graph()` scope by folder subtree or Inbox; a scoped graph returns
one-hop, both-direction **ghost** nodes for out-of-scope references (marked
external, never persisted). Deleting a folder clears membership (notes
survive); deleting a note cascades its membership rows. New routes:
`GET /v1/notes?folderId=<id|none>`, `GET /v1/notes/graph?folderId=…`,
`PUT /v1/notes/:id/folders` (501 when folders are unwired). The Notes list
and graph get project scope selectors, project chips, an editor Projects
multi-select, dimmed ghost nodes + an "other projects" toggle, drag-to-ghost
and a "Link to note…" picker. Schema v15 → v16 (`note_folders`); audit stays
membership counts only.

### M16 — knowledge workspace (2026-09-09, implemented)

`PLAN-M16.md` ships six features (implemented; packaged walk env-gated): a
React Flow notes relationship graph (edges follow who references whom; mutual
refs render bidirectional; drag positions persist), **Brainstorm from notes &
captures**
activating a seed-on-demand **Brainstorming** persona (`p-brainstorm`),
**versioning for notes & captures** (history, diff, undoable restore),
**Discuss in Assets** (branch/thread of the asset's own discussion, or fork
into a new one — schema v14 adds `conversations.parent_id` +
`source_asset_id`), **Assets → Export working in the packaged desktop app**
(native save-dialog path in the Tauri shell; blob fallback in browsers), and
**CSV assets rendered as tables** (pure shared parser). Schema v13 → v14.
Root suites: shared 51 · core 837 (2 pre-existing env cipher failures) ·
web 486 · typechecks 0 · web build green · `ux_audit` green.

**M16 follow-up — linked, reopenable brainstorms (schema v14 → v15).** A
brainstorm conversation is linked back to its source note/capture nodes
(`brainstorm_sessions` keyed by the deterministic source set + a
`brainstorm_sources` join); the graph badges those nodes and lists their
sessions. Clicking **Brainstorm (N)** over a set that already has an ACTIVE
session reopens it instead of starting a duplicate; once a path is
**concluded** a fresh brainstorm starts, and the concluded one stays listed in
the graph with **Reopen** to continue it. The open brainstorm chat also
carries a `Brainstorm active|concluded` chip with **Conclude**/**Reopen** in
its action bar. Owner actions, ids/counts only.

### M14 — scheduled & autonomous work (2026-09-06, core engine green)

Personas carry **schedule definitions** inside their independence bundle
(`independence.schedules[]` — daily/weekly wall-clock or a rolling interval,
prompt, optional IANA tz, per-run round bound, save-note flag). The core's
scheduler wakes on a heartbeat (`SCHEDULER_TICK_MS`, default 30 s;
`SCHEDULER_TZ` overrides the machine-local default; UTC in demo) and fires
due schedules for **unpaused auto/autonomous personas only**. Each fire is a
**headless bounded persona tool-loop run** on the same engine playbooks use:
the brief lands as a user turn in the schedule's own conversation thread
(auto-created, persona-bound, home-folder aware, reused across runs); tool
use keeps every existing gate (independence × risk matrix, persona bans,
default-deny broker grants); a queued tool pauses the run (row status
`queued` + `pendingId`); deciding that approval from the Files queue or the
in-chat card **auto-resumes the run in-process** — no UI click needed to
continue; the final answer appends to the thread on done (+ optional
save-note); every attempt writes a `scheduled_runs` row and audit
`schedule.run`/`schedule.resume`/`schedule.skip` rows (ids/counts only —
prompts and transcript text never cross audit). Pausing the persona is an
instant kill switch for its schedules (new runs AND resume). Missed windows
fire at most one catch-up run; windows never storm. Schedules are edited
through the existing persona surface; new routes: `POST
/v1/personas/:id/schedules/:scheduleId/run-now` (headless), `GET
/v1/schedules/runs` + `/v1/schedules/runs/:runId`. Schema v13 (additive:
`personas.schedules`, `scheduled_runs`). Spec: `PLAN-M14.md`. Web slice
(schedule editor + runs panel) is done: web/src/SchedulesSection.tsx renders in the persona
editor — list with enabled toggles, add/edit/remove, daily/weekly/interval fields,
timezone + round-cap, Run now for persisted schedules with inline errors, and a
Recent runs mini-panel (status dots, model, queued-approval hint, auto-refresh
after run-now). Token-only, ux_audit green, web build + typechecks 0.
live manual walk (env-gated) only; the decide-hook is now proven end-to-end
(core/test/http/schedulesApproval.test.ts — real broker loop, approve + deny, headless
auto-resume, transcript + audit assertions).
Live walk executed 2026-09-07 against https://api.ne1.dev/v1 (deepseek-v4-flash) +
Brave search: purpose provider healthy (1063 ms, 4 models), real Brave results returned,
scheduled run paused on a queued approval and auto-resumed headlessly to done, final
brief persisted in the conversation thread and as a note, audit rows content-free,
core log clean of key material. Walk bug found + fixed: resume-completed runs now
save-note (the resume path carried schedule=null) — covered by a manager unit test.
Remaining: packaged-app walk (shell/NSIS) only.

### M13 — purpose providers & in-session model switch (2026-09-06)

Providers can be set up **by purpose** (General · Cheap · Deep · Coding ·
Vision · Research) from one endpoint + key: discover the endpoint's models,
**assign which model(s) each purpose uses** (first = default), optionally cap
spend per profile, then
`POST /v1/providers/purposes` creates one profile per purpose with those
pins (no pins = heuristic: vision keeps image-capable models, others the
full list); the single key lands in each profile's keychain item. The
standalone single-provider add form is gone — the purpose card is the only
add surface (the single-provider create route stays for API clients and the
llm-self-service import). Chat
has a **per-message model picker** (Auto = persona routing, or any
provider's models grouped by purpose, vision-marked), backed by a per-turn
`providerId` pin that wins over persona pinning and purpose routing.
Attached photos now reach a vision model: an implicit turn whose model
can't see images is rerouted to the best vision-capable model
(`chat.vision_reroute` audit), an explicit pick is never overridden, and
vision capability lives in one shared module (`shared/src/vision.ts`)
used by core and web alike. Spec: `PLAN-M13.md`.
Suites after the pass: core 681 (5 env-gated skips) · web 470 · typechecks
0 · ux_audit green on the new picker + bundle card.

### M12 capability pass — personas can actually use web search (2026-09-06)

Chat personas now know what they may do: every persona turn declares its
independence level, and when the internet-search backend is enabled
(Providers → Internet search) the persona is told the tool exists with the
exact directive grammar to call it:

- **auto / autonomous** — run `search` directly (the enabled backend is the
  consent); results land as a system note for the next turn.
- **suggest** — every search request queues an approval in the Files queue
  (tagged with the persona, showing the truncated query); **Approve** runs
  the search once and posts the result note into the conversation, **Deny**
  posts a denial note. No grant is ever created (external tools have no
  project root).
- **assist** — chat/proposals only; never offered the tool and never asked
  to approve (approvals start at Suggest).

Providers → Internet search shows **two provider cards** (Tavily and Brave).
Each card stores its own keychain key and endpoint override, and a radio on
the card picks the active provider — so a user holding both keys can keep
both and switch without re-entering either.

### M12.6 — approvals live where the ask happened + the chat continues (2026-09-06)

Suggest-level asks now surface **on the chat screen itself**: pending rows
carry their `conversationId`, and while the active conversation has one, an
"Approval needed" card (Approve / Deny) renders above the composer with the
same row detail as the Files queue (tool, risk, truncated query, persona).

- **Approve / Deny in the card** decides the row exactly like the Files
  queue (search runs once / denial note) **and then continues the turn**: a
  new `/v1/chat` mode (`continueTurn: true`, conversation only, no user
  message) streams the persona's next round against the outcome note the
  decision just posted — no phantom user turns, no navigating away.
- The Files queue stays the global queue (badge count unchanged); decisions
  made there post their notes and the chat transcript refreshes when you
  return to the Chat view.
- Guarded: `continueTurn` requires a conversation, refuses request messages
  and `noPersist`, and every existing turn path is byte-identical unless the
  flag is sent. Audit stays query-free.

Suites after the pass: core 673 passed (5 env-gated skips) · web 461
passed — typechecks 0, `ux_audit` green on the new chat-approval card.

Persona tool bans are respected everywhere; disabled/assist personas are
never even told the tool exists (default-deny). Audit rows stay query-free
(query length + hit count only). Suites after the pass: core 657 passed
(5 env-gated skips) · web 460 passed.

Dev note: `npm run dev:core` runs demo mode by default — an **in-memory
DB + fake keychain**, so personas/config/search keys reset on every restart.
Use `DEMO_MODE=0` (with a `DB_PATH`) for a persistent setup.
