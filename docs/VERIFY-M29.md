# VERIFY-M29 — the multi-user lifecycle

Record for `PLAN-M29.md`. Everything below was run on 2026-09-18 on Windows
(Node 22 / better-sqlite3-multiple-ciphers), against the working tree that
became the `v0.1.23` release.

## 1. Gates

| Gate | Result |
|---|---|
| root suite (`npm test`) | **1766 passed**, 5 env-gated skips (1746 before M29 → **+20**) |
| shared | **90 passed** |
| web (`npx vitest run --root web`) | **944 passed** (937 → **+7**) |
| typechecks (`npm run typecheck`) | **0 errors** |
| web build (`npm run build -w web`) | green (580 modules) |
| `ux_audit` (new Members/Shared/sidebar-footer rules) | **PASSED** — tokens, states, slop tells; APCA on the new text pairs (light 93.21 / 81.40, dark 91.06 / 75.23) |
| container refresh | `partner-server:local` rebuilt + recreated, healthy |
| Windows package | NSIS built (see §4) |

New tests, by lane:

- `core/test/http/m29Lifecycle.test.ts` (**13**) — sign out closes the partition
  and a re-sign-in reopens it; `DELETE /v1/session` still works; `/v1/account`
  reports role/key access and no credential; `/v1/users` is owner-only; an owner
  mints/lists/revokes an invitation and a redeemer cannot escalate; a shared
  member sees the owner's published provider while an own member does not; a
  member's own provider stops the fallback; each account's file root is
  `<volume>/<userId>` and `POST /v1/roots` is `roots_fixed`; a note is shared,
  read, imported and revoked while a third account gets 404; refresh pushes an
  edit; a user cannot share a resource they do not own; an asset shares by
  conversation id.
- `core/test/users/invites.test.ts` (**4**) — hash-only storage, single-use
  consume, expiry on an injected clock, the loopback mint default.
- `core/test/sharing/sharedAccess.test.ts` (**3**) — publish/read/prune of
  provider keys, search keys dropped when no longer published, disabled search
  not published.
- `web/test/account-api.test.ts` (**7**) — the client's request shapes, tolerant
  sign-out, no token in any URL, the share body.

Existing files updated deliberately: `core/test/http/signup.test.ts` (the invite
manager replaced the in-memory secret double; the code is now 64 hex chars; a
wrong code is `unknown` rather than a guess-lock; the owner-mint lane redeems
with `SIGNUP_MODE=off`), and the six `SCHEMA_VERSION` tripwires (22 → 23).

## 2. The browser walk (measured, not asserted)

A LOGIN-mode core was booted on `127.0.0.1:4399` serving the built SPA, with a
`FIXED_ROOTS` volume and two accounts (`0`/owner, `ama`/member+shared). Driving
a real Chromium via the browser tool:

1. **Sign in** as `owner` → workspace.
2. **Members** → the account card (`owner · Configures their own providers`),
   the **Invite someone** card (Role = *Member — own space, uses shared access*,
   AI access = *Use this Partner’s access (no key needed)*), the **Invitations**
   list, and **Shared AI access** (*Nothing is published yet…*).
3. **Create invitation link** → a real single-use link
   `http://127.0.0.1:4399/#signup=<64 hex>` is rendered under *Send this to them
   (single use)* with a Copy link action.
4. **Shared** → the *Share something of yours* composer (What / Note / Share
   with), *Shared with me* and *Shared by me*.
5. The **desktop pairing shape** was walked too (a demo core): the Members view
   shows the *This device → Sign out* card instead of an account, and the
   sidebar footer's **Sign out** is present at both shapes.

Proof frames: the `m29-ui` checklist (`signout`, `members`, `shared`, `invite`
all proven, then audited) — evidence images under the browser artifact
directory for that session.

**What the walk found:** the pairing-mode Members view first rendered a
permanent "Loading your account…" because `GET /v1/account` answers `{user:null}`
on a paired core; it now renders a *This device* card with the sign-out action.
Fixed before the release.

## 3. Decisions taken beyond the spec's letter

1. **`SIGNUP_MODE` no longer gates redemption.** It governs only the loopback
   operator mint (`POST /v1/signup/code`), which stays the way to create the
   FIRST account. An owner-minted invite redeems in login mode regardless — the
   feature is "no console", and requiring an env change would put the console
   back in the loop. The security argument is that only an authenticated owner
   (or the loopback operator) can produce an invite at all.
2. **A duplicate name no longer burns the invite.** M22 spent the code before
   the duplicate check; M29 refuses shape errors AND a taken name first, so an
   owner can re-send the same link. The remaining race (two sign-ups with one
   code) is closed by the conditional consume, and the loser is refused.
3. **A shared asset imports as a topic-tagged note.** Assets are bound to a
   conversation the grantee does not own; a note is the durable, linkable home
   for the copy, and the provenance line says so. The shared READ view keeps the
   asset's own kind/title.
4. **Per-user roots are `<volume>/<userId>` for every account, including the
   first.** Keeping the first user at the volume root would let the owner see
   every other account's directory — the exact cross-user access the request
   forbids. The cost (moving existing files once) is documented in
   `docker/server/README.md`.
5. **No cross-partition read path exists for shares.** The snapshot design means
   `readOwn` only ever opens the CALLER's partition; a share to someone else's
   resource id is a 404, and a signed-out owner's copies stay readable to the
   grantee. That is a deliberate trade (freshness for isolation + liveness), and
   "Update copy" is the explicit way to push an edit.

## 4. Container + Windows package

- `docker/server/stage.sh` (or `stage.ps1` on Windows) → image
  `partner-server:local` → `docker compose up -d --force-recreate partner` →
  container healthy, public host answering, `/data` volume intact.
- The Windows NSIS package was built via the repo's `shell/windows` script (see
  the release commit for the exact artifact). Per M13/M15 precedent the packaged
  *live walk* is env-gated; the build itself is green.

## 5. What is NOT verified

- **A live model turn through shared access.** The provider fallback is proven at
  the configuration/list/key level (HTTP tests) and the key is read from the
  deployment keychain, but no real endpoint was called with a member's shared
  provider — there is no endpoint in this workspace. Same for shared search.
- **A second real user provisioning end to end in the container.** Two users are
  proven in-process (`m29Lifecycle`), and the container was refreshed, but this
  session did not create a second container account and sign in as them.
- **The packaged (NSIS) live walk** — env-gated, as for M13/M15/M16/M28.
- **A phone-tier walk of the new views.** They are in the More sheet and render
  at desktop width; the phone geometry was not re-measured for these two pages.
