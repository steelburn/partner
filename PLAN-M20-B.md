# PLAN-M20-B — the server role: executable breakdown

Companion to `PLAN-M20.md` (which holds the *why*). This file holds the *how*:
the slices, their exact files, the tests to write FIRST, and the decisions each
slice needed. **All gates are closed** (§6); §3.0 carries the status. Produced by a read-only scout pass against the working tree on
2026-09-12, then corrected by the supervising agent where noted.

**Status: two waves landed 2026-09-12 plus the S7 WIRING wave 2026-09-13; the
slice status table in §3.0 is the authoritative done-vs-remaining list.** M20.A
(the mobile/tablet UI) shipped alongside. Landed: S1, S2, S2a, S3, the
**S4/S5/S6 wiring** (the capability envelope enforces, the device registry
exists, the transport matrix is real), and **S7** (networked pairing: a 256-bit
single-use secret issued loopback-only, redeemable from anywhere and minting
`mobile` — never `desktop` — with per-peer rate limiting, plus the SPA's client
half). **Not landed: S8**, and the deliberate vocabulary gap (provider key
writes and autonomous firing have no capability name yet). **S9 landed
2026-09-13** with schema v19 (`users.keep_unlocked` + the per-user wrapped
partition key).
Verification records: `docs/VERIFY-MOBILE.md` (M20.A), `docs/VERIFY-M20-B.md`
(M20.B waves 1–3).
(M20.B).

---

## 1. The seams this milestone turns

Verified line references (working tree, HEAD-era):

| seam | what it means |
|---|---|
| `core/src/config.ts:104-118` | LIVE refuses any non-loopback bind **by construction**; `:144-160` derives `hostAllowlist` as loopback-only, `skillsDir = join(dirname(dbPath),'skills')`, 30-day `sessionTtlMs`. |
| `core/src/http/server.ts:360` | `originOf(req) = req.headers.host.toLowerCase()`. Once clients are remote this is **a lookup key, not a network control** (§2.1 reclassification). |
| `core/src/http/server.ts:1237` | `hostGuard(allowlist)` is the first middleware (403 `forbidden_host`). |
| `core/src/http/server.ts:1325` | the **only** place a session is minted: `sessions.create('web', origin)`. |
| `core/src/http/server.ts:1107` | `actorOf(session) = session.kind` — **the audit actor IS `session.kind`**. |
| `core/src/broker/broker.ts:51` | `ExecContext = { requestedBy }` — the per-tool gate has **no client-class dimension**. |
| `core/src/keychain/dbKey.ts:13` | `DB_KEY_ACCOUNT='db-key'`, service `partner` — one cipher key per OS user. |
| `core/src/index.ts:645-655` | `openCoreDatabase`: demo/`:memory:` plaintext; live file → `ensureDbKey` + `openEncryptedDatabase`. |
| `core/src/index.ts:657-1040` | `createCore` builds ~40 stores over **ONE** `db` handle and hands them to `createCoreApp`. |
| `core/src/index.ts:1085` | `listen()` is plain `app.listen` — **no TLS anywhere in `core/src`**. |
| `shared/src/contracts.ts:137` | `SCHEMA_VERSION = 16`. |

Today: one process = one encrypted SQLite file = one OS-keychain cipher key =
one skills dir, behind a loopback-only bind and a derived Host allowlist, with
one Bearer session minted at `POST /v1/pair` and origin-bound. Isolation is
therefore **already per-OS-user**; M20.B generalizes it one level down (per app
user) and adds the missing authorization dimension, device lifecycle, and
transport.

## 2. Two corrections to the scout's report

**2.1 The audit-actor risk was overstated — but "do not widen `kind`" stands.**
The scout wrote that widening `session.kind` "rewrites *every* audit actor and
breaks `?actor=web` filters". Verified: the audit actor is mostly a **literal
string chosen at the call site** (`audit.log('session', …)` ×7, `'web'` ×3,
`'pair'` ×3, `'shell'` ×1), and `actorOf()` is used at only **7 sites**
(`files.browse`, `roots.add`, `roots.remove`, `grant.add`, `grants.remove`, …).
No test asserts a live `'web'` actor from those routes — the sole `actor: 'web'`
is a web unit-test fixture (`web/test/audit-helpers.test.ts:21`).

