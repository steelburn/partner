# M13 — Purpose providers & in-session model switch (Partner)

Status: **implemented** · Master plan: `PLAN.md` (§4.2, §15) · **Depends on**
M11 F4 purpose providers · Style: TDD red → green (suites green at exit).

## Goal

Providers are set up **by purpose** (General | Cheap | Deep | Coding |
Vision | Research) from one endpoint + key, models are identifiable for what
they do, and a chat session can change the serving model **per message** —
including handing an attached photo to a vision model when the persona's
default model cannot see it.

## Design

### F1 — Image-turn vision handoff (`core`)

- **New resolver export** `resolveImageTurnUpgrade`
  (`core/src/gateway/resolver.ts`): given a persona + enabled providers,
  returns the best vision-capable model — (1) the persona's own
  `taskClasses.vision` mapping when it can see, else (2) the first
  image-capable model in an enabled provider's default list (persona-pinned
  provider first, then a `vision`-purpose provider, then creation order).
- **`POST /v1/chat`** (managed path): when the turn binds a staged inline
  image (≤ 3 MB) AND routing was **implicit** (no `model` / `taskClass` /
  `providerId` from the client) AND the routed model is not image-capable,
  the turn is rerouted to the upgrade result. Audit row
  `session/chat.vision_reroute` records the change. An **explicit** client
  pick is the user's confirmed choice and is never overridden; when nothing
  enabled can see images the turn stays on the text model with the existing
  descriptor context (no silent drop — the model is told an image is there).
- Vision capability lives in **one** shared module
  (`shared/src/vision.ts`): `isImageCapableModel` / `isInlineableImageMime` /
  `modelCapability`; `core/src/gateway/vision.ts` re-exports it so the core
  and the web UI can never disagree.

### F2 — Per-turn model picker (`core` + `web`)

- **Core**: `POST /v1/chat` accepts an optional `providerId` alongside
  `model`. Explicit `providerId` (must exist + be enabled: 404/400
  otherwise) wins over persona pinning and purpose routing in
  `resolveChatModel`, so a model that only exists on another provider can
  serve one turn. `web/src/lib/api.ts` `streamChat` forwards it.
- **Web** (`ChatStrip.tsx`): a "Model for this message" select above the
  composer — *Auto (persona routing)* plus one optgroup per enabled provider
  (labelled `provider · purpose`), each model suffixed `· vision` when
  image-capable. The option list refreshes every time the Chat view becomes
  visible again (and on persona change), so providers added in the Providers
  view appear without remounting. A staged photo **auto-selects** a
  vision-capable model with a status note; the user can change it or return
  to Auto before sending (their explicit pick then rides the turn). After a
  send the picker returns to Auto.

### F3 — Purpose-provider bundle with model assignment (`core` + `web`)

- **Core discovery** `POST /v1/providers/discover`
  (`{endpoint, key}`): one upstream `/models` call, nothing persisted — the
  UI step that lets the user see the provider's models before assigning them.
- **Core route** `POST /v1/providers/purposes`
  (`{endpoint, key, purposes?, modelPins?}`): when `modelPins`
  (`purpose -> model ids`) is supplied every requested purpose must carry a
  non-empty list of models the endpoint actually reported (400 otherwise) —
  each purpose profile then gets EXACTLY the pinned models, **first = that
  purpose's default** (used when a persona has no override and shown first in
  the chat picker). Without pins the old heuristic applies (vision keeps
  image-capable ids, others the full list). The single key is stored into
  **each** profile's keychain item (never the DB or a response). Upstream
  failure → 502, nothing created.
- **Web** (`ProvidersView.tsx`): the "Add purpose providers" card is now
  the only provider-add surface (the standalone Add-provider form was
  removed as redundant — the single-provider create route stays for API
  clients and the llm-self-service import). Pre-ticked purposes adapt to
  what exists: all six on a fresh setup, only the purposes an endpoint is
  missing, nothing when a NEW endpoint joins an existing set (tick e.g.
  Vision only for a second vision provider) — with All/None shortcuts and
  explicit copy; manual ticks win. Two steps: endpoint + key + purposes (+ optional per-profile budget, applied to every created profile via
  `budgetCents`) → **Discover models** → per-purpose model chips
  (vision-marked, suggested defaults pre-checked, first selected = default)
  → **Add purpose providers** with the pins. Endpoints that report no models
  can still be added without defaults (models are then set per persona or in
  the chat picker). Routing then has real purpose profiles whose model sets
  you chose.
- **Core** (`providerManager.test`): Test refreshes HEALTH but never
  clobbers a curated model list — pinned per-purpose models survive Test;
  only profiles with no defaults yet are auto-populated from the live list
  (fresh single adds). The upstream's full list still rides `health.models`.

### F4 — Identifiability

Providers already carry purpose badges + filter; pickers now group models by
provider + purpose and mark vision capability inline; the chat meta line
already shows the exact model per turn (the reroute is visible there too via
the actual model answered).

## Tests

- `core/test/gateway/resolverM13.test.ts` — explicit `providerId` precedence
  (incl. disabled fallback); `resolveImageTurnUpgrade` matrix (persona
  vision mapping, purpose-vision default, pinned-first ordering,
  non-capable mapping skip, null when nothing can see).
- `core/test/http/imageParts.integration.test.ts` — image-capable persona
  inlines; implicit text-model turn reroutes to the vision provider with the
  image part; explicit text pick keeps plain text on the pinned provider; no
  capable provider anywhere keeps plain text + descriptor.
- `core/test/http/chatUpstream.test.ts` — per-turn `providerId`+`model`
  rides that provider; unknown → 404, disabled → 400.
- `core/test/http/providersRoutes.test.ts` — bundle creates one profile per
  purpose with the key in each keychain item (never in responses), subset +
  ordering, validation 400s, unauthed 401, upstream 502 without partial
  creation; `modelPins` honored exactly (incl. order), rejected when
  missing/empty/unknown/off-list; `discover` returns models without
  persisting (guards 400/401/502); optional `budgetCents` lands on every
  created profile (invalid → 400).
- `web/test/api.test.ts` — `streamChat` sends/omits `providerId`, bundle
  client posts endpoint+key+purposes (+ `modelPins`), discover client
  posts endpoint+key and parses models.

## Exit criteria

- [x] All suites green: core 681 (5 env-gated skips) · web 470 ·
      typechecks 0 · production web build clean.
- [x] `ux_audit` green on the new chat picker + bundle card CSS
      (APCA contrast on both themes, states declared, token-only).
- [ ] Live manual walk (env-gated): bundle an endpoint into purpose
      providers from Providers; in Chat, attach a photo on a text-model
      persona → picker suggests a vision model → send → photo answered by the
      vision model; switch back to Auto next message.
