# PLAN-M37 — Memory library as responsive group cards (Kind ⇄ Persona)

Status: **implemented + verified** · 2026-09-19 · no schema change (schema stays
**v24**) · no core route change.

The owner's ask: *"i think we can have responsive cards for the Memory section, &
group together based on Kind/Persona. We can use switch to view either
grouping."*

This is an information-architecture pass on the **library** (the confirmed facts
in the Profile card). It follows M36, which cleaned the rows up; this changes how
the rows are bucketed.

## 1. What the section is now

```
Profile  [8 confirmed] [3 in use]
Confirmed facts about you drive how the partner tailors replies …

[Kind] [Persona]                      ← one segmented pill, aria-pressed

All personas      3     Shared        1     Researcher    1
┌───────────────────┐   ┌───────────────┐   ┌───────────────┐
│ [Preference] …    │   │ [Identity] …  │   │ [Identity] …  │
│ All personas · …  │   │ 2 personas · …│   │ You · 1m ago  │
│        Edit Delete│   │    Edit Delete│   │    Edit Delete│
└───────────────────┘   └───────────────┘   └───────────────┘
Builder          1     Analyst        1     Removed persona 1
┌───────────────────┐   ┌───────────────┐   ┌───────────────┐
…

Suggestions (2)   ← unchanged: a status-first inbox, not part of the library
Rejected (1)      ← unchanged: the collapsed audit trail
Add what the partner should know  ← unchanged
```

- **A card is a group, not an entry.** One card per bucket: a head (name + count
  chip) over that bucket's rows. Four kinds max; N personas + the catch-alls at
  most.
- **Responsive without a breakpoint.** `grid-template-columns: repeat(auto-fill,
  minmax(320px, 1fr))` — the M31 Persona-wall grid. Measured: 3 columns at 1440
  (391px cells), 2 at 1100 and 900 (328px), 1 at 390 (295px, pinned `1fr`).
  Inside a cell the row keeps its own wrap rules, so the value / meta / actions
  stack rather than crush — the M20.A failure mode, checked for explicitly (0
  rows with a value narrower than 140px at 900 and 1100).
- **No third surface plane.** `.card` is `--surface` and a row is `--surface-2`;
  a filled group card would nest a surface inside a surface. Separation is the
  grid gap plus the head label — DESIGN.md's first device (space → background
  shift → elevation before a border).

## 2. The switch

One `.seg-tabs` segmented pill (the system's view-switch component, as on
Notes/Plans/Skills): `role="group" aria-label="Group memory by"`, one
`aria-pressed` button per option (`Kind`, `Persona`). The choice is a **view
preference**, stored under `partner.factGrouping` through `lib/storage.ts`
(`readLocal`/`writeLocal`) and read back through `parseGrouping`, which falls
back to `kind` for anything unrecognised. Verified to survive a reload.

Key naming note: the storage census' content detector forbids the word `memory`
(that is where facts would live), so the key is `factGrouping` — the fix for a
guard that fires is a better name, not a weaker guard. The key is declared in
`web/test/security-guards.test.ts`'s allowlist with its reason.

## 3. The bucketing rule — a partition, both ways

`groupEntries(entries, personas, mode)` is pure and unit-tested. The invariant:
**every fact lands in exactly one card, in either mode.** A fact is never listed
twice and never dropped, which is what makes the two groupings two views of one
library.

**By kind** — the four kinds in chip order (`preference`, `identity`, `rule`,
`style`), empty kinds omitted. Head label = the kind label, head colour = the
kind's chip tone (`preference` accent, `rule` danger, the rest neutral).

**By persona** — fixed order:

| Bucket | Rule | Scope line on the row |
|---|---|---|
| `All personas` | the empty scope set (the global form) | shown (`All personas`) |
| `Shared` | two or more **live** personas honor it | shown (`2 personas`) |
| a persona card | exactly one live persona | **hidden** — the head says it |
| `Removed persona` | no scope resolves to a live persona | shown |

A fact scoped to a live persona *and* a deleted one stays with the live persona;
its own tooltip still names the rest. A persona with no facts gets no card.

## 4. De-duplication (the M36 rule, applied to the new heads)

The card head and its rows should not say the same thing twice:

- **Kind-grouped** cards drop the row's kind chip (`showKind={grouping ===
  'persona'}`) — the head already names the kind.
- **Single-persona** cards drop the row's scope item (`showScope={!group.single}`)
  — the head already names the persona. Catch-all buckets keep it, because
  "2 personas" / "Removed persona" is detail the head cannot carry (and the
  item's `title` carries the full names).
- The `Delete` action's accessible name still states the kind, so removing the
  chip loses nothing for assistive tech.

## 5. Status panels stay status-first

The **Suggestions** inbox keeps its own panel with its Confirm/Edit/Reject rows,
and **Rejected** stays the collapsed audit trail. Rationale: the nav badge counts
waiting suggestions, and scattering them across four-to-nine cards would make
"2 waiting for me" harder to action than it is now — the inbox is not a library.
This was a judgement call, flagged to the owner; moving the suggested rows into
the cards later is a small change (the rows and their actions are unchanged).

Episodes are untouched: "Kind" has no meaning for a conversation summary, so the
switch is scoped to the facts library.

## 6. Files

- `web/src/lib/memory-helpers.ts` — `MemoryGrouping`, `MEMORY_GROUPINGS`,
  `MEMORY_GROUPING_LABELS`, `parseGrouping`, `MemoryEntryGroup`, `groupEntries`,
  `groupCountLabel`.
- `web/src/MemoryView.tsx` — the switch, `FACT_GROUPING_KEY`, the group-card
  render, and the `showKind` / `showScope` row props.
- `web/src/app.css` — the M37 block (switch spacing, `auto-fill` grid, group
  head + kind tones, phone tier).
- `web/test/memory-helpers.test.ts` — 7 grouping tests, including the partition
  invariant and the stored-preference parser.
- `web/test/memory-display.test.ts` — 7 M37 guards (source + stylesheet).
- `web/test/security-guards.test.ts` — declare `partner.factGrouping`.

## Exit

- [x] Cards render per group in both modes; measured column counts at 1440 /
      1100 / 900 / 390; no crushed rows and no horizontal overflow.
- [x] The switch persists across a reload (`partner.factGrouping`).
- [x] `web` 64 files / **1084** passed · root 189 files / 1812 passed (5 skipped)
      · typecheck 0 · bundle green.
- [x] `ux_audit` PASSED — 20 explicit APCA pairs (10 light + 10 dark) covering
      the new rules, plus Tokens / States / Slop tells. Light `Rule` head
      (`--danger` on `--surface`) measures **Lc 75.42** — thin but passing, as
      DESIGN.md documents; the kind head uses `--accent-hover` (**Lc 82.97**),
      not `--accent`, which would measure 72.6 there.
- [x] Walked live at 1440 (light + dark), 1100, 900 and 390×844 on a demo core
      (`docs/VERIFY-M37.md`).

## Out of scope

- No core, schema or wire change: the buckets are derived in the view.
- No change to the rows themselves, the add form, episodes, search or the
  controls — this pass only re-buckets the confirmed library.
- No masonry/column-balancing: rows are placed by CSS grid, so a tall card in a
  row leaves space beneath its shorter neighbours. That is accepted (the
  alternative is a JS layout or `columns`, which reorders content).
