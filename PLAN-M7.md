# M7 — Browser extension (MV3) & native-messaging bridge

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§3, §4.5,
§15 M7) · Gates: same as M0–M6.

## Goal

The Partner **browser extension** talks to the desktop core over **Chrome
native messaging** (no network socket, no keys in the browser). It can
"partner this page" (capture → the core's persona summarizes/analyzes it),
act on the page within **per-site scopes**, and surface the core's status +
pairing. Core gains a **native-messaging mode** (length-prefixed JSON on
stdio) with a minimal extension-facing command set.

## Environment notes (documented)

No Rust/no Chrome install here: the extension cannot be click-tested in this
environment. Deliverables: full source + manifest + tsc build + pure-logic
unit tests, plus a manual load checklist (`extension/README.md`). The core
NM mode IS integration-tested by spawning the core and piping framed JSON.

## Data (core SQLite schema v8 — additive)

```sql
CREATE TABLE IF NOT EXISTS site_scopes (
  origin TEXT PRIMARY KEY,            -- hostname or 'host:port' / scheme+host
  scope TEXT NOT NULL DEFAULT 'ask',  -- off|ask|read|read+act|trusted
  updated_at INTEGER NOT NULL);
```
Default policy: unknown origin = `ask` for capture/act; `read` is the
minimum for the extension's passive page metadata; banking/payments/account
origins are on a built-in hard `off` blocklist (match lists) that no scope can
override. `SCHEMA_VERSION` 7 → **8**.

## Native-messaging protocol (frames)

Chrome framing: 4-byte little-endian length + UTF-8 JSON. Messages:
```
{ "type":"request", "id":"…", "command":"…", "payload":{…} }
{ "type":"response","id":"…", "ok":true|false, "payload":{…}|"error":"code" }
```
Commands (core): `hello` (version + demo flag) · `pair.code` (demo only,
returns the current dev code) · `scope.get` {origin} → resolved scope +
blocked reason · `page.capture` {url,title,origin,selection?,text?} → resolves
policy (`read+act`/`trusted` → ok; `read`/`ask`/`off` → denied with the
required scope) · `page.analyze` {url,title,text,selection?,personaId?} →
capture policy, then summarize via the persona/provider (demo placeholder
when none) returning the reply text. Errors are codes: `unknown_command`,
`not_paired`, `denied_scope`, `persona_paused`, `no_provider`, `bad_frame`.
Security: this is a LOCAL loopback channel; still never log page text, and
NM responses never carry secrets.

## Core API additions (authed, web-visible scope management)

`GET /v1/browser/scopes` · `PUT /v1/browser/scopes/:origin` {scope} ·
`DELETE /v1/browser/scopes/:origin` (back to default) · `GET
/v1/browser/policy/:origin` (resolved + blocked?) — scopes manager
(createSiteScopeManager: resolve with blocklist; blocked origins immutable).

## Extension (MV3, `extension/`)

- `manifest.json` (v3): background service worker `{type:"module"}`,
  content script (all http/https), action popup, host? NO host_permissions
  beyond none (capture happens in the content script / popup via tabs API
  with only `activeTab`-style grants? MV3 needs permissions: "tabs" avoided —
  use activeTab + scripting? Keep minimal: `permissions:["nativeMessaging",
  "storage","activeTab"]`, content_scripts matches http/https). Native host
  id `com.partner.core` (registration documented in README).
- `src/background.ts` (module): owns the `chrome.runtime.connectNative`
  port, an id→promise request map, auto-reconnect, and message routing
  between popup/content and the core.
- `src/content.ts` (self-contained, no imports): on request returns a page
  snapshot (title/url/selection text/`document.body.innerText` truncated
  100k) and can perform `fill/click/scroll` primitives for later action
  scopes; posts to background via `chrome.runtime.sendMessage`.
- `src/popup.*`: minimal — connect status (paired? demo code button →
  `pair.code`), "Partner this page" (capture + analyze → show reply or the
  denied_scope reason + a hint to open Partner scopes), a site-scope quick
  view (current origin scope + set `read+act`/`read`/`off`).
- `src/lib/protocol.ts` + `scope.ts` (pure, unit-tested under node):
  frame encode/decode, message types, `resolveScopeForUrl` (blocklist →
  stored → default), `canCapture/resolveDecision`.
- Chrome typings: local `src/chrome.d.ts` ambient decls (no dependency
  adds). Build: `tsc -p extension/tsconfig.json` (noEmit false, outDir
  dist, ESM for module files, classic for content). No bundler.

## Tests

Core: NM mode frame server unit/integration (spawn core `--native-messaging`
demo; hello/pair.code/capture+denied/analyze-demo happy path/unknown command
/bad length), scope manager (blocklist immovable, precedence, CRUD, policy
endpoint), routes 401; M0–M6 suites stay green. Extension: protocol
round-trip, scope resolution incl. hard-blocked origins (banking list),
decision for ask/read/act, snapshot truncation + selection extraction; build
+ typecheck. Manual checklist in README.

## Exit criteria (tick PLAN.md M7)

- [ ] Core NM mode + scope manager/policy tested; extension source builds,
      logic unit-tested; manual Chrome-load checklist documented.
- [ ] Browser click-through + native-host OS install flagged as
      environment-gated (needs a real Chrome + packaged host) — the
      "research flow end-to-end" exit is verified at the protocol level now
      and click-level later with the packaged app.

## Out of scope

Autonomous page automation loop (fills/actions beyond primitives), search
engine driving (research actuator — later), extension theming sync (uses the
core's cssVars only in popup from the active theme? popup uses fixed tokens;
defer), per-profile multi-account.
