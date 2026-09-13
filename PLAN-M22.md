# PLAN-M22 — remote-hosted accounts, deployment-owned files, no llm-self-service

Companion to `PLAN.md` §15 (index) and `docs/VERIFY-M22.md` (measured record).
Three changes requested for the remote-hosted shape, plus the findings they
turned up.

## 1. Pairing → user login (`AUTH_MODE=login`)

**Why it had to change:** pairing proves *device enrollment by proximity* — "can
this client reach the core?" It says nothing about **who is asking**. That is
sound for the desktop app (the machine's OS profile identifies its holder, §2a),
and wrong for a core on the internet.

| Shape | `AUTH_MODE=pairing` (default: desktop) | `AUTH_MODE=login` (this image) |
|---|---|---|
| Way in | 6-digit code (loopback) or a single-use secret link | username + passphrase (`POST /v1/auth/session`) |
| Session carries | no user (`user_id` NULL) | `user_id` — the identity authorization needs |
| Client class | `desktop` from the loopback code, `mobile` from a link | `LOGIN_SESSION_CLASS` (default `desktop`) |
| Pairing routes | live | **403 `pairing_disabled`** (`/v1/pair`, `/v1/pair/payload`, the M15 device channel, the demo code seam) |
| Smoke signals | — | `/v1/health` reports `authMode` + `hasUsers` |

- **Credential primitive:** per-user scrypt (S2a, already built) — salt, params
  and derived key in the **system DB** (`data/system.db`, its own `system-key`),
  never the passphrase. A wrong password and an unknown username are
  indistinguishable (timing parity); three failures lock for five minutes; a
  per-peer rate limit sits on top, because behind a tunnel every request shares
  one peer address and the lockout alone would let one actor lock the owner out.
- **Account management is a CLI, not a route:** `tools/user.mjs` with
  `add | passwd | list | lock-account | unlock-account`. "Can run a process in
  the container" is the operator's proof of being at the machine — the same
  reasoning that makes the pairing secret loopback-only — so no HTTP surface was
  added for it.
- **One user, deliberately.** The account lane identifies a user, but a *second*
  user has nowhere to put their data: per-user partitions (S1) are not wired into
  `createCore`, so two accounts would share one database. `add` refuses a second
  account with that reason instead of creating a data leak.
- **Sessions become owner-scoped.** Because the session now carries `user_id`,
  the S5 device registry scopes by owner for real (`listByUser`) instead of
  falling back to the transitional user-less rule.

## 2. Deployment-owned project roots (`FIXED_ROOTS`)

The container mounts one volume and that is all the file tools may see.

- `FIXED_ROOTS=/files` (comma-separated, absolute) → the core registers each root
  at boot and **`POST`/`DELETE /v1/roots` answer 403 `roots_fixed`**; the Files
  view renders the list read-only (no Add card, no Remove button).
- Registration is **idempotent**: grants reference a root by ID, so a second boot
  reuses the existing row (a duplicate insert would orphan every grant). A
  configured path that is not a directory **fails the boot**, naming it.
- Desktop is untouched: with no `FIXED_ROOTS` the roots surface behaves exactly as
  before (`rootsFixed: false` in `GET /v1/roots`).

## 3. llm-self-service removed

The M1 import (login-key + connect routes, the page-side RSA-OAEP envelope, the
demo double, the Providers card, the shared contracts) is gone. Provider setup is
a base URL + key typed by the user. The `'llm-self-service'` **`ProviderSource`
value stays** in the shared enum so provider rows written by an older install
still read; nothing creates one. This also retires the external **S0** dependency
(`PLAN.md` §17 item 6 and the S0 milestone).

## Findings this work turned up (each fixed)

1. **The container CLI started a second core.** The bundle's entry guard treated
   "no `import.meta.url`" as "I am the entry", so `tools/user.mjs` requiring the
   bundle booted a server, hit `EADDRINUSE` against the running core, and looked
   like a tooling bug. The guard now compares the *entry file* with itself
   (`core/src/entry.ts`, unit-tested), and operator tools can require the bundle.
2. **A stale origin certificate was silently reused.** `stage.sh` kept
   `secrets/origin.crt` whenever it existed, so changing `PARTNER_HOST` produced a
   cert for the wrong name and a boot loop (`cert_san_uncovered`). Both stage
   scripts now regenerate unless `openssl x509 -checkhost` proves coverage.
3. **"Pair again" copy inside a login-mode app.** Nine views said "Pair again
   to …" when the gate the user will actually see is a sign-in form.
   `web/src/lib/auth-mode.ts` caches the mode (`partner.authMode`: one word,
   allowlisted as UI metadata) and the views render the right action.
4. **`{error, message}` responses surfaced the machine code.** The client's error
   extractor preferred `error` over `message`, so users saw `invalid_input` /
   `no_account` instead of the sentence. `message` now wins.

## Exit

- [x] Login mode: sign-in mints a session that names its user and class; wrong
      password and unknown user are identical (401); lockout (429 + Retry-After);
      disabled account refused; no-account answered 409 with the operator command;
      rate-limited per peer; the password is in no response and no audit row.
- [x] Pairing refused in login mode on every pairing route; `/v1/health` reports
      the mode; a login-mode boot without the system DB is refused.
- [x] Fixed roots: registered idempotently at boot, listed with `rootsFixed:
      true`, add/remove 403 `roots_fixed` and audited, a non-directory root fails
      the boot, desktop behaviour unchanged.
- [x] llm-self-service gone from core, web, shared and tests; suites green.
- [x] Container (login mode + `/files`): the account was created by the CLI,
      sign-in through the tunnel returned a `desktop` session, `/v1/roots` was
      read-only, and a brokered write into `/files` completed
      proposal → approval → file on the mounted volume.
- [x] Login gate verified in a browser: both fields, submit disabled until
      filled, sign-in → workspace, and only `partner.token` + `partner.authMode`
      (+ the theme cache) in storage.
- [ ] Multi-user (per-user partitions, S1/S8/S9) — deliberately refused, not
      implemented.
- [ ] Idle re-lock / sign-in-as-unlock (S9) and session revocation on password
      rotation — recommended below, not built.

*State: implemented + container-verified 2026-09-13. Record: `docs/VERIFY-M22.md`.*

## S1 / S9 status

**S1 (per-user partition) — done and now WIRED.** Its modules landed in the first
M20-B wave; R1's rails are the caller that was missing, so it is verified end to
end (two users, two encrypted files, per-user keys/audit/skills; LRU + idle close;
the first user keeps the pre-partition database and a boot guard refuses to orphan
it). See `docs/VERIFY-M22.md` "S1 / S9".

**S9 (per-user key unlock) — done.** Schema **v18 → v19**: `key_wraps` +
`users.keep_unlocked`. At first sign-in the partition key is wrapped under a key
derived from the passphrase (**own salt + HKDF domain separation**, so the stored
credential verifier cannot unwrap it — that is a test) and the plaintext is
removed from the keychain. A signed-out user's partition answers
`401 unauthorized / partition_locked` even while their session is still valid, and
signing in again re-opens it; `rails.close` drops the handle because an open handle
would keep decrypted pages in SQLite's cache. The per-user, audited opt-in
(`tools/user.mjs keep-unlocked`) keeps THAT user's key in the keychain so their
schedules can run with nobody signed in — the plan's accepted cost, enforced by
code. `passwd` refuses to orphan a wrapped key unless `--reset` is passed.

**S8 (Vault/Runner tier split) — NOT done, deliberately.** Role isolation and
briefcase caps are a boundary where a half-implementation is worse than none (the
slice's first test is "a runner bundle cannot open `vault.db`"). The plan stands as
written in `PLAN-M20-B.md` §S8; S9's `key_wraps.purpose` column is reserved for the
runner's job key and the vault's `adopt`/`unlock` seam is role-agnostic.

## Delivered in this slice (R1–R9, R5 skipped by request)

| # | What | Where it is enforced |
|---|---|---|
| **R1** | **Per-user partitions.** A user's partition is a complete single-user core built over their own encrypted database, key and skills dir; the listening app authenticates and **delegates** every other `/v1` request to that user's own app | `core/src/users/rails.ts` (LRU + idle), `delegate` in `core/src/http/server.ts`, `createCore` built once per user. **Two users are provably isolated: a read in one partition cannot contain the other's rows** (`core/test/http/userPartitions.test.ts`) |
| **R2** | **Rotation revokes sessions** — `tools/user.mjs passwd` signs out every device of that user and reports the count | the CLI (the only place a passphrase changes) |
| **R3** | **Idle re-lock.** `PARTITION_IDLE_MS` closes a partition that has gone idle, dropping its key material from memory; the next request re-opens it from the keychain | `rails.sweep()` + a timer in `startServer` |
| **R4** | **Trusted client IP.** `CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`) is believed **only** when the socket peer is inside `TRUSTED_PROXY_CIDRS`, and it feeds the auth rate-limit buckets only — never a locality decision | `isIpInCidrs` / `rateLimitKeyFor` in `http/peer.ts`, wired in `index.ts` |
| **R6** | **`FIXED_ROOTS_READ_ONLY=1`** registers the deployment's roots read-only | `applyFixedRoots`; the file tools already refuse writes on a read-only root |
| **R7** | **Upload caps are knobs** — `MAX_UPLOAD_BYTES` (default 8 MiB) and `MAX_JSON_BYTES` (default 1 MiB) | attachment manager option + `express.json` limit |
| **R8** | **Verified backup tool.** `tools/backup.mjs` snapshots every database with `VACUUM INTO` (consistent while running), copies the keychain + skills trees, re-opens each snapshot with the copied key, runs `integrity_check`, writes `BACKUP.json`, prunes to `--keep N`, and **exits non-zero when anything could not be verified** | container tool, run live (see VERIFY-M22) |
| **R9** | **The vocabulary gap is closed.** `provider.configure` (`/v1/providers/:id/key`, `/v1/search/key`) and `persona.run` (playbook run, schedule run-now) are named and denied to mobile/extension by the envelope table | `http/capabilities.ts` + the four route mounts |
| — | **R5 (Cloudflare Access) skipped** at the user's request; it remains a deployment-layer recommendation in `docker/server/README.md` | — |

### How R1 keeps the surface honest

| Shared (system DB) | Per user (their partition) |
|---|---|
| `users`, `user_credentials` | every store: notes, plans, memory, chat, attachments, assets, skills, grants, roots, themes, settings, spend, **audit** |
| `sessions`, `pairings` | their own whole-file-encrypted `partner.db` |
| sign-in audit rows (operator-level) | their own `skills/` tree |

Because two users never open the same database, “a query cannot cross users” is
structural rather than a property of remembering to filter. Costs, stated:

- a partition’s **scheduler runs only while it is open** — a signed-in user’s
  schedules fire, an absent user’s do not (M20 §16’s stated cost, now real);
- `PARTITION_MAX_OPEN` (default 8) bounds open handles, each of which is a
  database plus ~40 stores;
- **R3 is memory hygiene, not cryptography**: with the file keychain the key is on
  the volume, so closing a partition removes key material from *memory*. True
  per-user cryptographic unlock (key wrapped by the passphrase) is S9 proper and
  is not built.

## Recommended next (still open)

| # | Change | Why it is not done here |
|---|---|---|
| R5 | **Cloudflare Access** in front of the hostname | Skipped by request; a deployment decision, not code |
| R3b | **Passphrase-wrapped partition keys** (S9 proper) | Needs a key-wrapping format + a recovery story; R3 closes the memory window but the file keychain still holds the key |
| R10 | **Sign-out / device management in the SPA** | The registry API exists (`/v1/devices`); the UI lists nothing yet |
| R11 | **Per-user quotas** (spend, storage) | Only the gateway's per-provider budget exists; a hosted core with several users wants an operator-level cap |

