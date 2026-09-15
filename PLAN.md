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
| 5 | llm-self-service key import | **Integrated** (M1) — **REMOVED in M22**: the portal-based import is gone; providers are configured by base URL + key. See §2 |

---

## 2. Relationship to llm-self-service — **REMOVED in M22**

> **The integration described below no longer exists.** M22 removed the
> "Connect llm-self-service" import from core, web and `shared` (routes, page-side
> RSA envelope, demo double, Providers card), so provider setup is always a base
> URL + key typed by the user. The `'llm-self-service'` `ProviderSource` value is
> kept so provider rows written by an older install still read. The section is
> retained as the historical record of why the endpoint shapes looked the way
> they did, and `S0` (the companion endpoint in that repo) is closed as obsolete.

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
                        │  SQLite + FTS5 / keychain               │
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
| **Analysis** | open CSV/Excel (local, read-only root) → pandas/FTS5 or chart render in UI | Columnar data + charts; no cloud |
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
  toggle, not a rewrite. Keys are held per provider (`search:tavily`,
  `search:brave`) so both may be stored at once; endpoint overrides are per
  provider too (`SearchConfig.endpoints`), the active provider is a config
  field chosen by a radio in the UI, and the keychain never carries more than
  one provider's key in a single account.

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
| **Profile** | Facts & preferences: name, languages, timezone, tone/verbosity/format prefs, "do/don't" rules, writing style samples | Partner **auto-detects** suggestions (global or persona-scoped); **user confirms each**; manual edits | Highest trust; drives tailoring; `persona_scope` null = global, else one persona (M19) |
| **Episodes** | Summaries of past conversations/tasks with outcome | Partner, on demand (per conversation) | Namespaced per persona unless shared |
| **Retrieval** | FTS5 full-text over profile/episodes (and notes/plans) | Store writes | The semantic (vector) index is deferred until an embeddings provider is pinned (M4 deviation) |

- **Tailoring loop:** the partner notices "you tend to want TL;DRs before
  detail" → proposes a Profile entry with evidence ("in 6 of your last 10
  asks…") → user confirms/edits/declines → applied thereafter. Confirmed GLOBAL
  entries tailor every persona; **persona-scoped** entries (M19) are recalled
  ONLY in chats with that persona, and only when its private-memory toggle is
  on.
- **Automatic remember (M19):** after a persisted persona turn the core asks
  the persona's cheap-task-class model — out of band, after the response has
  ended — whether the exchange holds a durable user fact; findings land as
  `suggested` entries the user confirms. Detection has **two independent
  consents**: a user-level **global auto-remember** setting (settings table,
  default **on**) files facts that apply to every persona regardless of which
  persona spoke; each persona's **private-memory** toggle (default off) files
  facts scoped to it. Extraction runs when either is on and drops findings for
  a scope whose consent is off. If the cheap/chat target cannot be resolved
  (no default model on the provider, an explicit per-message model),
  extraction rides the exact model that served the turn, so a successful turn
  never silently skips remembering. Each finding is **global**
  (`personaScope: null` — name, role, language, standing tone/format rules,
  so it tailors every persona) or **persona-scoped** (only that persona). The
  extractor prompt is fixed, parsing/caps/secret-filter are defensive, and
  audit rows carry ids/counts only.
- **Forgetting:** per-entry delete, per-store wipe, or "forget everything
  before <date>". Memory exports as JSON/Markdown. A rejected fact is never
  re-suggested.
