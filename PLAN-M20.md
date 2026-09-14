# PLAN-M20 — Partner as a client-server product (mobile first)

Status: **all gates closed (D1–D5 + §12) 2026-09-12.** M20.A is implemented and
measured; M20.B (the server role) is scoped into executable slices — see
`PLAN-M20-B.md`, whose §6 carries the decision for every gate. No code is implied
by this document beyond what M20.A shipped.

> **Reconciled 2026-09-12 (twice).** This line first read "decision gates D1–D4
> open", contradicting `PLAN.md` §15 and `README.md`, which recorded those as
> locked — flagged by a scout pass. It then read "D5 and §12 Q1–Q11 open", which
> was accurate until the owner directed that the blockers be cleared. **Every gate
> now carries a decision** (§11, §12, `PLAN-M20-B.md` §6), each with its
> consequence stated. Four (⚠ D5, Q2, Q4, Q11) land on how the product is *used*
> and are marked so they can be revisited deliberately.

Scope: the client-server architecture mobile requires, the multi-user /
multi-device partitioning that follows from it, then the mobile clients.

Read with `PLAN.md` (§3 surfaces, §4 architecture, §11 security, §12 data
model, §13 API, §14 stack), `DESIGN.md`, `PLAN-M12.md` (responsive pass that
deliberately stopped at ~780px).

---

## 1. Framing: Partner is already client-server

The core is a server; `web/` and `extension/` are clients. What mobile
requires is not *a* client-server architecture but a **remote, multi-device,
multi-user server role** — one the core currently refuses **by construction**,
because every security control was tuned for a localhost client on a
single-user machine.

Three additions, only the first obvious:

1. **Transport & reachability** — TLS, a named reachable-host allowlist,
   discovery or NAT traversal. (`core/src/config.ts:104-118` throws on any
   non-loopback `HOST` in live mode; `:146` allowlists only
   `127.0.0.1:<port>` / `localhost:<port>`.)
2. **Client-class authorization** — the core authorizes against *the person at
   this machine*: project roots, file tools, deploy profiles, OS keychain. A
   remote client inherits that authority wholesale. A phone session must not
   carry file-write or deploy authority by default.
3. **Availability** — a server implies someone is always on; a desktop sleeps,
   reboots and updates. A product decision, not a code one.
4. **Sensitivity** — user configuration and data (provider keys, memory about
   the person, notes, chat, generated artifacts) is the most sensitive class
   this product holds. It is not a caveat on the design; it is a constraint
   that **reorders the options** in §3/§4 and makes several items below
   mandatory rather than recommended (see §8.1). Where sensitivity and
   convenience conflict, sensitivity wins.

**The core cannot run on a phone** (Node 22 + `better-sqlite3` native module +
OS keychain + real project roots + MV3 extension). The phone is always a
client of a core that runs elsewhere — which is why this is a server
milestone, not an app milestone.

## 2. Verified starting point (2026-09-12, HEAD `a9816e7`)

### 2.1 The locality assumption is load-bearing (and must be reclassified)

```
core/src/http/server.ts:298   originOf(req) = String(req.headers.host).toLowerCase()
core/src/http/session.ts      validate(token, origin) → rejects 'origin_mismatch'
core/src/config.ts:146        hostAllowlist = ['127.0.0.1:<port>', 'localhost:<port>']
```

On loopback this is a genuine control: only local processes can connect and
the allowlist pins the `Host` header. **Remotely, `Host` is client-supplied** —
so `origin_mismatch` stops being a security boundary and becomes a lookup key.
TLS/SNI + the bind allowlist become the actual controls. This must be stated
in `PLAN.md` §11, or the model will read stronger than it is.

### 2.2 The device registry is ~80% already built

`SessionRow` (`core/src/stores/types.ts`) already carries what a device list
needs; `touch()` and `revoke()` exist (`core/src/http/session.ts`):

```ts
{ id, tokenHash, kind, origin, createdAt, expiresAt, lastSeenAt, revokedAt }
```

Missing: a device identity (`kind` is the literal string `'web'`, minted at
`server.ts:1264`), a label/platform, a `user_id`, **token rotation/refresh**
(today one 30-day bearer, no refresh), and a surface to list/revoke.

### 2.3 Isolation today is per-**OS user** — i.e. Partner is already multi-user

```
core/src/keychain/dbKey.ts   service 'partner', account 'db-key' (one key per OS user)
  "…the DB cannot be decrypted by another OS user or by copying the DB file off the machine"
core/src/config.ts:154       skillsDir = join(dirname(dbPath), 'skills')
PLAN.md §11                  "OS profiles are separate Partner profiles: distinct
                              keychain items, DBs, skill stores. Installed skills
                              are never shared between profiles."
```

One OS user → one DB + one whole-file cipher key + one skills dir, **zero
shared state**. This is the fact that makes §4 cheap: the desired partitioning
already exists, one level up.

### 2.4 Other verified facts that shape the work

| Fact | Where | Consequence |
|---|---|---|
| SPA is same-origin, no API base URL | `web/src/lib/api.ts` header comment | A native shell or hosted core both need an explicit configurable base — pay once, keeps D1/D2 independent. |
| Token in `localStorage`, bearer-only, never in URLs/cookies | `web/src/lib/token.ts` | Bearer avoids CSRF; a lost phone holds a 30-day credential → short remote TTL, rotation, revoke, native keystore. |
| 38 tables, schema v16, guarded `ALTER` migrations | `core/src/stores/db.ts` (`CREATE TABLE` ×38), `PLAN.md` §12 | Decides the §4 fork: partition by database, not by a `user_id` column on 38 tables. |
| Core serves the built SPA (`STATIC_DIR`) | `core/src/http/server.ts:1180` | Phone loading the SPA *from the core* keeps every call unchanged — but see §7 on secure contexts. |
| M12 stopped at ≈780px; ≤640 keeps a **200px rail** | `PLAN-M12.md:139`, `app.css:6326` | 375–430px is unusable. The layout phase is a re-architecture, not a tweak. |
| Extension is desktop-MV3 only | `extension/`, `PLAN.md` §4.5 | Browser-actuator research/search unavailable on mobile; share-to-Partner replaces it. |
| No Partner cloud, by design | `PLAN.md` §16 | No server push; notifications are polling or user-hosted Web Push. |
| Degraded "session-only" chat already specified | `PLAN.md` §3 | Free mobile story: borrowed phone, in-memory key, no local tools. |
| Shell crate reserves `cdylib`/`staticlib` "for future mobile targets" | `Cargo.toml:9-11` | Tauri v2 mobile is the intended native path. |

## 3. Primary fork: where the single source of truth lives (D1)

| | **Model A — desktop authoritative** | **Model B — core is a hosted service** |
|---|---|---|
| Source of truth | this desktop's core | an always-on core (user-hosted) |
| Phone is | a guest of the desktop | a first-class client |
| Desktop is | the server | **also a client** |
| Adds beyond transport + device registry | client-class authz | + per-user secret store without an OS keychain (§4.4), cert/domain lifecycle, SPA off same-origin |
| Sync | none | none — one core, several clients |
| File tools / project roots | unchanged (desktop holds the roots) | **broken**: a server core cannot see desktop files → needs a *desktop agent* talking to the server, a **second client-server link** |
| Availability | "partner offline" while the desktop sleeps | always on |
| Browser actuator | unchanged (desktop-local extension) | needs the desktop agent to carry it |

**Model C — per-device cores + sync.** CRDT/sync engine, secret replication,
per-device roots, conflict semantics. **No**, not in v1.

**Recommendation: Model A first** — preserves local-first, no sync, desktop
stays the trust anchor. Model B is the honest target *if and only if* "my
partner is available whenever I open my phone" is a hard requirement — in
which case the desktop agent is its own workstream, not a detail.

### 3.1 Model A′ — the hybrid: split by trust tier, not by location

**Constraint first, because it bounds the design space.** For the *same bytes*
you cannot have both "the server holds no key that opens the data" **and**
"the server processes that data while the user is away": if the server must
compute over plaintext in the user's absence, a key that opens that plaintext
must be present in the user's absence. That is information-theoretic, not an
implementation gap. Every viable compromise therefore narrows **which bytes,
for how long, under whose key.**

**Two roles, two key scopes — one core stops being one trust domain:**

| | **Vault** (Model A role) | **Runner** (Model B role) |
|---|---|---|
| Where | the user's own machine | always-on (NAS / Pi / mini-PC / VPS) |
| Holds | the **user key** | only a **job key** |
| Owns | **Tier C** — memory/profile, notes, chat, attachments, provider keys, project roots | **Tier W** — schedules, briefcases, run outputs, spend ledger |
| Available | when the user is present | always |
| Blast radius if compromised | everything (it *is* the vault) | **briefcases only** |

**No new crypto — it is the existing mechanism applied twice.**
`ensureDbKey` (`keychain/dbKey.ts`) + `openEncryptedDatabase`
(`stores/db.ts:827`) + the demo/live switch (`index.ts:650-654`) already do
whole-file keyed databases, and every store factory already takes a `db`
handle. Two tiers = **two files, two keychain accounts** (`vault-key`,
`runner-key`) and a subset bundle per role. This is §4.1's per-user partition
extended: partition by **trust tier** as well as by user.