**Conclusion unchanged, for a sharper reason:** every session mints
`kind: 'web'` today, so `kind` *already is* the audit actor for those 7 routes.
Widening it would silently change what `?actor=` returns for file/root/grant
actions. **Add a new `client_class` column; leave `kind` alone.**

**2.2 The chip rules the sweep called "dead" are live.** The sweep classified
`.mem-chip-danger` (and `.skill-chip-danger`) as dead because no literal
reference exists. They are reached through **computed** class names —
`MemoryView.tsx:592` renders `` `mem-chip mem-chip-${tone}` `` and
`kindTone('rule')` returns `'danger'`; `SkillsView.tsx:88` does the same for
skill chips. Both pass only because the chip carries its own `--bg` ground
(Lc 80.9), **not** because they are unused. Lesson recorded: a grep for a class
literal cannot prove a class is dead when the name is composed.

## 2a. Authentication is not pairing — the multi-user gap

**Verified gap.** `core/src/http/server.ts:1324` is the only place a session is
minted: `sessions.create('web', origin)` — a client kind and an origin, **no
user**. `SessionRow` (`core/src/stores/types.ts:39`) has `kind` and `origin` and
no `user_id`, and no user concept exists anywhere in the core.

So pairing answers **"may this client talk to this core?"** — a *device
enrollment* question, proven by proximity (a 6-digit code shown on the machine,
or a QR secret for an invited device). Multi-user needs a different question
answered: **"who is this session acting as?"** — an *authentication* question.
As scoped, S3 adds a `user_id` column and S2 adds a `users` table, but **nothing
says how the column is populated**; on a multi-user core, pairing physically
cannot determine it.

### The three layers, separated

| layer | question | proven by | lifetime | mechanism |
|---|---|---|---|---|
| **Enrollment** | may this *device* reach the core? | proximity — a code shown on the machine, or an invite | per device, once | **pairing, unchanged** (6-digit on loopback, QR secret remotely per S7) |
| **Authentication** | which *user* is this session? | a credential | per session, repeatedly | **new** — see below |
| **Authorization** | what may it do? | the user's grants + the client class | per request | S3/S4 (client class + capability envelope) |

**A session must never carry a user without a user-authentication event.** There
is no implicit "the pairing user"; that shortcut is exactly how a shared core
leaks one person's partition to another.

### Single-user desktop keeps today's experience (no sign-in)

On a single-user install, enrollment **does** imply the user, because the OS
profile already identifies them: `user #0` maps to the OS-profile holder (S2's
`osProfile` mapping). Enrollment mints directly as user #0 and the PairGate stays
byte-identical to what it is today. **This is the constraint that keeps the
desktop copy untouched** — the added ceremony only appears once a core actually
has more than one user, or is reached from an unenrolled device.

### Multi-user / web requires an explicit sign-in

Once a core has two or more users, enrollment yields a **device record**, not an
acting session. The acting session is minted only after sign-in, and carries
`(device, user)`. Consequences the UI and the API must both respect:

- `POST /v1/pair` **stops minting an acting session** on a multi-user core; a new
  `POST /v1/auth/session` (sign-in) mints one with a `user_id`.
- One **device** may hold sessions for several **users** (a shared family
  browser), so the device registry (S5) lists devices per user and revoke is
  per (device, user) — revoking your session on the kitchen tablet must not
  evict your partner's.
- Sign-out **re-locks** that user's partition (see below) and drops only their
  session.
- The SPA's "session expired — pair again" copy becomes "sign in again"; pairing
  is only re-required when the *device* loses its enrollment.

### The credential primitive

| option | why | why not |
|---|---|---|
| **Per-user passphrase** (argon2id/scrypt hash in the **system DB**, not Tier C) | works offline, on a self-hosted core, with **no third party** and no mail/SMTP; nothing to enrol | shared secret; needs a rotation and a lockout policy |
| **WebAuthn / passkey** | phishing-resistant, no shared secret, no password database | needs a secure context (S6 supplies TLS) **and a recovery story that must be designed rather than improvised** |
| **External IdP (OIDC)** | Partner already has precedent — §2's "Connect llm-self-service" logs into AppCore with the RSA-OAEP envelope | makes identity depend on a third party, contradicting §1 "your keys, no vendor lock-in". An *optional adapter*, never the only path |

