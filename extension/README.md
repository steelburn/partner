# Partner — Browser extension (MV3) · M7

The extension is the **actuator**; the local Partner core is the brain
(PLAN.md §3/§4.5, PLAN-M7.md). It talks to the core exclusively over Chrome
**native messaging** (`com.partner.core`) — no network socket, no keys in the
browser. The core runs at `http://127.0.0.1:4390` (web UI + authed API) and is
reached from the popup only via the core's own web pages.

> **Security invariant:** page text is the user's own data. Snapshots travel
> only from the content script → popup → background → local core over the
> extension's own channels. Nothing here logs or stores page text.

## What ships in this directory

| Path | Purpose |
|---|---|
| `manifest.json` | MV3 manifest (root of the unpacked extension) |
| `src/background.ts` | Service worker (module): native port, id→promise map, auto-reconnect w/ backoff, popup routing, pairing state, “scope needed” badge |
| `src/content.ts` | Classic content script (no imports): `partner.capture` snapshots + minimal `partner.act` primitives |
| `src/popup.html`, `src/popup.ts` | Action popup: status/pair, “Partner this page”, scope quick-read |
| `src/lib/protocol.ts` | PURE NM framing (4-byte LE length + UTF-8 JSON), envelope builders, streaming decoder |
| `src/lib/scope.ts` | PURE scope resolution mirroring the core rules (blocklist → stored → default `ask`) |
| `src/lib/snapshot.ts` | PURE capture snapshot builder (100k body / 10k selection caps) |
| `src/lib/act.ts` | PURE act guard (`needsSensitiveRefusal`) |
| `src/lib/messages.ts` | Popup ⇄ background / popup ⇄ content message shapes |
| `src/chrome.d.ts` | Ambient Chrome MV3 types — strictly the used surface (no dependency) |

No runtime dependencies and no bundler: `tsc` emits plain ESM into `dist/`.
Pure logic is unit-tested under node.

## Build

```bash
# from the repo root
npx tsc -p extension/tsconfig.json          # typechecks src AND emits extension/dist
npx tsc --noEmit -p extension/tsconfig.test.json   # strict check incl. extension/test
npx vitest run --config extension/vitest.config.ts # pure-logic tests (node)
```

`extension/vitest.config.ts` is a dedicated include list — the root
`vitest.config.ts` (shared-owned) deliberately does not cover `extension/`, so
M0–M6 suites are unaffected.

## Load unpacked (manual, environment-gated)

1. Run the core in native-messaging mode (core lane; wrapper below execs
   `node --import tsx <repo>/core/src/index.ts --native-messaging`).
2. `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
   select this `extension/` folder (it must contain `manifest.json`).
3. Note the extension id shown (needed for the native-host manifest below).
4. Register the native host (per browser profile), e.g. Linux Chrome:
   `~/.config/google-chrome/NativeMessagingHosts/com.partner.core.json`:

   ```json
   {
     "name": "com.partner.core",
     "description": "Partner desktop core (native messaging)",
     "path": "/absolute/path/to/partner-native-host.sh",
     "type": "stdio",
     "allowed_origins": ["chrome-extension://<EXTENSION_ID_FROM_STEP_3>/"]
   }
   ```

   `partner-native-host.sh` (executable, replace `<REPO>`):

   ```sh
   #!/bin/sh
   # Partner core NM host: reads framed JSON on stdin, writes on stdout.
   exec node --import tsx "<REPO>/core/src/index.ts" --native-messaging
   ```

5. Fully quit and restart Chrome so the host list reloads, then reopen
   `chrome://extensions` and press **Reload** on Partner.

> **Environment gate:** this development environment has no Chrome/Rust
> install, so the extension cannot be click-tested here (PLAN-M7.md). Build +
> typecheck + pure-logic tests are the CI gate; the checklist below is the
> manual gate on a real Chrome once the packaged host ships. Popup icons are
> omitted in M7; Chrome shows a default letter tile.

## Demo pairing walkthrough

The core runs in **demo** mode by default (PLAN-M7.md): pairing is
code-display only, no secret exchange over the loopback channel.

1. Core is running with `--native-messaging` (or the packaged host is up).
2. Open the extension popup on any http(s) tab → status shows *Paired* after
   the background worker says `hello`, or *Not paired*.
3. **Pair with core** → the background asks the core for `pair.code` and the
   popup displays the dev code. Confirm it matches the code printed by the
   core console (demo).
4. **Partner this page** → popup asks the active-tab content script for a
   snapshot (`page.capture`-shaped), then sends `page.analyze` to the core.
   The persona reply appears in the popup, or the denial reason when the
   origin's scope is not `read+act` (badge shows “!”).
5. Scope quick-read shows the resolved scope for the current origin. **Scope
   changes happen in the Partner web UI** (`http://127.0.0.1:4390`) — the NM
   command set has no scope-set command; the popup links there.

## Manual verification checklist (real Chrome)

| # | Click test | Expected |
|---|---|---|
| 1 | Load unpacked, open popup on a normal site | Status → *Paired* (host registered) or a clear *not reachable / not paired* state |
| 2 | Pair button | Popup shows the demo code; core console shows the same |
| 3 | Popup on `https://example.com` | Scope line shows *Ask* (default); “Partner this page” enabled |
| 4 | Click “Partner this page” on an ask/read origin | Denied reason shown; badge “!” appears on the toolbar icon; hint links to the web UI |
| 5 | In the web UI set that origin to read + act | Popup quick-read shows *Read + act*; “Partner this page” returns the persona reply |
| 6 | Popup on `https://www.chase.com/` (banking) | Scope line: blocked; no scope/button can change it; capture is denied |
| 7 | Select text, then “Partner this page” | Reply references the selected passage (selection ≤ 10k) |
| 8 | Kill the core process, open popup | Status flips to not reachable; no crash; restart core → next popup reconnects (backoff) |
| 9 | DevTools on the service worker: `chrome.tabs.sendMessage(<tabId>, {kind:'partner.act', payload:{kind:'scroll', deltaY:400}})` | Page scrolls; on a page with a login form, `fill`/`click` return `sensitive_page` unless `allowSensitive:true` |
| 10 | Non-web tab (chrome://settings) | Popup disables “Partner this page” |

Content scripts inject at `document_idle` — tabs opened before the extension
was loaded need one reload.

## Sync notes (cross-lane)

- `src/lib/scope.ts` `BLOCKED_HOSTS` and `src/lib/protocol.ts` envelope shapes
  must stay in sync with the **core's** scope-manager blocklist and NM server
  (`shared/src/browser.ts` wire types, SCHEMA_VERSION=8). The core is the
  author of both; the extension mirrors them locally (no shared import, to
  keep the `tsc` rootDir clean).
- `src/content.ts` mirrors `src/lib/snapshot.ts` + `src/lib/act.ts` inline
  (classic scripts cannot import); keep constants/guards in sync.