**Mechanism — the briefcase.** A pre-authorized, bounded, expiring, read-only
snapshot prepared *while the user is present*: only the inputs a schedule
needs (schedule prompt, allowlisted profile facts, selected notes, non-secret
persona config, tool allowlist, budget cap), with enforced item/byte caps and
a short TTL (hours). Caps are load-bearing — an unbounded briefcase is just a
copy of the DB and silently becomes Model B. It is **legible**: the user is
shown "the runner can read these 12 notes until 09:00 tomorrow", which is the
transparency discipline of `PLAN.md` §8 applied to keys.

**Mechanism — the one-way valve.** The Runner cannot write Tier C (it has no
key), so outputs land encrypted in Tier W and the Vault **drains** them at the
next unlock: decrypt, validate, integrate, delete from Tier W. Two benefits:
memory writes can only land at a user-present moment, so **M19 automatic
remember cannot silently write while the user is away** (it surfaces as "3
scheduled results waiting to be integrated"); and every headless artifact
passes a human checkpoint before entering the sealed tier.

**Key handling, ranked:**

| | Approach | Security | Availability |
|---|---|---|---|
| i | **Desktop-mediated unlock** — Vault hands a time-boxed key at fire time | Best: zero standing plaintext | Weak: desktop must be awake/reachable |
| ii | **Job-key briefcase** (above) | Good: compromise leaks briefcases only | Full: desktop may sleep |
| iii | **TPM/DPAPI-sealed server key** | Stolen DB backup useless; a software-level attacker *on the box* can still invoke the TPM | Full |

**Recommended: (ii), with (iii) composable as defense-in-depth.** Threshold /
split-key crypto is rejected: it breaks the asynchronous case it exists to
serve, for complexity not yet needed.

**What A′ buys:** schedules run with the desktop asleep (B's actual benefit) ·
no CRDT/sync engine and no per-device cores (C stays rejected) · the operator
never holds a key to the user's private data (the §1.4 objection to B is
resolved, not accepted) · client-class authorization gets a natural home — the
Runner's class simply has no Tier C capability.

**Honest costs, recorded so they are not discovered later:**
1. Briefcases must be prepared in advance → a run can only use pre-authorized
   data. A genuine limitation, and simultaneously the property that makes the
   boundary legible.
2. **Drain requires id remapping** — scheduled conversations, messages and
   blobs live in `runner.db` until drained (insert-into-vault +
   delete-from-runner + audit row). Real work.
3. **Two audit streams** (runner + vault) must reconcile on drain.
4. **Node cannot reliably zero memory** (GC copies strings); `mlock`/
   `VirtualLock` + disabled core dumps are partial mitigations. Do not sell
   "decrypted in memory" as airtight.
5. The job key remains usable by an attacker **on the Runner** → keep TTLs
   short.

**Deciding factor:** whether the always-on Runner is the **user's own second
machine** or a **shared VPS**. User-owned → operator == user, so the
"operator can read everything" objection disappears and A′ becomes simple and
strong. Shared VPS → briefcase scoping is load-bearing and (iii) earns its
keep.

## 4. Partitioning: users, devices, system config (D4)

**Requirement (user-set):** every configuration that exists today stays
**individual** per user; **system-wide** configuration exists as a deferred
layer.

### 4.1 The fork: partition by database, not by column

| | **Option 1 — per-user partition** | **Option 2 — one DB, `user_id` everywhere** |
|---|---|---|
| Layout | `data/users/<userId>/partner.db` + one cipher key per user + per-user skills dir | one `partner.db`; `user_id` on 38 tables |
| Isolation | **structural** — a query cannot leak across users; there is no cross-user query | enforced by discipline in every store + every query, forever |
| Encryption | one whole-file key per user (already the model, §2.3) | one key for all users; a single bug is a cross-user disclosure |
| Existing code | stores, migrations, FTS, backups untouched | every store signature + migration + test churns |
| Cross-user queries | need aggregation across DBs (admin views — *later*, per the deferral) | cheap |
| Cost | a per-user connection/manager pool | 38-table churn now + permanent blast radius |

**Recommendation: Option 1.** It is not a new design — it is §2.3 generalized,
so it inherits the existing security argument verbatim. Free consequences:
`skillsDir` already derives from `dbPath` (`config.ts:154`) and chat
attachments already live in `chat_blobs`, so **both partition automatically**
once `dbPath` does.

### 4.2 Three levels — and multi-device stops being a separate feature

| Level | Is | Reuses |
|---|---|---|
| **User** | the data partition: DB, cipher key, provider keys, skills, personas, memory, notes, grants, project roots, audit | **new** (`users` table) |
| **Device** | a credential *belonging to a user*: label, platform, last-seen, rotation, revoke | `SessionRow` already has `lastSeenAt` / `revokedAt` |
| **Client class** | capability envelope: `desktop` / `mobile` / `extension` | `kind` (today the literal `'web'`) |

Device = session ⇒ **once a session carries `user_id`, multi-device is
automatically per-user.** No separate device model is needed.

Consequences to hold:
- Keychain items (DB key, provider keys) are **namespaced per user**, not just
  per service. `dbKey.ts`'s account becomes user-scoped.
- `spend_ledger` is per user (rolling windows are user data).
- Audit is per user, **plus** a separate system audit for admin actions.
- **No cross-user sharing in v1**: skills, personas, themes, and notes stay
  private to their user — consistent with `PLAN.md` §11 ("installed skills are
  never shared between profiles"). Sharing is a *later* system-layer feature,
  never a default.

### 4.3 System-wide configuration — scope it now, build it later

The requirement is "for later", so the deliverable now is the **seam plus a hard
boundary**, not the feature. Build: one `systemConfig` read path that is
*separate from every user store* and holds only today's machine/service-level
values. Defer: admin UI, policies, quotas, sharing.

Belongs system-wide (never user content, never per-user values):

- bind host + **named** allowlist, port, remote-access on/off
- TLS cert/domain lifecycle, certificate paths
- mDNS announce on/off, update channel, log level
- which **client classes** are permitted at all
- per-user **ceilings** (budget cap, token cap, storage cap) — a limit, not a value
- notification transport / VAPID keys, if D3 ever adopts Web Push
- schema/partition root layout (`data/users/…`)

Two rules that prevent the classic multi-user regression:

1. **A system-wide default is copy-on-read**, materialized into the user's
   store on first use — never a live shared row. Otherwise an admin changing a
   default silently mutates every user's behaviour ("why did my theme move?").
2. **System config is local/admin-only.** It must never be writable from a
   remote user session, and never readable by one — this is the first concrete
   consumer of the client-class envelope (§1.2, §8).

### 4.4 The genuinely hard part — and it is the same question as D1

> **Superseded by §3.1 (Model A′) in the recommended design.** With the user
> key held only by the Vault and a separate job key on the Runner, the server
> never holds a key to Tier C — so neither the operator-readable envelope nor
> the loss of headless schedules is necessary. **This section applies only if
> A′ is rejected** and a single-host core must serve absent users.

A desktop core can hold per-user DB keys as separate OS-keychain accounts:
trivial. **A headless server core has no per-user OS keychain**, so it needs
one of:

- **(a) Envelope.** A server master key (OS keychain, service account) wraps
  each user's DB key; the user key is unwrapped into memory only while that
  user has an active request. Requires trusted key material in the running
  process. *Honest downside: the OS user running the core can decrypt every
  user's DB — defensible only where the operator **is** the user (a family
  machine, a personal server). For anyone else it is an unacceptable weakening
  of a dataset that is precisely the user's private life.*
- **(b) Passphrase-derived.** Each user's DB key is derived from something only
  they hold; the server **cannot** decrypt at rest. Strongest, but breaks
  headless scheduled runs (M14) and anything that must work while the user is
  absent — it trades directly against §1.3 availability.

The consequence must not be buried, because it is decision-relevant:

- Under **(b)**, any work that must run while the user is absent — **M14
  headless scheduled runs**, autonomous personas, background research — **stops
  working** unless the user's key is present.
- Therefore **Model B is in direct tension with the sensitivity requirement
  (§1.4)**, not merely larger than Model A: choosing it means accepting either
  an operator-readable store **or** the loss of the always-on behaviour that
  motivated B in the first place.
- **Model A + per-OS-user keychain (§2.3)** satisfies both needs, and **§3.1
  (A′) satisfies both while still running schedules while the desktop
  sleeps** — which is why A′ is the recommendation and this fork is the
  fallback.

## 5. Secondary fork: what the mobile client is (D2)

Downstream of D1/D4 and largely reversible.

1. **Mobile web** — the existing SPA re-architected for phone widths.
2. **Installable PWA** — (1) + manifest/icons/standalone + offline shell.
   **Needs a secure context** (§7), so not free.
3. **Native shell** — Tauri v2 mobile wrapping the *same* SPA: secure token
   storage, biometric lock, share-target, camera, local notifications.

Non-negotiable either way: the SPA gains an explicit **configurable core base
URL** — required by both a native shell and a hosted core, and the seam that
keeps D1 and D2 independent.

## 6. Phases

### M20.A — Mobile web layout (no core change) — *independent of D1/D2*
**State: implemented + measured 2026-09-12** (`docs/VERIFY-MOBILE.md` is the
verification record). Developed against `localhost` (already a secure
context).

Delivered: phone bottom tab bar (4 primary + More sheet) driven by a testable
nav model (`web/src/lib/nav.ts` + `nav.test.ts`, which asserts the phone
surface reaches every view exactly once — a view could otherwise become
unreachable on a phone while every type-check stayed green); rails become
overlays; full-width transcript and composer; `100dvh` + safe-area tokens +
`viewport-fit=cover` viewport meta; a 44px touch-target floor with no-hover
reveal for the row actions; additive touch/safe/viewport tokens in
`shared/src/theme.ts` (no existing value changed).

- **Navigation:** bottom tab bar (Chat · Notes · Files · More); conversation /
  notes / assets rails become **overlays**, never columns.
- **Chat:** transcript-first, composer pinned and keyboard-safe (`100dvh` +
  `visualViewport`, never `100vh`); M12.6's in-chat approval card
  (Approve/Deny + `continueTurn`) becomes the primary mobile interaction.
- **Touch contract:** ≥44×44px targets, `:active`/pressed on every control
  (hover may never be the sole affordance), `env(safe-area-inset-*)`, no
  horizontal scroll ≥320px.
- **Priority:** chat, conversations, notes capture/read, files approvals,
  persona picker. Memory, providers, skills, theme studio, audit, notes graph
  **reachable but desktop-first** (graph editing on a phone is an explicit
  non-goal).
- **Media profile:** documented mobile profile in `DESIGN.md` + assertions in
  `shared/src/theme.ts` tests. **No existing token values change.**

*Exit:* geometry gates at 430/390/375/360 (mirroring M12's gate style at
1440/1280/1024/900/780) · touch-emulated Playwright pass (`hasTouch`,
`isMobile`) · keyboard-open composer not occluded at 430×740 · `ux_audit`
green on every new component (light + dark) · existing web suite green.

*Measured:* composer **28→296px @360**, **58→326px @390**, **98→366px @430**;
permanent chrome **252px→0** on phone; transcript **122→390px @390**; controls
under 44×44 **11→0** on phone and **0** inside the rail overlay (delete row
action **1×19→74×44**); `overflowX` 0 throughout. Tablet 768/1024 geometry
**byte-identical** to before (composer 368/584 with the rail open), so the
pass is additive above the phone tier. `ux_audit` **PASSED** (12 APCA pairs
light+dark, tokens, states, slop tells). Root suite 893 · web **547** (+6) ·
typecheck 0 · web build green.

*Open (recorded, not claimed):* no visual inspection was performed (the
session model is text-only, so render-and-inspect was skipped by design) · the
`@media (hover: none)` branch is authored but **not runtime-exercised** (the
browser reports `hover: hover`, `pointer: fine`, `maxTouchPoints: 0`) · no
real-device walk, so safe-area insets and on-screen-keyboard behaviour are
unproven · the whole-file `ux_audit` run is outstanding (176KB payload) · the
geometry probe is a recorded manual pass, not a CI gate (the web suite is
Node-only). **Capability gap — CORRECTED, there was none:** I claimed that
removing the drag handle left conversation re-filing with no touch path. That
was wrong: `.rail-item-move` is a `<select aria-label="Move … to folder">` and
the `(hover: none)` rule reveals it (measured 66×44 in the phone rail), so
dragging was never the only path and nothing was built for it.

### M20.A follow-up — persona cards, chat composer, attention (same session)
**State: implemented + measured 2026-09-12.** Three things the first pass did
not reach, all found by measuring rather than assuming:

- **The composer was still unusable — and my earlier claim was wrong.**
  "Composer 326px" was the *container*; the **message field** was **49px**
  (15% of the row) because the `＋ Attach` (109px) and `Send` (105px) text
  buttons took 214px. Now icon-only 44×44 controls and a 16px phone gutter:
  field **222px (62%)**. The field, not the container, is the number that
  matters — the gate now asserts it as a **share of the row**.
- **Persona cards** were 488–584px tall (~1.3 per screen) with a 247×285px
  identity head and a 183×78px action blob indented 96px, plus 52 controls
  under 44×44. Now **340px** cards (~2.5 per screen), head **263×129**,
  actions a single full-width **263×44** row, **0** sub-44px controls.
- **Attention badges.** Memory suggestions existed only as a count inside the
  Memory view, so a suggestion could sit unconfirmed indefinitely. New pure
  module `web/src/lib/attention.ts` (+18 tests) generalizes "waiting on you"
  across destinations; the **phone More tab carries the aggregate** of what the
  sheet hides (a badge on an item inside a closed sheet is invisible — the one
  notification that says "open the sheet" was the one that could not be seen).
  Verified end to end with seeded suggestions: More badge `3` → reject one →
  `2` immediately. **Design rule recorded:** a badge must be able to clear
  itself, so failed scheduled runs self-clear on a 24h window (they have no
  dismiss action), and `queued` runs are excluded everywhere because a paused
  run *is* the pending approval — counting both reports one event twice.

*Measured:* field 49→**222px** @390 · card height 584→**340** · Personas
sub-44px controls 52→**0** · `overflowX` 0 throughout. `ux_audit` **PASSED**
(18 APCA pairs, tokens, states, slop tells). Root 893 · web **565** ·
typecheck 0 · build green.

*Still open:* as above — no visual inspection, no real-device walk, no
background/OS notification delivery (poll runs only while the page is open;
that is the D3 "no notifications in v1" decision, and push is M20.B/C),
whole-file `ux_audit`, geometry not a CI gate. Plus: **no acknowledgement
model**, so failed runs can only self-clear on time; re-filing a chat between
folders on touch still has no affordance.

### M20.A follow-up 2 — Memory view (control cards, suggestions, entries)
**State: implemented + measured 2026-09-12.** The Memory view had the same
flex-crush bug as the composer, in three places, and had been **missed by
M12's legibility pass**:

- **Memory controls card 1483→1056px.** `.mem-control-text` is
  `flex: 1; min-width: 0`, and `min-width: 0` lets a flex item shrink *below*
  min-content — so the row never wrapped and the copy column collapsed to
  **9–11px (one character per line)**, with the Import row 411px tall. Rows now
  stack on phone; text columns 50/183/11/9 → **263px**, and the actions
  (including both irreversible ones) become full-width targets.
- **Entry rows: a 20px value column 399px tall.** My first fix attempt here
  **did not apply** — it targeted `.row-actions`, which only exists elsewhere;
  the real container is `.mem-actions` inside `.mem-row-meta`. Found by
  re-measuring, not by reading. The Profile card went 3501→**2429px**.
- **Suggestions: nested padding was the root cause.** 32+32+24+24 = **112px per
  side (57% of a 390px viewport)** left a **135px** measure, which is also why
  Confirm/Edit/Reject stacked into a 148px column and one suggestion ran 450-471px.
  Flattened to one 16px gutter per level (8px grid): measure **263px**,
  suggestion **293px**, actions one 44px row.
- **Legibility floor:** `.mem-privacy`, `.mem-evidence`, `.mem-row-meta`,
  `.mem-chip`, `.mem-tag-inuse`, `.mem-cap-note`, `.mem-control-copy` were still
  12px; now 14px, matching Personas. The 12px step is the context-label step.

*Measured:* Memory view total 5436→**4075px (−25%)** while the text measure
nearly doubles (135→263px) and sub-44px controls go **12→0**; `overflowX` 0.
`ux_audit` **PASSED** (18 APCA pairs).

**Contrast margin to watch:** the destructive label `--danger` on the light
card surface passes at **Lc 75.42** against a floor of 75 — barely. If the
`--surface` or `--danger` token is ever retuned, this pair fails first.

**Reorder APPLIED** (at the user's direction, after this section was written):
the rendered order is now **Export → Import → Forget before a date → Forget
everything** — portability first, destructive last, severity escalating — with
all danger-coloured rows inside `.mem-danger-group` and 32px of space above it
(space → background shift → elevation, before a border). Card 1056→1072px at
390px. No group heading was invented: the danger colour and the arm/confirm
pattern already carry the signal, and a kicker there would be the tracked-out
eyebrow the design system bans.

*Open:* as above. Specifically for this pass, the **two irreversible actions
were measured but never pressed**, so the arm/confirm flow is verified as
rendered and touch-sized, not as behaving — they stay on the manual checklist.

### M20.A follow-up 6 — one submit per question set (grouped answers)
**State: implemented + verified end to end 2026-09-12.** Reported bug: a reply
carrying a radio/choice **and** a set of free-text questions rendered two cards
with two independent submits (**"Confirm"** and **"Submit answers"**), and
pressing either sent only its own answer — the other question set was silently
discarded while the two buttons sat side by side as if unrelated.

Cause: `PartnerMarkdown` renders each structured block as its own segment, and
each card owned its own submit, validation and draft clearing. Nothing existed
at the *message* level — the only level that can see that two containers were
asked in one breath.

Fix: `web/src/lib/answer-group.ts` (pure, 15 tests) owns the rule —
`shouldGroupAnswers(blocks)` is `answerableCount > 1`, so a **single-container
message keeps its existing card button unchanged** and the common case cannot
regress. `composeGroupedAnswer` joins each part with the exact string that card
would have sent alone, so nothing on the wire changes except that the parts
arrive together. `web/src/AnswerGroup.tsx` owns the single submit; the cards
render inputs only (`showSubmit={false}`) and report upward via
`onAnswerChange`. A grouped form requires every question (`requireAllAnswers`),
and once sent the group locks ("Answers sent", all inputs disabled) so one
prominent button cannot double-post.

*Verified through the real chat path* — the demo provider cannot emit
containers, so a throwaway loopback OpenAI-compatible stub returned a choice +
form, was registered as a provider, and the group was driven for real:
**1 group · exactly 1 submit · 0 per-card submits**, the gate walking
disabled→disabled→disabled→enabled with hints `2 → 1 → 1 → none`, and the single
press producing **one** user turn whose text carries **both** the choice and the
Q/A pairs.

*Open:* the answered-lock is **per page session** — whether a card was answered
is not persisted, so a reload makes an answered group answerable again (this is
the pre-existing behaviour of the standalone cards, unchanged here; a proper fix
needs a message-level answered marker). Grouped forms require every question
while standalone forms accept any non-empty answer — deliberate and documented
in the prop, easy to flip. The group was measured at 1280px; its phone rules
were audited but not measured. `ux_audit` PASSED (16 APCA pairs); web
565→**580**; root 901; typecheck 0; build green.

### M20.A follow-up 7 — danger-on-`--surface-2` sweep (DONE) + attachment-chip contrast
**State: implemented + gated 2026-09-12** (a first attempt at this lane failed to
produce any change — a forked worker continued the parent's reasoning instead of
executing; the `fresh`-context retry succeeded).

**16 selectors** across 10 rule groups were sitting on a `--surface-2` well with
light-mode `--danger` text at **Lc 69.52** against a 75 floor: the ghost
`.btn-danger` controls in `.theme-row` (ThemeStudio), `.mcp-server-row`
(McpPanel) and `.p-milestone` (PlansSegment), `.attach-chip-remove`, and the
`.row-error` / `.chat-attach-error` copy in those rows plus `.mem-row`,
`.compare-result` and `.n-graph-sessions`. All now rest on `--bg` → **Lc 80.88**
light / **−80.54** dark.

The full enumeration covers **all 38** `color: var(--danger)` rules: 16 fixed,
the rest already passing (traced to `--bg`/`--surface` grounds), 5 unreferenced
by literal, and one non-text hit.

**Two further pre-existing defects the gate found in the same chip, also fixed**
(token-only swaps): `.attach-chip-preview` accent on `--surface-2` at 12px =
**69.02** → `--accent-hover` = **77.08** (DESIGN.md M12 P0.3 names
`--accent-hover` for surfaces); `.attach-chip-meta` `--text-faint` on
`--surface-2` = **68.86** → `--text-muted` = **81.40** (faint is exempt for
disabled/placeholder only — a file size is neither).

**Method correction:** the sweep classified `.mem-chip-danger` and
`.skill-chip-danger` as dead because no literal reference exists. Both are in
fact **live**, reached through computed class names (`mem-chip-${tone}` with
`kindTone('rule') === 'danger'`); they pass only because the chip carries its own
`--bg` ground. **A grep for a class literal cannot prove a class is dead.**

### M20.A follow-up — persona picker on a phone (FIX, reported bug)
**State: implemented + measured 2026-09-13.** The persona list was unusable on a
phone while looking present in the DOM:

- **Cause.** The phone top bar is a horizontal scroller
  (`.app-topbar-right { overflow-x: auto }`), and `overflow-x: auto` makes
  `overflow-y` compute to `auto` too. The absolutely positioned `.picker-pop`
  therefore sat inside a scroll container: measured at 390×844 with the 9 demo
  personas it laid out **655px tall but painted only inside the bar's 60px
  band — 1 of 9 options visible**, and the open-time `focus()` on the first
  option scrolled the bar itself up **65px**, taking the trigger off-screen. It
  was reachable by scrolling a 60px window, which is why nothing looked broken
  in the DOM or in an overflow gate.
- **Fix (≤640 tier).** The list becomes the same **bottom sheet** as the More
  control: `position: fixed` (escapes the scroll box), full width, anchored on
  the tab bar (`bottom: calc(var(--bottom-nav-h) + var(--safe-bottom))`),
  `max-height: 60dvh` + `overflow-y: auto`, rows `flex: none` so the bounded
  panel scrolls instead of squashing rows under the 44px floor, and the scrim
  takes the More sheet's tint (the sheet covers 60% of the screen). Motion is
  `sheet-rise`, with `.picker-pop` added to the file's **top-level**
  reduced-motion list rather than a nested copy (the file's own note: nesting
  makes the guarantee depend on the nesting staying intact).
- **Second hole (any width).** A landscape phone (844×390) is **outside the
  width-based ≤640 tier**, so it got the absolute popover with no height bound:
  a 655px list ran off a 390px viewport. The base rule now carries a token-only
  `max-height: calc(100dvh - var(--topbar-compact-h) - …)` + `overflow-y: auto`.
  Desktop is unchanged (655px list < the bound).

*Measured after, with the real demo personas.* Fully inside the viewport and the
last option reachable at **360×640, 390×844, 844×390, 768×600, 1280×900**; rows
≥**71px** everywhere; the bar no longer grows (`scrollHeight` 715→**60**);
selection verified end to end (Researcher → `DP/Assist`), scrim tap closes, and
the reduced-motion fallback reports `animation-name: none`. New guard
`web/test/picker-mobile.test.ts` (**+7**) asserts the invariants from the
stylesheet text (base absolute + bounded, phone fixed + anchored + capped, rows
`flex: none`, motion fallback) and was **falsified** by reverting `position:
fixed` to `absolute`. `ux_audit` **PASSED** on the picker rules with 8 APCA pairs
(light `Active` on the selected `--surface` row Lc 82.97, dark −87.06; focus
rings 80.37 / −88.04). Web suite **635→642**; root 150 files / **1215 passed**
(+5 skipped); typecheck 0.

*Open:* the **whole-file `ux_audit`** (191KB payload — same acknowledged gap as
the M20.A entry above, so the picker region was audited rather than the file),
no visual inspection (this session was text-only: geometry was read numerically,
not seen), and geometry is still a **recorded measurement, not a CI gate**.

### M20.A follow-up — the top bar owns the chrome (Assets + Theme moved up)
**State: implemented + measured 2026-09-13.** Two reports in sequence, and the
second reversed the first — recorded in order, because both were measured:

1. **Reported:** "Assets seems redundant. There's one at the top, and another
   near chat input." Verified worse than two: **three controls, one action** (a
   top-bar icon, a labelled chat-bar button, and the in-pane chevron), the first
   two bound to the same handler/state, on screen at once **579px apart**
   (@390×844: 49×44 at y 8–52, 73×44 at y 631–675), and disagreeing on enabled
   state. The third reused the top-bar one's accessible name.
2. **Criterion given for the choice:** *maximise chat input width.* Measured —
   phone 390×844: input **222px with the pane open or closed** (the lane is
   `position: absolute`, an overlay, so it costs no width); desktop 1280×900:
   **682 → 366px (−316px, −46%)** when the pane opens. The pane is the only lever
   on input width, and the **top-bar** icon was the one control that could pull it
   with **nothing to show** — it was not gated on a conversation, and the pane is
   conversation-scoped (`listAssets(token, conversationId)`), so it opened a
   300px column rendering one line of placeholder copy.
3. **Owner's direction then settled it: "move Theme and Assets to top."** This is
   also the shell's own stated design — app.css M14: *"a slim top bar (persona
   picker + lane/theme controls)"* — so both controls live in the top bar and the
   row above the composer keeps only conversation-context (brainstorm state, the
   save flash), rendering **only when it has content**.

