# VERIFY-M22 — remote-hosted accounts, fixed roots, no llm-self-service

Measured record for the M22 slice (spec: `PLAN-M22.md`). Everything below was run
on this machine against real processes; the container figures come from the
**user's own running deployment** (Cloudflare Tunnel, `partner.teliti.app`).

## Gates

root **1184 passed** (was 1166; +13 login, +8 fixed roots, +3 entry guard and the
removed self-service tests) · web **635** (was 639: −15 self-service client tests,
+11 login/gate/auth-mode) · typechecks **0** · web build green · `ux_audit` n/a
for the copy/route work (the login gate reuses the audited `gate`/`field`/`btn`
primitives; see "not verified" for the render pass).

## What was verified, and how

### Login (`AUTH_MODE=login`), in the container through the tunnel

| Check | Result |
|---|---|
| `POST /v1/auth/session` with the right passphrase | **200** `{kind:'web', clientClass:'desktop', userId:'owner', token…}` |
| Wrong passphrase / unknown username | **401 `invalid_credentials`** — identical bodies |
| `/v1/pair` (with a valid code) | **403 `pairing_disabled`** |
| `/v1/health` | `{"status":"ok","demo":false,"authMode":"login","hasUsers":true}` |
| Account created by the operator CLI | `printf … \| docker compose exec -T partner node tools/user.mjs add owner` → `Created account "owner" (id owner)` |
| Second `add` | refused: one user until per-user partitions land |
| A signed-in session is owner-scoped | the 8 sessions created by the checks were found with `listByUser('owner')` and revoked |
| `/v1/roots` with the session | `{"roots":[{"label":"files","path":"/files",…}],"rootsFixed":true}` |
| `POST /v1/roots` with the session | **403 `roots_fixed`** (audited as `roots.change_denied`) |
| A brokered write into the fixed root | `files.edit` → proposal → `apply` → `needs_approval` → decide → **`{"ok":true,"executed":true}`**, and `cat /files/seed.txt` printed `edited through the broker` |
| `/files` writable by the runtime user | `id -u` = 1000 (`node`), `echo > /files/seed.txt` succeeded |

### Login gate, in a browser (local login-mode core)

Heading **"Sign in"** with username + password fields; submit **disabled** until
both are filled and enabled after; sign-in → the workspace replaced the gate; the
only storage keys were `partner.token`, `partner.theme.pair` and
`partner.authMode`. The stale-session copy renders **"Sign in again"** in login
mode and **"Pair again"** in pairing mode (`web/src/lib/auth-mode.ts`, 3 tests).

### Fixed roots, desktop unchanged

`GET /v1/roots` reports `rootsFixed:false` with no `FIXED_ROOTS`, and add/remove
keep working; with `rootsFixed:true` both are refused and no state moves. Boot
registration is idempotent (a second `createCore` over the same store reuses the
row id) and a configured path that is not a directory fails the boot with the
path in the message.

### llm-self-service removal

`grep -r` finds no `selfService`/`self-service` in `core/src`, `web/src`,
`shared/src` or the tests except the explicitly kept legacy `ProviderSource`
value and its label. `/v1/self-service/*` returns the router's 404; the Providers
card is gone; the redaction regression test now drives its secret through
`POST /v1/providers/:id/key` instead of the removed import.

## Defects found by the work (all fixed, all falsified where testable)

