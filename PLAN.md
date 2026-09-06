# Plan: Partner — a personal AI partner workspace

Goal: a user-owned AI "partner" app. The user brings their **own API keys and
endpoints** (as provisioned by `~/apps/llm-self-service`), so there is no
metering, no vendor lock-in, and no third party that ever sees their
conversations, files, or secrets. Partner runs on the user's machine: a
**desktop core** (owns secrets + tools + the brain), a **browser web UI**, and
a **browser extension** that lets the partner act on web pages the user allows.

The partner researches, vibe-codes, designs, drafts emails, writes documents,
builds presentations, and analyses data. It keeps plans and notes for the
user, remembers the user's preferences and personality, and tailors every
response to them. The user composes **personas** — named characters with their
own skills, voice, model routing, and a user-configurable **independence
level** (how much the persona may do without asking). Themes are
user-configurable via a versioned token schema. Skills come from an online
gallery and are installed **for the user's use only**.

Security is a first-class feature, not a bolt-on: secrets never leave the
machine unencrypted, tools are default-deny, every partner action is
auditable, and skills run sandboxed under declared permissions.

---

## 1. Product pillars

1. **Your keys, your endpoints.** Partner is a *client*, not a service. It
   talks to any OpenAI-compatible endpoint the user configures — e.g. the
   LiteLLM proxy from llm-self-service (`https://api.ne1.dev/v1`), or any
   other provider. Keys live in the OS keychain via the desktop core. No
   remote Partner backend exists in v1.
2. **Local-first, local-capable.** Conversations, memories, plans, notes,
   skills, and audit logs are stored on the user's machine. File and browser
   interaction happen through the local core under explicit, revocable grants.
3. **Default-deny autonomy.** Every tool has a capability manifest. Nothing
   touches files, the network, or the browser without a grant. Grants are
   per-(tool, scope, resource, expiry). Personas can raise their own autonomy,
   but only inside the envelope the user configured, and the user always holds
   a pause/kill switch.
4. **Remembers, but transparently.** The partner builds an explicit, editable
   profile of the user (preferences, tone, personality) and uses it to tailor
   responses. Nothing is learned silently: memory entries carry provenance,
   are visible, editable, deletable, and exportable.
5. **Composable identity.** Personas = character + skills + model routing +
   autonomy + memory access + theme. Users create their own and switch
   freely; any persona can run any capability the user grants it.
6. **Ownable look.** The UI is token-driven (a versioned theme schema, not
   hardcoded values). Users pick presets, tweak tokens, or import a theme.
   Contrast and accessibility are validated when a theme is saved.

### 1.1 Decisions locked at kickoff (user answers)

| # | Question | Decision |
|---|---|---|
| 1 | Desktop shell | **Tauri v2** (subject to the M0 core-sidecar packaging spike, §15/§17) |
| 2 | Provider adapters | **OpenAI-compatible only in v1**; the gateway is adapter-shaped so Anthropic/Gemini plug in later |
| 3 | Research search | **Both**, but ship the **browser actuator first** — zero setup and no billing for non-technical users; API-key search is an optional later backend (§6.2) |
| 4 | Vibe-coding scope | Any project the user opens; v1 safety flow = git repo root + side-by-side diff review. Plus a first-class **Ship (deploy) playbook** so vibe-coded apps land in the user's own infrastructure hassle-free (§6.1) |
| 5 | llm-self-service key import | **Integrated** — Partner signs in with the *same org-credential flow the portal uses* and pulls the user's key into the keychain (§2, §15 S0) |

---

## 2. Relationship to llm-self-service

Partner reuses the *conventions* of `~/apps/llm-self-service` and does not
depend on its server for daily use — with one small companion endpoint added
to it for frictionless key import:

- **Endpoint model** mirrors the self-service portal: a provider profile is a
  *name + base URL + key*. The OpenAI-compatible base URL (`<proxy>/v1`) is
  exactly what the portal's "copyable endpoint" shows.
- **Keys are the user's own.** In llm-self-service the user retrieves their
  key (`sk-...`) from `/dashboard` or has it provisioned. In Partner the user
  pastes that key once; the desktop core stores it in the OS keychain and
  never sends it anywhere except the configured endpoint.
