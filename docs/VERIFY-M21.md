# VERIFY-M21 — container deployment + Cloudflare Tunnel

Record for the deployment slice. Everything below was measured on this machine
(Docker Desktop 29.7.2, linux/overlayfs engine, Windows host) against an image
built from the current tree. The **edge leg** — cloudflared talking to
Cloudflare — needs a real tunnel token and is therefore *not* verified; see
"What is not verified".

## What was built

| Piece | What it is |
|---|---|
| `core/src/keychain/file.ts` | `KeychainKind = 'file'`: a JSON secrets file (0600, atomic writes, serialised in-process) — the container/headless keychain. Live mode previously had no way to run in a container with a persistent database |
| `core/src/config.ts` | `KEYCHAIN_KIND=file` + `KEYCHAIN_FILE`; an **unknown** kind is now refused instead of silently defaulting to `native`; `KEYCHAIN_FILE` without the kind is refused |
| `core/src/index.ts` | one `createConfiguredKeychain()` — the DB open and the app build previously built the keychain separately and could have disagreed |
| `docker/server/` | `Dockerfile` (live, non-root, node healthcheck), `docker-compose.yml` (core + tunnel, **separate network namespaces**, no published port), `.env.example`, `stage.sh`, `stage.ps1`, `tools/{partner-request,healthcheck,pair-link}.mjs`, `README.md`, `.gitignore` |
| `tests/deploy-files.test.ts` | 15 tests: `node --check` every tool, the compose topology invariants, Dockerfile↔stage-script agreement, LIVE/file-keychain/S6 env, non-root, gitignore |

## Measured evidence

**Boot (LIVE, container).** `partner-core v0.1.7 up on https://0.0.0.0:4390
demo=off schema=v18 · no pairing code surface`. No keyring daemon present; the
file keychain was used.

**Healthcheck = `healthy`.** The check requests `/v1/health` over HTTPS with the
allowlisted host as SNI *and* Host, so a pass proves the cert covers the host and
`ALLOWED_HOSTS` matches — the two mistakes that would otherwise 403 every
browser request while the process looked "running".

**Pairing from a non-loopback peer** (host → published port → bridge gateway, the
same shape a tunnel request arrives in):

| Request | Result |
|---|---|
| `POST /v1/pair` `{secret}` (issued via `compose exec … tools/pair-link.mjs`) | **200** `{"kind":"web","clientClass":"mobile"}` |
| `POST /v1/pair/payload` (mint a secret) | **403 `loopback_required`** |
| `POST /v1/pair` `{code:"123456"}` | **403 `loopback_required`** (the code ceremony stays local) |
| `GET /v1/health` | 200 (public by design) |
| `GET /v1/devices` with the minted token | **200**, two `mobile` device rows |
| `POST /v1/roots` with the minted token | **403 `capability_denied`, `clientClass:"mobile"`** |

**Persistence across a container restart** — the point of the new keychain kind.
`docker compose restart partner`, then the *same* session token →
`GET /v1/devices` **200** with the previously paired devices: the
whole-file-encrypted database reopened with a key that outlived the process.

**At rest**: `/data/keychain.json` is `-rw-------` and holds
`partner.db-key`; `/data/partner.db`'s first 16 bytes are **not**
`SQLite format 3` (ciphertext, as M10 W1 requires).

**SPA served**: `GET /` → 200 `text/html`.

**Tunnel wiring**: `docker compose up -d` starts cloudflared with the intended
command line and it fails only on the placeholder token —
`Provided Tunnel token is not valid.` — i.e. the env/command plumbing is right
and the flag parsing is not the problem. (The restart loop is expected with a
dummy token.)

**Non-vacuity of the new tests** (both injected, observed, reverted):
appending `const bad: string = "x";` to a tool → **1 test fails**
(`node --check` + the annotation guard); inserting
`network_mode: "service:partner"` into the compose → **1 test fails** (the
topology invariant that keeps anonymous callers from minting a pairing secret).

## Findings worth recording