- **Privacy defaults:** global auto-remember is **on** by default but only
  ever produces visible, confirmable suggestions (nothing tailors a reply
  until confirmed); persona-scoped memory of a conversation requires that
  persona's private-memory toggle; memory never includes the *content* of user
  files the partner read unless explicitly saved into a note; headless
  (playbook/schedule/brainstorm) runs neither read nor write persona memory.

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
| **Secrets** | Keys only in OS keychain (core). Never in localStorage, cookies, extension storage, URLs, or logs. Redaction layer scrubs key-like patterns from all logs/audit/UI transcripts. **Deployments with no OS keyring** (containers, headless servers, M21) use `KEYCHAIN_KIND=file`: one JSON secrets file, 0600, atomic + serialised writes, malformed ⇒ refuse to boot. It co-locates the cipher key with the volume it protects, so it is documented as protection against a copied DB/backup — not against a reader of the volume — and `native` remains the default wherever a keyring exists. |
| **Transport** | Web UI ↔ core: loopback only, origin allowlist, session token from one-time pairing code. Extension ↔ core: native messaging (no socket). All upstream calls HTTPS. |
| **Org login (key import)** | Same method as the portal: password POSTed only to AppCore over HTTPS (RSA-OAEP envelope per the portal), never stored/logged; session held only to fetch the key, then discarded (§2). |
| **Partition keys (M20-B S9)** | In login mode the partition key is **wrapped under the user's passphrase** (AES-256-GCM; separate salt + HKDF domain separation, so the stored credential verifier cannot unwrap it) and the plaintext is removed from the keychain at first sign-in. A signed-out user's partition answers `401 partition_locked` even with a valid session, and closing the partition drops the handle (an open handle would keep decrypted pages cached). The per-user, audited opt-in `keep-unlocked` is the stated exception. |
| **Storage at rest** | SQLite: whole-file encrypted via better-sqlite3-multiple-ciphers (SQLCipher-style, M10 W1 Decision A); 32-byte key held in the OS keychain (account `db-key`); live mode refuses plaintext DBs with a migration message; demo `:memory:` untouched. Vector store same discipline. |
| **Tool safety** | Default-deny broker (§4.3), risk tiers, project roots, write-preview, no blind applies, atomic writes + backups. |
| **Browser safety** | Per-site scopes; sensitive-site blocklist; extension refuses autonomous action on pages with password/CC fields unless explicit per-action user click. |
| **Skills** | Signed packages, hash verification, manifest-permission enforcement, sandboxed workers, no implicit network, budgets, one-click uninstall + store wipe. |
| **Supply chain / updates** | Core updates signed + verified; gallery registry pinned (HTTPS + signature); no telemetry by default — opt-in crash reports only, containing no content or keys. |
| **Budget** | Optional per-provider/per-session spend caps enforced by the core's gateway (defense-in-depth under the proxy's own caps). |
| **Accounts (M22)** | A hosted core (`AUTH_MODE=login`) authenticates a **user**, not a device: `POST /v1/auth/session` proves a per-user passphrase (scrypt, in the **system DB**, never the passphrase itself) and mints a session that carries `user_id`. Wrong password and unknown user are indistinguishable; three failures lock for five minutes; a per-peer rate limit sits on top because behind a tunnel every request shares one peer address. The pairing routes answer 403 in this mode. Accounts are created by the operator CLI (`tools/user.mjs`) — shell access is the "at the machine" proof — or, with `SIGNUP_MODE=invite`, by the person themselves from a **single-use invite the operator mints on the machine** (`tools/signup-link.mjs`), so the operator never sees their passphrase; each account gets its own partition (M20-B S1/S9). |
| **Audit** | Append-only local audit log (tool actions, skill runs, grant changes, persona autonomy events). User-visible; exportable. |
| **Multi-user on one machine** | OS profiles are separate Partner profiles: distinct keychain items, DBs, skill stores. Installed skills are never shared between profiles. |
| **Remote clients (M20)** | Origin binding is **reclassified**: the `Host` header is client-supplied once clients are remote (`server.ts:298`), so it is a lookup key, not a network control — TLS/SNI plus a **named** host allowlist are. |
| **Multi-user partition (M20)** | Isolation by **partition**: `data/users/<id>/partner.db` + its own cipher key + skills dir. A query cannot cross users. The operator-with-master-key caveat of §4.4 does not arise under Model A′. |
| **Vault / Runner split (M20)** | The always-on Runner holds only a **job key** (Tier W: schedules, briefcases, outputs) and **cannot** open the Vault DB (Tier C). Briefcases are pre-authorized, capped, expiring and read-only; results drain into Tier C only at a user-present unlock. |
| **Client classes (M20)** | Session `kind` becomes a client class (`desktop` / `mobile` / `extension`) with a capability envelope; a mobile session is denied file-write, project roots, deploy and skill install by default — a gate *above* the per-tool broker. |
| **System config (M20)** | Separate local/admin-only path; never readable or writable from a remote user session; system-wide defaults are copy-on-read. |
| **Mobile at rest (M20)** | Browser storage holds the token + theme only (no content, regression-tested); remote tokens carry a short TTL with rotation and revoke; the native shell uses the OS keystore. |
| **Content serving (M20)** | Core-served bytes must never execute on an authenticated origin: `Content-Security-Policy: sandbox` on content routes and attachment disposition for HTML-ish types (`X-Content-Type-Options: nosniff` alone does not stop a declared `text/html`); long term a separate origin for attachment content. |
| **Enrollment vs authentication (M20)** | Pairing answers *"may this device reach the core?"* (proximity); it does **not** answer *"which user is this session?"*. Today the only mint site is `sessions.create('web', origin)` with **no user** (`server.ts:1324`) and `SessionRow` carries no `user_id`, so the two are conflated. M20 separates them: **enrollment** (pairing, unchanged, per device) → **authentication** (new, per session, credential-proven) → **authorization** (client class + capability envelope). **A session may never carry a user without a user-authentication event.** On a single-user install enrollment *does* imply the user, because the OS profile identifies them (user #0) — which is what keeps the desktop PairGate byte-identical. A multi-user core mints an acting session only after sign-in, and one device may hold sessions for several users, so revoke is per (device, user). Detail: `PLAN-M20-B.md` §2a. |

Explicit **non-goals / boundaries**: Partner never stores user passwords; it
never acts on the browser without a site scope; it is not an autopilot for
payments/accounts (blocked by default); keys are never sent to the gallery or
any Partner-owned server (there is none in v1).

---

## 12. Data model (core SQLite)

| Table | Purpose |
|---|---|
| `providers` | endpoint profile (no key material; `keyRef` only) |
| `personas` | persona JSON (§5) + independence/schedules, capability policy |
| `profile_entries` | user Profile facts (confirmed/suggested/rejected; `persona_scope` null = global) |
| `episodes` | conversation summaries (persona namespace) |
| `memory_fts` / `notes_fts` | FTS5 indexes over memory + notes/plans (vectors deferred — see M4 deviation) |
| `notes` / `plans` / `note_links` | markdown stores + wiki-link edges |
| `note_versions` / `note_graph` | note/capture snapshots + graph node positions (M16) |
| `note_folders` | note↔folder membership, many-to-many (M17; shared tree) |
| `brainstorm_sessions` / `brainstorm_sources` | linked/reopenable brainstorm threads (M16 follow-up) |
| `grants` | tool/scope grants with source + expiry |
| `project_roots` | user-granted filesystem roots |
| `pending_tools` / `file_proposals` | approval queue + write proposals |
| `skills` / `skill_invocations` | installed skill metadata + hashes; invocation audit |
| `playbook_runs` / `scheduled_runs` | playbook runs + scheduled-run state (M14) |
| `spend_ledger` | rolling provider spend windows (M10) |
| `deploy_profiles` | Ship/deploy targets (§6.1) |
| `site_scopes` | browser capture scopes + sensitive-site blocklist |
| `themes` | named theme JSON |
| `settings` | key-value (budget caps, browser scopes, active theme, per-conversation themes) |
| `folders` | chat + note organization tree (conversations.folder_id = the chat edge) |
| `chat_blobs` / `attachments` | chat uploads: deduped payload bytes + per-message edges |
| `assets` | typed saved artifacts (documents/tables/code/references/deductions…) |
| `mcp_servers` | configured stdio MCP servers (default-deny OFF) |
| `users` | local accounts: data-partition root + disabled flag (M20) |
| `users` | local accounts: the data-partition root, OS-profile mapping and disabled flag — in the **system DB**, not a per-user DB, because it must exist before a user is resolved (M20.B S2) |
| `user_credentials` | per-user passphrase credential: salt, scrypt params, derived key, failure bucket and lock window. Stores **no passphrase** (M20.B S2a) |
| `pairings` / `sessions` | device/origin pairing + session tokens; sessions gain `user_id`, client class, device label/platform and `rotated_at` (M20) — **`kind` is deliberately NOT widened**: it is the audit actor for 7 routes |
| `audit_log` | append-only activity |

Schema is `v19` (additive; guarded `ALTER ADD COLUMN` via `ensureColumn` for
`personas.policy`/`home_folder`/`schedules`, `providers.purpose`,
`conversations.folder_id`/`parent_id`/`source_asset_id`,
`messages.content_type`, `pending_tools.conversation_id`/`persona_id`, and —
M20.B — `sessions.user_id`/`client_class`/`device_label`/`platform`/`rotated_at`).
`v17` added the `users` + `user_credentials` tables; `v18` added the session
columns; `v19` (M20-B S9) added `key_wraps` (the passphrase-wrapped partition key)
and `users.keep_unlocked` (the per-user, audited opt-in that keeps a key in the
keychain so that user's schedules can run while nobody is signed in).

**M20 partitions by user and by trust tier:** one whole-file-encrypted DB +
cipher key + skills dir per user under `data/users/<id>/` (generalizing the
existing per-OS-user keys), and a separate `runner.db` under a distinct job key
for the always-on Runner role — the same `ensureDbKey` +
`openEncryptedDatabase` mechanism applied twice, with no new crypto.

**Legacy carve-out, and it is a data-safety property:** the first user
(`LEGACY_USER_ID`, which `FIRST_USER_ID` derives from so the two cannot drift)
owns the **pre-partition layout** — `<dataRoot>/partner.db`, its `<dataRoot>/skills`
dir and the legacy `db-key` keychain account. So an existing install keeps its
database, key and installed skills where they already are. The mapping is
deterministic rather than "alias only when the legacy file exists", because a
filesystem probe would give a fresh install and an upgraded one different shapes
for the same user. (An adversarial review caught that this was asserted but
unimplemented; see `docs/VERIFY-M20-B.md` §2.)

`better-sqlite3` (same as llm-self-service). The semantic (vector) index is
DEFERRED until an embeddings provider is pinned (M4 documented deviation);
retrieval is SQLite **FTS5** over profile/episodes/notes/plans. A `data/` dir
inside the core's app-data folder; per-OS-profile separation.

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

Later milestones extend this surface: providers by purpose
(`/v1/providers/discover`, `/v1/providers/purposes` — M13); live desktop
pairing (`/v1/pair/device`, `/v1/boot` — M15); notes knowledge workspace
(`/v1/notes/graph` + `/graph/positions`, `/v1/notes/:id/versions` +
`/restore`, `/v1/notes/brainstorm`, `/v1/conversations/:id/assets` +
`/promote` — M16); note projects (`GET /v1/notes?folderId=…`,
`PUT /v1/notes/:id/folders` — M17); and schedules (`POST
/v1/personas/:id/schedules/:scheduleId/run-now`, `GET /v1/schedules/runs` +
`/runs/:runId` — M14). M19 adds **no chat route**: automatic remember runs on the
chat path and only widens `/v1/memory/profile` with global and persona-scoped
suggested entries. The M19 follow-up adds `GET`/`PUT /v1/memory/settings`
(`{ autoRememberGlobal: boolean }`) for the user-level global consent.

M22 adds the **account lane** for the hosted shape: `POST /v1/auth/session`
({username, password} → a session that carries `user_id` and `LOGIN_SESSION_CLASS`),
`/v1/health` gains `authMode` (+ `hasUsers` in login mode), `GET /v1/roots` gains
`rootsFixed`, and `POST`/`DELETE /v1/roots` answer `403 roots_fixed` when the
deployment owns the roots. In `AUTH_MODE=login` the whole pairing lane
(`/v1/pair`, `/v1/pair/payload`, `/v1/pair/device`, `/v1/dev/*`) is **refused**.
The M1 `/v1/self-service/*` routes and the `llm-self-service` import were
**removed** (M22).

M22 sign-up (invite lane, `SIGNUP_MODE=invite`, off by default) adds two routes:
`POST /v1/signup/code` (**loopback-only**, mints a 256-bit single-use invite — the
same primitive as the pairing secret — issued by `tools/signup-link.mjs`) and
`POST /v1/auth/signup` (`{code, username, password}` from anywhere → creates the
users row + scrypt credential exactly as `tools/user.mjs add` would, `201` with
the new id, **no session**), and `/v1/health` gains `signupMode` (`off`/
`invite`). The rules a name and passphrase must satisfy live in
`shared/src/accounts.ts` so the browser validates what the core enforces. See the
M22 entry in §15 for why `open` registration is deliberately not a mode.

M22/R7 also fixes the **upload transport**: `POST
/v1/conversations/:id/attachments` takes the file as the **request body** (content
type = the mime, `x-attachment-name` = the percent-encoded name), bounded by
`MAX_UPLOAD_BYTES` via `express.raw`, and `/v1/health` republishes that cap as
`maxUploadBytes` so the SPA can refuse before uploading. It replaced a base64
JSON envelope that inflated every payload by a third and inherited the 1 MiB JSON
cap — which is why the documented 8 MiB was really ~768 KiB
(`docs/VERIFY-M22.md`). iPhone **HEIC/HEIF photos are converted to JPEG in the
SPA** (`web/src/lib/image-convert.ts`: platform decode → canvas → JPEG, 4096px
edge) because the core, the preview and the model providers cannot read HEIC;
the core keeps refusing an unconverted `image/heic` with a message that says to
attach it as JPEG.

M20 adds a server surface (PLAN-M20-B.md). **Implemented:**
`GET /v1/devices` + `POST /v1/devices/:id/revoke` + `POST /v1/devices/revoke-all`
(S5, 404-not-403 across users, no token material in any body),
`POST /v1/session/rotate` (S3 — the outgoing token fails on the NEXT request),
the S4 **client-class capability guards** on the machine-power route groups
(file write, roots, grants, deploy, skill install/invoke, MCP call **and MCP
server create/update/delete— configuring one spawns a process—browser scopes),
and **S7 networked pairing**: `POST /v1/pair/payload` (loopback-only; refuses
without remote access + TLS) issues a 256-bit single-use secret for a link/QR,
and `POST /v1/pair` accepts `{secret}` from anywhere and mints a **`mobile`**
session (never `desktop`), refuses `{code}` from a non-loopback **socket peer**
before verifying it, and rate-limits both paths per peer.
**Still planned:** local-only `POST /v1/users` (S2a), the sign-in route
(`POST /v1/auth/session`) that supplies `user_id` (§2a), briefcase routes (S8),
and per-user partition unlock (S9).

WS events: `turn.started`, `tool.request` (confirmation), `tool.executed`,
`grant.revoked`, `skill.install`…, `persona.paused`, `budget.reached`.

---

## 14. Tech stack & repo layout

**Stack (all TypeScript / Node ≥ 22, matching llm-self-service conventions):**
desktop shell: **Tauri v2** (tray, native window, autostart, updater,
keyring). Core: Node 22 + better-sqlite3 + FTS5 + Express (Express chosen at
M0; the vector index stays deferred until an embeddings provider is pinned —
§8 M4 deviation), shipped as a **Tauri sidecar** (packaging spike at M0 —
§17.1). Web UI: Vite + React + TS, token-driven components. Extension: MV3 +
TS. Tests: vitest + supertest + Playwright for the web UI, TDD milestones
like llm-self-service.

```
apps/partner/
  shell/           # Tauri v2 app (tray, window, autostart, updater; cdylib/staticlib reserved for the M20.D mobile target)
  core/            # Node core = Tauri sidecar (gateway, broker, skills, storage, pairing)
    src/ clients/ stores/ tools/ skills/ services/ http/
  web/             # SPA (Vite+React)
  extension/       # MV3
  shared/          # types: persona, theme, tool manifests, wire protocol
  docker/server/   # M21: LIVE server container + Cloudflare Tunnel compose
                   # (Dockerfile, docker-compose.yml, stage.sh/ps1, tools/*.mjs)
  DESIGN.md        # default theme + component contracts
  PLAN.md          # this file
  tests/           # cross-cutting integration tests
```

---

## 15. Milestones (TDD, red → green)

> **Maintenance rule.** Detailed per-milestone specs live in `PLAN-M<N>.md`,
> but this section is the master index: whenever a module/milestone is added,
> changed, or completed, update its entry here (status, description, `*Exit:*`)
> in the same change — plus the affected design sections (§8 memory, §12 data
> model, §13 API surface, §14 stack) and `README.md`. `[x]` only when the full
> exit is locally green; `[ ]` + a `*State:*` line when an env-gated walk
> remains.

- [x] ~~**S0 — Self-service companion API**~~ **CLOSED as obsolete in M22** — the
      llm-self-service import it existed to unblock was removed (§2), so the
      companion endpoints are no longer wanted. Nothing was built in that repo.
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
      A/B persona studio; sandboxed HTML/CSS preview (F12 follow-up: an
      ```html code block in chat, the assets read view or the note-editor
      preview renders inline beside its source); schema v12. *Exit:
      core 683 · web 440 · extension 57 · typechecks 0 · NSIS packaged app
      boots env-free (demo, schema v12); live + packaged UI sweeps green.*
- [x] **M12 — UI readability & polish pass (detailed spec: `PLAN-M12.md`).**
      Responsive shell (header ≤ 80px, nav shrinkable, rails adapt below
      1280/960), accent-on-surface-2 contrast-gate fix (light), 16px
      token-styled nav icons, grouped view order + collapsible Notes lane,
      dense-list legibility floor. No new features; token-only; suites and
      ux_audit gates stay green. *Exit: PLAN-M12 P0–P2 ticked; geometry
      gates at 1440/1280/1024/900/780 (no overflow, composer ≥ 320px @900);
      light+dark+custom walks green; fresh-context review closed.*
- [ ] **M13 — Purpose providers & in-session model switch (detailed spec:
      `PLAN-M13.md`).** Image-turn vision handoff (implicit text-model
      turns with an attached photo reroute to a vision-capable model;
      explicit picks never overridden; shared vision capability in
      `shared/src/vision.ts`); per-message model picker in chat
      (`providerId` + `model` per turn); purpose-provider bundle with model
      assignment (`POST /v1/providers/discover` + `/v1/providers/purposes`
      `modelPins`: one endpoint + key → one profile per purpose carrying
      exactly the models you choose, first = default; key in each keychain
      item). *Exit: core 681 · web 470 ·
      typechecks 0 · ux_audit green on new UI · live manual walk
      (env-gated).*
      *State: implemented + verified (suites/typechecks/ux_audit per the
      README M13 note). Box left open: the exit list also records a live
      manual walk (env-gated) that has not yet been executed.*
- [ ] **M14 — Scheduled & autonomous work (detailed spec: `PLAN-M14.md`,
      implemented + live-walked 2026-09-07; packaged-app walk (shell/NSIS)
      env-gated remains).** Personas carry
      schedule definitions (`independence.schedules[]`: daily / weekly /
      interval + prompt + tz, JSON column on personas, schema v13); a
      scheduler driver fires due schedules (auto/autonomous, unpaused,
      enabled personas only) and drives each as a HEADLESS bounded persona
      tool-loop run (shared playbook engine): brief lands as a user turn in
      the schedule's own conversation thread, the answer appends on done
      (+ optional save-note), one `scheduled_runs` row per attempt (status
      running/done/queued/error/loop_exhausted + pendingId), audits
      `schedule.run`/`schedule.resume`/`schedule.skip` (ids+counts only).
      Queued tools pause the run; deciding the approval from the Files queue
      or the in-chat card auto-resumes it in-process; a paused persona is a
      kill switch for new runs AND resume. Routes: run-now (headless fire),
      run history + detail; schedules edit via the persona surface.
      *Exit: core 715 passed · typechecks 0 ·
      ux_audit green on the schedule editor + runs panel ·
      decide-hook e2e (real loop approve+deny auto-resume) · live walk
      executed 2026-09-07 (api.ne1.dev + Brave; approval pause → headless
      auto-resume → done + note; found/fixed resume save-note bug) ·
      packaged-app walk (shell/NSIS) env-gated.*

- [ ] **M15 — Live desktop mode (exit demo; detailed spec: `PLAN-M15.md`).**
      Packaged shell boots LIVE by default (persistent whole-file-encrypted
      DB + OS-keychain key + skills under the per-user app-local data dir,
      not the install dir); a per-boot device secret enables the
      header-guarded `GET /v1/pair/device` code channel; the tray (Show
      pairing code… / Open Partner / Quit) surfaces the live pairing code;
      the PairGate is health-aware (live copy + no demo button).
      `PARTNER_DEMO_MODE=1` keeps the demo boot.
      *Exit: core 726 passed · typechecks 0 · web tests + build green ·
      windows-build green · live packaged-boot walk (tray → pair → chat →
      restart-survives, ciphertext DB, demo override) · HANDOFF refreshed.*
- [ ] **M16 — Knowledge workspace (implemented + verified 2026-09-09;
      detailed spec: `PLAN-M16.md`).**
      Notes relationship graph (view notes + relationships; edge direction =
      who references whom, mutual refs render bidirectional; React Flow,
      `@xyflow/react`, drag positions persist; reuse for brainstorming and,
      later, doc building); **Brainstorm from notes & captures** (activates a
      new **Brainstorming** persona `p-brainstorm`, seed-created on demand if
      missing; bundle ≤ 20 note excerpts into a persona-bound conversation);
      **versioning for notes & captures** (snapshot every mutation at one
      choke point — covers quick captures, promote, summarize, restore —
      history + diff + undoable restore); **Discuss in Assets** (asset
      discussion becomes a branch/thread of the same discussion — origin
      conversation — or optionally **forks into a new discussion** via
      `conversations.parent_id`/`source_asset_id` lineage); **Assets →
      Export works in the Desktop app** (native save-dialog path in the
      Tauri shell + blob fallback for browsers); **CSV assets render as
      tables** (pure shared RFC-4180 parser + token-only table view). Schema
      v13 → v14 (additive). **Follow-up (v14 → v15):** brainstorm
      conversations link back to their source note/capture set
      (`brainstorm_sessions` + `brainstorm_sources`); the graph badges those
      nodes and reopens an ACTIVE session instead of duplicating it, while a
      concluded session stays listed with **Reopen**. *Exit: core + web + shared suites green ·
      typechecks 0 · web build green (React Flow) · windows-build green ·
      `ux_audit` green on new UI (light + dark) · manual walk (graph,
      brainstorm persona auto-create, versions/restore, discuss + fork,
      packaged export save dialog, CSV table) · HANDOFF refreshed.
      *State: shared 51 · core 837 passed (2 encryptedDb cipher failures
      pre-exist at HEAD — environment) · web 486 · typechecks 0 · web build
      green (@xyflow/react) · ux_audit green. Box open: shell
      windows-build (no local Rust; CI workflow) + the packaged live walk
      are env-gated, matching M13/M15 precedent.*
- [x] **M17 — Note projects (implemented + verified 2026-09-11).** An
      organizational layer over the shared Projects/Folders tree: notes join
      projects many-to-many, with **no membership = Inbox**. One membership
      write path (`setFolders`) backs both create-time `folderIds` and
      re-filing; `list()`/`graph()` scope by folder subtree or Inbox, and a
      scoped graph returns one-hop **ghost** nodes for out-of-scope
      references (marked external, never persisted). Deleting a folder clears
      membership (notes survive); deleting a note cascades its membership
      rows. Routes: `GET /v1/notes?folderId=<id|none>`,
      `GET /v1/notes/graph?folderId=…`, `PUT /v1/notes/:id/folders` (501 when
      folders are unwired). Notes list + graph gain project scope selectors,
      project chips, an editor Projects multi-select, dimmed ghost nodes with
      an “other projects” toggle, drag-to-ghost, and a “Link to note…” picker.
      Schema v15 → v16 (`note_folders`); audit stays membership counts only.
      *Exit: root + web suites green · typechecks 0 · web build green ·
      `ux_audit` green on the new UI.*
- [x] **M18 — Chat multi-question forms (implemented + verified
      2026-09-11).** When a persona has **more than one open-ended question**
      it emits a `:::partner.form` container instead of a prose list; each
      question renders in its own textarea and the user submits **once**. The
      answers become a single labelled user turn through the normal chat path
      (nothing client-only; the persisted text is unchanged). The parser
      shares the `:::partner.*` grammar (`shared/src/structured.ts`): one
      question per bullet line, a title from the `title=` attr / fence tail /
      lead line, closed-container-only materialization so streaming stays
      safe, and malformed or unclosed blocks degrade to plain prose. Pending
      drafts survive switching conversations (client-side per-conversation UI
      memory). The `forms` guidance ships in the default structured feature
      set alongside choices and assets; styles are token-only. *Exit: root
      suite 877 passed (1 pre-existing platform-specific MCP spawn case) ·
      web 539 passed · typechecks 0 · web build green · `ux_audit` green.*
- [x] **M19 — Persona-scoped memory & automatic remember (implemented +
      verified 2026-09-12; detailed spec: `PLAN-M19.md`).** Personas gain
      **private memory**: a per-persona tick (`memory.personaMemory = on|off`,
      off by default) makes a persona keep its OWN facts about the user and
      recall them **only while chatting with it** (the interactive `/v1/chat`
      route) — never in another persona's prelude, and never in the headless
      playbook/schedule/brainstorm loops. Global confirmed facts still tailor
      every persona (M4). **Automatic remember**: with private memory on, the
      core asks the persona's cheap-task-class model — out of band, AFTER the
      client's response has ended — whether the finished exchange holds
      anything durable about the user, and files findings as
      `partner_suggestion` / `suggested` entries **labeled global or
      persona-scoped** for confirmation in the Memory view (alongside the
      existing explicit add-a-fact path). The extractor prompt is fixed and
      never user-derived; parsing is defensive (fence/JSON guard, kind whitelist, caps,
      obvious-secret filter); dedupe covers global + same-scope entries,
      rejected included, so a rejected fact is never re-suggested;
      demo/no-provider turns skip; audit rows carry ids/counts/model only. Web:
      a Memory fieldset in the persona editor, a persona-aware “in use”
      marker, and an “Auto-detected” provenance chip. No schema change (M4's
      `profile_entries.persona_scope`/`source` and the `personas.memory_flags`
      JSON were enough). *Exit: core 893 passed (5 env-gated skips) · web 541
      passed · typechecks 0 · web build green · `ux_audit` green (APCA
      light + dark).*
      **Follow-up (global auto-remember):** the extractor now labels each
      finding `scope: "global"|"persona"` (missing/unknown → persona). Global
      findings file `personaScope: null` and, once confirmed, tailor **every**
      persona — so the partner learns a fact once (name, language, standing
      tone) instead of per persona; persona findings stay scoped. Dedupe
      covers both scopes and never files the same value twice. `memory.remember`
      audit gains `globals`/`personaScoped` counts (still content-free). Web
      copy (persona-editor Memory hint, Memory privacy note) explains the two
      scopes. *Exit: core suite green · web 712 passed · typechecks 0.*
      **Follow-up (turn-target fallback):** extraction no longer silently
      no-ops when the persona's cheap/chat resolver yields no model — it rides
      the provider client + model that actually served the turn
      (`RememberInput.fallbackTarget`), so a provider with no default models
      (per-message model picks) still remembers. Route test proves a
      default-model-less provider files a global suggestion from a turn's
      explicit model. **Follow-up (independent global consent):** global fact
      detection no longer rides the per-persona private-memory toggle. A
      user-level `memory.autoRemember.global` setting (settings table, default
      ON, `GET`/`PUT /v1/memory/settings`) governs facts that apply to every
      persona; the persona toggle governs only persona-scoped facts. The chat
      route enqueues extraction when either is on and passes a per-turn policy
      so only consented scopes are filed. Web: an “Automatic memory” card in
      the Memory view; persona-editor copy scoped to persona facts. No schema
      change. *Exit: core 1158 passed · web 733 passed · typechecks 0.*
- [ ] **M20 — Client-server, multi-user & mobile (detailed spec:
      `PLAN-M20.md`; decisions locked 2026-09-12; M20.A in progress).**
      Partner grows a remote, multi-device, multi-user server role.
      **Model A′ (§3.1):** the core splits into two roles with two key
      scopes — a **Vault** on the user's own machine holding the user key and
      **Tier C** (memory, notes, chat, attachments, provider keys, project
      roots), and an always-on **Runner** holding only a job key and
      **Tier W** (schedules, briefcases, run outputs) — so scheduled work runs
      while the desktop sleeps while the operator never holds a key to private
      data. Pre-authorized, capped, expiring **briefcases** plus a one-way
      **drain** at unlock replace sync. **Multi-user by partition (D4):**
      `data/users/<id>/partner.db` with its own cipher key and skills dir
      (generalizing today's per-OS-user isolation, §2.3); user / device /
      client-class are three levels, and **device = session**, so multi-device
      is per-user for free. System-wide config gets a separate local/admin-only
      read path now (**M20.E deferred**). Sensitive-data prerequisites (D5,
      §8.1): close the core-served-`text/html` same-origin hole, keep content
      out of web storage, pin the cert via QR. Phases: **A** mobile/tablet/
      touch UI (no core change) · **B** the server role (TLS, named host
      allowlist, QR pairing, device registry + revoke, client-class capability
      envelopes, per-user partition) · **C** PWA · **D** optional Tauri v2
      native shell · **E** system layer (later).
      *Exit:* refusal matrix (live/remote/TLS) · two users provably isolated
      (DB, key, skills, audit; a query cannot cross) · the Runner cannot open
      `vault.db` · briefcase caps + idempotent drain · a mobile-class session
      denied file-write/deploy/skill-install · QR pairing single-use + expiry +
      lock · real phone pair → chat → approve → revoke · geometry gates at
      430/390/375/360 · `ux_audit` green.
      *State:* **M20.A (mobile/tablet/touch UI) implemented + measured
      2026-09-12** — composer 58→326px @390 and permanent chrome 252px→0 on
      phone, controls under 44×44 11→0, tablet geometry unchanged, `ux_audit`
      PASSED, web suite 547 (+6 nav tests), typechecks 0, build green.
      **M20.A follow-up (same session):** the *message field* (not the
      container) was still 49px — text buttons took 214px of the row — now
      **222px (62%)** with icon-only 44px controls; persona cards 584→**340px**
      (~2.5 per screen) with a full-width action row and **0** sub-44px
      controls (was 52); and new **attention badges** (`web/src/lib/attention.ts`
      +18 tests) so memory suggestions can no longer sit unnoticed — the phone
      **More tab carries the aggregate** of what the sheet hides, verified
      `3` → reject → `2`. Web suite now **565**. Rules recorded: a badge must
      be able to clear itself (failed runs self-clear on a 24h window) and
      `queued` runs are excluded everywhere (a paused run *is* the pending
      approval).
      **M20.A follow-up 2 (same session) — Memory view:** the same flex-crush bug
      in three places, plus a legibility floor this view was **missed by M12**.
      `.mem-control-text` is `flex: 1; min-width: 0`, and `min-width: 0` lets a
      flex item shrink *below* min-content, so the control-row copy collapsed to
      **9–11px (one character per line)** — the Import row 411px tall — and the
      Memory controls card ran 1483px. Entry rows were worse: a 42-character
      entry rendered a **20px value column 399px tall** (my first fix attempt
      targeted `.row-actions`, which only exists elsewhere; the real container
      is `.mem-actions` — found by re-measuring). **Suggestions** failed for a
      different reason: 32+32+24+24 = **112px nested padding per side (57% of a
      390px viewport)** left a 135px measure, which is also why Confirm/Edit/
      Reject stacked into a 148px column. Flattened to one 16px gutter per
      level: measure 135→**263px**, suggestion 450-471→**293px**. Copy/chips
      12→**14px**. Memory view total 5436→**4075px (−25%)** while the measure
      nearly doubles; sub-44px controls **12→0**. `ux_audit` PASSED (18 pairs).
      Recorded: `--danger` on the light card surface is **Lc 75.42** vs floor 75
      — thin, so it fails first if either token is retuned. **Recommended but
      NOT applied:** "Forget everything" is the *first* row of the controls
      card, putting the most irreversible action in the most prominent position;
      portability-first / destructive-last is the safer convention, but that is
      a product decision (see `PLAN-M20.md` §12).
      **Applied recommendations (2026-09-12, same session):**
      **(1) `PLAN-M20.md` §8.1.1 — the live security hole is CLOSED.** Core-served
      `text/html` executed on the SPA's own origin where the session token
      lives. One exported policy (`attachmentContentHeaders()`) now keeps only
      images and PDF `inline` and forces everything else to `attachment` +
      `Content-Security-Policy: sandbox`; HTML upload is unchanged (the model
      legitimately reads attached HTML) and `CodePreview`'s sandboxed path still
      previews it. Verified no SPA regression: the app fetches attachment bytes
      with a Bearer header, and `fetch()` ignores `Content-Disposition`, so only
      direct navigation changes. 8 new tests in
      `core/test/http/attachmentContentSafety.test.ts`; root suite **893→901**.
      **(2) Memory controls reordered** to Export → Import → Forget before a
      date → Forget everything (portability first, destructive last, severity
      escalating, 32px separation), verified rendered in a browser.
      **(3) `.preview-frame`'s `#ffffff` tokenised** as `--surface-doc` — the
      stylesheet now has **no raw hex in any declaration**.
      **Two of my own claims were corrected:** there was never a touch
      re-filing gap (`.rail-item-move` is a `<select aria-label="Move … to
      folder">`, measured 66×44 — I built nothing for it), and the
      `--rail-action-w` token I suggested was a bad idea (the width is
      label-driven, so a token would be false systemisation).
      **M20.A follow-up 6 (same session) — one submit per question set.**
      Fixes a reported bug: a reply carrying a choice **and** a set of free-text
      questions rendered two cards with two independent submits ("Confirm" /
      "Submit answers"), and pressing either sent only its own answer while the
      other was silently discarded. `web/src/lib/answer-group.ts` (pure, 15
      tests) owns the message-level rule — `answerableCount > 1` groups, so a
      single-container message keeps its existing button untouched — and
      `composeGroupedAnswer` joins each part with the exact string that card
      would have sent alone, so only the *arrival* changes. `AnswerGroup.tsx`
      owns the one submit; grouped forms require every question; the group locks
      after sending ("Answers sent") so one prominent button cannot double-post.
      **Verified through the real chat path** (a throwaway loopback
      OpenAI-compatible stub, since the demo provider cannot emit containers):
      1 group · **exactly 1 submit** · **0 per-card submits** · gate walks
      disabled→disabled→disabled→enabled with hints 2→1→1→none · the single press
      produced **one** user turn containing both the choice and the Q/A pairs.
      `ux_audit` PASSED. *Open:* the answered-lock is per page session (a reload
      makes an answered group answerable again — pre-existing behaviour, needs a
      message-level marker to fix properly).
      **M20.A follow-up 7 — danger-on-well sweep + chip contrast (DONE):** a
      subagent wave (scout + 3 writers + fresh-context reviewer) found the
      grouped-answer lock should derive from **transcript position** rather than
      client storage (no new key, and it survives reload, a different device and
      cleared storage), and swept **16 selectors** whose light-mode `--danger`
      text sat on a `--surface-2` well at **Lc 69.52** against a 75 floor
      (`.theme-row`/`.mcp-server-row`/`.p-milestone` ghost danger controls,
      `.attach-chip-remove`, and `.row-error`/`.chat-attach-error` copy) → now
      **80.88**. The gate also caught two pre-existing chip defects, both fixed:
      `.attach-chip-preview` accent on a well (**69.02** → `--accent-hover`
      **77.08**) and `.attach-chip-meta` `--text-faint` (**68.86** →
      `--text-muted` **81.40**). The reviewer found **2 MAJOR defects the parent
      had missed**: `.answer-group-parts` had **no CSS rule** (0px separation
      between question sets) and **no test rendered `AnswerGroup`** — deleting
      `showSubmit={false}` restored the original bug with the suite green; both
      fixed, the latter now falsified as non-vacuous. **Lane failure recorded:**
      the first danger sweep produced nothing (a forked worker continued the
      parent's reasoning); retried with `context: 'fresh'`. Verification +
      arbitration record: `docs/VERIFY-MOBILE.md`.
      **M20.A follow-up — phone persona picker (FIX, reported bug):** the list was
      unusable on a phone while looking fine in the DOM. The top bar is a
      horizontal scroller and `overflow-x: auto` forces `overflow-y: auto`, so
      the absolute `.picker-pop` sat inside a scroll box — measured @390×844
      with 9 personas it laid out **655px** tall but painted only the bar's
      **60px** band (**1 of 9** options), and the open-time focus scrolled the
      bar up **65px**, hiding the trigger. ≤640 now renders the list as the
      **same bottom sheet as the More control** (fixed, full width, anchored on
      the tab bar, `max-height: 60dvh`, scrollable, rows `flex: none`), and the
      base popover gained a `calc(100dvh - …)` bound because a **landscape
      phone (844×390) is outside the width-based tier** and its tail was
      unreachable too. Measured after: fully in-viewport with the last option
      reachable at 360×640, 390×844, 844×390, 768×600, 1280×900; rows ≥71px;
      bar `scrollHeight` 715→**60**; desktop popover unchanged. New guard
      `web/test/picker-mobile.test.ts` (**+7**), falsified against a reverted
      `position: fixed`. `ux_audit` PASSED (picker rules, 8 APCA pairs);
      web suite **635→642**.
      **M20.A follow-up — the top bar owns the chrome (Assets + Theme moved up):**
      reported as "Assets seems redundant … one at the top, and another near chat
      input." Verified worse than two: **three** controls for one action (top-bar
      icon, labelled chat-bar button, in-pane chevron), the first two bound to the
      same handler/state, on screen **579px apart**, disagreeing on enabled state.
      Then two owner criteria in sequence: **maximise chat input width** (measured:
      phone input **222px either way** — the lane is an absolute overlay; desktop
      **682 → 366px (−46%)** when it opens, and only the *ungated* top-bar icon
      could do that with nothing to show), and finally **"move Theme and Assets to
      top"** — which is also the shell's own M14 design ("a slim top bar (persona
      picker + lane/theme controls)"). Final state: top bar = persona ·
      conversations · notes · **assets** · **theme** · mode, with the assets toggle
      still gated on a conversation; the row above the composer keeps only
      brainstorm state and the save flash, and renders only when it has content.
      Measured after: desktop 6 controls / 523px in 1008px, no scroll; phone 6
      controls / **318px** in 358px, **no scroll**; phone transcript **513 → 565px**
      (a 52px row directly above the composer is gone); theme bind proven end to
      end ("Midnight" → `preset-midnight`, surviving a reload). One trade on the
      phone: the **level** chip yields its 31px (`Paused` never does). Guards in
      `assets-lane-controls.test.ts` (5) + `picker-mobile.test.ts` (+1), both
      falsified. Web suite now **648**.
      **M20.A follow-up 9 — tap outside a floating pane to put it away (DONE,
      measured in-browser @390×844 / 700×900 / 1280×900).** On a touch tier the
      rail (≤640) and the two right-hand lanes (≤760) float over the transcript,
      so until now the only way back was the toggle that had opened the pane:
      measured the open rail covers **320 of 390px** and those toggles live in a
      horizontally scrolling top bar — the one gesture a touch user knows (tap
      the content you can see) did nothing. It does now, and the pane **slides
      out to its own edge** before its state closes (frame trace 0 → −83 → −204
      → −273 → −306 → −319px over 180ms = `--motion-base`, then the pane
      closes), so leaving looks like arriving. The scrim is scoped to
      `.chat-workspace` (measured 390×728 from y=60 — the top bar's bottom
      edge), so the toggles that opened the pane stay live and undimmed, and the
      desktop column model is untouched (**0** scrims at 1280 and a click on the
      transcript closes nothing). Floating panes are mutually exclusive at the
      phone tier (they overlap by **202px** there), and a reduced-motion
      preference closes at once rather than waiting for motion that is disabled.
      Decision + tier numbers in `web/src/lib/panels.ts`; `panels.test.ts` (+16)
      anchors them to app.css, pins the cascade order (exit declared after
      entry), the one scrim value and the reduced-motion fallback — both
      falsified (a tier predicate returning `true` failed 2, swapping the
      animation order failed 2). Web suite **673 → 689**; typecheck 0;
      `ux_audit` PASSED; bundle green.
      **M20.A follow-up 10 — the sidebar minimize toggle, tablet AND desktop
      (DONE, measured in-browser @1440×900 / 1024×900).** M12 collapsed the
      sidebar to an icon rail automatically below 1150px, which left the
      labelled **224px** menu on every wider viewport with no control to reclaim
      it — and an iPad in landscape reports **>1150 CSS px**, so “tablet” and
      “desktop” both meant 224px. The rail is now a **state**
      (`.app.side-minimized`, one `--side-w` knob) that the tablet query only
      *defaults*: measured sidebar **224 → 60px** and content column
      **1216 → 1380px** (the 164px returned to the view), tabs 44px with a
      centred icon, and at 1024 the default is the rail with the toggle able to
      restore a 200px labelled menu. The **attention badge survives** collapse on
      the button's corner (verified with a real attention item: 24×28, inside the
      44px button and the 60px rail) — the old rail hid badges at ≤1150, the
      exact failure M20.A shipped badges to prevent. The toggle lives inside the
      sidebar (so the phone tier cannot show a dead control), is 44×44 on touch
      tiers, remembers the choice per session, and crossing into the tablet tier
      collapses once rather than fighting the user. Decision + tiers in
      `web/src/lib/nav.ts`; `sidebar-collapse.test.ts` (+10) pins the state/knob,
      the tier-only *default*, the badge, the touch floor and the absence of a
      width transition — falsified 4 ways. Web suite **689 → 699**; typecheck 0;
      `ux_audit` PASSED; bundle green.
      **M20.A follow-up — phone Notes view crowding (QUEUED, measured, NOT
      started).** Reported as "mobile view is too crowded"; a scan of all four
      phone tabs found Chat/Files/Personas clean and **Notes is the offender** —
      its chrome is deeper than the viewport (measured @390×844: toolbar 235px in
      **5 wrapped rows**, scope bar 128px in 3 rows, three stacked control
      cards, and the **search field 405px below the fold** at y 1249) with
      **3 controls under the 44px floor** (`Graph` 72×35, `Select` 71×35,
      `New project` 111×35). Proposed: hide the desktop explainer paragraph on
      phones (precedent: `.persona-theme-hint`), 2 toolbar rows with secondary
      actions behind a `⋯` overflow (precedent: the phone's More sheet), a
      one-row scope bar, and the 44px floor applied to the 35px controls. The
      only product call is moving 4 actions one tap deeper. Full measurements +
      *Exit:* in `PLAN-M20.md`.
      Verification record — plus the explicitly unverified list (no visual
      inspection; the `hover: none` branch not runtime-exercised; safe areas
      and keyboard unproven; no background/OS notification delivery; the two
      irreversible forget actions were **measured but never pressed**; whole-file
      `ux_audit` outstanding; geometry not a CI gate) — in
      `docs/VERIFY-MOBILE.md`. **All gates are now closed (D1–D5 + §12 Q1–Q12):**
      the owner directed that the blockers be cleared, and each now carries a
      decision with its consequence stated (`PLAN-M20-B.md` §6). Four are marked
      ⚠ because their cost lands on how the product is *used*, not just built:
      **D5** the Runner must be a machine the user owns (no shared/multi-tenant
      VPS in v1 — cost: the product assumes an always-on device); **Q2** user
      creation is local-only (cost: a remote owner cannot add a family member);
      **Q4** a mesh VPN is the supported path with cert-fingerprint pinning on the
      LAN fallback (cost: LAN-without-mesh is explicitly lower-assurance); **Q11**
      un-drained Runner results are expendable. Also decided: briefcases are
      tag-selected with **enforced** caps (≤ 20 items / ≤ 256 KB / ≤ 24 h TTL), the
      drain is **append-only**, the per-user layout uses **N rails** (so cross-user
      reads are structurally impossible rather than relying on every call site),
      `users`+`pairings`+`sessions` live in a **system DB** with today's
      `data/partner.db` treated as user #0, and the `extension` class is
      read+browser+chat only.
      **Deferred reviewer nits cleared, not deferred:** the guards file's
      duplicated allowlist (lifted to module scope behind a shared
      `declaredPartnerKeys()` — which surfaced a real `/^partner./` vs
      `/^partner\./` regex bug introduced during the edit), the unbounded
      `<ReactMarkdown` slice (now brace-depth-bounded, strictly stronger), the
      wrong `strip`/`clobber` rationale, and two false "no DOM harness"
      premises. The storage census's blind spot is narrowed: inline key literals
      passed to storage calls are now covered (with a non-vacuity proof); a key
      held in a *variable* remains invisible and is documented as such.
      Remaining: **M20.B (the server role) — scoped, every gate decided.** Slice
      plan in `PLAN-M20-B.md`; status table in its §3.0.
      **M20.B third wave (S7 WIRING) LANDED 2026-09-13 — a real phone can now
      obtain a mobile session.** `POST /v1/pair/payload` issues a 256-bit
      single-use secret to a **loopback** caller (and refuses without remote
      access + TLS, so no secret is ever carried over plaintext);
      `POST /v1/pair` accepts `{secret}` from anywhere and mints **`mobile`** —
      never `desktop` — while `{code}` is refused from a non-loopback **socket
      peer** *before* it is verified, so a remote caller can neither consume nor
      lock the code on the user's screen. Locality is the peer address, not the
      `Host` header (§2.1). Both paths are rate-limited per peer and a successful
      pair resets the bucket. Client half: the SPA reads `#pair=…`, re-validates
      the payload itself (https, canonical 32-byte base64url), confirms once and
      clears the fragment; the Providers screen issues links. Root suite
      1109 → **1131**, web 619 → **638**, typechecks 0, build green,
      `ux_audit` PASSED (24 pairs, light + dark), geometry measured at 1280/390
      in both modes (no overflow, 0 controls < 44px, copy 73 chars/line).
      **The audit also exposed a pre-existing defect, now fixed:**
      `.field::placeholder` used `--text-faint` (Lc 68.86 light / 48.02 dark,
      below the 75 floor) — placeholders are instructive text, so they now use
      `--text-muted` and `DESIGN.md` reserves `--text-faint` for disabled text.
      **Not done:** QR rendering (no encoder dependency — the link is shown as
      text), the shell-side "copy pairing link", and a real phone/TLS walk
      (env-gated). Issuing a link is loopback-only, so a deployment that turns
      remote access on needs a local loopback route to the allowlisted host
      (hosts-file alias) — stated in the UI copy and in
      `docs/VERIFY-M20-B.md`.
      **M20.B second wave (S4/S5/S6 WIRING) LANDED 2026-09-12:** the capability
      envelope now **enforces** — 21 route mounts, `ExecContext.clientClass`, and
      the refusal ordered **before** the grant check; the device registry
      (list/revoke/revoke-all, 404-not-403 across users, no token material on the
      wire); and the transport matrix (`REMOTE_ACCESS` + TLS files + a named
      `ALLOWED_HOSTS`, https listener, `startServer` re-asserting the refusal).
      Root suite 1066 → **1109**, typecheck 0, build green.
      **The review found three BLOCKERS — the envelope was bypassable three ways,
      all now fixed:** (1) the **approval queue** (`broker.decide` took an actor
      *label*, not a class, so a mobile session could approve a queued write and
      have it run, or acquire a grant via approve-and-remember); (2) the
      **persona/skill/playbook tool loops** reached the broker class-less, so a
      mobile *chat turn* executed with **desktop authority**; (3) **MCP server
      CRUD** was ungated while an enabled server is **spawned as a process** —
      code execution, which I had underestimated as configuration hygiene. Also
      fixed: the S5 transitional rule was keyed on the *caller* having no user, so
      a user-less session could read **and revoke a named user's devices** (now
      scoped to `user_id IS NULL` — identical today, hole closed for the future);
      `startServer` re-asserts the transport refusal; and an unmapped tool now
      fails closed for **every** class including desktop.
      **At the end of wave 2 enforcement was unreachable; the S7 wiring wave
      closed that.** As written at the time: **S7** (pairing secret +
      client-class delivery) was unwired, so a mobile session could only be
      minted in tests and `/v1/pair` minted `desktop` with `user_id` NULL.
      **Since the third wave (2026-09-13, above) a real phone can obtain a
      `mobile` session.** Remaining: **S8**, **S9**, plus the recorded
      vocabulary gap (provider key writes and autonomous firing have no capability
      name — a reviewed decision, not a tidy-up). Record:
      `docs/VERIFY-M20-B.md`.
      **Added after the gates closed — pairing is not authentication** (raised by
      the owner: the local desktop copy pairs, but a multi-user web version needs
      different handling). Verified: the only session mint site is
      `sessions.create('web', origin)` with **no user**, and `SessionRow` has no
      `user_id`, so pairing proves *device enrollment by proximity* and cannot
      answer *which user a session acts as*. Now separated into **enrollment →
      authentication → authorization**, with the rule that a session never carries
      a user without an authentication event. The **desktop copy is unchanged**
      (on a single-user install enrollment implies the OS-profile user #0, so the
      PairGate stays byte-identical); a multi-user core mints an acting session
      only after sign-in, and one device may hold sessions for several users, so
      revoke is per (device, user). Credential primitive: **per-user passphrase**
      (argon2id/scrypt in the system DB), passkey as a later adapter behind the
      same seam. **Sign-in doubles as the partition unlock event**, which resolves
      §4.4's operator-readable-store problem for a hosted multi-user core at a
      per-user, explicit, audited cost to headless schedules. This adds slices
      **S2a** (credentials) and **S9** (per-user unlock) and raises **S6**:
      **TLS is now a prerequisite for multi-user**, not only for remote access.
      Design: `PLAN-M20-B.md` §2a.
      **M20.B first wave LANDED 2026-09-12** (verification record:
      `docs/VERIFY-M20-B.md`). Built: **S1** per-user partition (incl. the
      legacy-user alias), **S2/S2a** `users` + `user_credentials` in a second
      encrypted **system DB** with scrypt credentials, **S3** session widening +
      rotation/revoke, and the **pure primitives** for S4/S6/S7. Schema v16 →
      **v18** (v17 tables, v18 session columns), each bumped once through the
      guarded-column migration surface. Root suite 901 → **1066**.
      **A MAJOR data-loss bug was caught by the review and fixed:** the plan
      asserted that the existing `data/partner.db` stays as user #0's partition
      while no code implemented it, so an install booting with `USER_ID=0` would
      have opened an **empty** DB under a new key and orphaned the real data.
      Fixed with a single `LEGACY_USER_ID` constant (`FIRST_USER_ID` derives from
      it, so they cannot drift) mapping that user to the legacy path, skills dir
      and `db-key` account. Also fixed from the same pass: Windows reserved
      **stem** names (`con.txt` etc.), a fail-OPEN `uncoveredHosts`, **wildcard
      SANs not matching** (which would have refused every real Let's Encrypt/mesh
      cert — now RFC 6125 single-label, with the `evil-example.com` suffix-attack
      as a test), the mobile envelope's three **indirect** routes to denied
      capabilities, a credential **timing oracle**, and a partition
      close-during-open race. `kind` was **not** widened.
      **CAVEAT as of wave 1 (superseded by the wave-2 entry below).** The
      users/credentials/system-DB work is not called by `createCore`; `/v1/pair`
      mints exactly as before with `user_id` NULL. So **no new control was in
      force after wave 1** — the envelope, TLS refusal, rate limiting and
      networked pairing were available, not active. Wave 2 (below) wired S4/S5/S6,
      and the third wave wired **S7**, so the delivery path now exists too.

- [x] **M21 — Container deployment + Cloudflare Tunnel (implemented + container-verified
      2026-09-13; detailed spec: `PLAN-M21.md`, record: `docs/VERIFY-M21.md`).**
      Partner runs headless in a container, in LIVE mode, and reaches the internet
      only through a Cloudflare Tunnel — no published port, no inbound rule, no
      cert to renew. Adds the one thing live mode was missing in a container: a
      **`file` keychain kind** (`KEYCHAIN_KIND=file` + `KEYCHAIN_FILE`; JSON,
      0600, atomic + serialised writes, malformed ⇒ refuse to boot, never
      re-key), plus one config hardening (an unknown `KEYCHAIN_KIND` is refused
      instead of silently meaning `native`). `docker/server/` ships the live
      image (non-root, S6 remote matrix: `REMOTE_ACCESS` + TLS + a named
      `ALLOWED_HOSTS`), the two-service compose, stage scripts that also generate
      the origin certificate, and three container-side tools (`healthcheck`,
      `pair-link`, `partner-request`). **Topology is a security property:** the
      tunnel sidecar keeps its OWN network namespace, because the pairing routes
      decide by socket peer (S7) and a shared namespace would make every internet
      request look loopback — an anonymous visitor could then mint a pairing
      secret. Pairing is therefore `compose exec partner node tools/pair-link.mjs`
      (operator shell access = the "at the machine" proof) and yields a
      **`mobile`** session; `desktop` class is unreachable in this shape (the
      coherent follow-up — letting a loopback-issued secret carry its intended
      class — is a reviewed capability decision, not taken here).
      *Exit: container boots LIVE (`demo=off`, schema v18) and reaches `healthy` ·
      a non-loopback peer redeems a secret for a `mobile` session while
      `/v1/pair/payload` and `{code}` stay 403 `loopback_required` · the session
      survives a container restart (volume + file key) and is refused
      `desktop`-only capabilities by class · both new test invariants falsified by
      injection · root 1131 → 1162 · web 638 · typechecks 0 · `ux_audit` n/a (no
      new UI).*
      *State: the Cloudflare edge leg, the dashboard's hostname settings and
      `stage.ps1` on Windows PowerShell were env-gated at the time of writing and
      are now **verified against a real tunnel** — the user deployed it at
      `partner.teliti.app` on 2026-09-13 and the whole path (edge → tunnel → core
      → pairing → mobile session → authenticated read) was checked in a browser.
      That live check found a **blocker the suite had certified**: the SPA's
      payload validator counted decoded CHARACTERS instead of BYTES, so every
      genuine pairing link was refused ("missing a valid certificate
      fingerprint") — the tests passed because their fixtures were ASCII filler.
      Fixed (byte-based canonical validation), fixtures replaced with
      `randomBytes(32)`, and the cross-module seam is now pinned by
      `tests/pair-payload-agreement.test.ts`; both fixes falsified by injection.
      A second defect of the same check: a pairing link pasted into an
      already-open tab did nothing (fragment-only navigation does not remount the
      SPA) — `PairGate` now listens for `hashchange`. Root **1166** · web **639**.
      Record: `docs/VERIFY-M21.md` ("Live deployment check").*

- [x] **M22 — Remote-hosted accounts, deployment-owned files, no llm-self-service
      (implemented + container-verified 2026-09-13; detailed spec: `PLAN-M22.md`,
      record: `docs/VERIFY-M22.md`).** Three changes for the hosted shape.
      **(1) Pairing → user login:** `AUTH_MODE=login` makes `POST
      /v1/auth/session` the only way in — a per-user passphrase (scrypt, system
      DB) mints a session that carries `user_id`, wrong-password and
      unknown-user are indistinguishable, 3 failures lock for 5 minutes, a
      per-peer limiter sits on top (behind a tunnel every request shares one peer
      address), and **the whole pairing lane answers 403**. Accounts are managed
      by the operator CLI `tools/user.mjs` (shell access = the "at the machine"
      proof); **one user per core is enforced** until per-user partitions (S1/S8/S9)
      land, because two accounts would share one database. The desktop pairing
      shape is unchanged. **(2) Deployment-owned roots:** `FIXED_ROOTS=/files`
      registers the mount at boot (idempotently — grants reference the root by id)
      and `POST`/`DELETE /v1/roots` answer `403 roots_fixed`; a non-directory root
      fails the boot; the Files view renders read-only. **(3) llm-self-service
      removed** from core, web and `shared` (the `ProviderSource` value stays so
      old rows read), which also closes **S0** as obsolete.
      *Exit: container-verified through the user's tunnel — account created by
      CLI, sign-in returns a `desktop` session, `/v1/roots` read-only, and a
      brokered write into `/files` completes proposal → approval → file on the
      volume · login gate walked in a browser (fields, disabled submit, sign-in →
      workspace, only token/theme/authMode stored) · root 1166 → 1184 · web 639 →
      635 · typechecks 0 · build green.*
      **R-slice (same session):** the recommendations were then built except R5
      (Cloudflare Access, skipped by request). **R1 per-user partitions** — a
      partition IS a single-user core (its own encrypted database, key and skills
      directory): the listening app authenticates against the shared system
      sessions and **delegates** every other `/v1` request to that user's app, so
      not one of the ~200 routes changed. Two users are provably isolated
      (`core/test/http/userPartitions.test.ts`: a read in one partition cannot
      contain the other's rows; separate `db-key:<id>` keys; per-user audit and
      skills), and the rails' LRU/idle/close semantics are unit-tested. **R2**
      rotation revokes that user's sessions. **R3** `PARTITION_IDLE_MS` closes idle
      partitions — memory hygiene, documented as exactly that. **R4**
      `CLIENT_IP_HEADER` + `TRUSTED_PROXY_CIDRS` give per-client auth rate limiting,
      believed only from a trusted peer and never used for a locality decision.
      **R6** `FIXED_ROOTS_READ_ONLY=1`. **R7** `MAX_UPLOAD_BYTES` /
      `MAX_JSON_BYTES` — and the upload cap is now the *upload* cap: the file
      bytes are the request body (`express.raw`, content type = mime,
      `x-attachment-name` = the name), so 8 MiB is reachable. Until 2026-09-14
      uploads rode a base64 JSON envelope and were really capped at ~768 KiB by
      the 1 MiB JSON limit, which is what refused iPhone photos; the 413 now
      names the file, its size and the limit, and `/v1/health` publishes
      `maxUploadBytes` so the SPA refuses before uploading
      (`docs/VERIFY-M22.md`, `core/test/http/attachmentUploadLimit.test.ts`).
      **R8** a verified backup tool (`VACUUM INTO` +
      `integrity_check`, exits non-zero when it cannot verify, prunes to `--keep`).
      **R9** the vocabulary gap is closed (`provider.configure`, `persona.run`).
      Root 1184 → **1204**, web 635, typechecks 0.
      **S1/S9 (PLAN-M20-B):** S1 verified end to end (the rails are its missing
      caller) and **S9 landed** — schema v19 wraps the partition key under the
      passphrase (own salt + HKDF, so the stored verifier cannot unwrap it),
      removes the plaintext at first sign-in, refuses a locked partition with
      `401 partition_locked`, closes the handle with the key, and offers the
      per-user AUDITED `keep-unlocked` opt-in. **S8 (Vault/Runner) NOT done** —
      deliberately not half-landed. Root 1204 → **1215**.
      **Sign-up (invite lane, 2026-09-14):** a hosted person can now create their
      OWN account, so the operator never types their passphrase — the one thing
      `tools/user.mjs add` could not avoid. `SIGNUP_MODE=invite` (default `off`,
      needs `AUTH_MODE=login`) enables it: the operator mints a 256-bit single-use
      invite on the machine (`tools/signup-link.mjs` → `POST /v1/signup/code`,
      loopback-only, the same secret primitive as the pairing link) and sends
      `https://<host>/#signup=<code>`; `POST /v1/auth/signup` consumes it and
      creates the users row + scrypt credential exactly as the CLI would (`0` for
      the first account), returning **no session** — sign-in stays the single
      authority path. Validation is shared (`shared/src/accounts.ts`), the shape
      checks run BEFORE the code is spent (a typo must not burn a one-time
      invite), a taken name is a 409, and neither the name nor the passphrase
      reaches a response or an audit row. **There is deliberately no `open`
      mode:** a hostname the internet reaches is reachable by anyone, and "who may
      reach it" is not "who may create an account" — the operator's invite is the
      decision. Root 1215 → **1229**, web 699 → **712** (a container-shaped walk
      found the fresh-tab invite path rendering an empty code field; seeded from
      one shared helper now, with the invariant pinned in `web/test/signup.test.ts`).
      Record: `docs/VERIFY-M22.md`.
      **The Windows `userPartitions` failure — two real defects, both fixed
      (2026-09-15).** Five partition tests failed on every `verify (windows)` run
      while linux passed, with `Cannot read properties of null (reading 'port')`
      in the test's own boot helper. **(1) `listen()` resolved a core that was
      never listening:** `app.listen(port, host, cb)` calls `cb` even when the bind
      FAILED (Windows/Node 25), so a taken port resolved the boot, printed "up on
      …" and served nobody, and the real `EADDRINUSE` was discarded (its `reject`
      ran after the promise had settled). Readiness now comes from the `listening`
      event and failure from `error`, so a taken port rejects the boot by name
      (`core/test/listen.test.ts`). **(2) `PORT=0` silently became 4390**
      (`readInt` falls back to the default for anything out of range), which is why
      three core test files depended on 4390 being free — a leak from an earlier
      e2e run, or a dev core, broke them. `loadConfig` now REFUSES a malformed or
      out-of-range `PORT` (0 included) with the reason a caller must name the port
      (the loopback allowlist is derived from it), and those tests bind a **named
      free port** (`freePort()`); teardown drops keep-alive sockets before waiting
      (`closeServer`), which also removed the `EPERM` on the temp dir. Windows root
      suite **1254 passed / 5 failed → 1262 passed / 0 failed** (5 env-gated
      skips); no assertion was weakened.
      *State: still open — S8, a device/sign-out UI, per-user quotas; unverified — a two-user browser walk,
      R4 against the real Cloudflare edge, an R8 restore, and R3's live timer. See
      `docs/VERIFY-M22.md`.*

- [x] **M23 — Scorecard chat answers (implemented + verified 2026-09-15).**
      A fourth answerable container joins choices and free-text forms:
      `:::partner.scorecard` rates several named items on one shared numeric
      scale so the user answers a multi-item review in a single pass. Grammar:
      one item per bullet line, `scale=<2–10>` (default 5) is the highest score
      with scores running 1..scale, and an optional `labels="Low|High"` names
      the ends. One radio group per item makes one-score-per-item structural.
      Submitting once sends a single labelled user turn
      (`Q: <item>` / `A: <score>/<scale>`) through the normal chat path —
      nothing client-only, persisted text unchanged. The parser lives in
      `shared/src/structured.ts` beside the other containers
      (closed-container-only materialization; malformed or unclosed blocks
      degrade to prose; a bad scale clamps rather than dropping the card).
      `ScorecardCard` is answerable in the M20.A one-submit group — grouped
      scorecards require every item rated, while a standalone card accepts any
      non-empty rating set — and pending ratings survive conversation switches
      via the existing per-conversation UI memory. The `scorecards` guidance
      ships in the default structured feature set; styles are token-only
      (`accent-emphasis`/`accent-contrast` selected state, `--target-min`
      targets, one column on phones). *Exit: shared 16 · web
      722 · core `instructions.test.ts` green · typechecks 0 · web build
      green. (The root suite's scrypt-heavy auth/partition files time out under
      parallel CPU load both at HEAD and here — a pre-existing environment
      flake, green in isolation with a raised timeout.)*

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
- No multi-user *server* mode as a hosted multi-tenant service: one operator,
  several users on their own core, isolated by partition (M20) — still no
  Partner-hosted accounts, and still no Partner cloud.
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
9. ~~**M20 §12** — the M20 decision gates~~ **RESOLVED 2026-09-12.** Every gate
   carries a decision with its consequence stated: `PLAN-M20.md` §11 (D1–D5) and
   §12 (formerly-open questions 1–12), execution detail in `PLAN-M20-B.md` §6.
   Four are marked ⚠ because their cost lands on how the product is *used*
   (D5, Q2, Q4, Q11) and are worth revisiting deliberately.
10. ~~**M20/§3.1** — Runner: the user's own machine or a shared VPS?~~
    **RESOLVED: the user's own machine.** A shared/multi-tenant VPS is out of v1
    scope, so briefcase caps are blast-radius reduction rather than the primary
    control, and TPM sealing is optional. *Cost accepted:* the product assumes
    the user runs an always-on device; without one, schedules only fire while the
    Vault is awake — plain Model A, not A′.
11. ~~**M20/§8.1** — does remote access need an explicit consent screen?~~
    **RESOLVED: yes** — local-only, plain-language risk line, cannot be flipped
    from a remote session, and switching it off invalidates remote sessions
    immediately.
12. **M20/§4.4** — if Model A′ is ever rejected, the fallback secret store is
    an operator envelope or passphrase-derived keys (the latter breaks M14
    headless runs). Recorded so it is never defaulted.
13. ~~**Pairing vs authentication for a multi-user web version**~~ **RESOLVED
    2026-09-12** (raised by the owner: the local desktop copy pairs, a multi-user
    web version cannot use pairing as its identity mechanism). **Pairing proves
    device enrollment by proximity; it cannot answer which user a session acts
    as** — verified: the only mint site is `sessions.create('web', origin)` with
    no user, and `SessionRow` has no `user_id`. Now separated into **enrollment →
    authentication → authorization**; a session never carries a user without an
    authentication event. The **desktop copy is unchanged** (enrollment implies
    the OS-profile user #0), and the credential primitive is a **per-user
    passphrase**, with passkey a later adapter behind the same seam. **Sign-in is
    also the unlock event**, which resolves §4.4 for the hosted case without an
    operator-readable store — at a **per-user, explicit, audited** cost to
    headless schedules. Design: `PLAN-M20-B.md` §2a; decisions 13–16 in
    `PLAN-M20.md` §12.
14. **M20.B remaining work** (status table: `PLAN-M20-B.md` §3.0). Two items,
    in the order I would take them — **S7 wiring is DONE** (2026-09-13, §15 M20
    and `docs/VERIFY-M20-B.md`), so the reachability gap it closed is no longer
    on this list:
    - **The capability vocabulary gap — a decision, not a tidy-up.** Provider
      **key writes** (`/v1/providers/:id/key`, self-service connect, search key)
      and **autonomous firing** (playbook run, schedule run-now) have **no
      capability name**, so they are ungated for *every* class. The ten existing
      names cover the machine-power surfaces; the data plane (notes, memory,
      personas, conversations) is ungated **by design** because a phone may
      legitimately edit its own data. Naming the two power surfaces
      (`provider.configure`, `persona.run`) changes what a mobile/extension
      session can do, so it wants a reviewed change. The route header in
      `core/src/http/server.ts` states the gap so it is not misread as coverage.
    - **The upgrade rehearsal — do this before anyone sets `USER_ID`.** The
      legacy-partition alias (user #0 owns `data/partner.db`, `data/skills` and the
      `db-key` account) is asserted by unit tests but has **never been exercised by
      a real file-DB boot with `USER_ID` set**. That is the one path where being
      wrong means silent data disappearance rather than an error, so rehearse it
      against a copy of a real data directory first.