- **Proxy quirks already solved.** api.ne1.dev's WAF rejects OpenAI SDK
  telemetry headers (`x-stainless-*`) and the OpenAI user-agent — see
  `scripts/llm-relay.mjs` in llm-self-service. Partner's model gateway strips
  the same headers and uses a neutral user-agent, so SDKs work without a
  local relay; a relay remains an optional escape hatch for exotic proxies.
- **Budgets remain the proxy's job.** Spend caps set on the LiteLLM key are
  honored upstream; Partner additionally enforces its own optional
  *per-provider session budgets* so a runaway task cannot silently burn a
  metered key.
- **Integrated key import — same login method as the portal.** The Providers
  screen offers "Connect llm-self-service": the user signs in with their org
  credentials against AppCore (`appcore.beesuite.app`), exactly as on the
  portal's `/login`; Partner then retrieves the user's provisioned key and
  stores it in the keychain as a provider profile. The password is used once
  over HTTPS and is never stored or logged — matching the portal's own
  security notes. Paste-and-save stays available for everyone else.
- **Most of the API surface already exists** in llm-self-service: `POST
  /api/session` already accepts the RSA-OAEP `passwordCipher` envelope, and
  `POST /api/session/regenerate` already rotates keys. The S0 companion
  (spec: `~/apps/llm-self-service/PLAN-S0.md`) adds only the two missing
  pieces a machine client needs: `GET /api/login-key` (envelope public key,
  today only embedded in the login page HTML) and `GET /api/me/key` — a
  session-authenticated, rate-limited, offline-safe route returning
  `{ email, proxyBaseUrl, endpoint, key, expiresAt }` so any of the user's
  own tools (Partner first) can fetch the current key programmatically.
- **Defense-in-depth:** the portal's login page already supports an RSA-OAEP
  envelope (`src/store/loginCipher.ts`) against passive sniffing. The import
  wizard reuses that same envelope scheme for its programmatic login (the
  self-service side exposes its login public key for exactly this, per §17.6)
  and holds the session cookie only long enough to fetch the key, then
discards it.

---

## 3. Surfaces & where each part lives

| Surface | What it is | Owns | Does not own |
|---|---|---|---|
| **Desktop core** (`core/`) | Local Node service (shipped inside a desktop shell; also runnable headless via CLI) | OS keychain secrets, LLM gateway + routing, tool/permission broker, file tools, skill runtime/sandbox, storage (SQLite + vectors), audit log, pairing, auto-update | Rendering |
| **Web UI** (`web/`) | SPA served by the core on `http://127.0.0.1:<port>` (also runs against a remote core later) | Chat & task surfaces, persona studio, plans/notes editors, memory browser, skills gallery client, theme studio | Secrets, raw file access, tool execution |
| **Browser extension** (`extension/`) | MV3 extension; talks to the core over **native messaging** (no network socket) | Tab DOM/actions, "partner this page", page capture for research, per-site scopes, acting on the user's behalf in the browser | Keys, LLM calls (relays through core) |

Why three pieces: a browser page cannot touch local files or your keychain,
and an extension cannot be trusted with keys. The core is the single trust
boundary — both the web UI and the extension are *clients* of it.

**Degraded mode:** with no core reachable, the web UI may open a "session
only" chat where the user pastes a key that lives in memory for that tab and
is never persisted, and all local/browser tools are disabled. This keeps the
product usable from a borrowed machine without weakening the security model.

---

## 4. Architecture

```
                        ┌────────────────────────────────────────┐
                        │            DESKTOP CORE (local)        │
  Web UI ──WS/HTTP─────►│  pairing  ──►  gateway ──► user providers│──► LiteLLM/proxy
  (127.0.0.1, token)    │     │            ▲   │                     │   (api.ne1.dev…)
                        │  persona engine  │   ├─ tool broker (default-deny grants)
  Extension ───────────►│  memory + plans  │   ├─ file tools (scoped roots)
  (native messaging)    │  skill sandbox   │   ├─ browser bridge
                        │  theme store     │   └─ audit log
                        │  SQLite / sqlite-vec / keychain         │
                        └────────────────────────────────────────┘
```

### 4.1 Trust model in one paragraph
The desktop core is trusted; everything else is a client. Clients authenticate
with a **pairing code** (displayed by the core; shown once per device+origin
or native-messaging host). After pairing, the core issues a session token and
enforces an origin allowlist. The core never binds outward except to
(1) endpoints the user configured and (2) the skills-gallery registry the
user enabled. All tool execution funnels through one permission broker.