1. **The tunnel must NOT share the core's network namespace.** The S7 pairing
   routes decide by **socket peer** (loopback-only for `{code}`, and for the
   secret issuer). A tunnel container with `network_mode: service:partner` would
   dial 127.0.0.1, so *every* internet request would look local: an anonymous
   visitor could `POST /v1/pair/payload` and trade the secret for a session. The
   compose keeps two namespaces, and `tests/deploy-files.test.ts` now pins that.
   The cost is the other finding:
2. **`desktop` class is unreachable in this topology**, so the only session a
   container deployment can issue is `mobile` — chat/read/notes/memory/personas/
   playbooks(¹)/provider setup(¹) work; file write, roots/grants, deploy and
   skill install are refused by class. (¹ the recorded vocabulary gap: provider
   key writes and autonomous firing have no capability name). Pairing happens
   through `compose exec`, which is the operator's proof of being at the machine.
   If desktop powers are wanted from a container UI, the small, coherent change
   is for the **loopback-issued payload** to carry the intended class (operator
   proof at issuance), rather than relaxing the peer rule at redemption — a
   reviewed capability decision, deliberately not taken here.
3. **Git-Bash mangles `-subj "/CN=…"`** into a Windows path, so `stage.sh`
   generates the certificate from a temp **openssl config file** (no
   path-convertible argument) — it works in every shell. The failure mode was
   silent: the key was created and the cert was not, and `set -e` then aborted
   mid-stage.
4. **`node --check` is the gate for `.mjs` deploy tools.** The first healthcheck
   shipped with TypeScript generics inside a `.mjs` file: the image built, the
   core booted, and the container sat permanently `unhealthy` with a Node syntax
   error in the health log. Hence the tool-syntax tests.
5. `KEYCHAIN_KIND` was silently defaulting to `native` for any unrecognized
   value; a typo in a container would have produced a keyring-daemon error
   instead of a configuration error. Now refused.

## Gates

root **1162 passed** (was 1131; +31: file keychain 10, live-boot 3, config 3,
deploy files 15) · web **638** · typechecks **0** · image builds · container
reaches `healthy` · pairing + persistence walks above all green. `ux_audit`
n/a (no new UI).

## What is NOT verified

- **The Cloudflare edge leg.** No real tunnel token here, so: cloudflared
  connecting to the edge, the dashboard's public-hostname settings, and whether
  `No TLS Verify` / `Origin Server Name` behave as documented are **unproven**.
  Everything on the container side of that hop is proven.
- **No phone/browser walk** against the tunnel (env-gated, same as M20-B S7's
  note).
- **Host-header preservation through the tunnel** is asserted by the healthcheck
  for the *container-internal* path only; the dashboard's `HTTP Host Header`
  setting is documented as the deterministic fix rather than measured.
- **Cloudflare Access** (extra auth in front of the hostname) is recommended in
  the README and not configured here.
- The `desktop`-class gap in finding 2 (a product decision, not a defect).
- **The container shipped no skill worker harness until 2026-09-18.** The
  runner forks `worker-runner.mjs` as its own process, and in a bundled CJS
  artifact `import.meta.url` is empty, so it resolves `$PWD/worker-runner.mjs`
  (WORKDIR `/app`) — a file the image never copied. Every skill invocation and
  Studio dry-run in the deployed container failed `no_worker`. The image now
  COPYs it and both stage scripts copy it out of `core/src/skills/`, and a real
  forked invocation inside the container is measured (ready → invoke → result).
- **`stage.ps1` did not run on Windows PowerShell 5.1 until 2026-09-18.** It
  failed to PARSE (not to execute): a UTF-8 em dash inside a double-quoted
  string is read as a smart quote under the ANSI code page, closing the string
  early. `docker/server/stage.ps1` is ASCII-only now (the same one-line hazard
  was fixed in `shell/windows/build-windows.ps1`), and the script was run end to
  end on Windows: SPA + core bundle + staging + certificate reuse + image build.

---

# Live deployment check — `partner.teliti.app` (2026-09-13)

The user ran the compose stack against a real Cloudflare Tunnel. This is the
first time the M20-B S7 pairing path ran on the public internet, and it found a
**blocker that the whole suite had certified as working**.

## What worked, verified in the browser through the tunnel

