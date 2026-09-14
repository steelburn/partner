# Partner — Windows CI handoff & project state

**Purpose:** everything an agent needs to continue from a **Windows machine,
cloning `github.com/steelburn/partner`**, plus a full project status snapshot
so no local-only context is lost. Refreshed 2026-09-12 (M19 shipped; schema
v16). `PLAN.md` §15 + `README.md` are authoritative for per-milestone state;
this file is the Windows onboarding + history snapshot.

## TL;DR

- Product milestones **M0–M19 are complete and verified** (fresh-context
  reviews closed; exit checklists ticked): **M15** (live desktop mode, exit
  demo), **M16** (knowledge workspace — notes graph, versioning, brainstorm,
  discuss, CSV tables), **M17** (note projects), **M18** (chat multi-question
  forms), **M19** (persona-scoped memory + automatic remember).
- **M20 is IN PROGRESS** and is the live workstream. `PLAN.md §15` M20 gives the
  milestone entry; `PLAN-M20.md` is the design spec; **`PLAN-M20-B.md` is the
  execution breakdown and its §3.0 status table is the authoritative
  done-vs-remaining list.** `docs/VERIFY-MOBILE.md` (M20.A) and
  `docs/VERIFY-M20-B.md` (M20.B) are the verification records.
- **M20.A — mobile/tablet/touch UI: landed and measured.** Bottom tab bar +
  More sheet, overlay rails, keyboard-safe composer, a 44px touch floor, and
  attention badges (so a memory suggestion can no longer sit unnoticed).
  Measured at 390px: composer 58→326px, permanent chrome 252px→0, controls under
  44×44 11→0.
- **M20.B — first wave landed** (S1 per-user partition, S2/S2a users +
  scrypt credentials in a second encrypted system DB, S3 session widening +
  rotation/revoke, and the pure primitives for S4/S6/S7).
- **M20.B — second wave landed** (S4/S5/S6 **wiring**): the client-class
  capability envelope now **enforces** (21 route mounts, `ExecContext.clientClass`,
  refusal ordered *before* the grant check), the device registry exists
  (list/revoke/revoke-all, 404-not-403 across users, no token material on the
  wire), and the transport matrix is real (`REMOTE_ACCESS` + TLS files + a named
  `ALLOWED_HOSTS` + https listener). An adversarial review found **three blockers
  — the envelope was bypassable three ways — all fixed**; see
  `docs/VERIFY-M20-B.md`.
- **Schema is v19** (additive: v17 = `users` + `user_credentials`, v18 = the
  session columns `user_id`/`client_class`/`device_label`/`platform`/
  `rotated_at`, v19 = `users.keep_unlocked`, the S9 per-user key policy). Current
  suites: root **1215 passed · 5 env-gated skips** · web **648 passed** ·
  typechecks 0 · web build green. Latest release tag: **v0.1.8**.
  **Run the root suite with no dev core on :4390:**
  `core/test/http/userPartitions.test.ts` fails 5/5 (`server.address()` returns
  null) while one is listening.
- **Everything through M22 is committed** as the v0.1.8 release — the tree was
  fully uncommitted before it, so this replaces the earlier "`git status` is the
  only record" caveat.
- **A real phone can use the M20.B enforcement.** **S7** is wired:
  `POST /v1/pair/payload` issues a single-use 256-bit secret to a loopback
  caller, and `POST /v1/pair` accepts it from anywhere and mints **`mobile`**
  (never `desktop`), with `{code}` refused from a non-loopback peer *before* it
  is verified. **S9** landed with v19 (`users.keep_unlocked` + the per-user
  wrapped partition key; `docs/VERIFY-M22.md` §"S9 — wrapped partition keys").
  **S8** (Vault/Runner tier split, briefcases, drain) is still **not started**
  (`PLAN-M20-B.md` §3.0).