### 4.2 The model gateway
- Provider profiles: `{ id, name, kind: 'openai-compatible' | 'anthropic' | 'gemini', baseUrl, keyRef, defaultModels[], enabled }`.
  `keyRef` points into the keychain; the plaintext key is decrypted in memory
  for the duration of a request only.
- OpenAI-compatible is the v1 baseline (covers LiteLLM/ne1, most proxies);
  Anthropic and Gemini adapters are thin additions behind that same seam
  (per §1.1).
- **Routing:** a persona requests a *task class* (chat / deep / coding /
  vision / cheap); Partner resolves it to a concrete model per provider,
  with fallback chain (primary → secondary → user prompt). Overridable per
  persona and per conversation.
- Streaming (SSE), tool-call loop, and usage telemetry are surfaced in the UI
  so the user sees cost/model per turn against any budget they set.

### 4.3 Tool & permission broker (the security core)
Every tool declares a manifest:
```json
{
  "id": "files.write",
  "scopes": [{ "resource": "path", "pattern": "/Users/me/Projects/**", "mode": "write" }],
  "network": false,
  "risk": "medium",
  "confirm": "on-first-use"
}
```
- Grants are stored as `(tool, scope, resource, expiry, source)`; source is
  `user` (manual), `persona` (independence envelope), or `skill` (declared in
  the skill manifest).
- Resolution order: user grant > persona envelope > skill declaration >
  deny. **Deny by default**, always.
- Risk tiers decide UX: `low` runs silently under grant; `medium` asks once
  per scope then remembers; `high` (delete, spend, network, install, browser
  on sensitive sites) asks **every time** unless the user explicitly sets
  "always allow for this scope".
- Every execution writes an audit row: tool, params (secrets redacted),
  grant id, result status, elapsed, cost. User can review and revoke any
  grant from the UI.

