# AGENTS.md — working instructions for Partner

Context file loaded by pi for this repository. Keep it short; it is memory,
not documentation.

## Plans & documentation upkeep (standing rule)

Keep the entry-point docs SMALL. Context budget is the reason this repo has a
doc structure at all: `README.md` (state snapshot), `PLAN.md` (design + compact
milestone index), `CHANGELOG.md` (releases), `PLAN-M<N>.md` (one spec per
milestone), `docs/` (verification + `docs/UNFINISHED.md`). Long-form history
lives in `docs/HISTORY.md` — archive, never load it for routine work.

When a module/milestone is added, changed, or completed:

- Add/update its entry in **`PLAN.md` §15 (Milestones)** with the status,
  one-paragraph description, an `*Exit:*` line and the spec pointer. Keep it
  compact (target ≤ 8 lines); detail belongs in `PLAN-M<N>.md`, not here. Use
  `[x]` only when the full exit is locally green; leave `[ ]` (with a
  `*State:*` line) when an env-gated walk/packaged step remains.
- Add a release entry to **`CHANGELOG.md`** (newest first) in the same change.
- Update the affected design sections in the same change when they describe
  it: **§8 Memory**, **§12 Data model** (tables + schema version +
  migrations), **§13 API surface** (routes), **§14 stack/architecture**.
- Keep the `README.md` status table in sync (suites, schema version, latest
  release, partly-open list).
- Prefer precise, verifiable facts (schema versions, route names, suite
  counts) over prose; do not restate a whole spec in PLAN.md or README.md.

## Repo conventions (verified)

- TypeScript/Node ≥ 22 monorepo (npm workspaces): `shared` · `core` · `web` ·
  `extension` · `shell`.
- Tests are TDD (`vitest`). Root: `npm test` · web: `npx vitest run --root web`.
- Types: `npm run typecheck` (all workspaces). Web bundle: `npm run build -w web`.
- Dev: `npm run dev:core` (core on :4390, demo mode by default) ·
  `npm run dev:web` (SPA on :5173).
- Security/audit discipline: never log, echo, or persist secrets or user
  memory content; audit rows carry ids/counts/lengths only.
