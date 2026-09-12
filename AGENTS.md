# AGENTS.md — working instructions for Partner

Context file loaded by pi for this repository. Keep it short; it is memory,
not documentation.

## Plans & documentation upkeep (standing rule)

`PLAN.md` is the master index. Detailed specs live in per-milestone files
(`PLAN-M<N>.md`), but **PLAN.md must stay current** — a reader who only opens
`PLAN.md` must be able to find every module and where its details live.

When a module/milestone is added, changed, or completed:

- Add/update its entry in **`PLAN.md` §15 (Milestones)** with the status,
  one-paragraph description, and an `*Exit:*` line. Use `[x]` only when the
  full exit is locally green; leave `[ ]` (with a `*State:*` line) when an
  env-gated walk/packaged step remains.
- Update the affected design sections in the same change when they describe
  it: **§8 Memory**, **§12 Data model** (tables + schema version +
  migrations), **§13 API surface** (routes), **§14 stack/architecture**.
- Keep `README.md` status + the milestone notes in sync, and point the
  milestone entry at its `PLAN-M<N>.md` spec.
- Prefer precise, verifiable facts (schema versions, route names, suite
  counts) over prose; do not restate a whole spec in PLAN.md.

## Repo conventions (verified)

- TypeScript/Node ≥ 22 monorepo (npm workspaces): `shared` · `core` · `web` ·
  `extension` · `shell`.
- Tests are TDD (`vitest`). Root: `npm test` · web: `npx vitest run --root web`.
- Types: `npm run typecheck` (all workspaces). Web bundle: `npm run build -w web`.
- Dev: `npm run dev:core` (core on :4390, demo mode by default) ·
  `npm run dev:web` (SPA on :5173).
- Security/audit discipline: never log, echo, or persist secrets or user
  memory content; audit rows carry ids/counts/lengths only.
