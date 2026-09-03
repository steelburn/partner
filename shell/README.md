# shell — Partner desktop shell (Tauri v2)

M0 scaffold — verify with cargo check once Rust is installed.

## Status gate (M0)

**NOT YET BUILDABLE HERE.** This machine has no Rust toolchain and no bun
(`which cargo rustc bun` → empty), so `shell/` is **source only** until a
machine with Rust runs `cargo check` / `cargo tauri dev`. Per PLAN-M0.md,
installs were out of scope; this gate is the explicit handoff.

Source layout:

```
shell/
  README.md             # this file
  package.json          # npm workspace stub (@partner/shell, no scripts yet)
  spike/                # M0 packaging-spike experiments (see core/docs/spike-sidecar.md)
  src-tauri/            # Tauri v2 crate — see src-tauri/README.md for the
                        # exact toolchain steps (rustup, tauri-cli, cargo check)
```

## Sidecar packaging decision (M0 spike → core/docs/spike-sidecar.md)

Evaluated three ways to ship the Node core as a Tauri sidecar against
`better-sqlite3` + `@napi-rs/keyring` (+ `sqlite-vec` later):

| Option | Verdict |
|---|---|
| Node SEA | Second — config stage reached locally (blob written); needs postject + a real-natives resolution spike on a cargo machine |
| `bun build --compile` | Not chosen — `better-sqlite3` (V8 addon) on Bun (N-API) is unverified; no bun here |
| **Bundled Node runtime** | **RECOMMENDED** — node binary as the single-file sidecar + esbuild-bundled core under resources; byte-identical native behaviour to dev (both natives verified loading on this node) |

Empirical anchors recorded in the spike doc: esbuild bundle 376 B minified
baseline and runs clean under system node; SEA config stage reached
(`node --experimental-sea-config`, exit 0); dev node binary 65 MB;
`better-sqlite3` prebuild 2.2 MB + `@napi-rs/keyring` 3.0 MB, both load OK.

## Toolchain gate summary

1. Core sidecar artifact must exist before `cargo tauri build`:
   drop the bundled-runtime binary at
   `src-tauri/binaries/partner-core-<target-triple>` (see
   `src-tauri/binaries/README.md`).
2. Icons must exist: `cargo tauri icon <png>` writes `src-tauri/icons/`.
3. Then `cargo check`, `cargo tauri dev` (core running on 4390), `cargo tauri
   build` — exact commands in `src-tauri/README.md`.

Fallback (recorded in PLAN, not preferred) if all three packaging options
fail on the cargo machine: Electron.