**Final state.** Top bar: persona · conversations · notes · **assets** ·
**theme (per conversation)** · mode. The assets toggle **keeps the conversation
gate** (`disabled={activeConversationId === null}`), so the 316px-for-nothing
path stays closed. `ChatStrip` lost 5 props (`assetsOpen`, `onToggleAssets`,
`themes`, `activeThemeId`, `onBindTheme`) and the `ThemeProfile` import;
`.chat-theme-label` / `.chat-theme-select` became `.topbar-theme-select`.

*Measured after (styled page, real demo store).*

| check | result |
|---|---|
| desktop 1280×900, conversation active | 6 controls, **523px** in a 1008px row, no scroll; theme select 111×25; transcript 655px |
| phone 390×844, conversation active | 6 controls, **318px** of controls in a 358px content row, **no scroll**, last control right edge 374 ≤ 390 |
| phone transcript | **513 → 565px** — the deleted row was 52px directly above the composer (gap is now the composer's own 34px padding) |
| assets toggle | `disabled` with no conversation, enabled with one |
| theme **bind**, proven end to end | choosing "Midnight" → select `preset-midnight`, and the choice **survived a reload** (re-opened the conversation: still `preset-midnight`) |

**The phone row needed one trade.** With the level chip, 348px of controls + 40px
of 8px gaps clipped the mode toggle by **14px**, and a partially cut control at
rest reads as broken rather than as a scrollable row. So
`.picker-trigger .picker-level` (31px + its 8px gap) is hidden at ≤640: it is the
one control whose information the picker sheet repeats for every persona.
**`Paused` is deliberately untouched** — a paused persona refuses chat, and that
state must never need a tap.

*Guards:* `web/test/assets-lane-controls.test.ts` (5) asserts one control per
concern, the top-bar location, the conversation gate, and that `ChatStrip` carries
no second copy of either control; `web/test/picker-mobile.test.ts` (+1) asserts the
level/`Paused` split by class. Both **falsified**: re-wiring a second
`onClick={toggleAssetsLane}` failed 2 tests, and merging the level chip back into
`.chip` failed 1. Web suite **642→648**; typecheck 0; no design tokens changed.

*Dev-server note, worth knowing before the next measurement (it cost real time
here):* editing `web/src/app.css` makes this Vite dev server serve the stylesheet
module **empty** (`__vite__css = ""` while `?direct` still returns the full file,
202KB), so the app loses **all** styling until the web dev server is restarted —
a page reload does not fix it. Two measurement passes in this session were taken
on that unstyled page (16×21px buttons, `Times New Roman`) and had to be thrown
away. Restart `npm run dev:web` after editing app.css.

### M20.A follow-up 9 — tap outside a floating pane to put it away (DONE)

**Reported as a product gap, not a bug:** “when side panel (either side) is
opened, touching outside the panel should slide back the panel into hiding.”
It was a real gap, and the numbers say why: on a touch tier the panes *are*
overlays (rail ≤640, lanes ≤760), the open rail covers **320px of a 390px
phone**, and the toggles that opened it live in a **horizontally scrolling top
bar** (M20.A follow-up — the top bar owns the chrome). Touch has no Escape key,
so the one gesture a touch user already knows — tap the content you can see —
had no meaning at all. Nothing was broken; the exit simply did not exist.

**What shipped** (geometry in app.css, decisions in `web/src/lib/panels.ts`):

1. **A tap on the transcript dismisses the floating pane.** A single
decorative scrim (`aria-hidden`, out of the tab order — same contract as the
More sheet’s) is the tap target for exactly the space a pane does *not* cover.
It is scoped to `.chat-workspace`, not the viewport, so the top-bar toggles
that opened the pane stay **live and undimmed** (measured: the scrim starts at
y=60, the top bar’s bottom edge) and the tab bar is untouched. The keyboard
path stays the toggles plus each pane’s own close control.
2. **The pane slides out to its own edge before its state closes.** The tap sets
a `*-exiting` class, the pane animates over `--motion-base`, and only then does
the pane’s own state close (`PANEL_EXIT_MS` = the same 180ms). Frame trace at
390×844: **0 → −83 → −204 → −273 → −306 → −319px**, then the pane closed at
208ms — i.e. the exit matches the entrance (panes also slide *in* now, which
they never did). A pane that owns a column, and a reduced-motion preference,
close **at once** rather than waiting for motion that is not going to run.
3. **Two floating panes can no longer coexist.** At the phone tier the rail and
a lane overlapped by **202px** (320 + 272 on a 390px viewport, one pane buried
under the other). Opening a floating pane now puts its floating siblings away
first, so `dismissTarget` always has exactly one pane to put away. Below the
phone tier the rail is a column and keeps its width — measured @700×900: rail
column 200px **stays**, the floating lane dismisses.
4. **The scrim is the system’s one overlay value**
(`color-mix(in srgb, var(--bg) 55%, transparent)` — the More sheet and the
phone persona sheet already use it), now named as such in `DESIGN.md`, which
also gains the dismissal contract under *Responsive & touch*. No new colour,
shadow or radius was invented.

**Why a module and not a `useState` in `App.tsx`:** the tier widths are geometry
(app.css) but “is this pane floating?” is behaviour, and a source guard on a CSS
string can prove neither that a tap closes anything nor that a desktop column is
never closed by one. `app.css` is re-read by the test so the two copies of
640/760 cannot drift, and `PANEL_EXIT_MS` is checked against
`shared/src/theme.ts`.

Measured in a real browser (`docs/VERIFY-MOBILE.md` §“Tap-outside dismissal”):

| viewport | pane open | scrim | tap on the transcript |
|---|---|---|---|
| 390×844 | rail (320×728, x=0) | 390×728 at y=60 | rail slides to −319px then closes; `.chat` back to 390px wide |
| 390×844 | notes (272×728, x=118) | 390×728 at y=60 | notes closes; `.chat` back to 390px |
| 700×900 | notes floats, rail column | 700×828 | lane dismisses, **rail column keeps its 200px** |
| 1280×900 | rail column + notes column | **none** | nothing closes (a column is not a target) |

*Guards:* `web/test/panels.test.ts` (+16) — behavioural for the tier decision and
`dismissTarget` (including the load-bearing `null` on desktop), source guards for
the scrim wiring, the cascade order (the exit rule must be declared **after**
the entry rule: while a pane leaves, both match at equal specificity), the one
scrim value and the reduced-motion fallback that covers every moving selector.
Both falsified: a tier predicate that returns `true` for everything failed 2
tests; swapping the entry/exit animation order failed 2; re-wiring the scrim to
`undefined` failed 1. Web suite **673 → 689**; typecheck 0; bundle green;
`ux_audit` PASSED (run on the new block plus the extended consolidated
reduced-motion block — the rest of the stylesheet is unchanged and was audited
at HEAD).

**Explicitly not verified:** no human or vision pass of the rendered frames
(the proof frames are measured, not looked at — the repo’s own gap, unchanged
here); `overflow-x: clip` on `.chat-workspace` (added so the 180ms travel cannot
extend the document’s scroll area at tablet widths) is Safari 16+ — older
engines degrade to the previous behaviour, i.e. a possible transient scrollbar,
which is why it is `clip` and not a scroll-container `hidden`; and the
reduced-motion branch was **not** runtime-exercised in this session (the code
path is a single early return, and the CSS fallback is asserted).

### M20.A follow-up 10 — the sidebar minimize toggle, tablet AND desktop (DONE)

**Reported as a product gap:** “for tablet view/desktop view, allow minimizing the
side menu to icons only, so that when toggled, we can maximize usable view.” The
M12 shell already collapsed the sidebar to an icon rail *below 1150px*
(automatically), which left two holes: the **labelled 224px sidebar on every wider
viewport**, and **no way back to labels** once CSS had collapsed it. The first is
the one that matters in the field — an iPad in landscape reports **>1150 CSS px**,
so “tablet” and “desktop” both landed on a 224px menu with no control to reclaim
it.

**What shipped**

1. **The icon rail is a state, not a breakpoint.** `.app.side-minimized` carries
the collapsed geometry and the tablet media query only sets the *default*
(`--side-w` 224px above, 200px when expanded inside the tier, 52px minimized below
760). The toggle therefore wins in both directions, at every tier, instead of
fighting a media query on the next resize.
2. **One width knob.** `.app-side` is `width: var(--side-w)`; the base `.app` sets
224px, `.app.side-minimized` 60px. Measured @1440×900: sidebar **224 → 60px**,
content column **1216 → 1380px** — the **164px** the menu occupied goes back to the
view — and every nav tab measures 44px with its icon centred (rail 60, padding 8).
3. **The attention badge survives collapse.** The old automatic rail hid badges
entirely at ≤1150, which is exactly the failure mode M20.A shipped badges to stop
(a blocked turn with no visible mark). The badge moves to the button’s corner
(precedent: the phone tab bar) — verified with a real attention item, measured
24×28 inside both the 44px button and the 60px rail, painted (`elementFromPoint`
returns it), not clipped.
4. **The toggle cannot become a dead control.** It lives *inside* the sidebar head
(`.side-head`: brand + chevron), so the phone tier — which hides the sidebar —
cannot render it, and the top bar’s horizontally-scrolling row (M20.A follow-up:
the top bar owns the chrome) does not gain a seventh control. It is
`aria-pressed` + an action label (“Minimize menu” /“Expand menu”), 44×44 on touch
tiers like every other control, and the icon-only items carry their label as a
`title`.
5. **Crossing into the tablet tier collapses it, once.** The M12 rule (no menu may
clip a smaller viewport) is preserved as a *crossing* action keyed on the tier
boolean, so a user who expands the rail at 1024 keeps it expanded through any
further resize inside that tier.
6. **The choice is remembered per session** (`partner.sideMinimized`, alongside
the existing rail/lane preferences) — verified across a reload — and it is a
layout preference, so it joins the storage allowlist rather than being a new
content key.

Measured in a real browser (`docs/VERIFY-MOBILE.md`, “Sidebar minimize toggle”):

| viewport | state | measurement |
|---|---|---|
| 1440×900 | expanded (default) | sidebar 224px, all 10 labels + brand + group titles visible, control 49×33 (mouse tier), content 1216px |
| 1440×900 | minimized | sidebar 60px, labels/brand/titles `display: none`, tabs 44px, icon at x=22, content 1380px, overflowX 0 |
| 1440×900 | minimized + badge | memory badge `1`, 24×28, inside the button and the rail |
| 1024×900 | fresh, no stored choice | **default is the rail** (60px), overflowX 0, **0** sidebar controls under 44×44 |
| 1024×900 | expanded by the user | sidebar **200px** (the tier’s own width, not the desktop 224), labels visible, composer still 450px, overflowX 0 |

*Guards:* `web/test/sidebar-collapse.test.ts` (**+10**) — behavioural only where a
node test can be: the state/`--side-w` knob (no literal width may return on
`.app-side`), the tier query changing the **default only**, the badge never being
`display: none`, the touch floor, and the *absence* of a width transition; plus
source guards for the wiring (toggle inside the sidebar, `aria-pressed`, action
label, chevron direction, storage read/write, the tier-crossing effect, the
tooltip). Falsified three ways, each reverted: hiding the badge in the rail failed
**1**, turning `.app:not(.side-minimized)` back into a bare `.app-side` rule failed
**1**, removing `aria-pressed` failed **1**, `readSession` → `null` failed **1**.
Web suite **689 → 699**; typecheck 0; build green; `ux_audit` PASSED (the new
block plus the stylesheet’s global reduced-motion fallback, without which the
audit correctly complains — the sidebar itself adds no transition).

**Explicitly not verified:** no vision pass (text-only session — the frames are
measured, never seen); the 641–760 band was not re-measured with the sidebar
expanded (the tier only lowers the width to 200px and the composer was measured at
1024); and the badge’s *corner* placement is measured in the desktop rail, not at
52px.

### M20.A follow-up — phone Notes view crowding (QUEUED · measured · NOT started)
**State: measured 2026-09-13 at 390×844 with the demo persona; no code changed.**
Reported as "mobile view is too crowded". A scan of all four phone tabs found
Chat, Files and Personas clean (0 sub-44px targets, <20 visible controls) and
**Notes is the offender**: its own chrome is deeper than the viewport, so nothing
you came for is on the first screen.

Measured stack, top to bottom (viewport 390×844):

| block | y | height |
|---|---|---|
| `.app-topbar` | 0 | 60 |
| `.page-head` ("STORES / Notes & plans") | 92 | 63 |
| **`.page-copy`** (2-line explainer, every visit) | 179 | **84** |
| `.seg-tabs` (Notes \| Plans) | 287 | 51 |
| `.card` 1 — `.n-toolbar` | 378 | **235** |
| `.card` 2 — `.n-scope-bar` | 822 | **128** |
| `.card` 3 — the search field | **1249** | 57 |

- **The search field is 405px BELOW the fold**, and the note list is below that.
  Three stacked control cards (boundaries 362 / 677 / 1133) put every control
  before any content — M20.A follow-up 3 flattened this nested padding for
  Memory and **Notes was never swept**.
- **`.n-toolbar` is 9 controls wrapped into 5 rows.** The wrap is not the bug;
  the count is. `.n-toolbar-sep` (1×20px) even wraps onto a row of its own,
  consuming a whole `--space-2` gap.
- **Three controls sit under the 44px floor**: `Graph` 72×35, `Select` 71×35,
  `New project` 111×35 — the M20.A floor rules never covered `.n-toolbar` or
  `.n-scope-new`.
- **`.n-scope-bar` is 3 rows for one control** (label 21 + select 56 +
  `.n-scope-new` 35).

Proposed fix, all inside existing precedent (each item names the precedent it
follows — none of this needs a new pattern):

1. **Hide `.page-copy` on phones** (saves 84px + gap). Precedent: M20.A already
   does exactly this for `.persona-theme-hint { display: none }` at ≤640.
2. **Two toolbar rows instead of five** (~235 → ~96px): row 1
   `Quick capture` + `New note` (flex 1, 44px); row 2 `List \| Graph` segmented +
   a `⋯` overflow holding `Daily note`, `Summarize day`, `Export notes`,
   `Select`. Precedent: the phone's 6 extra views already live behind the More
   sheet for the same reason ("six destinations cannot live in a five-slot
   bar"). **This is the one product call in the list** — it moves 4 actions one
   tap deeper.
3. **One-row scope bar** (~128 → ~60px): the select takes the free width, the
   label moves to the control's accessible name, `New project` becomes a 44px
   `+` beside it.
4. **Bring the three 35px controls to the 44px floor** (mandatory regardless of
   1–3; it is the M20.A floor rule, not a preference).

*Expected:* ~235px of the ~950px pre-content stack removed, plus the 84px
paragraph — the search field and the first note card reach the first screen.
Numbers are to be **re-measured after the change, not assumed**; the target is
"first note row visible at 390×844 with the demo store", and the floor is
"0 controls under 44×44 on every phone tab".

*Exit:* `.n-toolbar` ≤2 rows and 0 sub-44px controls at 390×844 · first note row
above the fold · `ux_audit` PASSED on the changed rules · a source guard in
`web/test/` for the row count/floor invariants · re-measured at 390×844 and
360×640 with no regression at 1280 · entry in `docs/VERIFY-MOBILE.md`.

### M20.B — The server role — *all gates closed; scoped and ready to execute*

> **Execution breakdown moved to `PLAN-M20-B.md`** (slices S1–S8 with exact
> files, tests-first, dependencies, parallelization waves, the corrected
> audit-actor finding, and the still-open gates). The scope below is the
> original summary.

- **User identity:** a `users` table; every session carries `user_id`; a
  first-run "create the first user" flow; OS-profile mapping on a desktop core
  (one OS user ⇒ one app user) preserved so nothing changes for today's users.
- **Per-user partition (§4.1):** `data/users/<userId>/partner.db`, one
  whole-file cipher key per user, per-user skills dir; the per-user connection
  pool; `users.<id>.disabled` refusing requests without deleting data.
- **Device registry:** widen `kind` into a real **client class** + label +
  platform; `GET /v1/devices`, `POST /v1/devices/:id/revoke`, revoke-all.
- **Client-class authorization:** a capability envelope wherever client class
  applies, so a mobile session cannot reach file-write, project roots, deploy
  profiles, or skill install by default. Genuinely new: the existing broker is
  per-*tool* and must not be the only gate.
- **Transport:** TLS required for any non-loopback host; host allowlist becomes
  an explicit **named** list; live mode refuses remote + no-TLS rather than
  warning; §2.1 reclassification documented.
- **Pairing for an untrusted network:** the 6-digit code is raceable on a LAN
  (10⁶ with a 3-attempt lock) → networked pairing uses a **high-entropy
  single-use secret via QR/link**, short TTL; the 6-digit path is restricted to
  loopback. Per-IP rate limit + lock; audit `pair.*` / `device.*`.
- **Credential lifecycle:** shorter TTL for remote devices, rotation/refresh,
  revoke + revoke-all, checked per request.
- **Reachability:** mesh VPN first (real TLS and a real hostname, no CA
  invented by Partner) or LAN (opt-in, named hosts, mDNS, local CA / explicit
  trust step).
- **System-config seam (§4.3):** the separate read path + its hard boundary.
  No admin UI, no policies, no sharing.
- **Model B only:** the §4.4 secret-store decision, cert/domain lifecycle, and
  the desktop agent carrying file/browser capability back to the desktop.

*Exit:* core suite proves the refusal matrix (live + remote off → refuses;
remote on without TLS → refuses; named host + TLS → serves) · **two users have
provably separate DBs, cipher keys, skills and audit; a query cannot cross the
boundary** · a mobile-class session is denied file-write / deploy /
skill-install with a named reason · system config is unreadable and unwritable
from a remote user session · QR pairing single-use + expiry + brute-force lock
· rotation + refresh · remote revoke kills the token on the next request ·
audit rows content-free · real phone completes pair → chat → approve → revoke ·
TLS config documented · `HANDOFF-WINDOWS.md` updated.

### M20.C — PWA polish (web only) — *gated on B*
`manifest.webmanifest` (icons incl. maskable, `display: standalone`,
`theme-color` from tokens), a service worker caching the **app shell and static
assets only** (never API responses or chat content — caching memory is a
security regression), install guidance, and a "this device is paired as …"
settings row. **Blocked by B:** no service worker without a secure context.

*Exit:* installs to a home screen from the core's TLS origin · offline shell
renders PairGate/"core unreachable", never a blank page or cached content ·
manifest validated in CI · `ux_audit` green.

### M20.D — Native shell (optional) — *gated on D2*
Tauri v2 mobile (`shell/src-tauri`, existing `cdylib`/`staticlib`) wrapping the
same SPA with the configurable base URL. In priority order: session token in
Keychain/Keystore · biometric/PIN lock · **share-target** (Android
intent-filter / iOS Share Extension) — the honest replacement for the absent
extension · camera/photo attachments · local notifications for M14 runs
completed while open.

*Exit:* iOS + Android debug builds in CI (or a documented manual build) · token
proven absent from app sandbox files · share-target lands as a chat attachment ·
biometric gate · `PLAN.md` §14 updated with the mobile target.

### M20.E — System layer (explicitly *later*, listed so it is not smuggled in)
Admin surface over `systemConfig`, per-user ceilings, user create/disable/
delete, cross-user aggregation for admin views, and — only if ever needed —
sharing/policy. **Not part of M20.A–D.**

## 7. Why "installable PWA" is not free

Service workers, install, and most device APIs need a **secure context** =
HTTPS *or* `localhost`. A phone loading `http://192.168.1.20:4390` gets a plain
page: no install, no offline shell, unreliable camera/clipboard.

- LAN over plain HTTP → **A only** (usable, not installable).
- Mesh VPN + its own cert → TLS for free → **A + C**.
- Native shell → secure context by default → **A + C-equivalent + D**.

## 8. Security delta for `PLAN.md` §11

| Area | Delta |
|---|---|
| Origin binding | **Reclassified**: `Host`-based origin match is a lookup key, not a network control, once clients are remote (`server.ts:298`). TLS/SNI + named allowlist are the controls. |
| Multi-user | Isolation by **partition** (DB + cipher key + skills dir per user), not by column — a query cannot cross users. Operator-with-master-key caveat stated explicitly if §4.4(a). |
| Client identity | Session `kind` becomes a client class; every request carries user + class; capability envelopes differ per class. |
| Transport | TLS required for non-loopback; named allowlist; plaintext remote serving refused, not warned. |
| Pairing | QR / one-time high-entropy secret for networked devices; 6-digit code restricted to loopback; per-IP rate limit + lock; shortened TTL. |
| Sessions | Device rows carry user, label, platform, last-seen; rotation + refresh; revoke + revoke-all; checked per request. |
| Authorization | Mobile sessions denied file-write, project roots, deploy, skill install by default — a gate above the per-tool broker. |
| System config | Local/admin-only: never readable or writable from a remote user session; defaults are copy-on-read. |
| Phone at rest | PWA: `localStorage` (documented, mitigated by short TTL + revoke). Native: Keychain/Keystore. |
| Exposure surface | The core becomes reachable by other hosts → every route's authorization re-audited; `/v1/dev/pair-code` and all demo seams provably unreachable in live+remote mode. |
| Push | None in v1. If D3 adopts Web Push, VAPID keys are generated **on the user's core**; record that FCM/APNs learn timing/metadata, never content. |
| Client-side storage | Web storage holds **no content** — no chat, memory, note, prompt, transcript or attachment bytes — and that is a **regression-tested invariant** (§8.1, §10), not a convention. Precision (corrected 2026-09-12 after a review caught the overclaim): the sanctioned set is **9 keys**, not 2 — `partner.token` (the credential), `partner.mode` + `partner.theme.pair` (theme), and six per-session UI preferences (`partner.notesLane`, `partner.railOpen`, `partner.railWidth`, `partner.notesWidth`, `partner.assetsLane`, `partner.assetsWidth`). All are UI metadata. The census guard in `web/test/security-guards.test.ts` asserts set-equality against that list, so a new key fails the suite until it is added deliberately with a reason. **Known scope limit:** the census matches `partner.`-prefixed literals, so a non-prefixed, computed, or direct `sessionStorage.setItem` key would escape it — `App.tsx:888/895/984` already bypasses the storage wrapper. |
| Content served by the core | Core-served bytes must never execute on an authenticated origin. `Content-Security-Policy: sandbox` on content routes; long term, a **separate origin** for attachment content. See §8.1. |
| Certificate trust | No blind TOFU. A self-signed cert the user clicks through provides no real MITM protection; QR pairing carries the **cert fingerprint** so the phone pins it verifiably. |
| Deletion | Per-user `data/users/<id>/` is the deletion unit; export is encrypted. Caveat recorded honestly: secure erase on flash storage is best-effort, not guaranteed. |

### 8.1 Prerequisite fixes — must land **before** any remote or mobile client

Ordered; the first is a verified code-path finding, not a hypothesis.
**Status: item 1 is now FIXED (2026-09-12)** — see `core/src/http/server.ts`
`attachmentContentHeaders()` and `core/test/http/attachmentContentSafety.test.ts`
(8 cases). Items 2–5 describe the properties that fix must not lose.

1. ~~**Core-served HTML executes same-origin (verified).**~~ **FIXED
   2026-09-12.** The finding: `core/src/attachments/manager.ts`
   `assertAllowed()` accepts any `kind.startsWith('text/')` — including
   `text/html` — and the content route served it `inline` with the
   client-declared `Content-Type` plus `nosniff`, which does not defend against
   an explicitly declared `text/html`. Because the SPA and the API are the
   **same origin**, such a document ran with access to `localStorage` — i.e.
   the session token. The realistic chain was the partner itself generating an
   HTML/CSS prototype and the user opening it.

   **Applied:** one exported policy, `attachmentContentHeaders()` in
   `core/src/http/server.ts`, keeps only `image/png|jpeg|webp|gif` and
   `application/pdf` **`inline`** (the SPA renders them; inline PDF is a real
   feature) and forces everything else to **`attachment`** plus
   `Content-Security-Policy: sandbox`. The sandbox is deliberately not applied
   to the inline types because it blocks plugins and would break PDF viewing.
   Uploading HTML is unchanged — the model legitimately reads attached HTML;
   only rendering it on the app's origin is refused, and `CodePreview`
   (`sandbox="allow-scripts"`, never `allow-same-origin`) still previews it.
   Tests: `core/test/http/attachmentContentSafety.test.ts` (8 cases; root suite
   893 → 901). **Still worth doing eventually:** serving attachment bytes from a
   separate origin remains the durable answer for a same-origin-token
   architecture, and the browser-level regression test is still only a header
   assertion over HTTP.
2. **Positives to preserve as tests.** `CodePreview.tsx:23` sandboxes with
   `allow-scripts` only and **never** `allow-same-origin`; `Markdown.tsx`
   sanitizes via `rehype-sanitize`; web storage carries only the token and the
   theme. Each becomes an assertion so a later change cannot silently remove
   it.
3. **Token handling on the client.** A mobile browser holding a 30-day bearer
   in `localStorage` is the weakest link in the whole system for a
   sensitive-data product (device backups can capture browser storage; any XSS
   reads it). Mitigations are cumulative, not alternatives: close (1) first,
   then shorter remote TTL + rotation + revoke (§6/M20.B), and prefer the
   native shell's **Keychain/Keystore** — which makes M20.D a **security**
   requirement, not a convenience one.
4. **No content caching.** The offline shell caches **static assets only**
   (§6/M20.C). Caching API responses or rendered chat on a phone is a
   disclosure, not a performance win.
5. **Cert pinning via QR.** Pairing payload becomes
   `{core URL, cert fingerprint, one-time secret}` so trust is established
   verifiably at pair time and the LAN path stops depending on the user
   clicking through a warning.

Unmoved non-goals: no Partner-hosted relay, no Partner account, no Partner
cloud; no autonomous action on sensitive sites. Note that "multi-user" here
means **one operator, several users on their own core** — still not a
multi-tenant SaaS, and still no hosted service.

## 9. Capability matrix (what mobile gets, honestly)

| Capability | Mobile status |
|---|---|
| Chat, personas, streaming, model picker | **Full** (core value) |
| In-chat approvals (Approve/Deny + continue) | **Full** — built in M12.6, ideal for mobile |
| Notes read/capture, folders, wiki-links | **Full** (capture is high value) |
| Plans, schedules, memory review | **Read/light edit** |
| Chat attachments, photos, camera | **Full** (native shell adds share-target) |
| Files / project roots / diffs / apply | **Approvals + read only** (client-class authz) |
| Browser-actuator research & search capture | **Unavailable** → API-key search + share-to-Partner |
| Notes graph, theme studio, audit, skills install | **Desktop-first** (reachable, not optimized) |
| Scheduled runs (M14) | Run on the core; phone sees results on open (push only if D3) |
| Ship/deploy playbooks | Core-side; phone triggers and reports (Model A) |

## 10. Test & verification plan

- `web`: viewport geometry at 430/390/375/360, touch emulation, keyboard
  occlusion, focus + disabled coverage on new controls, `ux_audit` (light +
  dark), configurable-base-URL tests (same-origin, absolute, failure/timeout).
- `shared`: mobile media-profile assertions; guard that existing token *values*
  are unchanged so user themes stay valid.
- `core`: config refusal matrix (live/remote/TLS) · **partition isolation**
  (two users: separate DB files, separate cipher keys, separate skills dirs;
  a user-scoped query returns nothing from the other user; disabling a user
  refuses requests without deleting data) · client-class authorization matrix ·
  QR pairing single-use/expiry/lock · rotation + refresh · remote revoke ·
  system config unreachable from a user session · demo seams unreachable in
  live+remote · audit content-free.
- **Security invariants (new, all must be asserted):** web storage contains
  only allowlisted keys (no content, ever) · attachment/content routes set
  `Content-Security-Policy: sandbox` and never serve executable HTML on the
  authenticated origin (browser-level test, per §8.1.1) · `CodePreview` never
  gains `allow-same-origin` · redaction still holds on the remote path
  (`docs/redaction-inventory.md`) · audit remains content-free per user.
- **Tier separation (A′, §3.1):** the Runner bundle opens `runner.db` with
  `runner-key` and **cannot** open `vault.db` — asserted by attempting every
  Tier C store operation from a runner-class context · briefcase caps (items /
  bytes / TTL) are enforced, not advisory · expiry and revocation rotate the
  job key · drain is append-only, idempotent, and remaps ids deterministically ·
  a second drain of the same run is a no-op · the role split holds in demo mode
  (fake keychain, `:memory:`) so tests stay hermetic.
- Manual, recorded in `docs/VERIFY-MOBILE.md` + `HANDOFF-WINDOWS.md`: real
  phone pair → chat → approve → revoke; offline shell; rotation; safe areas;
  two users on one core with distinct data.

## 11. Decision gates

| # | Question | Recommendation |
|---|---|---|
| **D1** | Source of truth: desktop authoritative (A) · hosted always-on core (B) · **vault/runner hybrid (A′)** · per-device sync (C) | **A′** (§3.1): schedules keep running with the desktop asleep, the operator never holds a key to private data, and no sync engine is needed. Plain A if schedules may be best-effort; B only if A′ is rejected; C: no. |
| **D2** | Mobile client: mobile web · PWA · native shell | **A + C** (layout, then PWA); native later as a wrapper |
| **D3** | Notifications | **None in v1**; revisit with core-generated Web Push, accepting FCM/APNs metadata |
| **D4** | Multi-user partitioning: per-user DB partition (Option 1) · `user_id` columns (Option 2) | **Option 1** — generalizes existing per-OS-user isolation; isolation becomes structural |
| **D4b** | *(only if A′ is rejected)* Secret store: envelope · passphrase-derived | **Passphrase-derived**, given §1.4 — with the explicit consequence that M14 headless runs stop working. Superseded by §3.1, where this trade-off does not arise. |
| **D5** | *(A′, opens the design)* Is the always-on Runner the **user's own second machine** or a **shared VPS**? | User-owned if possible — it removes the operator objection and makes TPM sealing optional. |

D2/D3 are reversible after D1. **D1 and D4 are not** — D1 decides whether the
desktop stays the server or becomes a second client (and whether a desktop
agent is in scope); D4 decides whether isolation is structural or permanent
discipline.

## 12. Decisions (all formerly-open questions are closed)

Resolved 2026-09-12 at the owner's direction. Each carries its decision and the
consequence; the four marked ⚠ land on how the product is *used* and are worth
revisiting deliberately. Execution detail per slice: `PLAN-M20-B.md` §6.

| # | question | decision |
|---|---|---|
| 1 | Remote-access opt-in screen | **Yes** — local-only consent screen, cannot be flipped from a remote session; turning it off invalidates remote sessions immediately. |
| 2 | Who creates users ⚠ | **Local-only** (loopback origin **and** desktop class). A remote session can never create, list or disable a user. First run creates user #0 from the OS profile. **Cost:** a remote owner cannot add a family member. |
| 3 | Headless secret store (§4.4) | **Superseded, not chosen.** The Vault/Runner split (§3.1) means the server never holds a key to Tier C, so neither the operator envelope nor the passphrase trade-off is needed. §4.4 now applies only if A′ is rejected. |
| 4 | Mesh VPN vs Partner-owned LAN TLS ⚠ | **Mesh VPN is the supported path; Partner ships no CA, discovery or trust store.** The LAN fallback requires **cert-fingerprint pinning** in the QR payload, so trust is established at pair time. **Cost:** the LAN-without-mesh path is explicitly lower-assurance. |
| 5 | Desktop agent (Model B) transport | **Moot for v1** — Model B is not pursued. If it ever is, the agent is a **separate daemon**, not the extension's native-messaging bridge, which is browser-lifecycle-bound and extension-specific. |
| 6 | Disable vs delete semantics | **Disabling refuses requests and retains all data (reversible). Deleting removes the `data/users/<id>/` directory — that directory is the unit for export, backup and wipe (irreversible).** Both are audited with ids only. |
| 7 | Cross-user reads | **Yes, but only as a system-layer query fan-out (M20.E) — never a `JOIN`.** Recorded here so Option 2 (`user_id` columns) is not reintroduced later. |
| 8 | iOS/Android share-target distribution | **M20.D ships developer-built artefacts only in v1.** Store signing and distribution is a later, separate decision. |
| 9 | Briefcase policy + caps | **Tag-based selection, per schedule, with an explicit allowlist; caps enforced at ≤ 20 items / ≤ 256 KB / ≤ 24 h TTL**, shown to the user before enabling. Caps are the mechanism that stops a briefcase becoming a DB copy. |
| 10 | Drain conflicts | **Append-only.** Runner output becomes new rows; it never overwrites Tier C. Conflicts surface as "N scheduled results waiting to be integrated". |
| 11 | Runner recovery ⚠ | **Un-drained results are expendable.** Consistent with Tier C having no backup path; the audit row survives, so the loss is visible rather than silent. |
| 12 | Memory-controls ordering | **RESOLVED AND APPLIED** (this line previously read "not changed", which had gone stale). Rendered order is now **Export → Import → Forget before a date → Forget everything** — portability first, destructive last, severity escalating, in `.mem-danger-group` with 32px of separation. Verified in a browser. |
| 13 | **Pairing vs authentication** (raised by the owner: the local desktop copy pairs, but a multi-user web version needs different handling) | **They are different questions and are now separated** (`PLAN-M20-B.md` §2a). Pairing proves *device* enrollment by proximity; it cannot say *which user* a session acts as — today's only mint site carries no user at all. **Enrollment (pairing, unchanged) → authentication (new, per session) → authorization (client class).** A session never carries a user without an authentication event. |
| 14 | Credential primitive for multi-user | **Per-user passphrase** (argon2id/scrypt hash in the **system DB**, never Tier C), because it works offline and on a self-hosted core with **no third party**. **WebAuthn/passkey is a later adapter behind the same seam** — stronger, but its recovery path is a design problem rather than a flag. An external IdP stays an *optional* adapter (Partner already has the AppCore precedent in §2), never the only path, since §1 promises no vendor lock-in. |
| 15 | Does the single-user desktop change? | **No.** Enrollment implies the user there, because the OS profile identifies them (user #0 via the S2 mapping), so the PairGate stays byte-identical. The sign-in step appears only once a core actually has more than one user, or is reached from an unenrolled device. |
| 16 | Headless schedules vs per-user key unlocking | **Sign-in is the unlock event** — the core holds ciphertext plus a wrapped key, and a user's partition is decryptable only while that user has a live session. This resolves §4.4 for the hosted case without an operator-readable store. **The cost is per-user and explicit:** schedules for user X run only while X is unlocked, and "keep my partition unlocked so my schedules can run" is an opt-in that is audited and weakens the guarantee **for that user only** — rather than the original all-or-nothing architecture fork. |

**The gate list is closed**, so S1–S8 in `PLAN-M20-B.md` are executable. The
remaining sequencing constraints are engineering, not decisions: the shared
files (`core/src/http/server.ts`, `config.ts`, `stores/{types,db}.ts`,
`index.ts`) still force the writer waves described in `PLAN-M20-B.md` §4.

**Added after the gate list closed** (`PLAN-M20-B.md` §2a): authentication is not
enrollment, and separating them adds **S2a** (per-user credentials) and **S9**
(per-user key unlock at sign-in), and **raises S6**: authentication over
plaintext HTTP is unacceptable, so **TLS becomes a prerequisite for multi-user**,
not only for remote access.


## 13. Adoption checklist (when D1/D4 are locked)

Per `AGENTS.md`: add the milestone to `PLAN.md` §15 with status, description
and `*Exit:*`; update §4 (architecture gains a server role, users, client
classes), §11 (security delta — §8 above, incl. the §2.1 reclassification and
the multi-user partition statement), §12 (new `users` table; widen `sessions`
with user_id/label/platform/class/rotation; note the per-user DB partitioning
so the section stays accurate), §13 (new routes: `/v1/users` (local-only),
`/v1/devices` + revoke, QR pair), §14 (mobile target, PWA assets, partition
layout), §17 (open questions above); update `README.md` status; keep this file
as the spec.
