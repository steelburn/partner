# binaries/ — core sidecar drop-in directory

M0 scaffold — verify with cargo check once Rust is installed.

`tauri.conf.json` declares `bundle.externalBin: ["binaries/partner-core"]`.
At build time Tauri looks for the **target-triple-suffixed** binary here and
renames it to the base name when bundling:

```
binaries/
  partner-core-x86_64-unknown-linux-gnu     # linux x64 (deb/rpm/appimage)
  partner-core-aarch64-unknown-linux-gnu    # linux arm64
  partner-core-x86_64-pc-windows-msvc.exe   # windows
  partner-core-x86_64-apple-darwin          # macOS intel
  partner-core-aarch64-apple-darwin         # macOS arm64
```

The artifact is produced by the M0 packaging decision —
**bundled Node runtime** (see `core/docs/spike-sidecar.md`): `partner-core`
IS an official Node ≥22 binary, and the esbuild-bundled core JS + pruned prod
`node_modules` ship under Tauri resources and are passed to it as an argument
(`NODE_PATH`/entry path wiring is a cargo-machine follow-up).

Get the triple list for the current host with:
`rustc -vV | sed -n 's/host: //p'` (requires Rust).
