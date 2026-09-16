# M19 — Persona-scoped memory & automatic remember

Status: **implemented** · Repo: `~/apps/partner` · Master plan: `PLAN.md` §8
(memory & the user model). Builds on M4 (`PLAN-M4.md`) which shipped global
profile tailoring, episodes, search, forget and export.

## Goal

Two additions to the explicit memory system:

1. **Persona-based memory, on/off per persona.** A persona can keep its OWN
   facts about the user. Those facts are recalled **only while chatting with
   that persona** (the interactive `/v1/chat` route) — never shared into
   another persona's chat, and never surfaced in the headless
   playbook/schedule/brainstorm loops. Off by default (privacy default).
2. **Automatic remember.** After a persisted persona turn, the core asks the
   model (out of band, after the client's response has ended) whether the
   exchange contains anything durable worth remembering, and files each
   finding as a `partner_suggestion` / `suggested` entry for the user to
   confirm — in addition to the explicit "add a fact" path already in the
   Memory view. Each finding is labeled **global** (a truth about the user in
   every conversation: name, role, language, standing tone/format rules; filed
   `personaScope: null`) or **persona** (only meaningful while working with
   this persona; filed scoped to it), so the partner can learn facts that
   apply everywhere without every persona re-learning them.

   **Two independent consents (follow-up).** Because a global fact tailors
   EVERY persona, noticing one is a user-level choice, not a per-persona one:

   - **Global auto-remember** (`memory.autoRemember.global` in the settings
     table, **default ON**): any persisted, provider-routed turn may file
     **global** findings, regardless of which persona is speaking and whether
     that persona has private memory on. Findings are visible suggestions, so
     the default leaks nothing into a reply before the user confirms.
   - **Persona private memory** (`personas.memory_flags.personaMemory`,
     default OFF): only a persona with the toggle on may file
     **persona-scoped** findings (and recall them).

   Extraction runs when either consent is on; findings for a scope whose
   consent is off are dropped before filing. Turning both off means no
   extractor call at all.

## Data

**No schema change.** `profile_entries` already carries `persona_scope`
(null = global, else persona id) and `source` (`user` | `partner_suggestion`)
from M4; the batch this milestone needed was wiring + UI + the extractor. The
new persona toggle lives inside the existing `personas.memory_flags` JSON
column, so an older row simply reads as `off`. The follow-up's user-level
global consent lives in the existing `settings` key-value table
(`memory.autoRemember.global`), so schema `SCHEMA_VERSION` is unchanged.

## Shared (`shared/src/persona.ts`)

`PersonaMemoryFlags` gains an optional `personaMemory?: 'on' | 'off'`
(absent = off). Optional on purpose: every existing persona fixture keeps
compiling, and the core normalizes a missing value to `off`.

## Core

- **Tailoring becomes persona-aware** (`memory/tailor.ts`). `buildTailoring`
  now accepts the persona (id + memory flags) and renders confirmed GLOBAL
  entries as before, PLUS — only when `persona.memory.personaMemory === 'on'`
  — the confirmed entries scoped to that persona. One merged newest-first
  list, still capped at 8 / 240 chars per line. A bare persona id keeps the
  old global-only behaviour, so the M4 tests stay valid.
- **Remember manager** (`memory/remember.ts`, new). A fixed, never
  user-derived system prompt asks for a JSON array of at most 3 durable,
  user-specific facts, each labeled `scope: "global"` (applies in every
  conversation) or `scope: "persona"` (only this persona; missing/unknown
  scope defaults to persona). Defensive parsing (fence stripping, first `[` →
  last `]`, shape + kind + scope whitelist), value/evidence caps, an
  obvious-secret filter, and dedupe against every existing entry the persona
  would honor (global + same-scope, including rejected — a rejected fact is
  never re-suggested, and the same value is never filed on both scopes).
  Findings are written `source: 'partner_suggestion'`, `status: 'suggested'`,
  with `personaScope: null` for global and `personaScope: <persona id>` for
  persona. Before the provider call, the payload carries a bounded, value-capped
  `ALREADY KNOWN` listing of the entries the persona would honor (confirmed +
  still-pending suggestions, global + its own scope, rejected withheld), so the
  model **reviews existing memory and pending suggestions before suggesting**
  and does not re-propose them in fresh wording; the deterministic dedupe stays
  the guarantee (a fact already known or already suggested is dropped even when
  the model repeats it, punctuation/case/space-insensitive). Demo mode and
  no-provider skip; every path is content-free in
  audit (`memory.remember` carries ids/counts/model only). `enqueue()` runs
  it fire-and-forget and `idle()` awaits in-flight work so tests are
  deterministic. `extract()` takes a per-turn `policy: { global, persona }`
  (default both) and drops findings for a disallowed scope; both-false skips
  the provider call entirely.
- **Review before suggest** (`memory/remember.ts`). `formatKnownBlock()` builds
  the fixed `ALREADY KNOWN` listing (≤ `REMEMBER_KNOWN_MAX` lines, ≤
  `REMEMBER_KNOWN_VALUE_CAP` chars each, whitespace collapsed, de-duped) and the
  fixed system prompt tells the model never to return a listed fact, even
  reworded. Rejected values stay out of the listing but remain in the dedupe
  set, and the normalized key now also ignores surrounding quotes and trailing
  sentence punctuation — so the same fact is never suggested twice.
- **Global consent store** (`memory/settings.ts`, new). One boolean over the
  shared settings table: `autoRememberGlobal()` reads `'off'` as the only
  false value (absent = ON), and `setAutoRememberGlobal()` persists it with a
  content-free `memory.settings` audit row. `MemoryBundle.settings` exposes it
  to the chat route and the HTTP surface.
- **Wiring.** `MemoryBundle.remember` is built by `createMemoryBundle`; the
  resolver rides the persona's `cheap` task class (falling back to general),
  so extraction can be pinned to a cheap purpose model. When that resolver
  yields no target — no cheap/chat model configured, or an enabled provider
  with no default models whose turn carried an explicit per-message model —
  the extractor rides the exact provider client + model that served the turn
  (`RememberInput.fallbackTarget`), so auto-remember never silently no-ops on
  a turn that streamed successfully. The chat route, after the response has
  ended (`res.end()` has fired, so the user never waits), enqueues extraction
  for persisted, non-continue, provider-routed turns when **either** consent
  is on — the user-level global flag or that persona's `personaMemory: 'on'` —
  and passes the matching `policy` so only consented scopes are filed.

## Web

- **Persona editor** gains a Memory fieldset: a single tick —
  "Keep a private memory of me for this persona" — bound to
  `memory.personaMemory`. Copy now scopes it to facts tied to that persona and
  points at the separate global setting.
- **Memory view** gains an **Automatic memory** card bound to
  `GET`/`PUT /v1/memory/settings`: one tick, "Notice facts that apply to every
  persona", default on. The card renders nothing until the setting loads and
  only reflects the value the core confirms.
- **Memory view** marks persona-scoped confirmed entries "in use" when their
  persona has private memory on (union with the global set), labels
  `partner_suggestion` entries as auto-detected, and shows each suggestion's
  scope ("All personas" or the persona name).

## Tests

Core: persona memory-flag normalization + round-trip; tailoring injects
scoped entries only when on (and never for a different persona); remember
parse/dedupe/cap/secret-filter/demo + no-provider skips, scope parsing with a
persona default, and global findings filed `personaScope: null`; the
`formatKnownBlock` listing (header, whitespace collapse, empty, bounds) and the
payload review (global + this persona's confirmed/pending facts listed,
rejected and other-persona facts withheld, rule kept out of the system prompt);
a fact already pending review is never filed again; policy
filtering (global-only, persona-only, both-off skips without a provider call);
the settings manager default/round-trip/content-free audit; HTTP integration —
a memory-on persona gets its scoped prelude, a managed-provider turn files
suggested entries that `GET /v1/memory/profile` returns, a confirmed global
suggestion from one persona tailors a different persona, global facts are
detected with the persona toggle OFF, persona findings survive global OFF, and
`GET`/`PUT /v1/memory/settings` round-trips. Web: helper tests for the
persona-aware in-use set and the auto-detected label, plus the settings API
client.
