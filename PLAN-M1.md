# M1 — Providers, model gateway & integrated key import (Partner)

Status: **spec** · Repo: `~/apps/partner` · Master plan: `PLAN.md` (§1.1
decisions, §2, §15 M1) · **Depends on S0** (`~/apps/llm-self-service/PLAN-S0.md`)
· Style: TDD red → green.

## Goal

The user can add an **OpenAI-compatible provider** (endpoint + key), chat
through the real gateway with streaming + WAF-safe headers + budget caps, and
connect **llm-self-service with the same login as the portal** — all without a
secret ever being persisted anywhere but the OS keychain.

## Decisions locked for this milestone

- Provider profiles live in core SQLite; the **key never does** — it is a
  keychain item (`service: partner`, `account: provider:<id>`), only a
  `keyRef` id sits in the DB (PLAN §12).
- Gateway is adapter-shaped: one `ProviderClient` interface; v1 ships
  `OpenAICompatibleClient` only (PLAN §1.1).
- Loopback HTTP server stays **Express** (org precedent; SSE handled with
  native `res` streaming like llm-self-service's `/api/test/stream`).
- Password for the self-service import is encrypted **in the web UI** with the
  S0 envelope key; the plaintext never crosses loopback. The core's import
  route **rejects a plaintext `password` field** outright.
- "Connect llm-self-service" never calls `regenerate` — the user's other
  tools may hold the same key; rotation is user-initiated only (later UI).

## Data model (core SQLite v2 — providers)

```sql
CREATE TABLE providers (
  id            TEXT PRIMARY KEY,          -- uuid
  name          TEXT NOT NULL,             -- display name
  kind          TEXT NOT NULL DEFAULT 'openai-compatible',
  endpoint      TEXT NOT NULL,             -- full OpenAI-compatible base, e.g. https://api.ne1.dev/v1
  default_models TEXT,                     -- JSON array, refreshed by /test
  budget_cents  INTEGER,                   -- optional per-session spend cap
  enabled       INTEGER NOT NULL DEFAULT 1,
  key_ref       TEXT NOT NULL,             -- keychain account id (provider:<key_ref>)
  source        TEXT NOT NULL DEFAULT 'manual',  -- 'manual' | 'llm-self-service'
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
```

## Gateway design

### `core/src/gateway/providerClient.ts`
```ts
interface ChatRequest { model: string; messages: Msg[]; stream?: boolean; }
interface ChatResult { text: string; model: string; usage: {prompt,completion,total}; latencyMs: number; }
interface ProviderClient {
  chat(req: ChatRequest): Promise<ChatResult>;
  chatStream(req: ChatRequest): AsyncGenerator<ChatStreamEvent>; // {type:'delta'|'usage'|'done'|'error', …}
  listModels(): Promise<string[]>;         // GET /models (fallback: empty)
  health(): Promise<{ok:boolean; latencyMs:number; error?:string}>;
}
```

### `openAiCompatible.ts` — the only impl in v1
- Calls `${endpoint}/chat/completions`, `Authorization: Bearer <key>`.
- **Header discipline:** the client only ever sends the headers it controls
  (`content-type`, `accept`, `authorization`) and a neutral
  `user-agent: partner-core/0.1`. It never emits OpenAI-SDK telemetry
  (`x-stainless-*`) — the api.ne1.dev WAF fix, no relay needed (PLAN §2).
- Non-stream + SSE stream (`data:` lines, `[DONE]`), finish_reason,
  usage parsing; `AbortController` timeouts (connect 15s, idle 60s).
- Error mapping → typed `UpstreamError` (`invalid_key` 401, `model_not_found`
  404, `rate_limited` 429, `timeout`, `network`, `http_<code>` w/ upstream
  message when safe to surface — never echo `Authorization`).
- Every request funnels through the single redaction-serialization point
  (M0) so keys can't leak to logs.

### `resolver.ts` — model selection
`resolve(provider, taskClass, requested?)`: requested > provider.defaultModels
(first entry) > `settings.defaultModel`. Fallback chain across *enabled*
providers is a skeleton in M1 (multi-provider fallback completes when persona
routing lands in M3); single-provider: configured model or the provider's
default, else a clear error listing what models the provider reported.

### `budget.ts` — session spend caps (defense-in-depth, PLAN §11)
- Per provider `budget_cents` (optional). Default: **off**.
- Tokens → USD via a bundled price table for common models
  (`shared/src/pricing.ts`, overridable later); when the model's price is
  unknown, fall back to a request-count cap so a runaway loop can still be
  stopped.
- Checkpoints happen **mid-stream per delta chunk** (char/4 token estimate,
  conservative default price for unknown models): exceeding the cap ABORTS
  the upstream stream before the over-budget chunk is delivered, with one
  explicit `budget_reached` event; final usage reconciles the estimate.
  The cap is a hard stop within one chat response — cumulative spend across
  separate turns belongs to the conversation store (M3) and is a documented
  M1 limitation (defense-in-depth, not accounting).

## Provider API (loopback, authed) — wire spec

- `GET  /v1/providers` → `[{id,name,kind,endpoint,defaultModels,enabled,budgetCents,source, health:{ok|error,latencyMs,lastError?}}]` — **never `keyRef`, never the key**.
- `POST /v1/providers` `{name, kind?, endpoint, defaultModels?, budgetCents?, enabled?}` → `201` profile (no key). Test: kind other than `openai-compatible` → `400 unsupported (v1: openai-compatible)`.
- `POST /v1/providers/:id/key` `{key}` → set **or** rotate (stores keychain item `provider:<id>`, replaces old atomically). Response `204`. Never echoes the key.
- `POST /v1/providers/:id/test` → runs `listModels` + a 1-token chat probe
  (a proxy with broken `/chat/completions` is NOT healthy); stores
  `default_models`; returns `{ok, models, latencyMs, error?}`.
- `DELETE /v1/providers/:id` → deletes keychain item + row.
- `GET  /v1/models?provider=<id>` → upstream model list.
- `POST /v1/chat` `{providerId, model?, messages, stream:true}` → SSE events `delta|usage|done|error|budget_reached`.
- `POST /v1/self-service/login-key` `{endpoint}` → proxies `GET {endpoint}/api/login-key` → `{publicKeyPem}` (S0). The web UI uses this to encrypt the password **in the page**.
- `POST /v1/self-service/connect` `{endpoint, email, passwordCipher}` →
  1. rejects a plaintext `password` field (`400`),
  2. `POST {endpoint}/api/session` with `{email, passwordCipher}` (in-memory cookie jar, discarded at the end),
  3. `GET {endpoint}/api/me/key` (S0) → `{email, proxyBaseUrl, endpoint, key, expiresAt}`,
  4. stores key in keychain, creates provider (`source:'llm-self-service'`, name `llm-self-service (org)`, endpoint from the response),
  5. returns `201 {provider}` — key never re-serialized.
  Upstream auth failure surfaces as `401 {error: message from upstream}` (identical wording for wrong-credential/unknown-user, no enumeration — same rule as the portal).

## Web UI (minimal, provisional — full chat UI is M3, theming studio M6)

A **Providers** screen: list + add form (name, endpoint, models), paste-key
field, "Test connection", delete. An **Import** card: "Connect
llm-self-service" → email + password → WebCrypto envelope (recipe below,
mirrors the portal's `login.ts`) → done. A **Probe** console (textarea →
streamed output + token/cost line) proves the gateway. UI only ever uses the
token module from M0 — no raw values (no design work here; this screen is
replaced by the real settings surface later).

