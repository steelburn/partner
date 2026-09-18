# PLAN-M29 — the multi-user lifecycle

Companion to `PLAN.md` §15 (milestone index), `PLAN-M22.md` (the hosted account
lane this builds on) and `docs/VERIFY-M29.md` (the measured record).

Five requests, all about a hosted Partner with more than one person on it:

1. **Sign out.**
2. **An owner creates an invitation without touching the console.**
3. **An invited user can use Partner without configuring their own provider and
   search key — depending on the role chosen when inviting.**
4. **Users have their own file path; one user cannot interact with another's
   files.**
5. **Notes and assets can be shared with other users.**

The shape M22 left behind is the starting point: `AUTH_MODE=login` authenticates
a *user*, each user owns a whole-file-encrypted partition under `data/users/<id>/`,
and the only ways to create an account were `tools/user.mjs add` (the operator
types the passphrase) or a loopback-minted, deployment-gated invite. Every one of
the five asks above is a step further from "one operator on a shell".

---

## 1. Sign out — `POST /v1/auth/signout`

`DELETE /v1/session` already revoked the presented session, but nothing on a
login core closed the *partition*: after a sign-out the key could still sit in
memory (and an open SQLite handle keeps decrypted pages in its cache), so
"signed out" was weaker than it sounded.

