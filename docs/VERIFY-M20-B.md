# VERIFY-M20-B — the server-role foundation wave

Verification record for the first M20.B execution wave (`PLAN-M20-B.md`).
Recorded 2026-09-12. **Read the "what this wave does NOT do" section before
drawing any conclusion about the security state of the product.**

---

## 1. What the wave built — and what it did not

**Built (4 writer lanes + 1 reviewer):**

| slice | what landed |
|---|---|
| **S1** per-user partition | `users/paths.ts`, `users/partition.ts`; per-user cipher key + skills dir; legacy-user alias |
| **S2 / S2a** identity | `system/db.ts` (second encrypted DB for the pre-user tables), `users/{store,manager,osProfile,credentials}.ts`, `users` + `user_credentials` tables |
| **S3** session lifecycle | `user_id` / `client_class` / `device_label` / `platform` / `rotated_at`; `rotate` / `refresh` / `listByUser` / `revokeById` / `revokeAllForUser`; `POST /v1/session/rotate` |
| **S4-pure, S6-pure, S7-pure** | `net/tls.ts`, `net/trust.ts`, `http/capabilities.ts`, `http/rateLimit.ts`, `http/pairSecret.ts`, `http/pairPayload.ts` |

**NOT built — and this is the load-bearing caveat:**

- **Nothing is wired.** The user store, the credential manager and the system DB
  are **not called by `createCore`**. The six pure primitives are imports nobody
  uses yet. `POST /v1/pair` still mints a session exactly as before.
- Therefore **no enforcement exists anywhere**: the client-class envelope, TLS
  refusal, rate limiting and networked pairing are *available*, not *in force*.
  Do not read this wave as "protection landed".
- **S4 wiring** (capability middleware per route group + `ExecContext` carrying
  the class, refused *before* the grant check), **S5** (device registry routes),
  **S6 wiring** (https listener + named allowlist), **S7 wiring** (pair/secret
  route + limits), **S8** (Vault/Runner, briefcases, drain) and **S9** (per-user
  key unlock at sign-in) are all **unstarted**.
- The **sign-in route does not exist**, so §2a's enrollment → authentication →
  authorization flow is designed and unbuilt; `user_id` is always NULL today.

## 2. The MAJOR finding — and it was a data-loss bug

An adversarial review caught that `PLAN-M20-B.md` §6 asserted *"the existing
`data/partner.db` is treated as user #0's partition and does not move"* while **no
code implemented it**. Verified independently:

```
FIRST_USER_ID = '0'  →  booting with USER_ID=0 opened
                        data/users/0/partner.db under key db-key:0
legacy install       →  the real data sat at data/partner.db under key db-key
```

An existing install would have opened a **new empty database** while the owner's
real data sat orphaned — silent disappearance, no error, no crash.

**Fixed:** `LEGACY_USER_ID` is now a single exported constant that `FIRST_USER_ID`
**derives from**, so the two cannot drift; `userDbPath`/`userRoot`/`userSkillsDir`
map the legacy user to `<dataRoot>/partner.db`, `<dataRoot>` and `<dataRoot>/skills`
(so installed skills are not orphaned either); and `dbKeyAccount` returns the
legacy `db-key` account for that user so the existing cipher key still opens the
file. The mapping is **deterministic** rather than "alias only if the legacy file
exists" — a filesystem probe would make storage location depend on hidden state
and give a fresh install and an upgraded one different shapes for the same user.

Tests: `core/test/users/legacyPartition.test.ts` (6), including that `'00'` is an
ordinary partition and that every other user keeps its own account — the property
that stops one key opening another's file.

## 3. Findings applied (mine and the reviewer's)