- **Windows desktop CI is GREEN.** `verify` runs on the self-hosted Linux +
  Windows runners (`win-intel-i5-core-ultra`, label `[self-hosted, Windows]`)
  and passes end-to-end on both. `windows-build` produces the NSIS installer;
  the last packaged boot verified env-free was **schema v12 (M11)**, so the M14
  packaged boot remains the outstanding env-gated walk. (M15 changed the packaged
  boot: the desktop shell now runs the core LIVE by default —
  `PARTNER_DEMO_MODE=1` restores the demo boot.)
- Remaining is **manual / env-gated only**: the M14 packaged-app boot walk, the
  per-surface light/dark/custom theme walkthrough
  (`docs/theme-conformance.md`), live-mode packaged-core boot + real-keyring/
  charged-provider items (`docs/VERIFY-M10.md`), Chrome click-through +
  native-host install (extension), S0 companion API in
  `~/apps/llm-self-service`, **and the M20.B upgrade rehearsal** — the
  legacy-partition alias is unit-tested but has never been exercised by a real
  file-DB boot with `USER_ID` set, which must happen before anyone sets it.
- Open infra note: the repo's root `vitest` config runs only `shared/test`,
  `core/test` and `tests/`; the web suite is run with
  `npx vitest run --root web` and the extension suite is **not wired to any
  runner** in this repo (no `test` script in `extension/package.json`).
- Repo: `github.com/steelburn/partner` (private), default branch `master`,
  pushed direct. `verify` auto-triggers on push; `windows-build` triggers on
  workflow_dispatch / `v*` tags.

## Machine prerequisites (this runner/dev box)

1. **VS Build Tools 2022, workload "Desktop development with C++"** (MSVC
   14.44 + Windows SDK 10.0.26100 verified). Needed by npm ci (node-gyp
   rebuild of the aliased `better-sqlite3`) AND cargo/NSIS.
2. **Rust stable-msvc** (CI installs via dtolnay; ~/.rustup on this box).
3. **Node 22** (SQLCipher-fork prebuilds need node ≥ 22).
4. **Smart App Control OFF** (Windows Security). SAC blocks unsigned cargo
   build scripts intermittently (`os error 4551`) — must be off for any
   native compile.
5. **Git for Windows first on PATH** — bash-using actions
   (`dtolnay/rust-toolchain`, …) resolve WindowsApps' WSL shim otherwise.
   Restart the runner after PATH changes.
6. **PowerShell execution policy is GPO-pinned** — workflow steps use
   `shell: cmd` (pwsh unusable; node-gyp's PS discovery also blocked, so
   node-gyp falls back to vswhere — works with the workload installed).

## Repo map

```
.github/workflows/verify.yml          CI: linux+windows legs, all suites
.github/workflows/windows-build.yml   Desktop build: stage → npm ci → bundle → tauri build nsis
shell/             Tauri v2 app (src-tauri; icons; resources gitignored, staged by CI)
shell/src-tauri/README-windows.md     Windows runbook (verified state + resources rationale)
core/              Node core (loopback API, broker, personas, memory, notes,
                   theming, NM mode, skills, playbooks, encrypted DB, budgets,
                   audit w/ redaction, chat tool pass, MCP client, search,
                   schedule engine + scheduler driver)
web/               React SPA (Vite; attachments/assets, folders, markdown,
                   choices, MCP + search panels, theme studio, Audit,
                   session-only chat, budget UI, schedule editor + runs panel,
                   left-sidebar shell)
extension/         MV3 extension (native-messaging bridge, theme stream) + README runbook
shared/src/        wire contracts (schema **v18**), theme tokens, redaction
                   (also exports LEGACY_USER_ID — see PLAN.md §12)
tests/             cross-cutting e2e (spawn real demo core; audit, playbooks)
PLAN.md + PLAN-M0..M20.md + PLAN-M20-B.md   milestone specs
                   (M20 = live workstream; its B spec has the slice status table)
skills-catalog/    local skills (hello-skill, note-echo, files-preview)
docker/webapp-demo/  demo container (node:22-slim; core bundle + web/dist)
docs/              VERIFY-M10.md, VERIFY-MOBILE.md (M20.A),
                   VERIFY-M20-B.md (M20.B), theme-conformance.md,
                   redaction-inventory, migrate-plaintext
```

