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

> **How to read this file.** It is long on purpose — it is the design reference.
> Read only what you need: **§15** is the compact milestone index (status,
> spec pointer, exit) and **`docs/UNFINISHED.md`** is what is left. Jump to §4
> architecture, §8 memory, §12 data model, §13 API surface for the relevant
> design. Release history is `CHANGELOG.md`; the pre-2026-09-18 long-form
> milestone log is archived in `docs/HISTORY.md`.

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
- **Vision capability is declared, not guessed (M24).** A model receives an
  attached photo when the user declared it capable on its provider — the
  per-model ticks (`providers.vision_models`), or any model pinned to a
  `vision`-purpose profile — or when its id matches a known vision family
  (`shared/src/vision.ts`). The declaration must win because an
  OpenAI-compatible gateway's model ids are **operator-chosen aliases**
  (LiteLLM's `model_name`): a name-only rule decided "text" for models that
  can see, the image part was never attached, and the persona reported that
  no image had been sent. One decision function (`isImageCapableModel` +
  `declaredVisionModels`) serves the core's gate, the reroute resolver, the
  chat picker and the capability chips.
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
| **Profile** | Facts & preferences: name, languages, timezone, tone/verbosity/format prefs, "do/don't" rules, writing style samples | Partner **auto-detects** suggestions (global or persona-scoped); **user confirms each**; manual edits | Highest trust; drives tailoring; `persona_scopes` empty = global, else the personas it names — **multi-select** (M19 scoping, M33 multi) |
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
  (M33: an EMPTY `personaScopes` array — name, role, language, standing
  tone/format rules, so it tailors every persona) or **persona-scoped** (only
  that persona). The extractor prompt is fixed, parsing/caps/secret-filter are
  defensive, and audit rows carry ids/counts only. Before suggesting, the
  extractor reviews a
  bounded `ALREADY KNOWN` listing (the confirmed and still-pending facts the
  persona honors — global + its own scope, capped) and must not re-propose
  them; a punctuation/case/space-insensitive dedupe keeps an already-known or
  already-suggested fact out of the store — so the same suggestion is never
  filed twice. **Rejected** facts (M32) ride a second, same-scope `REJECTED`
  listing (`formatRejectedBlock`) so the model does not re-ask a declined fact
  even in fresh wording; the deterministic dedupe stays the guarantee. The
  Memory view loads rejected entries (`GET /v1/memory/profile?includeRejected=1`)
  into a collapsed **Rejected** panel with Restore, and a pending suggestion
  carries a one-step "applies to" control so it can be scoped without opening
  the editor — since **M33** that control is the same multi-select checkbox set
  the add/edit forms use, so a fact can be shared by several personas.
- **Multi-persona scope (M33):** `personaScopes: string[]` replaces the
  single `personaScope` (empty = every persona; one id = private; two or more
  = exactly those). Tailoring, auto-remember's known/rejected/dedupe listing
  and the `?personaScope=` filter all read it as membership, so a shared fact
  is honored by each persona it names. The pre-M33 `personaScope` string/null
  is still **accepted on input** (an old caller or exported bundle maps to
  `[id]`/`[]`) and an old file's column is backfilled into the array on the
  open that crosses v24.
- **Forgetting:** per-entry delete, per-store wipe, or "forget everything
  before <date>". Memory exports as JSON/Markdown. A rejected fact is tracked
  (visible under **Rejected**) and never re-suggested.
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
- **Authoring (M26, planned — `PLAN-M26.md`).** The gallery is the *install*
  half; M26 adds the *make* half. A **draft** is an inert, editable bundle
  (stored as rows in the user's own encrypted DB, never a directory) that the
  user describes in chat (`skills.draft`) or in the **Skill Studio**
  (AI-assisted generation from the configured provider, or a template, so it
  works with no provider configured). Validation is deterministic and never
  executes code; a sandboxed **dry-run** returns the worker's own logs; and
  **install is the owner's act on both surfaces** — the Studio button, or an
  approval card in the chat the persona asked from (`skills.requestInstall`
  writes a `pending_tools` row of kind `skill_install`, and Approve calls the
  same `promote()` the Studio calls). The same door accepts an **UPDATE**: a
  persona passes the installed skill's id as `skillId` to `skills.draft`, the
  core opens that skill's `edit` draft, and the owner approves the change from
  the same card — which shows the permission summary, and the before→after table
  for a widening update, before it can send the acknowledgement. Installed
authored skills carry
  `source:'authored'`; a widened permission set on update forces re-consent on
  either path; unsigned bundle export/import lands as an inert draft (signing
  deferred). Capability `skill.author` is desktop-only; `network` stays refused.
  The *pure* and *reads-files* templates ship here; the *notes* and *MCP*
  templates need capabilities no skill had yet and landed with **M27 S4**
  (`notes-checklist`, `mcp-call`), each gated on the capability the picker reads.
- **What a skill may reach (M27 — `PLAN-M27.md`; S1 + S2 + S3 + S4 + S5 landed).**
  **Landed (S2, 2026-09-17):** a manifest may declare
  `permissions.mcpServers` and the sandbox can call an **enabled** MCP server's
  tools as `partner.tools.exec('mcp:<server>/<tool>')`. Declared per SERVER,
  never per tool name (a server is configured later, so a manifest must not
  name a tool that does not exist yet); needs a **medium-or-higher** ceiling
  (an MCP tool's own risk is unknowable in advance) refused at **validate**
  time; de-duplicated and capped at 8; and every failure is a **coded refusal**
  (`mcp_not_declared` / `mcp_disabled` / `upstream` / `capability_denied`) with
  **no pending row** — skills are non-interactive, so a server must be enabled
  BEFORE the run — and **one `mcp.call.denied` audit row per refusal** naming the
  server id and the code, because the invocation itself succeeds when the entry
  catches the denial. The `mcp.call` class envelope is checked FIRST, above the
  declaration, so a phone learns nothing about what is configured behind it —
  which closes **D7's MCP half** of the gap M20-B S4 recorded. The seam lives
  in `core/src/mcp/skillReach.ts` and is injected at the composition root, so
  `skills/` still never imports `mcp/`.
  **Landed (S1, 2026-09-17):** `ToolScope` is `{kind:'project'} | {kind:'app'}`
  and three read-only app tools (`notes.list/search/read`, mapped to the
existing `file.read` capability — **no new capability name**, so mobile keeps
  the reach it already had) resolve against a reserved `APP_SCOPE_ID='app'`
  instead of a project root, with rootless app grants beside the roots in the
  same grant surface (an **App data** group). `RuntimeCapabilities` gained the
  `notes` key the two reach templates gate on. **Landed (S4, 2026-09-17):** the
  last slice — the *notes* and *MCP* Studio templates. `notes-checklist`
  declares the three app-scoped read tools and reads the user's notes through
  them with **no `projectId` and no root** (the grant is keyed on
  `APP_SCOPE_ID`, which is what the picker's **App data** group consents to);
  `mcp-call` declares one MCP server and calls one of its tools as
  `partner.tools.exec('mcp:<server>/<tool>', args)` at the D6 `medium` ceiling.
  Each template carries the `requires` key its visibility is gated on —
  `notes` / `mcp` — and the omission is asserted in BOTH directions, including
  through the drafts door the picker actually calls. Both bundles were held to
  a real RUN: the notes template goes through a Studio dry-run in the real
  sandbox against a real granted note (and reports the coded `tool_denied`
  refusal without the grant, queueing nothing), and the MCP template runs
  against a local stdio server. Server ids are generated when a server is
  added, so the MCP manifest ships a placeholder id — the one field the author
  replaces — and the run test performs that same edit.
  **Landed (S3 + S5, 2026-09-16):** the **session client class now reaches the
  runner** for broker calls (read from the session row by both routes in, so an
  already-granted write can no longer walk a phone through the envelope — the
  M20-B S4 gap is closed for the broker — **and, since S2, for the MCP path
  too**), and
  **model reach** is live: `permissions.llm` enables `partner.llm.complete`,
  the skill's own `budget.maxTokens` is finally **enforced** (declared and
  validated since M8, never read until now) with a documented 4096 default, the
  invocation's tokens are **ledger-charged**, and `skill.llm` is a desktop-only
  capability — so a skill can send what it read to the configured provider,
  **declared and bounded**, never ambient (`docs/VERIFY-M27.md`).
- **Flow authoring (M28, slices A–F landed — `PLAN-M28.md`,
  `docs/VERIFY-M28.md`).** The Studio
  gains a fourth
  surface: a React Flow canvas (the dependency is already in `web/`, used by
  `NotesGraph.tsx`) where a skill is a graph of ten typed nodes and the model
  can build it, the user can draw it, and the model can refine it as a
  **proposal the user accepts or rejects**. The load-bearing constraint: a flow
  is **not a second kind of skill** — it compiles deterministically to
  `entry.mjs` (same artifact, same sandbox, same hash check, no flow
  interpreter), so the emitted code is held to the unmodified install gates.
  The vocabulary is deliberately not a programming language (no loops, no
  arbitrary expressions) and the compiler is total; expressions are a validated
  path grammar plus fixed operators, so an AI-written graph **cannot inject
  code**. `permissions.tools` and `permissions.llm` are derived from the graph,
  and flow/code coherence is a derived comparison against the last compile, not
  a flag. The `llm` node needs M27 S5, which landed, so the palette is the full
  ten nodes; a node type a build cannot compile is omitted from the palette and
  the core tells the canvas which (`llmAvailable` on the flow read). Because
  React Flow has no keyboard path to creating an edge, the Flow tab ships an
  equivalent **Nodes table** over the same document, and a `tool` node's `args`
  are editable there.

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
| `providers` | endpoint profile (no key material; `keyRef` only) + declared image-capable model ids (M24) |
| `personas` | persona JSON (§5) + independence/schedules, capability policy |
| `profile_entries` | user Profile facts (confirmed/suggested/rejected; `persona_scopes` JSON id array, empty = global — M33; legacy `persona_scope` column superseded, backfilled on the v24 open) |
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
| `skill_drafts` | authored skill bundles in progress: manifest text + entry code + the deterministic validation result. **Inert** — nothing runs or installs from here until `promote` (M26 cut A, schema v21). M28 C–F (v22) adds `flow_json`/`flow_sha256`/`flow_compiled_at`: the graph a Flow-authored draft was drawn as and the hash it last compiled to — staleness is derived on every read from those plus a recompile of the current graph, never stored, and `origin` may read `'flow'` |
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
| `users` | local accounts: the data-partition root, OS-profile mapping, disabled flag, **`role`** (`owner`/`member`) and **`key_access`** (`own`/`shared`) — in the **system DB**, not a per-user DB, because it must exist before a user is resolved (M20.B S2; M29 roles) |
| `user_credentials` | per-user passphrase credential: salt, scrypt params, derived key, failure bucket and lock window. Stores **no passphrase** (M20.B S2a) |
| `pairings` / `sessions` | device/origin pairing + session tokens; sessions gain `user_id`, client class, device label/platform and `rotated_at` (M20) — **`kind` is deliberately NOT widened**: it is the audit actor for 7 routes |
| `invites` | single-use, expiring invitations minted by an owner (or the loopback operator tool). Stores the code's **SHA-256 only** plus the `role`/`key_access` the redeemer gains — sign-up reads them from this row, never from the request (M29) |
| `shares` | cross-user note/asset shares as **snapshot copies** in the system DB (owner id, kind, resource id, grantee id, title, body, meta, revoked_at), so a grantee never opens the owner's partition and a share stays readable while its owner is signed out (M29) |
| `shared_access` | key/value holding the deployment's published provider + search configuration. Secrets live in the deployment keychain under `shared-provider:`/`shared-search:` accounts; only non-secret JSON is here (M29) |
| `audit_log` | append-only activity |

Schema is `v24` (additive; guarded `ALTER ADD COLUMN` via `ensureColumn` for
`personas.policy`/`home_folder`/`schedules`, `providers.purpose`/
`vision_models`, `conversations.folder_id`/`parent_id`/`source_asset_id`,
`messages.content_type`, `pending_tools.conversation_id`/`persona_id`/**`kind`**/
**`draft_id`**, `profile_entries.persona_scopes`, and — M20.B —
`sessions.user_id`/`client_class`/`device_label`/
`platform`/`rotated_at`).
`v17` added the `users` + `user_credentials` tables; `v18` added the session
columns; `v19` (M20-B S9) added `key_wraps` (the passphrase-wrapped partition key)
and `users.keep_unlocked` (the per-user, audited opt-in that keeps a key in the
keychain so that user's schedules can run while nobody is signed in); `v20` (M24)
added `providers.vision_models` — the models the user declares image-capable, so
a gateway alias can receive photos. A pre-v20 row reads `NULL` = nothing
declared, which is exactly the old name-only behaviour (an upgrade never invents
a capability).

**v21 (M26 cut A, landed):** adds `skill_drafts` (an authored bundle's editable
`manifest_text` + `code` + its deterministic validation result) and two
`pending_tools` columns (`kind`, `draft_id`) so a persona's install ask can ride
the approval queue that already exists — `PLAN-M26.md`. **Planned v21 (M27):**
no further table — app-scoped grants reuse the reserved `projectId='app'` —
`PLAN-M27.md`. **v22 (M28 cut B, landed):** three additive columns on
`skill_drafts` (`flow_json`, `flow_sha256`, `flow_compiled_at`) so a Flow-authored
draft keeps its graph and derives staleness against the code it compiled to —
`PLAN-M28.md`. `flow_json` holds the `SkillFlow` document itself; `flow_sha256`
is the hash the flow LAST compiled to, and **staleness is derived on every read**
(never stored) as "the code is not what the CURRENT graph compiles to": the code
side is compared to the recorded hash and the graph side is recompiled, because a
canvas save never touches `code` (a graph edited after a compile used to read
fresh — `docs/VERIFY-M28.md` §3.1). `origin` gained the value `'flow'`. Guarded
`ensureColumn`, so a v21 DB opens unchanged and pre-v22 rows read `NULL` = no flow.

**v23 (M29, landed):** adds `users.role` (default `'owner'` — an existing account is its deployment's owner) and `users.key_access` (default `'own'`), plus the `invites`, `shares` and `shared_access` tables. Additive: a v22 DB gains the two columns on its next open and the tables via `CREATE TABLE IF NOT EXISTS`, and a pre-v23 row reads as an owner with its own credentials — exactly the pre-M29 behaviour. `PLAN-M29.md`.

**v24 (M33, landed):** adds `profile_entries.persona_scopes` (JSON id array;
`NULL`/`[]` = every persona) so one profile fact can be shared by several
personas. The pre-M33 `persona_scope` column is **left in place but no longer
read or written**: the one open that crosses v24 backfills each legacy
single-scope row into a one-element array (`backfillPersonaScopes`, version-gated
via the recorded `schema_version`, so a later open can never resurrect a scope the
user has since widened to all personas), and a row with no legacy scope stays
`NULL` — which still reads as "every persona". Additive `ensureColumn`, so a v23
DB opens unchanged; ids are JSON-encoded in JS rather than with SQLite
`json_array()` so the migration needs no JSON1 build.

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

M26 cut A **landed** (implementation status: `PLAN-M26.md` §State,
measured record: `docs/VERIFY-M26.md`). Live now:
`GET /v1/skills/templates` · `GET|POST /v1/skills/drafts` ·
`GET|PUT|DELETE /v1/skills/drafts/:id` · `POST /v1/skills/drafts/:id/validate` ·
`POST /v1/skills/drafts/:id/install` · `POST /v1/skills/:id/fork` and
`POST /v1/skills/:id/edit`. `skill.author` gates authoring (desktop-only) and
`skill.install` gates the promote. Registered before `/v1/skills/:id`. Also live
(2026-09-18): `/run` (dry-run), `/request-install` (the `kind:'skill_install'`
branch on `POST /v1/tools/pending/:id`, which now also carries
`acknowledgePermissions` for a widened update), `/bundle` export and `/import`.
**A persona can propose an UPDATE**: `skills.draft` takes an optional `skillId`
(an INSTALLED skill), which opens the skill's `edit` draft through
`SkillDraftManager.openUpdate()` — the same row `POST /v1/skills/:id/edit`
manages — so the manifest keeps the installed id binding and promoting it is an
update. The ask rides the same queue row; the approval card (chat + Files queue,
`web/src/SkillInstallCard.tsx`) renders the draft's permission summary and, when
the update widens, the before→after table — and sends
`acknowledgePermissions` only once that table is on screen.
M27 **S1 landed**: app-scoped grants reuse `POST /v1/grants` with the reserved
`projectId:'app'`, accepted only for an app-scoped manifest and **refused for a
`files.*` tool** (and an app-scoped tool refuses any other projectId), so `app`
can never become a root alias — `PLAN-M27.md`. The app tools
(`notes.list`/`notes.search`/`notes.read`) dispatch through `POST /v1/tools/exec`
like any other broker tool. M27 **S2 also adds no route**: an MCP call from a
skill reuses the skill's own `tools.exec` channel (`mcp:<server>/<tool>` spotted
by the runner and dispatched to the MCP seam), and the server it reaches is
configured and enabled through the existing `/v1/mcp` surface. M27 **S4 also
adds no route**: the Studio picker reads the existing `GET /v1/skills/templates`,
whose list is derived from the capability object (`pure`, `reads-files`,
`notes-checklist`, `mcp-call` when every reach is wired — and never a template
whose reach this build cannot honour).
M28 adds the Flow surface under `/v1/skills/drafts/:id/flow` (schema v22, slices
A–F landed): `GET` · `PUT` · `/compile` · `/refine` · `/from-code` · `/explain`,
plus the `mode:'generate-flow'` value on the M26 create route. A graph can be
drawn in the Studio, generated from a description, refined by the model as a
proposal the owner accepts or rejects, compiled into `code` with the permissions
derived from it, and installed/run over HTTP — `PLAN-M28.md`,
`docs/VERIFY-M28.md`.

M29 (schema v23, all in the GATEWAY so they answer before per-user delegation)
adds the multi-user lifecycle: `POST /v1/auth/signout` (revokes the session AND
closes the user's partition — on a login core the token is not the only thing
that goes) · `GET /v1/account` (id, label, role, key access — never a
credential) · owner-only `GET /v1/users` · `GET|POST /v1/invites` and
`DELETE /v1/invites/:id` (single-use invitations; only the hash is stored, and
`role`/`key_access` come from the invite ROW at redemption, so a redeemer cannot
escalate) · owner-only `GET|PUT|DELETE /v1/shared-access` (publish the
deployment's provider/search configuration for members with `keyAccess:
'shared'`; secrets move to `shared-*` keychain accounts and the fallback is
read-only and only while the member has none of their own · sharing
`POST /v1/shares`, `GET /v1/shares/sent|received`, `GET
/v1/shares/received/:id`, `POST /v1/shares/:id/refresh|import`, `DELETE
/v1/shares/:id` (snapshot copies in the system DB, so no cross-partition read
ever happens) · `POST /v1/signup/code` keeps its loopback operator mint while
`POST /v1/auth/signup` also redeems an owner-minted invite even when
`SIGNUP_MODE=off` — an owner's explicit admission decision needs no deployment
switch · `PLAN-M29.md`, `docs/VERIFY-M29.md`.

Later milestones extend this surface: providers by purpose
(`/v1/providers/discover`, `/v1/providers/purposes` — M13) and edited in place
(`PUT /v1/providers/:id` — M24, non-secret fields only: model lists, vision
declarations, purpose, name, enabled, budget). M25 reconfiguration adds **no
route**: it rediscover-an-existing-endpoint read is `GET /v1/models?provider=<id>`
(uses the stored keychain key) and each reassignment reuses
`PUT /v1/providers/:id`; live desktop
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

M24 separates the **two byte budgets a photo meets**, which is what made photos
vanish: `maxUploadBytes` (8 MiB) is what the core will *store*,
`maxInlineImageBytes` (`MAX_INLINE_IMAGE_BYTES`, 3 MiB, shared) is what can
*ride a turn to the model*. Fitting the first produced files that stored,
thumbnailed and were then dropped from the request. `/v1/health` now publishes
both, and the composer encodes any image-shaped upload down to the smaller one
(a 6 MB JPEG is resized rather than silently withheld), so what you attach is
what the model receives. An image that still cannot ride is described to the
model as **NOT sent** instead of reading like a successful attachment.

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

> **Maintenance rule.** `PLAN-M<N>.md` holds the detailed spec for a milestone;
> this section is the master index — status, a one-paragraph description, an
> `*Exit:*` line and the spec pointer. Whenever a module/milestone is added,
> changed or completed, update its entry here plus the affected design sections
> (§8 memory, §12 data model, §13 API surface, §14 stack), `README.md` and
> `CHANGELOG.md`. `[x]` only when the full exit is locally green; `[ ]` + a
> `*State:*` line when an env-gated walk remains.
>
> **Unfinished work across milestones is consolidated in `docs/UNFINISHED.md`**
> (the review list: what is left, why, the dependency order, the exact entry
> points, and every env-gated walk that was never run). Start there.
>
> The full historical milestone log (measurements, follow-ups, review notes)
> was moved out of this section on 2026-09-18 and lives verbatim in
> `docs/HISTORY.md`.

- [x] ~~**S0 — Self-service companion API**~~ **CLOSED as obsolete in M22** — the
      llm-self-service import it existed to unblock was removed (§2), so the
      companion endpoints are no longer wanted. Nothing was built in that repo.
- [x] **M0 — Scaffold, Tauri shell & security spine** (`PLAN-M0.md`). Repo
      layout, shared types, vitest, config/.env patterns, keychain abstraction
      (fake keychain for tests), pairing codes + session tokens, origin
      allowlist; Tauri v2 shell scaffold + core-sidecar packaging spike
      (resolves §17.1). *Exit: two processes pair and echo a chat round with a
      demo fake provider; the packaged app opens and serves the UI on loopback.*
- [x] **M1 — Providers, gateway & key import** (`PLAN-M1.md`). Provider CRUD,
      OpenAI-compatible client (SSE streaming, header scrub, neutral UA), routing
      by task class + fallback, budget caps, usage surfacing, and the
      llm-self-service import wizard (removed in M22). *Exit: real chat against a
      user-supplied endpoint in demo mode.*
- [x] **M2 — Tool broker & files** (`PLAN-M2.md`). Tool manifests, grant store,
      risk tiers, confirmation UX, project roots, read/search/write-preview/apply
      with backups, audit log. *Exit: user grants a root; partner proposes a diff
      in a temp file; UI review; apply.*
- [x] **M3 — Chat + persona engine v1** (`PLAN-M3.md`). Conversation UI (SSE),
      persona CRUD, independence levels + pause/kill, model routing per persona.
      *Exit: two personas with different characters/autonomy respond
      appropriately.*
- [x] **M4 — Memory & profile** (`PLAN-M4.md`). Profile facts w/ user
      confirmation, episode summaries, semantic index, tailoring loop,
      forgetting + export.
- [x] **M5 — Plans & notes** (`PLAN-M5.md`). Stores, editors, wiki-links, daily
      note summary, plan execution with approved diffs.
- [x] **M6 — Theming** (`PLAN-M6.md`). `theme/v1` schema, presets, Theme Studio,
      token lint + APCA/WCAG gate on save, DESIGN.md component compliance.
- [x] **M7 — Extension bridge & search actuator** (`PLAN-M7.md`). Native
      messaging host, pairing, page capture, per-site scopes, sensitive-site
      blocklist, "partner this page", search-engine capture for research.
- [x] **M8 — Skills runtime** (`PLAN-M8.md`). Manifest + signing + hash verify,
      sandboxed workers, permission enforcement, audit, install/update/uninstall
      flows, local catalog + registry protocol.
- [x] **M9 — Capability playbooks** (`PLAN-M9.md`). Research, vibe-code, docgen,
      email draft, presentation, analysis, design-prototype flows wired to
      personas; the Ship/deploy playbook; the optional API-key search adapter.
- [x] **M10 — Hardening & alpha** (`PLAN-M10.md`). Encryption-at-rest,
      redaction sweep, budgets enforcement, audit UI, degrade-mode chat, NSIS
      packaging, demo mode + verification checklist + docs.
- [x] **M11 — Chat as the workspace** (`PLAN-M11.md`). Attachments + granted-root
      file references + multimodal image parts; chat tool execution (directive +
      native `tool_calls`), MCP stdio client, API-key internet search; persona
      skill/tool policy; purpose providers; choices; markdown→HTML; follow-latest;
      Assets; chat folders; per-conversation themes + extension theme stream;
      Notes lane; A/B persona studio; tabbed Code/Preview HTML viewer; schema
      v12. *Exit: core 683 · web 440 · extension 57 · typechecks 0 · packaged app
      boots env-free (demo, schema v12).*
- [x] **M12 — UI readability & polish pass** (`PLAN-M12.md`). Responsive shell
      (header ≤ 80px, rails adapt below 1280/960), accent contrast-gate fix,
      16px token nav icons, grouped view order + collapsible Notes lane, dense
      list legibility floor. No new features; token-only. *Exit: PLAN-M12 P0–P2
      ticked; geometry gates at 1440/1280/1024/900/780; light+dark walks green.*
- [ ] **M13 — Purpose providers & in-session model switch** (`PLAN-M13.md`).
      Image-turn vision handoff (implicit text-model turns with a photo reroute
      to a vision-capable model; explicit picks never overridden); per-message
      model picker; purpose-provider bundle with `modelPins`
      (`/v1/providers/discover` + `/v1/providers/purposes`). *State: implemented
      + verified (suites/typechecks/`ux_audit`); a live manual walk is
      env-gated.*
- [ ] **M14 — Scheduled & autonomous work** (`PLAN-M14.md`). Personas carry
      schedules (`independence.schedules[]`: daily/weekly/interval + prompt + tz,
      schema v13); a scheduler driver fires due schedules and drives each as a
      headless bounded persona run; `scheduled_runs` history; queued tools pause
      a run and deciding the approval auto-resumes it; pause is a kill switch for
      new runs AND resume. *State: implemented + live-walked 2026-09-07; the
      packaged-app walk (shell/NSIS) is env-gated.*
- [ ] **M15 — Live desktop mode (exit demo)** (`PLAN-M15.md`). Packaged shell
      boots LIVE by default (whole-file-encrypted DB + OS-keychain key + skills
      in the per-user app-local data dir); a per-boot device secret guards
      `GET /v1/pair/device`; the tray surfaces the pairing code; the PairGate is
      health-aware. `PARTNER_DEMO_MODE=1` keeps the demo boot. *State: live
      packaged-boot walk is env-gated.*
- [ ] **M16 — Knowledge workspace** (`PLAN-M16.md`). Notes relationship graph
      (React Flow, persisted drag positions); Brainstorm from notes & captures
      (auto-created `p-brainstorm` persona); note/capture versioning with
      history + diff + restore; Discuss in Assets (branch or fork via
      `conversations.parent_id`/`source_asset_id`); desktop export save dialog;
      CSV-as-table; follow-up brainstorm session links; schema v13 → v15.
      *State: suites green; the shell `windows-build` + packaged live walk are
      env-gated.*
- [x] **M17 — Note projects** (spec: this entry; M17 has no separate plan file).
      An organizational layer over the Projects/Folders tree: notes join projects
      many-to-many, with **no membership = Inbox**. One membership write path
      (`setFolders`) backs create-time `folderIds` and re-filing; `list()`/`graph()`
      scope by folder subtree or Inbox, and a scoped graph returns one-hop
      **ghost** nodes for out-of-scope references. Deleting a folder clears
      membership (notes survive); deleting a note cascades its rows. Routes
      `GET /v1/notes?folderId=<id|none>`, `GET /v1/notes/graph?folderId=…`,
      `PUT /v1/notes/:id/folders` (501 when folders are unwired); schema **v16**
      (`note_folders`). *Exit: root + web suites green · typechecks 0 · web build
      green · `ux_audit` green on the new UI.*
- [x] **M18 — Chat multi-question forms** (spec: this entry; no separate plan
      file). When a persona has more than one open-ended question it emits a
      `:::partner.form` container instead of a prose list; each question renders
      in its own textarea and the user submits **once**, producing a single
      labelled user turn through the normal chat path. The parser shares the
      `:::partner.*` grammar in `shared/src/structured.ts` (closed-container-only
      materialization; malformed blocks degrade to prose). Pending drafts survive
      conversation switches. *Exit: root 877 · web 539 · typechecks 0 · web build
      green · `ux_audit` green.*
- [x] **M19 — Persona-scoped memory & automatic remember** (`PLAN-M19.md`).
      A per-persona tick (`memory.personaMemory`, off by default) makes a persona
      keep its OWN facts and recall them only while chatting with it — never in
      another persona's prelude or a headless run. With private memory on, the
      core asks the persona's cheap model, out of band after the response ends,
      whether the exchange holds anything durable, and files findings as
      confirmable suggestions labeled global or persona-scoped. Fixed extractor
      prompt, defensive parsing, dedupe covering global + same-scope + rejected.
      Follow-ups: independent global auto-remember setting
      (`memory.autoRemember.global`), turn-target fallback, review-before-suggest
      (`ALREADY KNOWN`) and the `REJECTED` block. *Exit: core 1334 · web 760 ·
      typechecks 0.*
- [ ] **M20 — Client-server, multi-user & mobile** (`PLAN-M20.md`; execution
      breakdown + status table `PLAN-M20-B.md`; records `docs/VERIFY-MOBILE.md`,
      `docs/VERIFY-M20-B.md`). **Model A′:** the core splits into a **Vault**
      (user key + Tier C) and an always-on **Runner** (job key + Tier W), with
      pre-authorized capped expiring **briefcases** and a one-way **drain**.
      **Multi-user by partition** (`data/users/<id>/partner.db`, own key and
      skills dir); user/device/client-class are three levels and device =
      session. Phases: **A** mobile/tablet/touch UI · **B** the server role (TLS,
      named host allowlist, QR pairing, device registry + revoke, client-class
      capability envelopes, per-user partition) · **C** PWA · **D** optional
      Tauri v2 shell · **E** system layer (later). *State: **A implemented +
      measured**; **B landed through S7 + S9** (the envelope enforces, networked
      pairing mints a real `mobile` session, per-user partitions + wrapped keys);
      **S8 (Vault/Runner) not started**. All D1–D5 and Q1–Q12 decisions are
      closed (`PLAN-M20-B.md` §6).*
- [x] **M21 — Container deployment + Cloudflare Tunnel** (`PLAN-M21.md`,
      `docs/VERIFY-M21.md`). Partner runs headless in a container, LIVE, reached
      only through a Cloudflare Tunnel. Adds the `file` keychain kind
      (`KEYCHAIN_KIND=file` + `KEYCHAIN_FILE`; JSON, 0600, atomic writes,
      malformed ⇒ refuse to boot), a non-root live image, a two-service compose
      (the tunnel keeps its own network namespace, because pairing decides by
      socket peer), container tools (`healthcheck`, `pair-link`,
      `partner-request`), and operator-shell pairing. *Exit: container boots LIVE
      (demo off, schema v18) and reaches `healthy`; a non-loopback peer redeems a
      secret for a `mobile` session; the session survives a restart; verified
      against the real tunnel at `partner.teliti.app` (2026-09-13) and refreshed
      2026-09-18 (Windows `stage.ps1`, the skill worker harness).*
- [x] **M22 — Remote-hosted accounts, deployment-owned files, no
      llm-self-service** (`PLAN-M22.md`, `docs/VERIFY-M22.md`). (1) `AUTH_MODE=login`
      makes `POST /v1/auth/session` the only way in (scrypt passphrase, no
      user-existence oracle, lockout, per-peer limiter; the pairing lane answers
      403). (2) `FIXED_ROOTS=/files` registers the mount at boot and
      `POST`/`DELETE /v1/roots` answer `403 roots_fixed`. (3) llm-self-service
      removed from core/web/shared (closes S0). R-slices: per-user partitions
      (R1), rotation revoke (R2), idle-partition close (R3), per-client auth rate
      limit (R4), read-only roots (R6), upload/JSON caps (R7 — the upload cap is
      now the request-body cap), a verified backup tool (R8), vocabulary gap
      (R9). Invite-based sign-up (`SIGNUP_MODE=invite`, no `open` mode). S1/S9
      verified, S8 not. *State: S8, a device/sign-out UI and per-user quotas
      remain open; unverified — a two-user browser walk, R4 at the real edge, an
      R8 restore, R3's live timer.*
- [x] **M23 — Scorecard chat answers** (spec: this entry; no separate plan
      file). A fourth answerable container, `:::partner.scorecard`, rates several
      named items on one shared numeric scale (`scale=<2–10>`, optional
      `labels="Low|High"`), one radio group per item, submitted once as a single
      labelled turn. Parser in `shared/src/structured.ts`; answerable in the
      M20.A one-submit group; `scorecards` guidance in the default feature set.
      *Exit: shared 16 · web 722 · core `instructions.test.ts` green ·
      typechecks 0 · web build green.*
- [ ] **M24 — Make attached photos actually reach the model** (fix; spec: this
      entry; no separate plan file). Capability is **declared** per provider
      (`providers.vision_models`, schema **v20**) instead of guessed from the
      model name, read through one shared `isImageCapableModel`; the two byte
      budgets are split (upload 8 MiB vs inline 3 MiB, published as
      `maxInlineImageBytes`) and over-budget images are re-encoded; a turn carries
      several photos (`ChatMessage.images`, `MAX_INLINE_IMAGES_PER_TURN` = 4) and
      an unsent image is described as NOT sent. *State: locally green; the live
      packaged walk against the user's own endpoint is env-gated.*
- [x] **M25 — Reconfigure existing providers** (spec: this entry; no separate
      plan file). The setup card gains a *Reconfigure existing* mode: pick an
      existing endpoint, rediscover its models through the key the keychain
      already holds (`GET /v1/models?provider=<id>`, tried healthiest-first), tick
      the models each purpose carries, and save via `PUT /v1/providers/:id` per
      changed profile. Never creates, deletes or re-keys; an emptied profile is
      refused before any request. *Exit: root 1328 · web 758 · typechecks 0 · web
      build green · `ux_audit` PASSED.*
- [x] **M26 — Skill authoring: build a skill by talking to the partner**
      (`PLAN-M26.md`, `docs/VERIFY-M26.md`). A **draft** is an inert, editable
      bundle (`skill_drafts`, schema **v21**) in the user's own encrypted DB:
      describe it in chat (`skills.draft`, may ask with `skills.requestInstall`)
      or build it in the Studio (AI-assisted, template, or by hand), then read,
      dry-run and install it. The line held: **a model may write code and ask,
      but only the owner makes it executable** — drafting runs nothing,
      validation is deterministic, one `promote()` re-validates, and a widened
      permission set forces re-consent. `fork`/`edit`/export/import (import lands
      as a draft); `skill.author` is desktop-only. *State: **COMPLETE** (the
      notes + MCP templates landed with M27 S4); not walked — a live-endpoint
      generation and a packaged Studio run.*
- [ ] **M27 — What a skill may reach: app-scoped tools + MCP + model**
      (`PLAN-M27.md`, `docs/VERIFY-M27.md`). **S1** app-scoped notes tools
      (`notes.list`/`notes.search`/`notes.read`, reserving `APP_SCOPE_ID='app'`,
      no root, mapped to the existing `file.read` capability). **S2** MCP reach
      (`permissions.mcpServers`, per-server, `medium` ceiling minimum, coded
      refusals, **no pending row**). **S3** the session client class reaches the
      runner, closing the M20-B S4 gap. **S4** the notes + MCP Studio templates
      (capability-filtered picker). **S5** model reach (`partner.llm.complete`,
      enforced `budget.maxTokens`, ledger-charged, `skill.llm` desktop-only).
      *State: S1–S5 all landed; a real MCP server walk is env-gated.*
- [x] **M28 — Skill Studio Flow: build a skill on a canvas, with the model as a
      collaborator** (`PLAN-M28.md`, `docs/VERIFY-M28.md`, frames `docs/m28/`).
      The Studio's fourth surface is a React Flow graph of ten typed nodes, where
      the model can build a graph from a description, the user can draw it, and
      the model can refine it as an accept/reject proposal (never a silent
      rewrite). A flow is **not a second kind of skill**: it compiles
      deterministically to the same `entry.mjs`, expressions are a validated path
      grammar + fixed operators (no injection), and `permissions.tools`/`llm` are
      derived from the graph. Schema **v22** adds
      `flow_json`/`flow_sha256`/`flow_compiled_at` and three routes; an
      equivalent Nodes table edits the same document from the keyboard. Slices
      A compiler · B routes + staleness · C canvas + nodes table · D AI
      build/refine/from-code · E chat `flow` payload · F docs. *State: slices A–F
      landed 2026-09-17 (root 1746 · web 937 · typechecks 0 · build green); a
      live model walk for the four AI verbs is env-gated.*
- [x] **M29 — The multi-user lifecycle: sign out, in-app invitations, shared AI
      access, per-user files and note/asset sharing** (`PLAN-M29.md`,
      `docs/VERIFY-M29.md`). (1) **Sign out** revokes the session and closes the
      user's partition (unreadable, not merely unreachable). (2) **Owner-minted
      invitations** from the Members view (`users.role`/`users.key_access`,
      `invites` storing only the code hash; one conditional redemption update;
      shape errors before the invite is spent). (3) **Shared AI access**: an owner
      publishes providers + search config (`shared_access`, `shared-*` keychain
      accounts); a `keyAccess:'shared'` member uses them while they have none of
      their own. (4) **Per-user fixed roots** (`<FIXED_ROOTS entry>/<userId>`).
      (5) **Note/asset sharing** as snapshot copies in the system DB (`shares`).
      Schema **v23** (additive). *Exit: root 1766 · shared 90 · web 944 ·
      typechecks 0 · `ux_audit` PASSED · walked live against a real login-mode
      core.*
- [x] **M30 — One left panel: conversations under the Chat entry** (spec: this
      entry; detail in `docs/HISTORY.md`). The conversation list and folder tree
      moved into the sidebar, nested under Chat with a disclosure chevron
      (session-only state). Above the phone tier this is the tree's only home, so
      the transcript reclaims the rail's width; at the phone tier the same
      `ConversationRail` renders as the floating overlay. `railWidth` retired.
      *Exit: web 57 files / 956 tests · typecheck 0 · bundle green.*
- [x] **M31 — Settings, persona cards, and a magazine Notes & Plans** (spec:
      this entry; detail in `docs/HISTORY.md`). (1) Sidebar IA: Providers,
      Themes, Audit and Members grouped under **Settings**; Studio is
      personas/skills/playbooks, Tools is files/memory. (2) Personas as a wall of
      business cards whose face opens a slide-out editor drawer (Pause and Delete
      stay on the card). (3) Notes & Plans magazine layout (masthead, hairline
      rules, 1200px measure, newest item as a full-width lead). *Exit: web 58
      files / 967 tests · typecheck 0 · bundle green · checked at 1440 and 1024.*
- [x] **M32 — Persona-owned sessions, a resizable menu, a Catalog deck, and
      tracked memory** (spec: this entry; detail in `docs/HISTORY.md`). (1) The
      conversation tree moved under **Personas** (`PersonaChatTree`; orphaned
      chats under **Unassigned**). (2) Skills Catalog as a card deck + detail
      drawer (`CatalogDrawer`). (3) Drag-resizable left menu (180–420px,
      `partner.sideWidth`). (4) Memory: one-step suggestion persona select, a
      **Rejected** panel with Restore, and a `REJECTED` extractor block; chat no
      longer inlines the HTML preview. No schema change. *Exit: web 60 files /
      979 tests · core remember green · typecheck 0 · bundle green.*
- [x] **M33 — Multi-persona memory scope** (spec: this entry; detail in
      `docs/HISTORY.md`). `ProfileEntry.personaScopes: string[]` replaces
      `personaScope` (EMPTY = every persona); the deprecated field is still
      accepted on input and mapped to `[id]`/`[]`. Schema **v23 → v24** adds
      `profile_entries.persona_scopes` and backfills each legacy `persona_scope`
      once. Tailoring, auto-remember's known/rejected/dedupe listing and
      `GET /v1/memory/profile?personaScope=` read the set as membership. One
      `ScopePicker` checkbox set backs the edit form, add form and suggestion
      re-scope. *Exit: core 163 files / 1633 passed · web 61 files / 999 passed ·
      typecheck 0 · bundle green · `ux_audit` green (light + dark) · verified
      in-browser against a demo core.*

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
