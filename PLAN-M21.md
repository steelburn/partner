# PLAN-M21 — container deployment + Cloudflare Tunnel

Companion to `PLAN.md` §15 (index) and `docs/VERIFY-M21.md` (measured record).
This is a **deployment** milestone: it adds no product surface, one config knob
and one keychain kind — but it is the first way to run Partner as a server
somebody reaches from the internet.

## Why it needed code at all

Two hard blockers stood between "we have a server role" (M20.B) and "run it as a
container behind a tunnel":

1. **Live mode had no keychain it could use in a container.** `config.ts` refuses
   a live file database with the in-memory fake keychain (the key would vanish on
   restart), and the native keychain needs an OS keyring daemon (libsecret /
   Keychain / DPAPI) that a container does not have. The only alternatives were
   "refuse to boot" or "run demo mode and lose everything on restart".
2. **Pairing is deliberately loopback-only** (M20-B S7), so a headless
   deployment needs a *place* to mint a pairing secret from. That place is shell
   access to the container (`docker compose exec`), which is exactly the operator
   proof the loopback rule is standing in for.

## Decisions

| # | Decision | Consequence accepted |
|---|---|---|
| D1 | **A `file` keychain kind** (`KEYCHAIN_KIND=file` + `KEYCHAIN_FILE`): JSON, 0600, atomic writes, serialised in-process, malformed ⇒ refuse (never re-key) | The cipher key sits next to the database it encrypts: protection against a copied DB file or backup, **not** against a reader of the volume. `native` stays the default everywhere a keyring exists. One core per file. |
| D2 | **The tunnel sidecar keeps its OWN network namespace** (no `network_mode: service:…`) | `desktop` class becomes unreachable (see D3), but the local-only routes keep meaning something: an anonymous internet visitor cannot mint a pairing secret, and the 6-digit code ceremony stays local. |
| D3 | **Pairing happens through `compose exec … tools/pair-link.mjs`**, issuing a single-use 256-bit secret; the device pairs as **`mobile`** | No `desktop` session in this topology. Chat/read/notes/memory/personas/schedules/provider-setup work; file write, roots/grants, deploy and skill install are refused by class. Elevating an operator-issued secret to `desktop` is the coherent follow-up, and it is a **reviewed capability decision**, not a compose flag. |
| D4 | **No published port, ever** | The tunnel is the only ingress. A published port would expose the API untunnelled *and* break pairing (published traffic arrives from the bridge gateway → non-loopback). |
| D5 | **TLS on the origin leg is required and satisfied locally**: the stage script generates a self-signed cert (`SAN=<host>`, CA:TRUE) and the README documents both the `No TLS Verify` path and the Cloudflare Origin CA path | The core's S6 rule ("remote mode requires TLS") stays intact instead of gaining an "it's behind a tunnel" exception. |
| D6 | **`KEYCHAIN_KIND` now validates** | An unknown value used to silently mean `native`; in a container that produced a keyring-daemon error instead of a configuration error. |

## Files

- `core/src/keychain/file.ts` (+ `core/test/keychainFile.test.ts`,
  `core/test/keychainFileBoot.test.ts`)
- `core/src/config.ts`, `core/src/index.ts` (+ `core/test/config.test.ts`)
- `docker/server/` — Dockerfile, docker-compose.yml, .env.example, stage.sh,
  stage.ps1, .gitignore, README.md, `tools/{partner-request,healthcheck,pair-link}.mjs`
- `tests/deploy-files.test.ts`

## Exit

- [x] `KEYCHAIN_KIND=file` keys an encrypted DB that a **second boot** reopens,
      and a lost keychain **fails the open** instead of minting a key beside the
      data (both asserted in `core/test/keychainFileBoot.test.ts`).
- [x] Container boots LIVE (`demo=off`, schema v18), reaches **`healthy`**, and
      serves the SPA.
- [x] A non-loopback peer can redeem a `compose exec`-issued secret for a
      **`mobile`** session, and is refused `/v1/pair/payload` and `{code}`.
- [x] The minted session survives a **container restart** (volume + file key),
      and is refused `desktop`-only capabilities by class.
- [x] `tests/deploy-files.test.ts` pins the tool syntax and the topology, with
      both invariants falsified by injection (see VERIFY-M21).
- [x] **Live deployment verified 2026-09-13** at `partner.teliti.app` (user's
      real tunnel, real Cloudflare edge): SPA served, live-mode gate, a
      `compose exec`-minted link paired a browser, the session is `mobile`, an
      authenticated read (9 personas) worked, and the fragment was cleared after
      pairing. **The check found two client-side defects the suite had
      missed** — a byte/character confusion in the payload validator (a blocker:
      *every* real link was refused) and a link pasted into an already-open tab
      doing nothing (no `hashchange` listener). Both fixed, both falsified by
      injection, and the cross-module seam is now pinned by
      `tests/pair-payload-agreement.test.ts`.
- [ ] `stage.ps1` on Windows PowerShell (unused here — `stage.sh` under Git-Bash
      was validated instead).
- [ ] A phone (handset) walk: the browser walk above used this machine's desktop
      browser over the tunnel.

*State: implemented + container-verified + live-verified 2026-09-13. The two
unchecked boxes are env-gated conveniences, not blockers; see
`docs/VERIFY-M21.md` for the live record and the two defects it caught.*