## Verification commands (all green locally + on CI)

```bash
npx vitest run                 # root suite (shared/core/tests: 1109 passed; 5 env-gated skips)
npx vitest run --root web      # web suite (619 passed)
npm run typecheck              # workspaces (0 errors)
npm run build -w web           # SPA build
```

Windows leg skips 5 env-gated symlink tests (no Developer Mode) — expected.
Note: the web suite is **not** part of the root run (root `vitest` covers
`shared/test`, `core/test` and `tests/` only), so run it with the `--root web`
form above; the extension suite is not wired to any runner (see the open infra
note in TL;DR).

## Windows build (CI path — no local Rust/MSVC needed)

1. Stage happens inside the workflow: web build → esbuild core bundle →
   vendor natives (`shell/artifacts`) → sidecar placeholder (node renamed to
   `binaries/partner-core-x86_64-pc-windows-msvc.exe`) → copy all four into
   `shell/src-tauri/resources/` → `tauri build --bundles nsis`.
2. Artifact `partner-windows` (36 MB): `partner-shell.exe` + NSIS setup +
   `core-bundle.cjs`.
3. NSIS embeds the staged tree at `<exe>/resources/…`; `spawn_core`
   (`shell/src-tauri/src/lib.rs`) resolves staged files from
   `<resource_dir>/resources` or flat `resource_dir`, **strips the `\\?\`
   verbatim prefix** (node's CJS loader dies on `\\?\C:\…` main scripts),
   spawns the sidecar, waits for the port. Dev fallbacks
   `PARTNER_CORE_BUNDLE`/`PARTNER_STATIC_DIR`/`PARTNER_NO_SIDECAR` remain.

### Resources gotcha (fixed, documented in README-windows.md)

`bundle.resources` must be `["resources"]` (bare dir → walk). `"resources/**"`
matches **directories only** in glob 0.3.4, so tauri-build fails with
`glob pattern resources/** path not found or didn't match any files` even
when the dir is full of files.

## State ledger

| Area | State |
|---|---|
| M0 spine → M9 playbooks | ✅ verified + reviewed (closed) |
| M10 W1 encryption-at-rest | ✅ SQLCipher-style whole-file (Decision A); OS-keychain key; live mode refuses plaintext (docs/migrate-plaintext.md) |
| M10 W2 redaction sweep | ✅ single serialization point; seeded-secret audit test; docs/redaction-inventory.md |
| M10 W3 budgets | ✅ spend ledger (rolling 30-day window), chat pre-turn refusal, provider budget audit |
| M10 W4 audit UI | ✅ Audit tab (11th), filters, JSON/Markdown export, e2e |
| M10 W5 session-only chat | ✅ direct OpenAI-compatible streaming; key memory-only; PairGate entry |
| M10 W6 packaging | ✅ windows-build green; NSIS installer boots env-free (demo=on; rebuilt under M11 for schema v12) |
| M10 W7 verify docs | ✅ VERIFY-M10.md written; PLAN-M10 tick done |
| M11 chat-as-workspace | ✅ C1–C3 + F1–F12 implemented (schema v12); suites core 683 · web 440 · ext 57; typechecks 0; NSIS packaged app boots env-free (demo, schema v12); packaged UI swept headlessly — zero console errors; PLAN.md §15 M11 ticked; PLAN-M11 final report |
| M11 F5 manual theme walkthrough | ⚠️ docs/theme-conformance.md "Surfaces" checklist — packaged-app light/dark/custom walk on a real desktop (manual) |
| M12 UI readability & polish | ✅ token-only pass; geometry gates at 1440→780; suite + ux_audit green |
| M13 purpose providers + model switch | ✅ implemented + verified (purpose bundle, per-message model picker, photo→vision handoff; README M13 note). PLAN §15 box open: exit also lists an env-gated live manual walk (not yet recorded) |
| M14 scheduled & autonomous work | ✅ core + web shipped; decide-hook e2e (real loop approve/deny auto-resume); live walk 2026-09-07 (api.ne1.dev + Brave — approval pause → headless auto-resume → done + note; resume save-note bug found + fixed); schema v13 |
| M14 packaged boot | ⚠️ env-gated: the NSIS windows-build boot walk on the self-hosted Windows runner remains. Note the schema has moved on — the packaged boot is now against **schema v18**, and the last packaged boot verified env-free was v12 (M11) |
| M15 live desktop mode | ✅ core+web+shell shipped: packaged shell boots LIVE by default (persistent encrypted DB + native keychain + skills under app-local data dir), header-guarded device pairing channel (PARTNER_DEVICE_SECRET → GET /v1/pair/device), tray (Show pairing code… / Open Partner / Quit), health-aware PairGate, stdin parent-watch (core exits when the shell dies by any path) + e2e. Suite 726 core (+2 e2e) · typechecks 0 · windows-build green; packaged live walk executed 2026-09-07 (encrypted DB + keyring, tray-minted code → pair → conversation → restart-survives; force-kill → core self-exits) |
| M15 hardening: core boot identity | ✅ the shell's readiness probe was a bare TCP connect, so ANY listener on :4390 satisfied it: a leftover `npm run dev:core` (demo mode — wrong mode, in-memory DB) answered it, the shell logged "core is up", and the webview rendered against the foreign core while its own sidecar never served a request. Windows makes it worse than a lost bind — two Node listeners BOTH bind 127.0.0.1:4390 and the stray wins every connection, so there is no EADDRINUSE and no dying child to notice (reproduced: launched the shell against a stray demo core; netstat showed only the stray). The shell now mints a per-boot nonce (PARTNER_CORE_NONCE), the core echoes it at GET /v1/boot, and a mismatch (or a non-core listener) is a reported conflict — log + native dialog — instead of a silent wrong-core window. The staged `resources/core-bundle.cjs` must be rebuilt with the shell (it is gitignored, so a stale copy fails closed). 3 Rust unit tests + 6 e2e · suite 852 · typechecks 0 |
| Web shell rework | ✅ left sidebar nav (icon rail ≤1150px), slim top bar, zero h-scroll 1440→640, ux_audit green |
| Web/extension test-runner wiring | ⚠️ open infra item: root vitest excludes web/test + extension suites (historical counts not wired) |
| VERIFY-M10 manual walk | ⚠️ live-mode packaged-core boot (DEMO_MODE=0 + native keychain in-shell), real keyring, charged-provider budget, NSIS install on a desktop — env/manual |
| M16 knowledge workspace | ✅ notes relationship graph (React Flow, drag positions persist), brainstorm-from-notes (seed-on-demand `p-brainstorm`), versioning for notes+captures (history/diff/undoable restore), discuss-in-assets (branch or fork via `conversations.parent_id`/`source_asset_id`), assets export via native save dialog, CSV rendered as tables; follow-up linked/reopenable brainstorm sessions. Schema v13 → v15 |
| M17 note projects | ✅ notes join the shared Projects/Folders tree many-to-many (no membership = Inbox); one membership write path (`setFolders`); scoped `list`/`graph` with one-hop ghost nodes; `GET /v1/notes?folderId=`, `PUT /v1/notes/:id/folders`. Schema v16 |
| M18 chat multi-question forms | ✅ `:::partner.form` renders one textarea per question with a single submit; answers become one labelled user turn (nothing client-only); shares the `:::partner.*` grammar; drafts survive conversation switching |
| M19 persona-scoped memory + automatic remember | ✅ per-persona private memory (off by default) recalled only in that persona's chats; out-of-band extraction after a turn files `partner_suggestion`/`suggested` entries for confirmation; defensive parsing, dedupe incl. rejected, audit carries ids/counts/model only. No schema change |
| M20.A mobile/tablet/touch UI | ✅ bottom tab bar + More sheet (testable nav model asserting every view stays reachable on a phone), rails as overlays, full-width transcript/composer, `--target-min` touch floor + no-hover reveal, safe-area/`dvh` tokens, attention badges (a memory suggestion can no longer sit unnoticed). Measured @390px: composer 58→326, chrome 252px→0, controls <44px 11→0. Tablet 768/1024 byte-identical. `ux_audit` green; record: `docs/VERIFY-MOBILE.md` |
| M20.B wave 1 (S1/S2/S2a/S3 + pure S4/S6/S7) | ✅ per-user partition (`data/users/<id>/partner.db` + own cipher key + skills dir) with the **legacy-user alias** (user #0 owns the pre-partition DB/skills/`db-key`, so existing installs do not move); `users` + `user_credentials` in a second encrypted **system DB**; scrypt credentials (timing parity, lockout, rotation); session `user_id`/`client_class`/`device_label`/`platform`/`rotated_at` + rotate/refresh/list/revoke. Schema v16 → **v18**. **A MAJOR data-loss bug was caught by review and fixed** (the legacy alias was asserted but unimplemented). Record: `docs/VERIFY-M20-B.md` |
| M20.B wave 2 (S4/S5/S6 wiring) | ✅ capability envelope **enforces** (21 mounts, `ExecContext.clientClass`, refusal *before* the grant check); device registry (list/revoke/revoke-all, 404-not-403, no token material on the wire); transport matrix (`REMOTE_ACCESS` + TLS files + named `ALLOWED_HOSTS` + https listener). **Review found 3 blockers (mobile reached file-write 3 ways) — all fixed:** the approval queue (`decide` took a label, not a class), the persona/skill/playbook tool loops (a mobile *chat turn* ran with desktop authority), and MCP server CRUD (an enabled server is **spawned**, so it was code execution). Root suite 1066 → **1109** |
| M20.B wave 3 (S7 wiring — networked pairing) | ✅ the three pure S7 modules are **wired**: `POST /v1/pair/payload` issues a 256-bit single-use secret **loopback-only** (refuses `remote_access_disabled` without remote access, `tls_required` without a pinned fingerprint); `POST /v1/pair` accepts `{secret}` from anywhere and mints **`mobile`** (never `desktop`), refuses `{code}` from a non-loopback **socket peer** *before* verifying it (so a remote caller can neither consume nor lock the code on screen), refuses ambiguous/missing credentials **before** spending one, and rate-limits per peer (success resets the bucket). Locality is the peer address, not the `Host` header. Client half: SPA reads `#pair=…`, re-validates the payload itself, confirms once, clears the fragment; Providers screen issues links (action-driven — mounting would mint a live secret). Root 1109 → **1131**, web 619 → **638**, typechecks 0, build green, `ux_audit` PASSED (24 pairs, light+dark), geometry measured at 1280/390 both modes (no overflow, 0 controls <44px, copy 73 chars/line). **Audit also caught a pre-existing defect now fixed:** `.field::placeholder` used `--text-faint` (Lc 68.86/48.02, below the 75 floor) → now `--text-muted`; `DESIGN.md` reserves faint for **disabled** text. Record: `docs/VERIFY-M20-B.md` |
| M21 container + Cloudflare Tunnel | ✅ LIVE server container reachable only through a Cloudflare Tunnel (no published port). New **`file` keychain kind** (`KEYCHAIN_KIND=file` + `KEYCHAIN_FILE`: JSON, 0600, atomic + serialised writes, malformed ⇒ **refuse to boot**, never re-key) — live mode previously had no usable keychain in a container; unknown `KEYCHAIN_KIND` now refused instead of silently meaning `native`. `docker/server/`: Dockerfile (non-root, S6 remote matrix, node healthcheck), two-service compose, stage scripts (+ origin cert generation; Git-Bash-safe via a config file, not `-subj`), `tools/{partner-request,healthcheck,pair-link}.mjs`. **Topology is security-relevant:** the tunnel keeps its OWN netns — a shared one would make every internet request look loopback and let a visitor mint a pairing secret. Pairing = `compose exec partner node tools/pair-link.mjs` (operator shell access = "at the machine"), yielding a **`mobile`** session; **`desktop` is unreachable in this shape**. Container-verified (LIVE boot `demo=off` v18, `healthy`, SPA served, remote `{secret}` → `mobile` while `/v1/pair/payload` + `{code}` stay 403 `loopback_required`, session survives a restart, DB ciphertext, keychain 0600; both new test invariants falsified by injection). **Live-verified 2026-09-13 at `partner.teliti.app`** — and the live check caught a **blocker the suite had certified**: the SPA's payload validator counted decoded CHARACTERS instead of BYTES, so every genuine pairing link was refused ("missing a valid certificate fingerprint"); the fixtures were ASCII filler, which satisfies both readings. Fixed (byte-based), fixtures now `randomBytes(32)`, cross-module seam pinned by `tests/pair-payload-agreement.test.ts`, both fixes falsified by injection. Also fixed: a link pasted into an already-open tab did nothing (no `hashchange` listener). Root **1166**, web **639**, typechecks 0. Record: `docs/VERIFY-M21.md` |
| M22 hosted accounts + owned roots | ✅ `AUTH_MODE=login`: `POST /v1/auth/session` (username + passphrase, scrypt in the system DB) mints a session carrying `user_id`; wrong password ≡ unknown user; 3-failure lockout + per-peer rate limit; **the whole pairing lane answers 403**. Accounts via the operator CLI `tools/user.mjs` (add/passwd/list/lock/unlock); **one user per core** enforced until partitions land. `FIXED_ROOTS=/files` registers the mount at boot (idempotent) and `/v1/roots` add/remove answer `403 roots_fixed`; desktop roots surface unchanged. **llm-self-service removed** from core/web/shared (S0 closed). Verified in the user's container through the tunnel: CLI account → sign-in → `desktop` session → read-only roots → brokered write into `/files` (proposal → approval → file). Login gate walked in a browser. Root 1166 → **1184**, web 639 → **635** |
| M22 R-slice (R1–R4, R6–R9; R5 skipped) | ✅ **R1 per-user partitions**: a partition IS a single-user core — its own encrypted DB, cipher key (`db-key:<id>`) and skills dir — built by `users/rails.ts` (LRU + idle), with the listening app authenticating against the **shared** system sessions and **delegating** every other `/v1` request to that user's app, so none of the ~200 routes changed. Proven: two users' reads cannot cross (`core/test/http/userPartitions.test.ts`, real sign-ins + real encrypted files); a session with no user gets `403 no_partition`; rails LRU/idle/close unit-tested. **The first account owns the pre-partition database** (so an existing hosted install keeps its history) and a boot **guard refuses** to start when a legacy DB has no user to own it. **R2** rotation revokes that user's sessions. **R3** `PARTITION_IDLE_MS` closes idle partitions (memory hygiene, stated as such). **R4** `CLIENT_IP_HEADER`+`TRUSTED_PROXY_CIDRS` per-client auth rate limiting, believed only from a trusted peer, never for locality. **R6** `FIXED_ROOTS_READ_ONLY`. **R7** `MAX_UPLOAD_BYTES`/`MAX_JSON_BYTES`. **R8** `tools/backup.mjs` (VACUUM INTO + integrity_check + keychain, exits non-zero when unverifiable, `--keep`). **R9** `provider.configure`/`persona.run` named and denied to mobile/extension. Root **1204**, web 635, typechecks 0 |
| M22/R7 upload cap — **a bug report, not a tidy-up** | ✅ Attaching a photo from an iPhone returned a bare `payload_too_large`. The advertised cap was theatre: uploads rode a **base64 JSON envelope**, so the body was 4/3 of the file and the limit that refused it was the 1 MiB **JSON** cap — the 8 MiB `MAX_UPLOAD_BYTES` was unreachable, real ceiling **≈768 KiB**. Probed on the live route: 786,300 B → **201**, 786,396 B → **413**, 8 MiB → **413**; and the 413 carried no `message` and no size. Fix: the file **bytes ARE the body** (`express.raw({type:'*/*', limit})`, content type = the mime, `x-attachment-name` = the percent-encoded name — a filename is user data, so it does not ride a URL); **one cap, three uses** (parser limit, manager cap, and a new `maxUploadBytes` on `/v1/health` so the SPA refuses over-size files *before* spending the upload); the 413 now names the file, its size and the limit from shared copy that rounds a **size up** and a **cap down** — otherwise an 8 MiB + 1 refusal renders "8.0 MB … limit 8.0 MB", i.e. a bug; an old base64 client gets `400 invalid_input` saying what an upload must look like. **HEIC deliberately NOT allowlisted** (iOS transcodes on file input, and most providers cannot decode `image/heic` — accepting it would store a file that fails at the model). Verified: `core/test/http/attachmentUploadLimit.test.ts` pins 8 MiB → 201 / 8 MiB + 1 → 413 with the sentence; browser walk on a demo core (SPA :5173, core :4390) — 2 MB JPEG → **201**, chip `2 MB`, and the core's own `GET …/attachments` returned one staged row `{size:2097152, mime:image/jpeg}`; 9 MB JPEG → **no request sent**, composer alert `…is 9 MB — the limit is 8 MB per file.`; `/v1/health` → `maxUploadBytes: 8388608`. Root **1228** (+6 core, +5 shared), web **653** (+5), typechecks 0, build green. **No CSS in the diff**, so `ux_audit` was not re-run (copy-only change; the gate is unaffected). An intermediate full run showed 5 failures in `userPartitions.test.ts` — reproduced on a clean tree and then green on re-run, so it is flaky in this environment, not caused by this change. Record: `docs/VERIFY-M22.md` |
| M22/R7 follow-up — **iPhone HEIC uploads as JPEG** | ✅ The cap fix was not enough for a phone: HEIC/HEIF is what an iPhone writes, and nothing downstream reads it (the allowlist refuses it, the transcript preview cannot render it outside WebKit, most providers cannot decode `image/heic`). Only WebKit HAS the decoder, so the conversion belongs there: `web/src/lib/image-convert.ts` decodes through the platform pipeline (`createImageBitmap` + `imageOrientation:'from-image'`, `<img>` fallback), draws to a canvas and re-encodes JPEG down a **ladder** — 4096px q0.9 → 4096px q0.75 → 2560px q0.75 — until the bytes fit the cap the core publishes. **The pre-upload cap check deliberately skips HEIC**: a 9 MB HEIC is a good photo that becomes a 2 MB JPEG, so refusing it on size would refuse exactly the file the path exists for; the cap is enforced on what is actually produced. Two honest consequences, both stated in the spec and the record: the re-encode **drops EXIF (including GPS)** — a converted photo leaves less behind than a direct JPEG — and an ordinary JPEG is **never** re-encoded (pass-through, name/size/mime intact). The core still refuses an unconverted `image/heic` — now with an instruction (*"attach the photo as JPEG (Safari converts iPhone photos automatically)"*) instead of a bare 415. Verified in a browser against a demo core: a **15,846,098-byte (1.9× the cap) 4400×1200 `.heic`** uploaded as **`IMG_7788….jpg` · 3.3 MB in 425 ms**, and the stored bytes came back `image/jpeg`, magic `FF D8 FF`, decoding **4096×1117** (the 4096px edge, i.e. a real re-encode, not a rename); an undecodable `.heic` produced the "could not be converted" message with nothing uploaded; the 2 MB JPEG pass-through was unchanged. The walk uses PNG bytes named `.heic` (Chromium sniffs content, so the whole pipeline runs — only the HEIC decoder is the platform's, and that is the part only WebKit provides): **a real iPhone HEIC on real iOS Safari is still unverified** (see the env-gated list). Root **1229**, web **673** (+20 node-only tests: geometry, ladder, naming, every message), typechecks 0, build green |
| M20-B S1/S9 | ✅ **S1** (per-user partition) verified end to end — the rails are its missing caller; two users, two encrypted files, per-user keys/audit/skills, LRU + idle close, the first user keeps the pre-partition DB. **S9** (per-user key unlock) landed: schema **v19**, `key_wraps` + `users.keep_unlocked`; the partition key is wrapped under the passphrase (own salt + HKDF, so the stored verifier cannot unwrap it) and the plaintext is REMOVED at first sign-in; a locked partition answers `401 partition_locked` and closing the partition drops the handle; `keep-unlocked` is the per-user audited exception; `passwd` refuses to orphan a wrapped key without `--reset`. Root 1204 → **1215** |
| M20-B S8 | ⚠️ **NOT done, deliberately.** Vault/Runner tier split (role keys, per-role store subsets, briefcases with enforced caps ≤ 20 items / ≤ 256 KB / ≤ 24 h, append-only idempotent drain) — a boundary where a half-implementation is worse than none. Plan stands as written in `PLAN-M20-B.md` §S8; `key_wraps.purpose` and the vault seam are already role-agnostic for it |
| M22 still open | ⚠️ A device/sign-out UI, per-user quotas. Unverified: a two-user browser walk, R4 against the real Cloudflare edge, an R8 **restore**, R3's live timer, and a `ux_audit` pass on the login gate |
| M20/M21 env-gated | ⚠️ `stage.ps1` on Windows PowerShell, and a handset (phone) walk — the live checks used a desktop browser over the tunnel |
| M20.B remaining | ⚠️ **S8** (Vault/Runner) and **S9** (per-user unlock at sign-in) unstarted. **Vocabulary gap, deliberately open:** provider key writes and autonomous firing (playbook run, schedule run-now) have no capability name and are ungated for every class — a reviewed decision, not a tidy-up. **S7 follow-ups:** no QR encoder (the link is shown as text; adding one is a dependency decision), no shell-side "copy pairing link" in the tray, and no real phone/TLS/mesh walk (env-gated). Issuing a link is loopback-only, so a remote-access deployment needs a local loopback route to the allowlisted host (hosts-file alias) — the UI 403 copy says so |
| M20.B upgrade rehearsal | ⚠️ env-gated: the legacy-partition alias is unit-tested but has never been exercised by a real file-DB boot with `USER_ID` set. **Must happen before anyone sets `USER_ID`**, or the first boot could open an empty DB beside orphaned data |
| CI | 🟢 verify: linux + windows legs green on self-hosted runners; windows-build green (dispatch) |
| Env-gated by design | Chrome click-through (extension), browser-actuator research capture, live ship deploys, email/presentation sending, signed updater artifacts |

## Local-only artifacts (NOT on GitHub)

- `shell/artifacts/` (core-bundle.cjs + vendored node_modules) — gitignored,
  regenerated by CI steps / stage scripts.
- Demo container `partner-webapp-demo` (rebuilt w/ node:22; verified then
  removed) — rebuild from `docker/webapp-demo/` if needed.
- Local demo core script `/tmp/partner-webapp.sh`; demo core was on
  `127.0.0.1:4390` serving `web/dist` (stopped during packaging smoke tests;
  restart via the script if needed).
- `~/.cargo` rustup toolchain + registry on this box (runner shares it).
- GitHub token for API/curl at `$TMP/gh-token.txt` (scopes repo+workflow;
  NOT `read:org`, so `gh auth login` validation fails — use curl).
