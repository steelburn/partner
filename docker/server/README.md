# Partner — LIVE server container + Cloudflare Tunnel (M21)

Runs the Partner core **headless in a container, in LIVE mode** (persistent
encrypted database, real providers, real schedules) and reaches the internet
only through a **Cloudflare Tunnel**. No published port, no inbound firewall
rule, no certificate to renew.

```
        browser / phone
              │  https://partner.example.com   (Cloudflare edge: real TLS)
              ▼
     ┌──────────────────────┐
     │ cloudflared          │  outbound-only tunnel         (own netns)
     └──────────┬───────────┘
                │ https://partner:4390  (docker network, no host port)
                ▼
     ┌──────────────────────┐
     │ partner (core + SPA) │  LIVE: /data volume, file keychain,
     │  https on 0.0.0.0    │  ALLOWED_HOSTS = partner.example.com
     └──────────────────────┘
```

## Quick start

```bash
cd docker/server
cp .env.example .env         # set PARTNER_HOST and TUNNEL_TOKEN
./stage.sh                   # builds SPA + core bundle + origin cert + image
docker compose up -d
docker compose exec partner node tools/user.mjs add <your-name>   # create the account
```

Then open the site and **sign in** with that username and passphrase. There is no
pairing code in this shape: the hosted core authenticates a *user* (M22), and the
pairing routes answer 403.

`stage.ps1` is the same thing for Windows PowerShell (it needs OpenSSL on PATH,
which Git for Windows ships).

## Sign-up (M22) — off by default, invite-gated when on

**M29: an owner usually does not need any of this.** Once an owner account
exists, they mint invitations from the app (Members view → *Invite someone*),
choosing **Member/Owner** and **shared/own AI access** per invite. Those links
redeem whether or not `SIGNUP_MODE` is on, because only an authenticated owner
(or the loopback operator tool below) can produce one. The rest of this section
is the **operator** lane, which is how the FIRST account is created on a fresh
deployment.

The default is the operator creating every account (below), because "who may
reach this hostname" is not "who may create an account here" — a public hostname
is reachable by anyone.

When you want someone to create their **own** account (so you never type their
passphrase), turn on the invite lane:

```bash
# 1. enable it in the deployment
printf '\nSIGNUP_MODE=invite\n' >> docker/server/.env
docker compose up -d partner

# 2. mint ONE single-use invite (loopback-only, so it runs in the container)
docker compose exec partner node tools/signup-link.mjs
```

It prints `https://<PARTNER_HOST>/#signup=<code>` — send that link to the person.
They choose their own name and passphrase, land signed in, and get their own
partition like any other account. Notes:

- **The invite is single use, expires (`SIGNUP_TTL_MS`, default 24h), only the most
  recently minted one is live, and a restart invalidates it.** Mint one per person.
  The code travels in the URL *fragment*, so it never reaches the core's log or any
  proxy between you and them.