| # | finding | resolution |
|---|---|---|
| 1 | **MAJOR** — legacy user not aliased (above) | fixed + tested |
| 2 | Windows reserved **stem** not checked: `con.txt`, `nul.db`, `com1.bak` were accepted (my finding; the lane tested the exact names only) | fixed — the check now uses the stem; not a traversal escape, but a broken partition for that user |
| 3 | `uncoveredHosts()` returned `[]` for a non-array host list, which reads as "everything covered" — the only fail-OPEN default in the new guards | fixed — throws instead |
| 4 | **Wildcard SANs did not match**, so a `*.example.com` cert (Let's Encrypt / mesh CAs — the common case) would have been refused | fixed with RFC 6125 single-label matching, implemented as a **label bound**, not a suffix test: `host.endsWith('.example.com')` alone matches `evil-example.com`, and that bypass is now a test case |
| 5 | Mobile envelope held `grants`, `skill.invoke`, `mcp.call` — three **indirect** routes to capabilities mobile is denied | narrowed to `chat` + `file.read` + `browser`, pinned by a test. Verified: neither `core/src/skills/` nor `core/src/mcp/` consults the client class, so the class would not constrain what they do on mobile's behalf |
| 6 | Credential **timing oracle**: an absent user returned before scrypt ran while a known user paid ~0.2 s | fixed — a discarded derivation on the absent path. The lane had called this "bounded by local-only user creation", but local-only bounds *creation*; the sign-in route is reached **remotely**, which is where enumeration matters |
| 7 | `close(userId)` racing an in-flight open left the partition **open after a close request** | fixed with a tombstone honoured by the pending open; a later open cancels it |
| 8 | Comment claimed the user manager owns "…the disabled gate **and audit**", but it takes no audit seam | corrected — audit rows are not written yet and the comment now says so |
| 9 | `openCoreDatabase` built a partition cache per call and discarded it, leaving the handle **untracked** (nothing could close it) while `closeAll()` claimed to manage it | removed — a single-user boot opens its one handle directly; the process-lifetime cache belongs to the N-rails wiring |
| 10 | Stale test title "keeps SCHEMA_VERSION at 11" while asserting 18 | title no longer names a version; the literal assertion (deliberate-update detector) is kept and explained |

**Reviewer over-citation, corrected:** it listed five store tests as carrying
stale version titles; only `m8Stores.test.ts` did — the other four import the
constant. Verified rather than repeated.

## 4. Verified sound without change

- **`kind` was not widened.** `SessionRow` keeps `kind` and adds `clientClass` as
  a separate column, `actorOf()` still returns `session.kind`, and `client_class`
  is migration-guarded with `DEFAULT 'desktop'`. The change that would have
  silently rewritten what `?actor=` returns for seven audit routes did not happen,
  and the code comment names the reason.
- **Traversal:** every hostile id refused — separators, `..`, drive/stream
  separators, absolute paths, control characters, unicode dot-lookalikes,
  >64 chars, non-strings, and the reserved names. Whitelist rather than
  sanitising, with the reason recorded (sanitising maps two ids onto one
  partition — the exact failure partitioning exists to prevent).
- **Key isolation:** distinct files, distinct accounts, cross-user read refused,
  and the legacy path/key byte-identical when `USER_ID` is unset.
- **Credentials:** `timingSafeEqual`, per-user salt, scrypt params stored per row,
  typed refusals (never a throw into a 500), and **no hash or salt in any return
  shape**.
- **Fail-closed:** every new guard denies or throws on unusable input.
- **Rotation:** the outgoing token fails on the **next** request; the device row
  survives. The outgoing token answers `not_found`, not `revoked` — a decision
  taken during the wave because revoking *keeps* the row while rotation replaces
  the hash, so the old secret is *gone*, not *revoked*. A `superseded` column was
  rejected: its clearing rule could not be stated, and rotation here is
  client-initiated so no flow needs the distinction.
- **No vacuous tests** were found; each guard carries a positive control.

## 5. Gates

| gate | result |
|---|---|
| `npm run typecheck` | 0 errors (shared · core · web · extension) |
| `npm test` (root) | **1066 passed**, 5 skipped — from 901 before the wave |
| `npx vitest run --root web` | **619 passed** |
| `npm run build -w web` | green |
| boot smoke | demo core starts, reports **schema v18** |
| schema | v16 → **v17** (S2 tables) → **v18** (S3 columns), each bump once, both via the guarded-column migration surface |

No lane strayed outside its file ownership (verified by mtime, not by report), no
lane committed, and the owner's live core on :4390 was never touched.

## 6. Still not verified / known limits

- **No browser or visual verification** applies to this wave (core-only change).
- **The upgrade path was verified by static assertion, not by running it.** No
  live file-DB boot with `USER_ID` set was executed — that needs a real OS
  keychain and would touch the owner's data directory. The alias is pinned by
  unit tests on the path/key resolution, not by an end-to-end upgrade rehearsal.
  **That rehearsal belongs in the wiring wave, before anyone sets `USER_ID`.**
- The timing-parity test is a **coarse** guard (a ratio with tens-of-ms
  derivations); it catches removal of the dummy derivation, not fine-grained
  timing leakage.
- `cert_unreadable`/`key_unreadable` are provable only through the injected
  reader; real `EACCES` is not portable.
- IPv6 SANs compare as Node renders them, so a compressed-vs-expanded form may
  mismatch.
- System-DB rows are written by the store, but **nothing opens the system DB in
  `createCore` yet**.

---

# M20.B second wave — S4/S5/S6 WIRING (2026-09-12)

This wave made the first wave's primitives **enforce**. Record: three writer lanes
+ a fresh-context reviewer.

| lane | landed |
|---|---|
| `s4-enforcement` | `requireCapability.ts`, 21 route mounts, `ExecContext.clientClass`, and the broker's refusal **before** the grant check |
| `s5-devices` | `GET /v1/devices`, `POST /v1/devices/:id/revoke`, `POST /v1/devices/revoke-all` + the manager methods |
| `s6-transport` | the refusal matrix, `REMOTE_ACCESS` / TLS files / named `ALLOWED_HOSTS`, the https listener |
| `wiring-review` | 3 blockers, 2 majors, 4 minors/nits |

## The reviewer found three BLOCKERS — the envelope was bypassable three ways

The mounts and the broker ordering were **correct**, and the tests proved it. The
holes were where the class never arrived:

1. **The approval queue.** `POST /v1/tools/pending/:id` had no capability mount and
   `broker.decide(pendingId, input, by)` took an actor *label*, no class. Approving
   **executes** the stored tool and `remember:true` **creates a grant** — so a
   mobile session could approve a queued write and have it run, or acquire the
   grant authority the envelope denies it. Reachable with no grant of its own.
2. **The chat/skill/playbook tool loops.** `chat/toolPass.ts:296`,
   `playbooks/loop.ts:415`, `skills/runner.ts:349` called `broker.exec` with no
   class, so `ctx.clientClass ?? 'desktop'` gave a **mobile chat turn desktop
   authority** — `/v1/chat` is allowed to mobile. I found this one independently
   while verifying the lane; the reviewer confirmed it and named the third call
   site.
3. **MCP server CRUD.** `POST`/`PUT /v1/mcp/servers` took an arbitrary
   `command`/`args`/`enabled` behind `requireSession` only. An enabled server is
   **spawned as a child process at the user's privilege**, so any class could
   register + enable a command and then invoke it — making the `mcp.call` guard on
   `/call` decorative. I had queued this as "gate MCP CRUD"; the reviewer showed it
   is code execution, not configuration hygiene, and I had **underestimated it**.

## Fixes applied

| # | fix |
|---|---|
| 1 | `decide(…, clientClass)` refuses `capability_denied` **before** executing, and requires `grants` for `remember:true`. A refused approval leaves the row **still waiting** — it must not consume the decision. The approval route passes the session's class. |
| 2 | `capabilityForTool` exported from the broker; the chat tool pass checks the envelope **before execute-vs-queue** (so a class that may not ask cannot even park the work), scoped by source: broker tools use their mapping, MCP's dynamic ids require `mcp.call`, static externals (web search) keep their existing consent. The playbook loop carries the class on `RunMemory` so a `resume` inherits the authority the run started with; the run request and the route thread it. |
| 3 | `capability('mcp.call')` mounted on MCP create/update/delete — configuring spawns, so it clears the same bar as calling. |
| 4 | **S5 major:** the transitional rule was keyed on the *caller* having no user, so a user-less session could read **and revoke a named user's devices** — and since every session in the field is user-less today, that wide branch was the **default**, not an edge. `listAll` (whole table) and the unscoped `revoke` became `listUnscoped` / `revokeUnscoped` (`WHERE user_id IS NULL`). Behaviour is identical today (all rows are user-less) and a named user's rows are now unreachable from it. The test that **pinned the wide behaviour** was rewritten with the read *and* write assertions. |
| 5 | `startServer` re-asserts `transportRefusal` (defence in depth: it accepts an explicit `CoreConfig`, so a hand-built one could have put a plaintext listener on a non-loopback host). |
| 6 | The `unknown_capability` / unknown-class branches are now tested for **every** class including desktop — the registry-widening hole where a new manifest without a mapping would silently be granted to everyone. |
| 7 | Two comments that overstated reality: the route header claimed *every* mutating group carries a capability (now names the real scope and the gap), and the demo-mode comment claimed exposure is "bounded to the demo surface" when `/v1/dev/pair-code` hands an unauthenticated remote caller a **desktop** session over `/v1/files/browse` — i.e. host filesystem read. |

## Verified by hand, not by summary

- **The matrix**: remote-without-TLS is refused **first**, before any allowlist
  logic; the loopback rule is correctly `&& !remoteAccess`; `ALLOWED_HOSTS` is
  assigned only in the `else` branch so it is verbatim with no implicit loopback
  entry; the listener reads the PEM **inside** the https branch, so a failure
  rejects `startServer` rather than downgrading to HTTP.
- **Smoke tests**: a live (non-demo) loopback boot still serves `http` with schema
  v18, and a live non-loopback bind with remote off is still refused.
- **Non-vacuity**: the chat-pass guard was falsified by construction — mobile is
  refused **and `exec` is never called**, while desktop executes the same
  directive, so the class is demonstrably what decides.

## Gates

typecheck **0** · root suite **1109 passed** (was 1066 before this wave) · web
**619** · build green · `ux_audit` n/a (no CSS).

## Still NOT done

- **Nothing a real phone could use yet:** **S7** (pairing secret + class
  delivery) was unwired, so a mobile session could only be minted programmatically
  in tests; the enforcement was real and proven but the delivery path was not
  built. **CLOSED by the third wave below (2026-09-13).**
- **S8** (Vault/Runner) and **S9** (per-user key unlock at sign-in) — unstarted;
  S9 needs the sign-in route, which does not exist.
- **The vocabulary gap, deliberately left open:** provider **key writes**
  (`/v1/providers/:id/key`, self-service connect, search key) and **autonomous
  firing** (playbook run, schedule run-now) have no capability name, so they are
  ungated for every class. Naming them (`provider.configure`, `persona.run`) is a
  reviewed decision, not a tidy-up, and the route header now says so.
- **`skills/runner.ts` still execs with no class** — recorded as a **non-hole
  today**: only desktop holds `skill.invoke`, so the desktop default matches the
  only reachable class. Thread it if a class ever gains that capability.
- `lastSeenAt` still equals `createdAt` (no `touch` on authenticated requests), so
  the device list's "last seen" is decorative.
- The **upgrade rehearsal**: the legacy-partition alias is asserted by unit tests
  but has never been exercised by a real file-DB boot with `USER_ID` set. That
  must happen before anyone sets it.

# M20.B third wave — S7 WIRING (2026-09-13): networked pairing

The second wave proved the capability envelope *enforces*. It left the delivery
gap: `POST /v1/pair` still minted `desktop` with `user_id` NULL for anyone who
could reach the port, and the three S7 modules (`pairSecret.ts`,
`rateLimit.ts`, `pairPayload.ts`) were pure and **unused** — so a real phone
could not obtain a `mobile` session at all. This wave wires them.

## The rule, in one table

| request | peer | outcome |
|---|---|---|
| `{code}` (6 digits) | loopback | `desktop` session — the unchanged local ceremony |
| `{code}` | **not** loopback | **403 `loopback_required`**, and the code is **not verified** (a remote caller can neither consume nor lock the code the user is reading off their own screen) |
| `{secret}` (256-bit) | anywhere (issued loopback-only) | `mobile` session — **never** `desktop`, from any shape of request |
| either | unattributable peer (`socket.remoteAddress` missing) | 403 `forbidden_peer` (refused, never pooled into an anonymous bucket) |
| either | over budget (10/min/peer) | 429 `too_many_attempts` + `Retry-After`; a **successful** pair resets the bucket |
| both `{code}` and `{secret}` | — | 400 `ambiguous_credential`, **before** either credential is spent |
| neither | — | 400 `missing_credential` |

**Locality is the socket peer, never the `Host` header** (`core/src/http/peer.ts`).
§2.1 already reclassified `Host` as a client-supplied lookup key; a remote caller
may send `Host: 127.0.0.1:<port>`, so it cannot answer "did these bytes come from
this machine?". IPv4-mapped (`::ffff:127.0.0.1`), zone-suffixed (`::1%lo0`),
bracketed and the whole `127/8` block are loopback; `127.0.0.256`, an IPv6
non-loopback, a missing address and a unix socket are all **not**, fail-closed.

`POST /v1/pair/payload` (the issuer) is **loopback-only**, refuses with
`remote_access_disabled` when remote access is off (a secret nobody can reach is
a dead credential), and with `tls_required` without a pinned fingerprint (a
secret carried to another device over plaintext is exactly what the pin
prevents). It never logs, audits or persists the secret; the audit row carries
the core URL only.

## What landed

| file | change |
|---|---|
| `core/src/http/peer.ts` | new, pure: `isLoopbackPeer` |
| `core/src/http/server.ts` | the two-credential `POST /v1/pair`, the payload route, per-peer limiter, optional-device-metadata validation, `peerAddress` (test seam) |
| `core/src/index.ts` | passes `remoteAccess` + the TLS fingerprint from S6 config into the app |
| `core/test/http/peer.test.ts`, `pairRoutes.test.ts` | 22 tests (3 + 19) over the whole contract above |
| `web/src/lib/pair-link.ts` | new, pure: fragment link build/read, an INDEPENDENT re-validation of the payload (https, no credentials, canonical 32-byte base64url), origin compare, device label. **CORRECTED 2026-09-13: this validator shipped BROKEN** — it compared the decoded TEXT length to 32, so every real 32-byte value (which decodes to ~28 UTF-8 characters) was refused and every genuine pairing link failed on the `partner.teliti.app` deployment with "missing a valid certificate fingerprint". The unit tests certified it because their fixtures were ASCII filler, which satisfies both readings. Fixed to count BYTES, fixtures replaced with `randomBytes(32)`, and the seam is now pinned by `tests/pair-payload-agreement.test.ts` (core builds → browser accepts, 25 random samples; both sides agree on refusals). See `docs/VERIFY-M21.md` ("Live deployment check"). |
| `web/src/lib/api.ts` | `requestPairSecret`, `fetchPairPayload`, shared `postPair` |
| `web/src/PairLinkNotice.tsx` | the two incoming-link states (usable / not usable), split out so they can be render-tested |
| `web/src/PairGate.tsx` | reads `#pair=…`, confirms once, stores the token, clears the fragment |
| `web/src/DeviceAccessPanel.tsx` + `ProvidersView` | the desktop issuer: "Create pairing link" → link + fingerprint + copy, **action-driven** (nothing minted on mount — mounting would create a live secret every render) |

The link carries the secret in the **fragment**, not the query string, so it is
never sent to the core or any proxy on the way, and the client clears it after
use. The phone re-validates the payload rather than trusting it (it arrives from
a QR code — i.e. from outside) and refuses by name.

## Gates

root **1131 passed** (was 1109) · web **638 passed** (was 619) · typechecks **0** ·
web build green · `ux_audit` **PASSED** on the new UI (24 pairs, light + dark) ·
geometry measured in a real browser against the real stylesheet at 1280 and 390,
light and dark: **no horizontal overflow**, fingerprint wraps instead of clipping
(231×42 at 390), **0** controls under 44×44 at 390, copy measure 73 chars/line.

**Later corrected by a live deployment (2026-09-13, `docs/VERIFY-M21.md`):** the
gate numbers above were green while `web/src/lib/pair-link.ts` refused every
REAL pairing payload (it counted decoded characters instead of bytes), because
the fixtures were ASCII filler. Fixed + falsified; root is now **1166** and web
**639**, with `tests/pair-payload-agreement.test.ts` pinning the cross-module
seam.

**One pre-existing defect the audit exposed and this wave fixed:** the *new*
`#device-name` field made `.field::placeholder` a supplied pair, and
`--text-faint` on the input well is **Lc 68.86 light / 48.02 dark** — below the
75 floor. Placeholders are instructive text (they say what to type), so the rule
is now `--text-muted` (**81.40 / 75.23**) and `--text-faint` is documented as
**disabled-only** in `DESIGN.md`. The `.gate-copy` / `.gate-meta` measures were
also constrained (M12.5 makes `.gate-panel` fluid, so an unconstrained line ran
~120 characters at 1280px).

## Known limits, stated rather than implied

- **No real phone, TLS or mesh walk has been performed** (env-gated). What is
  proven is the contract, the persistence/audit behaviour and the client's
  accept/refuse logic; what is *not* proven is a handset on a network.
- **Issuing a link is loopback-only, which is a deployment constraint.** With
  `REMOTE_ACCESS=1` the allowlist has no implicit loopback entry (S6, deliberate),
  so a browser on the machine reaching the core by its public/mesh name has a
  non-loopback peer and is refused. The supported local paths are a hosts-file
  alias (`127.0.0.1 <allowlisted-host>`, which keeps the certificate hostname
  valid while making the socket loopback) or an explicitly allowlisted loopback
  host whose certificate covers it. The 403 copy in the UI says this in plain
  words. A tray-side "Copy pairing link" (the M15 device-secret channel already
  exists to prove `local` for the shell) is the natural next step.
- **No QR rendering.** There is no encoder in the repo and adding one is a
  dependency decision, so the panel shows the link + fingerprint and suggests any
  QR app. The payload/link route and the client's paste/scan path are live.
- **The `DeviceAccessPanel` *issued* state was not runtime-inspected** — the
  initial state was rendered and measured, and the confirm/problem cards were
  rendered and measured; the issued panel's CSS is covered by `ux_audit` only.
- **The whole-file `ux_audit` remains outstanding** (as M20.A recorded); this
  wave audited the new UI plus every primitive it composes.
- **The §12 Q1 consent screen is not built.** `REMOTE_ACCESS` stays an operator
  env setting, which satisfies "cannot be flipped from a remote session" by
  construction; "turning it off invalidates remote sessions immediately" is not
  implemented (a live session survives a config change until restart/TTL), and
  mobile token TTL/rotation is S3/S8 scope.
- `peerAddress` is a **test seam** on `CoreAppOptions`: production (`index.ts`)
  never passes it, and the value can only make a request look *more* remote or
  unclassifiable, both of which fail closed. It exists because a hermetic test
  cannot dial a non-loopback address.

## Still NOT done (unchanged by this wave)

**S8** (Vault/Runner split, briefcases, idempotent drain) and **S9** (per-user key
unlock + the `POST /v1/auth/session` sign-in route). The **vocabulary gap** stays
deliberately open: provider key writes and autonomous firing have no capability
name. The **upgrade rehearsal** (a real file-DB boot with `USER_ID` set) still
must happen before anyone sets it.