### 4.4 Files
- The user defines **project roots** ("allow Partner to read/write
  `/Users/me/Projects/foo`"). Everything outside roots is invisible.
- Tools: read, list, search (ripgrep-like), write (always via temp file +
  atomic rename + backup), diff, apply patch, create folders, and *preview*
  of any file write before it lands.
- Destructive ops (delete, overwrite-outside-git, running scripts) are
  `high` risk.
- Vibe-coding flow: partner proposes a diff; user reviews it in the web UI
  (side-by-side) and applies or discards. Never a blind `apply`.

### 4.5 Browser bridge
- The extension is the actuator; the core is the brain. Core sends intents
  (navigate, capture, extract, fill, click, submit, scroll); the extension
  executes them on the active tab and returns DOM snapshots.
- **Per-site scopes** drive consent: for each origin the user picks one of
  `off` / `ask` / `read` / `read+act` / `trusted`, plus an optional *always
  block* list (banking, payments, password managers, admin consoles are
  blocked by default from any autonomous action — only explicit, per-action
  user clicks can act there).
- Research flow: the user starts "research X"; the core plans queries; the
  extension opens tabs in a dedicated research window, captures content, the
  core extracts + cites into a note. Costs and pages are visible live; the
  user can stop the loop at any time.

### 4.6 Skill runtime
Skills are installed and executed by the **core** in an isolated worker
process (see §9), never by the web page or extension directly.

---

## 5. Persona model

A persona is a declarative bundle — a file the user can read, edit, version,
share (sans secrets), and duplicate:

```json
{
  "schema": "persona/v1",
  "id": "p-maya",
  "name": "Maya",
  "tagline": "Your sharp, warm research & strategy partner",
  "character": { "voice": "warm-professional", "language": "en",
                 "systemPrompt": "…", "temperature": 0.6 },
  "avatar": "…", "colorTheme": "theme-sage",
  "model": { "taskClasses": { "chat": "gpt-4.1-mini", "deep": "gpt-4.1",
             "coding": "claude-sonnet-4", "vision": "gpt-4.1" }, "fallback": "…" },
  "skills": ["web-research", "plans", "docgen", "vibe-code"],
  "memory": { "userProfile": "read", "episodes": "read+write",
              "namespace": "p-maya" },
  "independence": { "level": "suggest",            // see below
                    "autoScopes": [],               // tool scopes auto-allowed
                    "schedule": null,               // e.g. daily brief
                    "requireHumanFor": ["high"] },  // risk tier guard
  "createdBy": "user", "updatedAt": "…"
}
```

### 5.1 Independence levels (user-configurable per persona)
| Level | Behaviour | Example |
|---|---|---|
| `assist` (0) | Answers + proposes only; never executes a tool without an explicit user action | Chat partner |
| `suggest` (1) | May execute `low` risk tools under grants; proposes `medium/high` and waits for confirmation | Research partner (default) |
| `auto` (2) | Executes within `autoScopes` up to `medium` risk; `high` still asks | Coding partner on one project root |
| `autonomous` (3) | Self-directed within the full configured envelope, incl. scheduled work; always logs, always within budget caps; instant pause | "Morning brief", background research |

Rules that hold at every level: the user can **pause** any persona
immediately (global kill switch in the header); `high` risk is gated by
`requireHumanFor`; autonomy never exceeds the intersection of user grants and
persona envelope; every action is logged and shown in the activity feed.

### 5.2 Persona marketplace (local)
Persona Studio: create from template, fork a persona, tune character/skills/
model/independence/theme, A/B two personas on the same prompt, export/import
persona JSON. Starter personas ship in v1: **Researcher**, **Builder** (vibe
coding), **Studio** (design), **Scribe** (emails/docs), **Presenter**,
**Analyst**, **Note-taker**, **Coach/Default partner**.

---

## 6. Capabilities & how they map to tools

Capabilities are not hardcoded features; they are **playbooks over
skills+tools** so users can remix them. v1 depth:

| Capability | Playbook (tools → deliverable) | v1 depth |
|---|---|---|
| **Research** | browser bridge capture + search → citations → note/plan | Full (core differentiator) |
| **Vibe coding** | project root → read/search → propose diff → side-by-side review → apply → **Ship** (§6.1) | Full in one repo root |
| **Ship (deploy)** | built app → validate → build → publish to a **deploy-target profile** → health check → URL reported in chat | v1: one target type, click-to-deploy (§6.1) |
| **Design** | theme tokens + brief → DESIGN.md-style token spec → HTML/CSS prototype (token-only, contrast-gated) | Generate specs/prototypes; no publish |
| **Emails** | profile (sender voice) + context → draft → send *via user's own mail app/browser compose* after review | Draft + handoff; sending = manual |
| **Documents** | docgen skill → markdown/docx (pandoc) into a chosen folder | Full |
| **Presentations** | outline → slide deck (pptx via templates, or HTML slides in the web UI) | Slides generated + editable |
| **Analysis** | open CSV/Excel (local, read-only root) → pandas/sqlite-vec or chart render in UI | Columnar data + charts; no cloud |
| **Plans & notes** | first-class stores (§7) the partner maintains and updates with the user | Full |

Each playbook declares: inputs the user must supply (roots, folders, site
scopes), models it prefers, risk it implies, and its default autonomy — so a
persona that gains `research` inherits sensible defaults the user can tighten.

### 6.1 Deploy targets — Ship into the user's own infrastructure

- The user's infrastructure is represented by **deploy-target profiles**
  (name + connection + defaults + allowed namespace). v1 ships one
  first-class target type: the shape that fits the org's stack — an SSH +
  Docker host behind an existing TLS reverse proxy (Caddy/nginx) where
  `enter.ne1.dev`-style apps already run. The exact contract is confirmed
  against the real infra (§17.2).
- **"Hassle-free" means:** an admin/power user saves a profile once; end
  users never touch a terminal. A persona with the `ship` skill runs the
  whole flow: validate → build (container or static bundle) → push → deploy
  → health check → report the URL + spend summary back in chat.
- A profile can restrict where apps may land (path/namespace/port range),
  may inject env (e.g. a freshly minted LiteLLM key + budget scoped to the
  new app), and every deployment is an audit event. Deploy never gets more
  privilege than its profile grants.

### 6.2 Research search — browser actuator first, API-key adapter later

- **v1 = the browser extension acts as the search client.** The partner
  opens the user's chosen search engine in a scoped research tab (per-site
  scope `read`; the user's own session), captures the results, and hands
  them to the core. Zero API keys, zero billing — the non-technical-friendly
  option. It obeys the same per-site scopes/blocklist as every other browser
  action (§4.5); engines that fight automation with CAPTCHAs degrade
  gracefully (retry another engine, or ask the user) and can be blocklisted
  (§17.8).
- **API-key search** (user-supplied key — Tavily/Brave/SerpAPI class) is a
  later, optional provider implementing the same `search` tool contract — a
  toggle, not a rewrite.

---

## 7. Plans & notes (first-class stores)

- **Notes:** markdown, wiki-links, folders/tags, quick capture, daily note
  auto-summary, link to sources.
- **Plans:** structured documents with goals, milestones, tasks (checked
  status), owners (which persona works it), and links to project roots. The
  partner can *execute* a plan step only with the same tool grants as any
  other action; plan updates (checking a box, appending status) are shown in
  the diff the user approves.
- Both stores are local SQLite rows + markdown files on disk (so they are
  grep-able and git-able). Search is full-text + vector.

---

## 8. Memory & the user model

Three explicit stores (all user-visible, editable, exportable, deletable):

| Store | Contents | Written by | Notes |
|---|---|---|---|
| **Profile** | Facts & preferences: name, languages, timezone, tone/verbosity/format prefs, "do/don't" rules, writing style samples | Partner suggests entries; **user confirms each**; manual edits | Highest trust; drives tailoring |
| **Episodes** | Summaries of past conversations/tasks with outcome | Partner, on conversation close | Namespaced per persona unless shared |
| **Semantic** | Vector index over notes/plans/episodes for retrieval | Indexer | Local (sqlite-vec) |

- **Tailoring loop:** the partner notices "you tend to want TL;DRs before
  detail" → proposes a Profile entry with evidence ("in 6 of your last 10
  asks…") → user confirms/edits/declines → applied thereafter across personas
  (per-persona overrides allowed).
- **Forgetting:** per-entry delete, per-store wipe, or "forget everything
  before <date>". Memory exports as JSON/Markdown.
- **Privacy defaults:** no memory of a conversation unless the conversation's
  memory toggle is on; memory never includes the *content* of user files the
  partner read unless explicitly saved into a note.

---

## 9. Skills gallery

- **Registry protocol** (later a hosted gallery; v1 ships with a local
  catalog + a documented remote registry protocol): a skill package is
  `manifest.json` + code + assets + icons, zipped and **signed**; the
  manifest declares name, description, author, version, permissions
  (`scopes`, `network`, `risk`), entrypoints, and required partner API.
- **Install flow (default-deny):** user browses gallery → sees the manifest's
  permission summary rendered in plain language ("this skill can read/write
  files under ~/Projects, needs no network") → installs → package hash is
  verified against the registry → stored under the user's local skill store.
- **User-scoped:** installed skills belong to the installing user's local
  profile. No re-upload, no shared cache between OS users. Skill data is
  separated from user memories.
- **Runtime:** each skill runs in its own worker process with an
  explicit capability policy derived from its manifest and intersected with
  the tool broker's grants. Network is denied unless declared *and* granted.
  Skills get a time/CPU/token budget and a kill switch. Updates require
  re-verification (new signature); breaking permission changes force a
  re-consent prompt.
- **Audit:** every skill invocation is logged (which persona invoked it,
  what it touched) and reviewable; a skill that asks for more than it needs
  can be uninstalled with one click, and its store wiped.

---

## 10. Theming

The UI is **token-only**; components never carry raw values (per the design
discipline in this repo's conventions).

- **Theme schema `theme/v1`:** a JSON document of design tokens —
  `colors` (base surfaces, one accent family, semantic states), `typography`
  (modular scale, family, weights), `spacing` (8px grid), `radius`,
  `elevation` (3–5 named levels, no ad-hoc shadows), `density`, `motion`
  (durations/easing), `mode` (light / dark / auto).
- **User configurable:** choose a preset → open the Theme Studio to tweak
  any token (with live preview) → save as a named theme → bind globally, per
  persona, or per conversation. Import/export theme JSON; share as a file.
- **Validation on save:** tokens are linted (all components reference tokens
  only), and contrast pairs are checked (APCA, WCAG sidecar) before a theme
  is accepted; a theme that fails contrast is blocked with a report.
- **DESIGN.md alignment:** the repo keeps a root `DESIGN.md` (Google Labs
  standard) describing the default theme + component contracts so every UI
  generation stays inside the system; user themes override tokens, never
  component structure.
- **Extension chrome** uses the same token stream from the core so the
  whole product matches the user's theme.

---

## 11. Security architecture (summary — the important part)

Threat model in one line: *the user's machine is trusted; the network, web
pages, skills, and other apps are not; the user is the final authority.*

| Area | Design |
|---|---|
| **Secrets** | Keys only in OS keychain (core). Never in localStorage, cookies, extension storage, URLs, or logs. Redaction layer scrubs key-like patterns from all logs/audit/UI transcripts. |
| **Transport** | Web UI ↔ core: loopback only, origin allowlist, session token from one-time pairing code. Extension ↔ core: native messaging (no socket). All upstream calls HTTPS. |
| **Org login (key import)** | Same method as the portal: password POSTed only to AppCore over HTTPS (RSA-OAEP envelope per the portal), never stored/logged; session held only to fetch the key, then discarded (§2). |
| **Storage at rest** | SQLite: whole-file encrypted via better-sqlite3-multiple-ciphers (SQLCipher-style, M10 W1 Decision A); 32-byte key held in the OS keychain (account `db-key`); live mode refuses plaintext DBs with a migration message; demo `:memory:` untouched. Vector store same discipline. |
| **Tool safety** | Default-deny broker (§4.3), risk tiers, project roots, write-preview, no blind applies, atomic writes + backups. |
| **Browser safety** | Per-site scopes; sensitive-site blocklist; extension refuses autonomous action on pages with password/CC fields unless explicit per-action user click. |
| **Skills** | Signed packages, hash verification, manifest-permission enforcement, sandboxed workers, no implicit network, budgets, one-click uninstall + store wipe. |
| **Supply chain / updates** | Core updates signed + verified; gallery registry pinned (HTTPS + signature); no telemetry by default — opt-in crash reports only, containing no content or keys. |
| **Budget** | Optional per-provider/per-session spend caps enforced by the core's gateway (defense-in-depth under the proxy's own caps). |
| **Audit** | Append-only local audit log (tool actions, skill runs, grant changes, persona autonomy events). User-visible; exportable. |
| **Multi-user on one machine** | OS profiles are separate Partner profiles: distinct keychain items, DBs, skill stores. Installed skills are never shared between profiles. |

Explicit **non-goals / boundaries**: Partner never stores user passwords; it
never acts on the browser without a site scope; it is not an autopilot for
payments/accounts (blocked by default); keys are never sent to the gallery or
any Partner-owned server (there is none in v1).

---

## 12. Data model (core SQLite)

| Table | Purpose |
|---|---|
| `providers` | endpoint profile (no key material; `keyRef` only) |
| `personas` | persona JSON (§5) |
| `profiles` | user Profile entries (confirmed facts) |
| `episodes` | conversation summaries (persona namespace) |
| `notes` / `plans` | markdown stores + structure |
| `memory_vectors` | sqlite-vec index over notes/plans/episodes |
| `grants` | tool/scope grants with source + expiry |
| `skills` | installed skill metadata + hashes |
| `skill_audit` / `audit_log` | append-only activity |
| `themes` | named theme JSON |
| `settings` | key-value (budget caps, browser scopes, blocklists, active theme, per-conversation themes) |
| `folders` | chat organization tree (conversations.folder_id = the edge) |
| `chat_blobs` / `attachments` | chat uploads: deduped payload bytes + per-message edges |
| `assets` | typed saved artifacts (documents/tables/code/references/deductions…) |
| `mcp_servers` | configured stdio MCP servers (default-deny OFF) |
| `pairing` | device/origin session tokens |

Schema is `v12` (additive; guarded `ALTER ADD COLUMN` via `ensureColumn` for
`personas.policy`, `providers.purpose`, `conversations.folder_id`,
`messages.content_type`, `personas.home_folder`).

`better-sqlite3` (same as llm-self-service) + `sqlite-vec` extension. A
`data/` dir inside the core's app-data folder; per-OS-profile separation.

---

## 13. Local API surface (core, loopback)

REST + SSE + WebSocket events, all behind pairing/session auth:

`/v1/pair` · `/v1/chat` (SSE) · `/v1/models` · `/v1/providers` ·
`/v1/personas` · `/v1/tools` (list) · `/v1/tools/exec` (goes through broker) ·
`/v1/files/*` (scoped) · `/v1/browser/*` (bridge intents) ·
`/v1/notes` · `/v1/plans` · `/v1/memory/*` · `/v1/skills` (install/list/run) ·
`/v1/theme` · `/v1/audit` · `/v1/budget` · `/v1/health` ·
`/v1/conversations/:id/attachments` (+ `/content`) · `/v1/conversations/:id/assets`
(+ `/promote`) · `/v1/folders` · `/v1/files/refs` (granted-root autocomplete) ·
`/v1/mcp/servers` (+ `/tools`, `/call`) · `/v1/search/config|key|query` ·
`/v1/conversations/:id/theme` · `/v1/personas/:id/theme` · `/v1/theme/active
?personaId=&conversationId=` · `/v1/chat` also accepts `{tools:true}` (native
function calls) and `{noPersist:true}` (A/B compare — streams, saves nothing)

WS events: `turn.started`, `tool.request` (confirmation), `tool.executed`,
`grant.revoked`, `skill.install`…, `persona.paused`, `budget.reached`.

---

## 14. Tech stack & repo layout

**Stack (all TypeScript / Node ≥ 22, matching llm-self-service conventions):**
desktop shell: **Tauri v2** (tray, native window, autostart, updater,
keyring). Core: Node 22 + better-sqlite3 + sqlite-vec + Fastify (or Express
— decide at M0), shipped as a **Tauri sidecar** (packaging spike at M0 —
§17.1). Web UI: Vite + React + TS, token-driven components. Extension: MV3 +
TS. Tests: vitest + supertest + Playwright for the web UI, TDD milestones
like llm-self-service.

```
apps/partner/
  shell/           # Tauri v2 app (tray, window, autostart, updater)
  core/            # Node core = Tauri sidecar (gateway, broker, skills, storage, pairing)
    src/ clients/ stores/ tools/ skills/ services/ http/
  web/             # SPA (Vite+React)
  extension/       # MV3
  shared/          # types: persona, theme, tool manifests, wire protocol
  DESIGN.md        # default theme + component contracts
  PLAN.md          # this file
  tests/           # cross-cutting integration tests
```

---

## 15. Milestones (TDD, red → green)

- [ ] **S0 — Self-service companion API (in `~/apps/llm-self-service`).**
      JSON route `GET /api/me/key` behind the existing cookie session,
      rate-limited, demo-mode path, plus exposing the login public key for
      the envelope. TDD in that repo. *Exit: curl with a demo-mode session
      returns the key JSON. Unblocks the M1 import wizard.*
- [x] **M0 — Scaffold, Tauri shell & security spine.** Repo layout, shared
      types, vitest, config/.env patterns, keychain access abstraction
      (fake keychain for tests), pairing code + session tokens, origin
      allowlist. **Tauri v2 shell scaffold + core-sidecar packaging spike**
      (Node SEA vs `bun build --compile` vs bundled runtime — resolves
      §17.1). *Exit: two processes (web, core) pair and echo a chat round
      with a demo fake provider; the packaged app opens and serves the UI on
      loopback.*
- [x] **M1 — Providers, gateway & key import.** Provider CRUD,
      OpenAI-compatible client (SSE streaming, header scrub for ne1 WAF,
      neutral UA), routing by task class + fallback, budget caps, usage
      surfacing. Integrated "Connect llm-self-service" wizard (org login via
      the envelope, S0 key fetch → keychain). *Exit: real chat against a
      user-supplied endpoint in demo mode; import pulls a demo key.*
- [x] **M2 — Tool broker & files.** Tool manifests, grant store, risk tiers,
      confirmation UX, project roots, read/search/write-preview/apply with
      backups, audit log. *Exit: user grants a root; partner proposes a diff
      in a temp file; UI review; apply.*
- [x] **M3 — Chat + persona engine v1.** Conversation UI (SSE), persona CRUD,
      independence levels + pause/kill, model routing per persona. *Exit:
      two personas with different characters/autonomy respond appropriately.*
- [x] **M4 — Memory & profile.** Profile facts w/ user confirmation, episode
      summaries, semantic index, tailoring loop, forgetting + export.
- [x] **M5 — Plans & notes.** Stores, editors, wiki-links, daily note
      summary, plan execution with approved diffs.
- [x] **M6 — Theming.** `theme/v1` schema, presets, Theme Studio, token lint +
      APCA/WCAG gate on save, DESIGN.md component compliance.
- [x] **M7 — Extension bridge & search actuator.** Native messaging host,
      pairing, page capture, per-site scopes, sensitive-site blocklist,
      "partner this page", search-engine capture for research. *Exit:
      research flow end-to-end into a note, search results captured from the
      user's engine with no API key.*
- [x] **M8 — Skills runtime.** Manifest + signing + hash verify, sandboxed
      workers, permission enforcement, audit, install/update/uninstall flows,
      local catalog + registry protocol.
- [x] **M9 — Capability playbooks.** Research, vibe-code, docgen, email
      draft, presentation, analysis, design-prototype flows wired to personas
      (depth per §6), plus the **Ship/deploy playbook** (deploy-target
      profiles, build → push → deploy → health check → URL) and the
      **API-key search adapter** (optional search backend).
- [x] **M10 — Hardening & alpha.** Encryption-at-rest, redaction sweep,
      budgets enforcement, audit UI, degrade-mode chat, packaging (NSIS on
      the self-hosted Windows runner; installer boots env-free; signed
      updates env-gated post-M10), demo mode + verification checklist + docs.
- [x] **M11 — Chat as the workspace (detailed spec: `PLAN-M11.md`).**
      Chat attachments + granted-root file references + multimodal image
      parts; chat tool execution (directive + native `tool_calls`), MCP
      stdio client with persona auto-calls, API-key internet search (core +
      chat tool + UI); persona skill/tool policy; purpose-based providers;
      clickable single/multi choices; markdown→HTML rendering; follow-latest;
      Assets (save/copy/promote-to-note); chat folders + drag-to-move +
      persona home folders; per-conversation themes (D6) + extension-chrome
      theme stream; Notes promoted (tab order, ＋Note/Ctrl+K, Notes lane);
      A/B persona studio; sandboxed HTML/CSS preview; schema v12. *Exit:
      core 683 · web 440 · extension 57 · typechecks 0 · NSIS packaged app
      boots env-free (demo, schema v12); live + packaged UI sweeps green.*

Demo mode mirrors llm-self-service: `DEMO_MODE=1` swaps in fake providers /
fake keychain / in-memory stores so the whole product is exercisable with no
credentials. Never in production builds.

---

## 16. Non-goals for v1
- No Partner-hosted cloud backend, accounts, or sync (optional later).
- API-key search is IMPLEMENTED (Tavily/Brave adapters, default-deny, chat
  tool + panel); the browser-actuator research capture remains an extension
  follow-up (env-gated).
- No plugin execution by web content; skills only via the core sandbox.
- No autonomous payment/banking actions; no acting on sensitive sites.
- No multi-user *server* mode (one machine, per-OS-profile separation only).
- Partner is an MCP **client** (stdio, config + persona tool calls) — it is
  still not an MCP *server*, and never will be in v1.

## 17. Open questions (resolve before/while building)
1. **Tauri core-sidecar packaging** (M0 spike): Node SEA vs `bun build
   --compile` vs a bundled Node runtime — affects binary size, native-module
   support (better-sqlite3 / sqlite-vec), and update signing. Fallback if the
   spike fails: Electron. (Shell decision is locked: Tauri.)
2. **The concrete "our infrastructure" deploy target** for Ship (§6.1): what
   actually runs `enter.ne1.dev` / `api.ne1.dev` today (Docker host + Caddy/
   nginx? k8s? a PaaS?), where new apps should land, and how subdomains/TLS
   are issued. v1 default assumption: SSH + Docker + existing reverse proxy;
   adjust once the real shape is confirmed.
3. Encryption-at-rest approach: full-DB encryption vs app-level AES-GCM over
   rows/files. (llm-self-service precedent: AES-256-GCM per record + IV.)
4. Email/presentation "sending" depth: handoff to the user's mail client vs
   deeper automation (likely handoff in v1).
5. Remote-gallery timeline: is a hosted registry needed for v1, or is the
   documented protocol + local catalog enough for the first users?
6. RSA-OAEP envelope for programmatic login: the self-service app must expose
   its login public key over a fetchable endpoint so the import wizard can
   reuse the portal's envelope instead of weakening it — confirm and build in
   S0.
7. Vibe-code beyond one repo: v1 opens any project as a root, but the
   guaranteed-safe diff-review flow is tuned for a git repo; non-git folders
   and multi-repo sessions need a later safety decision.
8. Which search engines the browser actuator may drive by default, and how
   CAPTCHA/consent prompts surface to the user (with an engine blocklist for
   engines that fight automation).