- **A spent or damaged link fails loudly** on the form ("already been used or has
  expired", "looks damaged") instead of doing nothing.
- **`off` is the default and an unknown value is refused at boot**, so a typo cannot
  leave self-service registration quietly enabled. There is deliberately no `open`
  mode.
- **Whoever signs up gets the same reach over their own partition as a
  CLI-created account** (`LOGIN_SESSION_CLASS` narrows the class for every login,
  sign-up included). Hand out an invite knowingly.

## Accounts (M22)

The operator CLI runs inside the container — shell access *is* the "at the
machine" proof — and it never takes a password from an argument or an environment
variable (both are visible to `docker inspect`/`ps`). It prompts with nothing
echoed, or reads stdin when you pipe:

```bash
docker compose exec partner node tools/user.mjs list
docker compose exec partner node tools/user.mjs add ama
docker compose exec partner node tools/user.mjs passwd ama          # forgot/rotate
docker compose exec partner node tools/user.mjs lock-account ama    # stop access, keep data
docker compose exec partner node tools/user.mjs unlock-account ama
```

Or let the person create their own account from a single-use invite — see
**Sign-up** above. Either path produces the same shape of account: a users row
plus a scrypt credential, with its own encrypted partition.

- **Every account gets its own partition.** A user's second sign-in on another
  device sees the same data; a *different* user sees nothing of it — separate
  encrypted database, separate cipher key, separate skills directory. `add`
  creates a normal second account.
- **The partition key is wrapped under the passphrase (S9).** At first sign-in the
  key is wrapped (`key_wraps`, schema v19) and the **plaintext is removed from the
  keychain**, so signing out really means unreadable: a session that is still
  valid gets `401 partition_locked` until someone signs in again, and a container
  restart locks everyone. The stored credential check cannot unwrap the key (its
  own salt plus HKDF domain separation).
- **`keep-unlocked` is the explicit exception**, per user and audited:
  `docker compose exec partner node tools/user.mjs keep-unlocked <name>` keeps THAT
  user's key in the keychain so their schedules run while nobody is signed in —
  their data, their choice, and the audit row records it. `lock-now <name>` undoes
  it.
- **`passwd` will not orphan a wrapped key**: it refuses unless you pass `--reset`,
  which drops the wrap and says plainly that the existing partition can no longer
  be opened. A user who wants to change their own passphrase keeps the data, so
  prefer asking them to do it from a signed-in session.
- **Sign-in limits.** Wrong passphrase and unknown username are deliberately
  indistinguishable; three failures lock the credential for five minutes; the
  route also has a per-peer budget (`LOGIN_RATE_LIMIT`, default 10/min). Behind a
  tunnel every request shares one peer address — set `CLIENT_IP_HEADER` +
  `TRUSTED_PROXY_CIDRS` (R4) so the budget is per real client instead.
- **Sessions are owner-scoped** (`/v1/devices` lists yours), live 30 days by
  default, and can be revoked per device or all at once. `passwd` **revokes every
  session of that user** (R2), so a rotated passphrase actually locks out a token
  someone already has.
- **Idle partitions close** (`PARTITION_IDLE_MS`, default off; R3): key material
  leaves memory, the next request re-opens from the keychain. With the file
  keychain the key is on the volume, so this is memory hygiene, not
  cryptographic re-locking.
- **A user's schedules run while their partition is open** (they fire on the
  user's own data, in their own database) — an absent user's do not. `PARTITION_MAX_OPEN`
  (default 8) bounds how many partitions are held open at once.
- **Forgetting the passphrase** costs nothing: `passwd` needs no old password
  (and signs the user's devices out — expected, it is a recovery action).

## Files the tools may touch (M22)

`FIXED_ROOTS=/files` is the **whole** visible filesystem for the file tools, and
the deployment owns it: the core registers the mount at boot and
`POST`/`DELETE /v1/roots` answer `403 roots_fixed`. The Files view shows the root
read-only (no Add, no Remove). To use your own directory, replace the named
volume with a bind mount in `docker-compose.yml`:

```yaml
      - /srv/partner-files:/files        # instead of partner-files:/files
```

Nothing else on the host is reachable, and a `FIXED_ROOTS` entry that is not a
directory stops the boot with the path in the message. The desktop app keeps the
old behaviour (the user registers roots in the UI).

### Every account gets its OWN directory (M29)

With several accounts, one shared `/files` would mean one shared directory. So
the core derives each account's root as **`/files/<userId>`** and creates it at
boot; `POST`/`DELETE /v1/roots` stay `403 roots_fixed` for everyone. Accounts are
provably unable to reach each other's files: they see different roots, and a
root is the only filesystem surface the tools have.

**Upgrading an existing deployment:** files that sit directly in the volume root
(`/files/<something>`) are no longer visible to any account. Move them into the
account's own folder — for the first account created by the CLI that is
`/files/0/` (its id is `0`), later accounts use their slugged name
(`/files/ama/`):

```bash
docker compose exec partner sh -c 'mkdir -p /files/0 && mv /files/* /files/0/ 2>/dev/null || true'
```

With no `FIXED_ROOTS` set, each account's root is inside their own partition
(`<partition>/files`) instead.

## Backups (R8)

```bash
docker compose exec partner node tools/backup.mjs            # → /data/backups
 docker compose exec partner node tools/backup.mjs /backup --keep 7
```

The tool snapshots **every** database (the system DB and each user partition) with
SQLite's `VACUUM INTO` — consistent while the core is running, no need to stop the
container — copies the keychain file and the skills trees, then **re-opens each
snapshot with the key from the copied keychain**, runs `integrity_check`, writes
`BACKUP.json` and exits non-zero if anything could not be verified. A backup whose
key and database did not travel together is not reported as a backup.

Restoring is the reverse: stop the container, replace `/data` with the backup's
contents, start it, and sign in. Keep the keychain file with the databases —
without it they cannot be opened by anyone, including you.

## What the Cloudflare side must say

Cloudflare dashboard → **Networks → Tunnels → your tunnel → Public Hostname**:

| Setting | Value | Why |
|---|---|---|
| Subdomain / Domain | the host in `PARTNER_HOST` | must match exactly: it is the core's only allowlisted host |
| Service | `https://partner:4390` | `partner` is the compose service name on the docker network |
| HTTP → HTTP Host Header | `PARTNER_HOST` (e.g. `partner.example.com`) | makes the allowlist deterministic instead of relying on Host preservation |
| TLS → **No TLS Verify** | **ON** for the generated self-signed cert | see "TLS at the origin" to switch this off properly |

`TUNNEL_TOKEN` comes from the same dashboard page (Install/Configure → the token
in the `cloudflared service install …` command).

## Pairing — and which session class you get

> **This section applies to `AUTH_MODE=pairing` only.** This image defaults to
> `AUTH_MODE=login` (M22): sign in with the account created above. The mechanism
> below remains for a core on a machine you can physically reach — set
> `AUTH_MODE=pairing` to use it.

`POST /v1/pair/payload` (the route that mints a pairing secret) is
**loopback-only by design** (M20-B S7): only a caller on the machine may create
one. In this deployment the way in is the tunnel, so the operator's proof of
"at the machine" is shell access to the container:

```bash
docker compose exec partner node tools/pair-link.mjs
```

It prints a `https://…/#pair=…` link carrying a **256-bit single-use secret**
(valid ~2 minutes, invalidated by a restart). Opening it pairs the device, and
the core mints a **`mobile`** session.

**A `desktop` session is not obtainable in this topology.** `{code}` — the
6-digit ceremony — is refused from any non-loopback peer, and everything through
the tunnel is non-loopback (the tunnel sidecar has its own network namespace).
That is deliberate, and it is the reason this compose file never puts the tunnel
in the core's namespace: sharing it would make every internet request look
loopback, so an anonymous visitor could mint a pairing secret and trade it for a
session.

What the `mobile` class can do — and what it cannot:

| Works | Refused by class (`403 capability_denied`) |
|---|---|
| chat, model routing, personas, notes, plans, memory, folders, themes | writing files (`/v1/proposals/*/apply`, `files.edit`) |
| provider setup, including provider keys¹ | project roots and grants (`/v1/roots`, `/v1/grants`) |
| browser scopes, file *browse*/read (`file.read`) | deploy profiles / shipping |
| playbooks and schedules¹ (autonomous firing has no capability name yet) | skill install/enable/disable, MCP server calls |
| device registry, session rotation/revoke | MCP server create/update/delete |

¹ These are the recorded **vocabulary gap** (PLAN-M20-B): provider *key writes*
and *autonomous firing* have no capability name, so they are ungated for every
class. This deployment makes that gap matter more than a phone-tethered one,
because `mobile` is the only class available. If you need file write / roots /
skill install from the container UI, that is a reviewed capability decision — not
a compose flag.

## TLS at the origin

The core refuses to boot in remote mode without TLS material (S6), so the
container always serves HTTPS. Two ways to satisfy cloudflared's side:

1. **Generated self-signed cert (default).** `stage.sh` writes
   `secrets/origin.{crt,key}` with `SAN=DNS:<PARTNER_HOST>`, valid as its own CA.
   Leave **No TLS Verify: ON** in the tunnel's public-hostname settings.
   The unverified hop is *inside one docker network* between two containers, not
   on a wire — nothing leaves the host.
2. **Cloudflare Origin CA cert (verified).** Dashboard → SSL/TLS → Origin Server
   → Create Certificate for `<PARTNER_HOST>`, then:
   ```bash
   cp origin.pem docker/server/secrets/origin.crt
   cp origin.key docker/server/secrets/origin.key
   docker compose restart partner cloudflared
   ```
   and set the tunnel's TLS options to **Origin Server Name: `<PARTNER_HOST>`**
   with **No TLS Verify: OFF**. Nothing else changes.

## Data, secrets, and backup

Everything that must survive lives in the `partner-data` volume at `/data`:

| Path | What it is | Losing it |
|---|---|---|
| `/data/partner.db` (+`-wal`, `-shm`) | the whole-file-encrypted SQLite database | all history, notes, memory, personas, pairings |
| `/data/keychain.json` (`0600`) | provider keys **and the database cipher key** | the database becomes unreadable — treat it as the crown jewel |
| `/data/skills` | installed skills | reinstall |
| `/certs/origin.{crt,key}` (bind mount, read-only) | the certificate the core serves | regenerate + re-pair nothing (device trust is the browser's, not pinned) |

- **Back up `/data` by copying it while the container is stopped** (a running
  SQLite WAL is not a consistent snapshot):
  `docker compose stop partner && docker run --rm -v partner_partner-data:/data -v "$PWD:/backup" alpine tar czf /backup/partner-data.tgz -C /data .`
- The keychain file is a **container-shaped keychain**, not an HSM: the cipher
  key sits next to the database it encrypts, so it protects a copied database
  file or a backup — not a reader of the volume. On a machine with an OS keyring,
  `KEYCHAIN_KIND=native` is strictly better (that is why it remains the default
  everywhere else).
- **One core per volume, one core per keychain file.** Two cores sharing them
  would each write their own copy of the secrets file and the last write wins.

## Operating it

```bash
docker compose ps                      # healthcheck status (see below)
docker compose logs -f partner         # core log (no secrets, no chat content)
docker compose logs -f cloudflared     # tunnel log
docker compose exec partner node tools/pair-link.mjs      # new pairing link
docker compose exec partner node tools/healthcheck.mjs    # the healthcheck itself
docker compose restart partner                            # data survives
```

- **The healthcheck is meaningful**: it requests `/v1/health` over HTTPS with the
  allowlisted hostname as SNI *and* Host, so `unhealthy` means one of the three
  things that would break every browser request anyway (listener down, cert does
  not cover the hostname, allowlist missing the hostname).
- **Updating**: `git pull && ./stage.sh && docker compose up -d`. Schema
  migrations run on boot; the volume is preserved.
- **Revoking a device**: from the app (Audit/Providers surfaces use
  `/v1/devices`) or `POST /v1/devices/revoke-all` with a session token. Sessions
  live 30 days by default (`SESSION_TTL_MS`).
- **Schedules** (M14) run inside the container, so autonomous work keeps
  happening while your laptop is closed. Set `SCHEDULER_TZ` so daily schedules
  fire when you expect.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| **Restart loop with `login mode found an existing pre-partition database at /data/partner.db …`** | The v19 boot guard refuses to start while a pre-partition database has no first user (id `0`) to own it. **On Git-Bash/Windows the obvious `rm` silently does nothing** — MSYS rewrites `/data/...` into a Windows path before the container sees it. Use `MSYS_NO_PATHCONV=1 docker compose exec partner rm -f /data/partner.db`, or the first account is created as id `0` and owns that file. |
| Container `unhealthy`, log says `healthcheck failed` | the cert does not cover `PARTNER_HOST`, or `ALLOWED_HOSTS` was changed. Re-run `stage.sh` after fixing `.env` (delete `secrets/` to regenerate). |
| Browser gets `403 forbidden_host` | the tunnel's HTTP **Host Header** (or the public hostname) is not exactly `PARTNER_HOST`. Compare with `docker compose exec partner node tools/healthcheck.mjs`. |
| Cloudflare 502 / `cloudflared` restarting | `Provided Tunnel token is not valid.` → wrong/expired `TUNNEL_TOKEN`. Otherwise check the origin service is `https://partner:4390` and that `partner` is healthy first. |
| Pairing link says "already been used or has expired" | the link is single-use, ~2 minutes, and dies with the process — `docker compose restart partner` between issuing and opening invalidates it. Issue a new one. |
| `{"error":"pairing_failed","reason":"not_found"}` | the secret was already consumed, superseded by a newer link, or the core restarted. |
| Phone gets `403 capability_denied` | by design — see the class table above. |
| The in-app **Create pairing link** button (Providers → Phone & tablet access) reports a 403 | expected: that button asks the core to mint a secret, and the request arrives over the tunnel, not loopback. The message now names the command to run instead — `docker compose exec partner node tools/pair-link.mjs`. |
| Pasting the link into an already-open tab does nothing | Fixed 2026-09-13 (the gate re-reads on `hashchange`); on an older image, reload the tab. |
| `docker compose exec` prints nothing | the tool needs `PARTNER_HOST` (from `.env`, via compose). Run it through `docker compose exec`, not `docker run`. |

## Security notes

- **No published port.** Publishing 4390 would expose the whole API without the
  tunnel, and would also break pairing (published traffic arrives from the bridge
  gateway, so it is non-loopback). If you must reach the core directly, do it
  with the desktop app or an SSH session — not by adding `ports:`.
- **What the internet can reach**: `/v1/health`, `/v1/boot`, the SPA assets, and
  `POST /v1/pair` (which needs a 256-bit secret that only `compose exec` can
  mint, and is rate-limited per peer). Everything else requires a session token.
  `/v1/pair/payload` and the 6-digit `{code}` path are refused remotely.
- **Consider Cloudflare Access** in front of the hostname (`Access → Applications`)
  if the app should only be reachable by your own identity. It is an extra lock on
  the door, not a substitute for the pairing token or the account.
- Demo mode is **not** used here. `DEMO_MODE=1` exposes an unauthenticated
  auto-pair endpoint and an in-memory database; never publish a demo core.