The new route runs in the **gateway** (before per-user delegation, so it answers
even when the caller's partition is already locked):

- revoke the presented session (the token stops resolving immediately);
- call `onSignOut(userId)`, wired in `index.ts` to `rails.close(userId)` — which
  stops the user's scheduler, closes the database handle and locks the key vault;
- audit `auth.signout` with the session id only.

Client: `web/src/lib/account.ts#signOut` is tolerant of a 401 (already gone =
success). UI: a **Sign out** control in the sidebar footer (icon-only on the
managed rail), a card in the Members view, and the Members view itself on the
phone More sheet. On a paired desktop the same button is an unpair.

## 2. Owner-minted invitations

### Roles

`users.role` (`owner` | `member`) and `users.key_access` (`own` | `shared`)
arrive as guarded additive columns (defaults `owner` / `own`, so an existing
account keeps exactly its old reach). The first account on an empty core is
always an owner — a deployment can never be left with nobody able to invite.

### Invites

A new `invites` table (system DB) stores `id`, the code's **SHA-256**, the
`role` and `key_access` the redeemer gains, who minted it, and its expiry. The
code itself exists only in the mint response.

| Route | Who | Behaviour |
|---|---|---|
| `POST /v1/invites` | owner | mint; returns `{ id, code, url, role, keyAccess, expiresAt }` |
| `GET /v1/invites` | owner | list with `state: pending\|used\|expired` — never a code |
| `DELETE /v1/invites/:id` | owner | revoke |
| `GET /v1/users` | owner | the account list (id/label/role/key access) |

`POST /v1/auth/signup` reads the invite ROW, so a redeemer cannot escalate by
putting `role: 'owner'` in the body. Two ordering decisions, both deliberate:

- **Shape errors and a taken name are refused BEFORE the invite is spent**, so a
  mistyped passphrase or a duplicate name does not burn the link (an owner can
  re-send the same URL).
- **Redemption is one conditional UPDATE**, so two concurrent redemptions of one
  code cannot both create an account; the loser gets `401 invite_failed`.

`SIGNUP_MODE` still governs only the **loopback operator mint**
(`POST /v1/signup/code`), which remains the way to create the FIRST account on a
fresh deployment. An owner-minted invite redeems regardless: it is an explicit,
authenticated admission decision, and requiring an env change would put the
console back in the loop this feature exists to remove.

## 3. Shared AI access — the invited user needs no key

An account created from an invite is empty: no provider, no search key. Handing
one over means the operator leaks a credential and the member holds it. Instead
the owner **publishes** their configuration once:

- `PUT /v1/shared-access` (owner) snapshots the owner's own provider list +
  search config into the system DB's `shared_access` rows, and copies the SECRETS
  into the deployment keychain under `shared-provider:<id>` /
  `shared-search:<provider>`. `DELETE` withdraws everything (rows and keychain
  entries); `GET` reports status and `canManage`.
- A member whose user row says `keyAccess: 'shared'` gets a read-only fallback in
  their own `ProviderManager`/`SearchManager`: the published providers appear in
  `list()` **only while the member has none of their own**, and a published key is
  read from the deployment keychain rather than the member's. `keyAccess: 'own'`
  accounts see nothing shared.

So the invite's `key_access` choice is the whole difference: "member, shared" can
chat and search immediately; "member, own" configures their own providers.

## 4. Per-user file paths

`FIXED_ROOTS` was one mounted volume that every user saw as the same directory —
the opposite of isolation. On a partitioned core (`config.userId` set), each
account's roots are now derived and created at boot:

- with `FIXED_ROOTS=/files`: the account's root is `/files/<userId>`;
- with no `FIXED_ROOTS`: the account's root is `<partition>/files`.

The roots surface is **read-only in login mode** (`rootsFixed: true`), so a member
cannot add a path that escapes their area, and `POST`/`DELETE /v1/roots` answer
403 `roots_fixed`. Desktop (pairing) mode is untouched.

**Cost, stated:** an existing deployment's files at the volume root are not
visible to any account after this change; they move to `/files/<userId>`. The
volume is preserved, but the owner must move their files once (documented in
`docker/server/README.md`).

## 5. Sharing notes and assets

A share is a **snapshot copy** in the system DB (`shares`): the owner's note/asset
content is copied at share time and can be refreshed. That is the design's load-
bearing choice, not an implementation shortcut:

- a live cross-partition read would undo M22's structural isolation ("two users
  never open the same database") and would stop working the moment the owner
  signed out (their key leaves memory);
- a copy stays readable while the owner is offline, which is what "I sent you
  this" should mean.

| Route | Who | Behaviour |
|---|---|---|
| `POST /v1/shares` | any user | snapshot one of THEIR OWN notes/assets to a named account |
| `GET /v1/shares/sent` · `GET /v1/shares/received` | any user | lists (no bodies) |
| `GET /v1/shares/received/:id` | grantee | the copy WITH its body |
| `POST /v1/shares/:id/refresh` | owner | push the current content into the copy |
| `POST /v1/shares/:id/import` | grantee | save it into their own notes |
| `DELETE /v1/shares/:id` | owner | revoke |

`readOwn` opens the CALLER's partition, so naming someone else's note id is a 404
(their partition has no such row), and a third account asking for a share that is
not theirs is a 404. Assets are shared by `conversationId` + asset id (assets are
conversation-scoped); an imported asset lands as a topic-tagged note, because the
grantee does not own the source conversation.

## Schema (v22 → v23, additive)

- `users.role TEXT NOT NULL DEFAULT 'owner'`,
  `users.key_access TEXT NOT NULL DEFAULT 'own'` (guarded `ensureColumn`).
- `invites`, `shares`, `shared_access` tables (`CREATE TABLE IF NOT EXISTS`).

A v22 database opens unchanged and reads as it did.

## Exit

- [x] Sign out revokes the session AND closes the partition; a paired desktop's
      unpair is unchanged.
- [x] An owner mints/lists/revokes invitations from the app; a non-owner is
      refused; the redeemer cannot escalate role or key access.
- [x] A `keyAccess:'shared'` member sees the owner's published provider and
      search without configuring anything; an `'own'` member does not; a member
      who configures their own stops riding the shared one.
- [x] Each account gets its own file root under the deployment volume, and the
      roots surface is read-only in login mode.
- [x] A note and an asset can be shared with another account, read, imported and
      revoked; nothing unshared is reachable through the share surface.
- [x] Suites green, typechecks 0, web build green, `ux_audit` PASSED, a live
      browser walk against a login-mode core, container refreshed, Windows
      package built.