**Decision: passphrase first, passkey as a later adapter behind the same seam.**
The primitive must work with no network and no third party, and a passphrase is
the only one that needs neither. WebAuthn is stronger but its recovery path is a
design problem, not a configuration flag.

### This resolves §4.4 for the hosted case — and the cost is per-user, not global

§4.4 framed a fork: a headless core either holds an operator master key (the
operator can read every user's data) or uses passphrase-derived keys (the server
cannot decrypt at rest — but M14 headless schedules stop working).

**Sign-in is the unlock event.** With passphrase-based authentication the core
needs only ciphertext plus a wrapped key: a user's partition becomes decryptable
while that user has a live session, and re-locks on sign-out or idle timeout.
That is §4.4 option (b) with a workable UX — the key is not re-typed per request
— and it removes the operator-readable store without removing authentication.

**The honest cost, and why it is now better than the original fork:** headless
schedules for user X run only while X has an unlocked session. A user who wants
schedules to fire while they are away makes an **explicit, per-user, audited**
choice to keep their partition unlocked — which weakens the guarantee *for that
user only*, rather than forcing a global architecture choice on everyone. That is
the right granularity: it is the user's own data being exposed, and they are the
one who can decide whether the convenience is worth it.

### What §16 still forbids (unchanged)

Nothing here licenses a hosted multi-tenant service. The operator must be a user
of their own core — a household or a team on one machine, or one self-hosted
instance. An unrelated custodian holding many users' data would need §16 changed
deliberately, and the operator-readable-store question would come straight back.

### Slices this adds or changes

- **S2a (new)** — per-user credentials: argon2id/scrypt hash in the system DB,
  first-user creation local-only (Q2), subsequent users created by an authorized
  local user, rotation, and lockout. Tests first: hash verify/reject, lockout
  after N failures, a remote session can never create a user, rotation
  invalidates old sessions.
