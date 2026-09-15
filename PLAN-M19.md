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

## Data

**No schema change.** `profile_entries` already carries `persona_scope`
(null = global, else persona id) and `source` (`user` | `partner_suggestion`)
from M4; the batch this milestone needed was wiring + UI + the extractor. The
new persona toggle lives inside the existing `personas.memory_flags` JSON
column, so an older row simply reads as `off`.

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
  persona. Demo mode and no-provider skip; every path is content-free in
  audit (`memory.remember` carries ids/counts/model only). `enqueue()` runs
  it fire-and-forget and `idle()` awaits in-flight work so tests are
  deterministic.
- **Wiring.** `MemoryBundle.remember` is built by `createMemoryBundle`; the
  resolver rides the persona's `cheap` task class (falling back to general),
  so extraction can be pinned to a cheap purpose model. The chat route, after
  the response has ended (`res.end()` has fired, so the user never waits),
  enqueues extraction for persisted, non-continue, provider-routed turns
  whose persona has `personaMemory: 'on'`.

## Web

- **Persona editor** gains a Memory fieldset: a single tick —
  "Keep a private memory of me for this persona" — bound to
  `memory.personaMemory`. Copy states the privacy boundary.
- **Memory view** marks persona-scoped confirmed entries "in use" when their
  persona has private memory on (union with the global set), labels
  `partner_suggestion` entries as auto-detected, and shows each suggestion's
  scope ("All personas" or the persona name). The scope chip already names
  the persona.
- **Persona editor** copy explains that a private-memory persona files global
  ("All personas") suggestions for facts that apply everywhere and scoped
  suggestions for facts tied to that persona; nothing is used until confirmed.

## Tests

Core: persona memory-flag normalization + round-trip; tailoring injects
scoped entries only when on (and never for a different persona); remember
parse/dedupe/cap/secret-filter/demo + no-provider skips, scope parsing with a
persona default, and global findings filed `personaScope: null`; HTTP
integration — a memory-on persona gets its scoped prelude, a managed-provider
turn files suggested entries that `GET /v1/memory/profile` returns, and a
confirmed global suggestion from one persona tailors a different persona. Web:
helper tests for the persona-aware in-use set and the auto-detected label.