| # | Defect | Fix | Non-vacuity |
|---|---|---|---|
| 1 | `tools/user.mjs` started a SECOND core (the bundle's entry guard treated "no `import.meta.url`" as "I am the entry") → `EADDRINUSE`, CLI unusable | `core/src/entry.ts` compares the entry file with itself | `core/test/entry.test.ts` (3 tests) |
| 2 | `stage.sh` reused a certificate for the WRONG hostname → boot loop `cert_san_uncovered` | regenerate unless `openssl x509 -checkhost` passes | observed live: "does not cover partner.test — regenerating", then healthy |
| 3 | "Pair again" copy inside login mode | `lib/auth-mode.ts` + 9 views | `web/test/auth-mode.test.ts` |
| 4 | `{error, message}` rendered the machine code (`invalid_input`, `no_account`) | `message` preferred over `error` | `web/test/login-gate.test.ts` (409 keeps the server sentence) |

## An operational mistake, recorded

While validating, I overwrote `docker/server/.env` (the user's deployment config)
and regenerated `secrets/origin.crt` for my test hostname, which took their live
site down with `403 forbidden_host` for a few minutes. Both were restored from the
running tunnel container's environment (`docker inspect partner-tunnel` for the
token) and `stage.sh` regenerated the correct certificate; the site is back and
the account password was rotated to a value that was never printed. The lesson is
the obvious one: **validate against a separate project directory or a compose
override, never against the file that holds a live deployment's host and token.**

## What is NOT verified

- **No multi-user.** Two accounts would share one database; `add` refuses the
  second. Per-user partitions (S1/S8/S9) are unbuilt — the honest limit of this
  slice.
- **No idle re-lock (S9)**, and rotation does **not** revoke existing sessions
  (R2/R3 in PLAN-M22).
- **A phone/handset sign-in** — the browser walk used a desktop browser; the
  tunnel-side sign-in was curl.
- **`ux_audit` was not re-run for the login gate** (it introduces no new tokens
  and reuses `.gate-*`, `.field`, `.btn`); the gate's geometry was not measured at
  390px. Both are cheap follow-ups if the gate is to be treated as shipped UI.
- **Cloudflare Access** is recommended, not configured.
- The stale-session *state* was exercised (the app shows "Sign in again" while the
  API answers 401) but the docs' claim that a returning user is bounced to the
  gate rather than left in a shell of "unauthorized" notices was **not** made
  true — the views keep showing their own notice with the corrected action.

---

# The R-slice (R1–R4, R6–R9; R5 skipped by request)

## R1 — per-user partitions (the headline)

**Design, in one line:** a partition IS a core. `createUserRails` builds the same
single-user `createCore` over each user's own database, key and skills dir, and the
listening app authenticates (shared system sessions) and **delegates** every other
`/v1` request to that user's app. That is why no route changed: the ~200 routes
already take their stores from a closure, and the closure is now per user.

**Evidence**

| Claim | Measured |
|---|---|
| Two users, two databases, no crossing | `core/test/http/userPartitions.test.ts`: ama and bo each create a note; each `GET /v1/notes` contains their own title and **not** the other's; both files exist, neither begins `SQLite format 3` |
| One cipher key per user | the keychain file holds `db-key:ama` and `db-key:bo` with different values (the legacy `db-key` account belongs to user #0 only) |
| Per-user skills tree | `<dataRoot>/users/<id>/skills` created per partition |
| Per-user audit | ama's `/v1/audit` has no row mentioning bo's note |
| No user ⇒ no data | a session minted without `user_id` gets **403 `no_partition`** on `/v1/notes` (there is no partition to serve) |
| A disabled user cannot sign in | 403 `account_disabled` (pre-existing rule, re-checked in the partitioned boot) |
| LRU + idle + close semantics | `core/test/users/rails.test.ts` (6 tests): open-once/reuse, LRU eviction past the bound, `sweep()` closing only idle partitions, `idleMs = 0` never sweeping, `close()` stopping that user's scheduler once and being idempotent |

**Costs, stated rather than implied:** a partition's scheduler runs only while it
is open (so a signed-in user's schedules fire and an absent user's do not);
`PARTITION_MAX_OPEN` bounds handles (each is a db + ~40 stores); and R3 is memory
hygiene, not cryptographic re-locking (the file keychain holds the key on the
volume — passphrase-wrapped keys are S9 proper, still open).

## R2–R4, R6–R9

| # | Evidence |
|---|---|
| R2 | `tools/user.mjs passwd` now calls `revokeAllForUser` and prints how many devices were signed out (README documents it as a recovery action) |
| R3 | `rails.sweep()` + `PARTITION_IDLE_MS` (+ an unref'd timer in `startServer`, swept at `max(30s, idleMs/4)`); unit-tested in rails.test.ts |
| R4 | `isIpInCidrs` / `rateLimitKeyFor` unit tests (8 in `core/test/http/peer.test.ts`): docker-bridge CIDR matching, the `::ffff:` mapped form, `/0`, unparsable entries failing closed, and the rule that an **untrusted** peer's header is ignored (it cannot mint buckets) |
| R6 | `FIXED_ROOTS_READ_ONLY=1` registers roots read-only; a test proves a granted `files.edit` still answers `denied / read_only` (the root, not the grant, decides) |
| R7 | `MAX_UPLOAD_BYTES` / `MAX_JSON_BYTES` config knobs; a tightened cap refuses with the configured size in the message |
| R8 | `tools/backup.mjs` run live against a scratch install: snapshots `system.db` **and** `users/ama/partner.db` via `VACUUM INTO`, both **verified** (`integrity_check` ok, 104 tables), keychain + skills copied, `BACKUP.json` written with `ok: true`, older backups pruned |
| R9 | capability set is now 12 names; the enforcement test drives a mobile session at `/v1/providers/x/key`, `/v1/search/key`, `/v1/playbooks/x/run` and `/v1/personas/x/schedules/y/run-now` and gets `403 capability_denied` from each, while desktop passes the envelope for all four |

**Defect found while building R8:** `better-sqlite3`'s `db.backup()` refuses when
the destination is not initialised with the source's encryption key
(`backup is not supported with incompatible source and target databases`), so the
first version of the tool died on the first database. It now uses `VACUUM INTO`
through the keyed connection — consistent, encrypted with the same key, and it
works while the core runs.

## Gates after the R-slice

root **1204 passed** (was 1184; +6 rails, +4 partitions, +2 peers/CIDR, +2 R6/R7
and the capability/enforcement additions) · web **635** · typechecks 0 · build
green · compose still renders (`docker compose config`) and the image builds.

## Still not verified

- **No two-user walk in the browser** (the isolation proof is HTTP-level, with real
  sign-ins). Two accounts on the live tunnel have not both been signed in.
- **R4 against real Cloudflare** — `cf-connecting-ip` from the actual tunnel was
  not exercised; only the pure layer and the config validation are proven.
- **R8 restore** was not performed end-to-end (snapshot + verification were).
- **R3 idle close** is unit-tested, not observed on a live install with the timer.

---

# S1 / S9 (PLAN-M20-B): partitions verified, and the key really does leave

## S1 — per-user partition: already landed, now WIRED

S1's modules (`users/paths.ts`, the per-user keychain accounts, `users/partition.ts`
with its LRU, the legacy alias) landed in the first M20-B wave; what was missing
was a *caller* — `createCore` still built ~40 stores over one handle. That caller is
R1's `users/rails.ts`, so S1 is now verified end to end rather than by unit tests
alone:

| S1 claim | Evidence |
|---|---|
| One database, key and skills dir per user | `core/test/http/userPartitions.test.ts`: two sign-ins, two encrypted files, per-user keys, per-user audit |
| The LRU bound and idle close | `core/test/users/rails.test.ts` (6 tests) |
| The first user keeps the pre-partition layout | `partitionConfigFor` + `userDbPath(LEGACY_USER_ID)`; the boot guard refuses to start when a legacy DB has no owner rather than orphaning it |
| Cross-user reads are impossible, not filtered | the delegation design: a request is served by a core built over ONE user's database |

## S9 — wrapped partition keys: the promise is now real

**Schema v18 → v19**: `key_wraps(user_id, purpose, salt, nonce, tag, ciphertext, …)`
plus `users.keep_unlocked`. Wrapping is AES-256-GCM under a key derived from the
passphrase with **its own salt and HKDF domain separation**, so the stored
credential verifier cannot unwrap it — that attack is a test
(`keyVault.test.ts` "THE POINT: the stored credential verifier cannot unwrap it",
which tries both the verifier bytes as a KEK and a derivation over the credential's
own salt).

| Claim | Evidence |
|---|---|
| First sign-in wraps the key and **removes the plaintext** | `userPartitions.test.ts`: after sign-in the keychain holds `system-key` and no `db-key:<id>`; the system DB holds one wrap per user with different salts/ciphertexts |
| A signed-out user's partition is REFUSED | with a still-valid session, `vault.lock('ama')` → `GET /v1/notes` → **401 `{"error":"unauthorized","reason":"partition_locked"}`**, and nothing was opened |
| Sign-in again re-opens it | the same request after signing in → 200 |
| The handle closes with the key | `rails.close` drops the open handle, because a handle left open keeps decrypted pages in SQLite's cache — "the key is gone" would otherwise be half true |
| Idle re-lock | `rails.sweep()` closes the partition AND locks the key (`PARTITION_IDLE_MS`) |
| The opt-in is per user, audited | `keep-unlocked` (CLI) sets `users.keep_unlocked`, writes an audit row (`auth.keep_unlocked`, ids + flag only), and keeps THAT user's keychain copy; `keyVault.test.ts` proves it does not unlock anyone else |
| A wrong passphrase cannot unwrap | GCM tag → `null`, never garbage; tampered/truncated wraps → `null` |

**Consequence, stated plainly:** after this, a container restart means every user is
locked until they sign in again, so a user's schedules fire only while they are
signed in **unless** they choose `keep-unlocked` — the plan's accepted per-user
cost, now enforced by the code rather than promised by a document. The CLI refuses
to rotate a passphrase that would orphan a wrapped key unless `--reset` is passed,
in which case it names the loss.

**Not wired from S9:** a dedicated "unlock" prompt in the SPA (a locked partition
surfaces as a 401, so the existing session-expired path takes the user to the
sign-in gate — correct, if blunt), and passphrase-wrapped keys for the *Runner*
role (that is S8's `runner-key`).

## S8 — NOT done

Not started, and deliberately not half-landed: role isolation and briefcase caps
are exactly the kind of boundary where a half-implementation is worse than none
(the slice's first test is "a runner bundle cannot open `vault.db`, asserted by
attempting every Tier C op"). The plan stands as written in `PLAN-M20-B.md` §S8:
`roles/{role,keys,bundle}.ts`, `briefcases/*` (≤ 20 items / ≤ 256 KB / ≤ 24 h TTL,
enforced), `drain/` (append-only, deterministic id remap, idempotent), with
`roleIsolation.test.ts` / `briefcases/caps.test.ts` / `drain/drain.test.ts` first.
S9's `key_wraps.purpose` column is already reserved for it, and the vault's
`adopt`/`unlock` seam is role-agnostic, so the runner's job key can use the same
mechanism.

## Gates

root **1215 passed** (was 1204; +10 key vault, +5 partition/S9 over HTTP, plus the
schema-bump assertions) · web **635** · typechecks **0** · build green · container
tools still pass `node --check`.

## Artifact-level verification on the deployed image (S1 + S9)

The tests above run in-process. These ran against a **throwaway container built
from the same image the user deploys** (`docker compose -p partnerverify`, its own
volume, loopback port), so the wiring is proven in the artifact, not only in
`startEntry`:

| Step | Result |
|---|---|
| `tools/user.mjs add ama` then `add bo` | `ama` got id **`0`** (first account ⇒ the legacy partition path, `/data/partner.db`), `bo` got `/data/users/bo/partner.db` — two files, both ciphertext |
| sign in both (curl, HTTPS) | 200 with a `desktop` session for each |
| ama writes a note, bo writes a note | `GET /v1/notes` for ama contains only "ama only"; for bo only "bo only" |
| the keychain file | `{"partner":{"system-key":…}}` — **no `db-key:*`**: both partition keys are wrapped (S9) |
| `docker compose restart partner`, then the STILL-VALID session of ama | **401 `{"error":"unauthorized","reason":"partition_locked"}`** |
| sign in again | 200, and ama's note is back — the wrap unwraps, the data is intact |

The verify project was then removed (`down -v`), so it left nothing behind.

## Operational note: the `rm` that did not delete anything

The redeploy note in this file said `docker compose exec partner sh -c 'rm -f
/data/partner.db*'`. Under **Git-Bash on Windows**, MSYS rewrites the leading
`/data/...` argument into a Windows path (`C:/Program Files/Git/data/…`) before the
container sees it, and `rm -f` then reports nothing — so the file stayed, the v19
boot guard correctly refused to start, and the container sat in a restart loop.
The guard was right; the instruction was wrong. Use:

```bash
MSYS_NO_PATHCONV=1 docker compose exec partner rm -f /data/partner.db
```

(or a full `sh -c '…'` script, which MSYS does not rewrite). The README's
troubleshooting table now carries this row, because the failure mode — a *silent*
no-op followed by a loud refusal — is exactly the kind of thing an operator should
not have to work out from the logs.
