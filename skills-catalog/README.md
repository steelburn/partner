# `skills-catalog/` — the sample set that ships with the build

These bundles are checked in and read by the core at boot: they are what the
**Catalog** segment of Skills shows, and installing one copies its code into the
user's own skill store. They are reference implementations as much as samples —
each one is small, declares the narrowest reach that does its job, and reports a
broker refusal as a code instead of quietly returning an empty result.

The set (author `Partner Samples`, version `0.1.0`):

| id | declares | what it is for |
|---|---|---|
| `hello-skill` | *(nothing)* | the smallest possible skill: `tools: []`, no network, no model |
| `note-echo` | *(nothing)* | proves the runtime path for a pure transform: no file, no note, no network |
| `files-preview` | `files.read` | reads ONE file under a granted root and returns its size |
| `file-inventory` | `files.list` | walks a granted root to a chosen depth and reports per-extension counts + bytes |
| `content-audit` | `files.search` | finds a phrase in a granted root and groups the hits by file |
| `notes-digest` | `notes.list`, `notes.search`, `notes.read` | titles, tags, word counts and checklist tallies — never note bodies |

Every entry talks to the core through one global, `partner`:

```js
export async function run(args = {}) {
  const listing = await partner.tools.exec('files.list', { projectId, path });
  return { entries: listing.entries.length };
}
```

The three rules these samples follow, in the order they matter:

1. **Declare the narrowest reach.** A skill that reports file *sizes* needs
   `files.list`, never `files.read`. The install card is generated from the
   manifest, so an over-declared permission makes the owner consent to more than
   the code uses.
2. **A refusal is a code, not an empty result.** Without a grant the broker
   answers `tool_denied` (an unknown root is `unknown_project`). Catching it and
   returning `{ ok: false, reason: <code> }` is what lets the user see *why*
   nothing happened.
3. **Bound everything and say when you stopped.** `MAX_ENTRIES`, `MAX_NOTES`,
   `MAX_FILES` — and a `truncated: true` field when the cap was hit. A silent
   truncation reads as a complete answer.

`content-audit` exists a second time as a **Studio template**
(`core/src/skills/templates.ts`, id `content-audit`): the template is the
authorable form of the same idea, so "start from a template" and "install from
the catalog" are two doors onto one worked example. Templates are TS constants
because the core builds them on demand, while a catalog bundle is a directory
the installer copies — hence the duplication, which the tests hold together
(both must validate against the same registry, and the template must pass a real
sandboxed dry-run).