**Envelope recipe (web, must match S0):**
`importKey('spki', der, {name:'RSA-OAEP', hash:'SHA-256'}, false,
['encrypt'])` → `encrypt({name:'RSA-OAEP'}, …)` → base64 (byte-for-byte the
portal's `encryptPassword`).

## Demo mode

- `DEMO_MODE=1`: in-memory stores + `demoProvider` streaming fake + a
  **fake llm-self-service** — implemented as an in-process S0 double the demo
  core serves itself (`createSelfServiceDemoDouble`: `/api/login-key`,
  `/api/session`, `/api/me/key` → `sk-demo-import`), so demo mode is fully
  offline and credential-free — same promise as llm-self-service's demo mode.
- Real-S0 (non-demo) integration is tested against a **loopback fake**, never
  a live server, in CI.

## TDD tests (red → green)

**Gateway (client):**
1. Non-stream happy path returns text + usage + latency.
2. SSE stream fixture (`delta…[DONE]`) yields correct deltas then `done`.
3. Server-side double captures request headers: assert **no `x-stainless-*`,
   neutral UA**, correct auth (401 from upstream → `invalid_key`).
4. 404 model → `model_not_found`; 429 → `rate_limited`; connect timeout →
   `timeout`; upstream error message surfaced only when safe (never auth).
5. Header-scrub regression: an upstream double that *rejects* `x-stainless-*`
   (mimics api.ne1.dev) passes.

**Resolver/budget:**
6. Resolver: requested model wins; else provider default; none → clear error.
7. Budget: caps on → stream aborts at the cap with `budget_reached`; off →
   unlimited; unknown-price model falls back to request-count cap.

**Providers API:**
8. CRUD authz: no session → 401 on every route.
9. `POST /v1/providers` then `…/:id/key` → fake keychain holds it under
   `provider:<id>`; **no response ever contains the key or `keyRef`** (scan
   all bodies).
10. Rotate replaces the keychain item (fake keychain asserts old gone, new
    present); delete removes row + keychain item.
11. `test` stores `default_models` from the fake upstream and reports health.

**Import:**
12. `login-key` route returns the fake's PEM.
13. `connect` happy path (fake llm-self-service): creates provider with
    `source:'llm-self-service'`, key in keychain, `endpoint` from S0
    response.
14. `connect` rejects a plaintext `password` field with `400` (envelope only).
15. Wrong credentials → `401`, same wording for unknown-user/wrong-password
    (no enumeration).
16. Envelope parity: encrypt with `crypto.subtle` (Node global — the same
    API the browser uses) using the PEM from `login-key`, then decrypt with
    the fake's RSA private key — byte-identical to the portal's client.
17. Redaction regression: run a full import + chat and scan captured logs —
    no `sk-`, no ciphertext, no password anywhere.

**E2E (demo):**
18. Spawn core demo → pair (M0 harness) → add provider via probe UI API →
    `/v1/chat` streams real gateway events → audit rows exist for import +
    chat without secrets.

## Exit criteria (tick against PLAN.md M1)

- [ ] S0 shipped & verified in `~/apps/llm-self-service` (its acceptance
      criteria pass).
- [ ] Real streaming chat against a user-supplied OpenAI-compatible endpoint
      in demo mode (fixture upstream + manual live check with the user's own
      key in `DEMO_MODE=0` dev).
- [ ] Key import works end-to-end against the fake llm-self-service; manual
      live check against `enter.ne1.dev` with real org creds (verify
      envelope, retrieval, no stored password, key present only in keychain).
- [x] Budget cap aborts a runaway stream; redaction scan tests green.
- [x] Providers screen + probe console functional (provisional UI).

## Out of scope here

Personas & task-class routing (M3 — resolver is a skeleton), conversation UI
(M3), multi-provider fallback chains (M3), Anthropic/Gemini adapters (later),
theme studio (M6), extension (M7), skills (M8), full chat memory (M4).