- **S3 (changed)** — the acting session moves behind authentication:
  `POST /v1/pair` mints an acting session **only** on a single-user core (as
  user #0); otherwise it records an enrolled device. New `POST /v1/auth/session`
  mints `(device, user)`. Device revoke becomes per (device, user).
- **S6 (raised in priority)** — authentication over plaintext HTTP is
  unacceptable, so **TLS becomes a prerequisite for multi-user**, not only for
  remote access.
- **S9 (new)** — per-user key unlock at sign-in: wrap the partition key with the
  user credential, hold it in memory for the session, re-lock on sign-out/idle,
  and an explicit per-user "keep unlocked so my schedules can run" opt-in that
  is audited. Tests first: a signed-out user's partition cannot be opened; idle
  re-lock; the opt-in is per-user and does not unlock anyone else.

## 3. Slices

### 3.0 Status — first wave landed 2026-09-12

Verification record: **`docs/VERIFY-M20-B.md`**. Read its "what this wave does NOT
do" section before drawing conclusions about the security state.

| slice | status |
|---|---|
| S1 per-user partition | **landed** (incl. the legacy-user alias that an adversarial review caught as unimplemented) |
| S2 users + system DB | **landed** (tables + managers) — *not wired into `createCore`* |
| S2a credentials | **landed** (scrypt, lockout, rotation, timing parity) — *no sign-in route yet* |
| S3 sessions | **landed** (`client_class` added as a NEW column; `kind` deliberately untouched) |
| S4 capabilities | **WIRED** — 21 route mounts, `ExecContext.clientClass`, and the refusal ordered **before** the grant check. Three bypasses the review found (approval queue, persona/skill/playbook tool loops, MCP CRUD) are closed; see `docs/VERIFY-M20-B.md`. |
| S5 devices | **landed** — list / revoke / revoke-all, 404-not-403, hash-free projection. The transitional user-less rule is **scoped** (`user_id IS NULL`), so it can no longer read or revoke a named user's device. |
| S6 transport | **WIRED** — refusal matrix, `REMOTE_ACCESS` + TLS files + named `ALLOWED_HOSTS`, https listener, and `startServer` re-asserts the refusal. |
| S7 pairing | **WIRED (2026-09-13)** — `POST /v1/pair/payload` issues a 256-bit single-use secret (loopback-only; refuses without remote access + TLS), `POST /v1/pair` accepts `{secret}` from anywhere and mints **`mobile`** (never `desktop`), refuses `{code}` from a non-loopback peer *before* verifying it, and rate-limits per peer. Client half: the SPA reads `#pair=…`, re-validates, confirms once, clears the fragment; the Providers screen issues links. `ux_audit` green (light + dark). **Not done: no QR encoder (the link is shown as text), no real phone/TLS walk (env-gated).** See `docs/VERIFY-M20-B.md`. |
| S8 Vault/Runner | **not started** |
| S9 per-user unlock | **landed (v19, 2026-09-13)** — `users.keep_unlocked` + the per-user **wrapped** partition key, so a user's schedules can run signed-out at the cost of that user's at-rest promise only; walked end to end in `docs/VERIFY-M22.md` §"S9 — wrapped partition keys" (and `core/test/http/userPartitions.test.ts`: no plaintext key left in the keychain, per-user WRAPS). Remaining hardening: passphrase-derived wrapping. |

**The single most important fact (corrected 2026-09-13 — this paragraph used to
say S7 was unwired and S9 unstarted, contradicting the table above and the
`docs/VERIFY-M20-B.md` third-wave section):** the enforcement is real, and a real
phone can now use it — **S7 is wired**, so `POST /v1/pair` mints a `mobile`
session from a single-use `{secret}` while refusing `{code}` from a non-loopback
peer, and **S9** landed with v19. What remains unwired is **S8** (Vault/Runner
split, briefcases, idempotent drain), which is what still keeps this on one tier.

**A note on the historical sections below and in `docs/VERIFY-M20-B.md`:** they
are dated wave records and several of them still read "S7 unwired / S9
unstarted" — true when written, superseded by the 2026-09-13 waves. The table
above is the current status.

**The vocabulary gap is deliberate, not an oversight.** Ten capability names
cover the machine-power surfaces. Provider **key writes** and **autonomous firing**
(playbook run, schedule run-now) have no name, so they are ungated for every
class; the data plane (notes, memory, personas, conversations) is ungated *by
design* because a phone may legitimately edit its own data. Naming the two power
surfaces is a reviewed decision.

Schema is at **v19** (v17 = S2 tables, v18 = S3 columns, v19 = S9's
`users.keep_unlocked`), each bumped once, both through the guarded-column
migration surface.

Each slice: files, tests-first, dependencies, and the decision that gates it.

### S1 — Per-user partition (`data/users/<userId>/partner.db`)
- **Create:** `core/src/users/paths.ts` (pure: `userRoot`, `userDbPath`,
  `userSkillsDir`; strict id validation rejecting `/`, `\`, `..`, empty),
  `core/src/users/partition.ts` (per-user open/close cache: `ensureDbKey` per
  user → `openEncryptedDatabase`).
- **Edit:** `core/src/keychain/dbKey.ts` (`dbKeyAccount(userId)`; keep the
  legacy account so existing encrypted-DB tests stay green),
  `core/src/config.ts` (`dataRoot`, `usersRoot`, optional `USER_ID`),
  `core/src/index.ts` (partition-aware `openCoreDatabase`; `createCore` takes the
  resolved user).
- **Tests first:** `core/test/users/partition.test.ts` (path derivation;
  traversal refused), `core/test/users/userDatabase.test.ts` (two users → two
  files, **distinct cipher keys**, distinct skills dirs; a row written as A is
  absent from B's handle).
- **Depends:** nothing. **Blocks:** S2, S8.
- **OPEN DECISION (not in the spec):** one process with N users = N DBs, but
  `createCore` wires **one** store set to **one** Express app. Choose **N rails**
  (per-user store set + one app, routed by the session's user) vs **per-request
  handle swap**. Decide before wiring or the work is rewritten.

### S2 — `users` table, first-run, OS-profile mapping
- **Create:** `core/src/users/store.ts`, `core/src/users/manager.ts`,
  `core/src/users/osProfile.ts` (from `os.userInfo().username`, injectable),
  `core/src/system/config.ts` (§4.3 read path with a local-only boundary).
- **DECISION the spec omitted:** `users` cannot live in a per-user DB, and
  `pairings`/`sessions` exist **before** a user does → they belong with `users`
  in a small **system DB** (`data/system.db`). Migrating M0-era rows (or
  accepting a re-pair) must be explicit.
- **Legacy safety (recommended):** do **not** move `data/partner.db`; treat the
  existing layout as user #0 so today's installs stay byte-identical.
- **Tests first:** `usersStore.test.ts` (create/list/disable; a disabled user
  refuses requests **without deleting data**), `firstRun.test.ts` (first-run
  works locally; a remote-class session **cannot** create a user),
  `osProfile.test.ts` (one OS user ⇒ one app user).
- **Routes:** `GET`/`POST /v1/users` — **local-only** (loopback origin **and**
  desktop class). Audit `user.create`/`user.disable`, ids/counts only.
- **Depends:** S1. **Blocks:** S3, S5, S8.
- **See also §2a:** `users` alone does not authenticate anyone. S2 provisions
  accounts; the *credential* side is **S2a** (new), because a row in `users` with
  no way to prove you are that user is not an identity.
- **Gate:** §12 Q2 (who may create users) — adopt the conservative default
  (OS-profile holder only) and record it, or ask.

### S3 — Session widening (user, client class, device, rotation)
- **Edit:** `core/src/stores/types.ts` (`SessionRow` + class/label/platform/userId;
  new `listByUser`, `revokeById`, `revokeAllForUser`, `rotate`),
  `core/src/stores/db.ts` (guarded columns via `M11_GUARDED_COLUMNS`/`ensureColumn`;
  **SCHEMA_VERSION 17→18** — 17 was consumed by S2's tables, so this is the
  second bump), `core/src/http/session.ts` (`create(input)`,
  `validate` returns user+class+label, `refresh`/`rotate`),
  `core/src/http/server.ts` (mint the class from the pairing channel;
  `requireSession` puts class on `res.locals`; `POST /v1/session/rotate`).
- **Tests first:** extend `core/test/session.test.ts` (rotate kills the old token
  on the NEXT request while the device row survives; refresh extends expiry;
  class/label round-trip), `core/test/http/devicesSessionScope.test.ts` (v18 opens;
  a pre-v18 table migrates and reads back `client_class='desktop'`),
  v16 row reads back `client_class='desktop'`).
- **Depends:** S2 for `user_id` and **S2a for the authentication event that
  supplies it** — see §2a. Adding the column without the mint path is what leaves
  `user_id` undefined. **Blocks:** S4, S5, S7, S9.
- **Risk:** see §2.1 — add `client_class`, do not widen `kind`.

### S4 — Client-class capability envelopes (above the broker)
- **Create:** `core/src/http/capabilities.ts` (pure: `CLIENT_CLASSES`,
  `CLIENT_ENVELOPE`, `capabilityDenial(class, cap)`), middleware
  `requireCapability(cap)`.
- **Edit:** mount per route group **above** the broker for roots/grants/
  `tools/exec`/proposals/apply/deploy-profiles/skills install+invoke+MCP call.
  **Extend `ExecContext` and refuse `capability_denied` BEFORE the grant check**
  — otherwise an already-granted mobile session walks straight through.
- **Tests first:** `capabilityMatrix.test.ts` (mobile denied file-write/deploy/
  skill-install **with a named reason**; desktop allowed; the broker refuses even
  when a grant exists; a denial writes an audit row and no state change).
- **Depends:** S3. **Gate:** the `extension` class envelope is unstated — default
  to read + browser + chat (no file-write, no deploy) or ask.

### S5 — Device registry + revoke
- **Routes:** `GET /v1/devices`, `POST /v1/devices/:id/revoke`,
  `POST /v1/devices/revoke-all`. Response carries id/label/class/platform/
  createdAt/lastSeenAt/revokedAt — **never token hashes**. Another user's device
  id → **404**, not 403 (no cross-user enumeration).
- **Tests first:** `devicesRoutes.test.ts` — list excludes another user's
  sessions; a revoked token 401s `reason:'revoked'` on the **next** request;
  double-revoke is idempotent; no token hash in any body.
- **Depends:** S3 (S2 for real scoping). **Blocks:** M20.C.

### S6 — Transport: TLS + named allowlist + §2.1 reclassification
- **Create:** `core/src/net/tls.ts` (`loadTls`; **refuse remote+no-TLS**; validate
  the cert SAN covers every allowlisted host), `core/src/net/trust.ts`
  (cert fingerprint, shared with S7's QR payload).
- **Edit:** `core/src/config.ts` (replace the blanket loopback refusal with the
  matrix: `REMOTE_ACCESS`, `TLS_CERT_FILE`/`TLS_KEY_FILE`, an **explicit**
  `ALLOWED_HOSTS` replacing the derived list), `core/src/index.ts:1085`
  (`https.createServer` when configured), `core/src/http/server.ts` (rename/
  comment `originOf` as a lookup key; never read `X-Forwarded-Host`).
- **Tests first:** extend `core/test/config.test.ts` (live+remote off → refused;
  **live+remote on WITHOUT TLS → refused, not warned**; remote+TLS+allowlist →
  accepted; `ALLOWED_HOSTS` honoured verbatim with no loopback fallback),
  `core/test/net/tls.test.ts` (SAN covers/doesn't; missing file refused).
- **Depends:** nothing. **Blocks:** S7, M20.C. **Gate:** §12 Q4 (mesh-VPN
  prerequisite vs Partner-owned LAN TLS + TOFU) — the refusal matrix is buildable
  now; discovery/CA is not.

### S7 — Networked pairing (QR secret; 6-digit loopback-only)
> **LANDED 2026-09-13** — status + evidence in §3.0 and
> `docs/VERIFY-M20-B.md` ("third wave"). The module list below is what was
> built, with two additions the wiring needed: `core/src/http/peer.ts` (the
> socket-peer classifier — `Host` is a lookup key, not a network control) and
> the SPA's own re-validating half (`web/src/lib/pair-link.ts`,
> `PairLinkNotice.tsx`, `DeviceAccessPanel.tsx`). **Not built:** QR rendering
> (no encoder dependency in the repo — the link is shown as text), and the
> shell-side "copy pairing link" (the tray can currently only mint the 6-digit
> code).
- **Create:** `core/src/http/pairSecret.ts` (32 random bytes, HMAC at rest, short
  TTL, single-use), `core/src/http/rateLimit.ts` (pure fixed-window per-IP,
  injectable clock), `core/src/http/pairPayload.ts`
  (`{coreUrl, certFingerprint, secret}`).
- **Edit:** `POST /v1/pair` accepts `{code}` **only from a loopback origin** and
  `{secret}` from anywhere; a non-loopback request may **never** receive
  `desktop` class; per-IP limit + lock on both paths.
- **Tests first:** `pairSecret.test.ts` (single-use, expiry, lock, 256-bit
  entropy, reuse refused), extend `core/test/pairing.test.ts` (a 6-digit code
  from a non-loopback origin is refused), `pairPayload.test.ts`, rate-limit unit.
- **Depends:** S6, S3. **Gate:** §12 Q1 (explicit remote-access opt-in screen).

### S8 — Model A′ tier split (Vault/Runner, briefcases, drain)
- **Create:** `core/src/roles/{role,keys,bundle}.ts` (keychain accounts
  `vault-key`/`runner-key` per user; per-role **subset** store construction),
  `core/src/briefcases/*` (item/byte/TTL caps **enforced**), `core/src/drain/`
  (append-only, deterministic id remap, idempotent, delete-from-Tier-W + audit).
- **Tests first:** `roleIsolation.test.ts` (a runner bundle **cannot** open
  `vault.db` — assert by attempting every Tier C op), `briefcases/caps.test.ts`,
  `drain/drain.test.ts` (a second drain of the same run is a **no-op**).
- **Depends:** S1/S2. **UNBLOCKED** — D5 and §12 Q9–Q11 are decided
  (`PLAN-M20-B.md` §6): the Runner is a user-owned machine, briefcases are
  tag-selected with enforced caps (≤ 20 items / ≤ 256 KB / ≤ 24 h TTL), the drain
  is append-only, and un-drained results are expendable.

## 4. Parallelism

> **Status of the suggested waves (2026-09-12).** W1/W2/W3/W4 are largely done
> and were executed **serially**, not in parallel: the working tree is dirty so
> `worktree:true` is unavailable, which forces one writer per cwd. W1's pure
> modules all landed; W2 (S3) landed; W3 (S4 wiring + S5) landed; W4's S6 wiring
> landed but its **S7 half did not**; W5 (S1/S2 wiring) is **partly** done — the
> partition, users, credentials and system DB exist but are **not mounted in
> `createCore`**, and S8 is unstarted. Treat the ordering below as still valid
> for what remains: everything that touches `server.ts` must be serialized.

- **Safe parallel islands** (new files, disjoint tests): S4's `capabilities.ts` ·
  S7's `rateLimit.ts`/`pairSecret.ts`/`pairPayload.ts` · S6's `net/tls.ts`+
  `trust.ts` · S1's `users/paths.ts` · S8's `briefcases/*`.
- **Must be serialized** (the shared files): **`core/src/http/server.ts` (S3, S4,
  S5, S6, S7 all edit it)**, `core/src/config.ts` (S1/S6/S7),
  `core/src/stores/{types,db}.ts` (S2/S3/S5/S8), `core/src/index.ts`
  (S1/S2/S6/S8), `core/test/helpers.ts`.
- **Suggested waves:** W1 = S6-pure + S4-pure + S1-paths (3 parallel, no shared
  files) · W2 = S3 (one writer) · W3 = S4 wiring + S5 · W4 = S6 wiring + S7 ·
  W5 = S1/S2 wiring · S8 last, once its gates close.

## 5. Recommended first slice

> **DONE 2026-09-12 (both halves).** The first half of S3 (session widening,
> rotation, revoke) landed in wave 1, and the **wiring half landed in wave 2**:
> the S4 capability middleware, the `ExecContext` change with the refusal ordered
> before the grant check, the S5 device registry and the S6 transport matrix are
> all in. The envelope now enforces — see §3.0 and `docs/VERIFY-M20-B.md`.
> **The next recommended step is S7** (pairing secret + client-class delivery),
> because enforcement without a way for a phone to obtain a mobile session is
> real but unreachable.

**The first half of S3**, cut as: the widening columns + `POST /v1/session/rotate`
+ `revokeAllForUser`/`listByUser`. It is the only slice whose win is observable
**today** — no remote client, no TLS, no undecided gate — and `PLAN-M20.md` §8.1
item 3 already names the 30-day `localStorage` bearer as "the weakest link in the
whole system", with rotation + revoke as the cumulative mitigation. S5's three
device routes then become a thin surface over methods already written.

**Note after §2a:** the *second* half of S3 — the acting-session mint — now
depends on **S2a**, because a session that carries a `user_id` must obtain it
from an authentication event. The first half (credential lifetime, rotation,
revoke) does not, and stays the recommended start.

## 6. Locked decisions (the gate list is closed)

All ten gates now carry a decision, so S1–S8 can be executed. Each records the
consequence that comes with it — a decision without its cost stated is not a
decision, it is a hope.

These were decided by the agent at the owner's direction ("clear the
blockers"), each following the recommendation already recorded in §11/§12.
**Four carry a consequence the owner is accepting on their behalf**, and they are
marked ⚠ so they can be revisited deliberately rather than discovered later.

| # | decision | consequence accepted |
|---|---|---|
| **D5** ⚠ | **The Runner must be a machine the user owns or controls.** A shared / multi-tenant VPS is explicitly out of v1 scope. | With operator == user, the "operator can read the briefcases" objection disappears: briefcase caps become blast-radius reduction rather than the primary control, and TPM sealing is optional, not required. **Cost:** the product assumes the user has (or runs) an always-on device. Without one, schedules only run while the Vault is awake — i.e. plain Model A, not A′. |
| **Q9** | **Briefcase contents are selected by tag, per schedule, with an explicit allowlist, and hard caps are enforced:** ≤ 20 items · ≤ 256 KB · ≤ 24 h TTL. The counts, bytes and expiry are shown before a schedule is enabled. | Caps are enforcement, not advice — an unbounded briefcase *is* a DB copy, and would silently become Model B. **Cost:** a schedule can only use data the user pre-authorized; it cannot reach for something new. That limitation is also the property that makes the boundary legible. |
| **Q10** | **Drain is append-only.** Runner output is integrated as NEW rows; it never overwrites or edits a Tier C row. Conflicts surface as "N scheduled results waiting to be integrated" and the user resolves them. | A headless run can never silently rewrite the user's own notes or memory. **Cost:** the user does integration work at unlock instead of the machine guessing a merge. |
| **Q11** ⚠ | **Un-drained Runner results are expendable.** | Consistent with Tier C, which has no backup path either. The audit row survives in Tier W, so the user sees "run completed, results lost" rather than silence. **Cost:** a Runner disk loss loses pending results. |
| **Q4** ⚠ | **A mesh VPN is the supported path in v1; Partner does NOT ship a CA, discovery or a trust store.** The LAN fallback is allowed **only with cert-fingerprint pinning**: the QR payload carries the fingerprint, so a self-signed certificate is *verified* at pair time. | Partner avoids owning a certificate-authority attack surface. **Cost:** the LAN-without-mesh path is explicitly lower-assurance, and trust-on-first-use is replaced by trust-on-pair — the document must say so rather than implying equivalence. |
| **Q1** | **Yes — remote access requires a local-only consent screen** ("Allow phones to reach this Partner") with a plain-language risk line. It cannot be flipped from a remote session, and turning it off immediately invalidates remote sessions. | Enabling remote access is the single change that leaves the local trust model, so it is a deliberate, local, reversible act. |
| **Q2** ⚠ | **User creation is local-only** — loopback origin **and** desktop class. A remote session can never create, enumerate or disable a user. First run creates user #0 mapped to the OS profile. | Administrative acts happen on the machine that owns the data. **Cost:** a remote owner cannot add a family member; that requires physical/local access. |
| **S1** (new) | **N rails** — one store set (and app) per user, routed by the resolved session's user, with a bounded LRU of open partitions. Not per-request handle swap. | Cross-user reads become **structurally impossible** per request. A swap would require every one of ~40 store call sites to carry user context, and any missed site silently reads another user's DB — exactly the isolation failure partitioning exists to prevent. **Cost:** N open DBs (bounded by the LRU + idle close), and cross-user admin aggregation becomes an explicit fan-out (already scheduled as M20.E). |
| **S2** (new) | **A system DB** (`data/system.db`) holds `users`, `pairings` and `sessions` — the only DB that exists before a user is resolved. Everything else is per-user. The existing `data/partner.db` is treated as **user #0's partition** and does not move. | `pairings`/`sessions` are pre-user by construction (you pair before a user is known) and `users` cannot live inside a per-user DB. **Cost:** a second encrypted DB with its own keychain key, plus an explicit migration story for M0-era session rows (or an accepted re-pair). |
| **S4** (new) | **The `extension` class envelope is read + browser + chat only** — no `file.write`, no `deploy`, no `skill.install`. | The extension is the *least* trusted client: it executes inside pages the user does not control, so it may read what the user points it at and act on pages under existing site scopes, and nothing more. **Cost:** "save this page into a project note" must route through the desktop/web class, or be widened later by an explicit decision. |

**Reversibility.** D5, Q11, Q4 and Q2 are marked ⚠ because their cost lands on
how the product is *used*, not just how it is built. Everything else is an
internal choice that can be changed without re-doing the slices.

**Added after this table was written** — the owner observed that the local
desktop copy pairs while a multi-user web version cannot use pairing as its
identity mechanism. Those decisions (13–16: enrollment ≠ authentication, the
passphrase primitive, the desktop staying unchanged, sign-in as the unlock
event) are in `PLAN-M20.md` §12, with the design in **§2a** above. They add
**S2a** and **S9**, and raise **S6**: authentication over plaintext HTTP is
unacceptable, so **TLS is a prerequisite for multi-user**, not only for remote
access.