| Check | Evidence |
|---|---|
| Tunnel + edge | cloudflared: 4 registered connections; ingress `partner.teliti.app → https://partner:4390` with `httpHostHeader` pinned and `noTLSVerify` (self-signed origin, as documented) |
| Core state | `partner: Up (healthy)`; `GET /v1/health` through the tunnel → `{"status":"ok","demo":false,"version":"0.1.7","schemaVersion":18}` |
| SPA over HTTPS | `https://partner.teliti.app/` renders the app; no certificate interstitial (Cloudflare edge TLS) |
| Sessionless gate | the pre-pairing gate renders in live mode (no demo-code button) |
| Pairing | a link minted by `compose exec partner node tools/pair-link.mjs` paired the device; the workspace replaced the gate; the fragment was cleared; `localStorage` holds exactly `partner.token` + `partner.theme.pair` |
| Client class | `POST /v1/roots` from the paired session → **403 `capability_denied`, `clientClass: "mobile"`** (the server named the class) |
| Authenticated read | Personas view rendered **9** persona cards through the tunnel (8 starters + on-demand `Brainstorming`) |

## The blocker: the browser refused EVERY real pairing link

The confirm card rendered **"This link is missing a valid certificate
fingerprint."** for a payload the core had just built and signed off on.

Cause, in `web/src/lib/pair-link.ts`: the field validator decoded the base64url
value to **text** and compared `decoded.length` to 32. The core issues 32
crypto-**random bytes**, which decode to ~28 UTF-8 *characters* (multi-byte
sequences collapse). Measured:

```
core-style fingerprint: 5YXktQg8iy7wdHUj-jNi3xua4P4d1RDQmVx9gvOeAHk
43 chars → 32 BYTES → but 28 decoded CHARACTERS
ASCII filler 'x'.repeat(32) → 43 chars → 32 bytes → 32 characters
```

So the check was correct-by-accident for ASCII filler and wrong for every real
value. Fixed by validating **bytes**: `base64UrlToBytes` (with the canonicality
re-encode) + `bytesToBase64Url`, and `isCanonicalBytes(value, 32)` counting
bytes.

**Why the suite missed it (the important part):** `web/test/pair-link.test.ts`
built its fixtures with `base64UrlEncode('x'.repeat(32))`. That satisfies both
readings, so 14 green tests said nothing about the real shape. The fixtures are
now `randomBytes(32).toString('base64url')` — the shape the core actually
produces — and `web/test/pair-link.test.ts` fails **5 tests** if the
character-count check is restored (verified by injection), while
`tests/pair-payload-agreement.test.ts` fails **3**.

**Durable guard added:** `tests/pair-payload-agreement.test.ts` (cross-cutting
suite) tests the SEAM — the core's `buildPairPayload` output must be accepted by
the browser's validator and vice versa, over 25 random samples, plus agreement on
refusals (truncated / padded / alphabet violations) and an explicit
characters-vs-bytes case. Two independent implementations of one wire shape had
nothing keeping them in step; that was the latent defect behind this bug.

## Second fix: a pairing link pasted into an open tab did nothing

`PairGate` read `window.location.hash` only on mount. A fragment-only navigation
(a QR app, or a user pasting the link into an already-open tab) does not remount
the SPA, so the link sat in the address bar ignored and the ordinary gate stayed
on screen — reproducible during this check (the confirm card appeared only after
a manual reload). `PairGate` now listens for `hashchange` and re-reads the
fragment; it only ever ADDS a link (`not_a_link` leaves the gate alone) and
`cancelLink` uses `history.replaceState`, which fires no event. Re-verified in the
live deployment: the link was opened **by fragment change alone, without a
reload**, and paired.

## Gates after the fix

root **1166 passed** (144 files) · web **639 passed** (40 files) · typechecks 0 ·
web build green · container rebuilt (`stage.sh` + `up -d`, volume preserved) and
re-verified `healthy`. Both fix paths were falsified by injection (see above).

## Lesson recorded

A fixture that satisfies two different interpretations of a rule is not a test of
that rule. The repo has burned itself on this before (M20.A's un-rendered
`AnswerGroup`); the S7 client validator shipped in exactly that state, and only a
real payload — over a real tunnel — exposed it. Where a wire format has two
implementations, the cross-module test is the one that matters.
