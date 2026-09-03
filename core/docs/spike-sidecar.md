# M0 spike — shipping the TS core as a Tauri sidecar

Status: **DECIDED** (M0 packaging spike, PLAN §17.1) · Repo: `~/apps/partner`

## Objective

Choose how to ship the Node ≥22 core (ESM/NodeNext, Express loopback on
127.0.0.1:4390) as a Tauri v2 sidecar, against three load-bearing native
modules: `better-sqlite3` (V8 C++ addon, per-Node-ABI prebuilds), `sqlite-vec`
(loadable SQLite extension `.so`, not yet a core dep at M0), and
`@napi-rs/keyring` (N-API addon via optional platform packages).

## Method (what was actually executed here)

No Rust toolchain and no bun on this machine (`which cargo rustc bun` empty).
Empirically testable parts were run with the system Node v22.23.2 and the
already-installed esbuild 0.25.12 binary (`node_modules/esbuild/bin/esbuild`,
executed directly). Artifacts live in `shell/spike/`. Everything else is
recorded as exact commands for a machine that has the toolchain (a "cargo
machine").

### 1a. Node SEA — config stage reached ✓

Entry `shell/spike/sea-entry.mjs`; exact config `shell/spike/sea-config.json`:

```json
{ "main": "bundle.cjs", "output": "sea-prep.blob", "disableExperimentalSEAWarning": true }
```
Run: `node --experimental-sea-config shell/spike/sea-config.json`
→ `Wrote single executable preparation blob to sea-prep.blob` (exit 0). A raw
ESM `.mjs` main is also accepted at the config stage (`sea-config.rawmjs.json`,
blob written) — the real build keeps the single-file **CJS** bundle as `main`
(esbuild, `--format=cjs`) to stay inside SEA's constraints (one file, no
external ESM imports, no top-level await). Blob ≈ 0.5 KB over the bundle.

**Remaining step (cargo machine, needs `npm i -D postject`):**

```bash
cp "$(command -v node)" shell/spike/partner-core            # same-arch prod node
npx postject shell/spike/partner-core NODE_SEA_BLOB shell/spike/sea-prep.blob \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
./shell/spike/partner-core
```
### 1b. Bundled Node runtime baseline — verified ✓

```bash
node node_modules/esbuild/bin/esbuild shell/spike/bundle-entry.mjs \
  --bundle --platform=node --target=node22 --format=cjs --minify \
  --outfile=shell/spike/bundle.min.cjs
node shell/spike/bundle.min.cjs
```
Runs clean (hello + sha256 output, exit 0). Size: **376 B** minified (467 B
un-minified) — pure-JS entry; a real core bundle incl. Express is a
tens-of-KB concern, measured again at M1. Natives verified loading under this
dev node: `better-sqlite3` (in-memory open/insert/select OK) and
`@napi-rs/keyring` (module loads; Linux get/set needs a keyring daemon at
runtime — documented caveat). Measured: dev `node` binary **65 MB**;
`better-sqlite3/prebuilds/linux-x64.node` 2.2 MB (package ships 8-platform
prebuilds, 17 MB — prune to platform prebuild at package time);
`keyring.linux-x64-gnu.node` 3.0 MB.

### 1c. bun compile + Tauri bundling — recorded, not runnable here

```bash
# bun machine:  bun build --compile core/src/index.ts --outfile dist/sidecar/partner-core
# tauri machine (any option): drop the artifact at
#   src-tauri/binaries/<target-triple>/partner-core-<target-triple>  then
cargo tauri build   # bundle.externalBin: ["binaries/partner-core"],
                    # bundle.createUpdaterArtifacts: true → signed update archive
```
### 1d. Native-module note

| Native | ABI | Prebuilt on npm? | Implication per path |
|---|---|---|---|
| `better-sqlite3` | V8 C++ (per-Node-ABI) | ✓ `prebuilds/<plat>.node` in tarball | Cannot be embedded in a SEA blob or an esbuild bundle — `.node` must sit on disk; SEA/runtime both load via require from a real path. Bun (N-API focus) is **unverified** for this addon. |
| `@napi-rs/keyring` | N-API | ✓ optional platform pkg (`@napi-rs/keyring-linux-x64-gnu`) | N-API → portable in principle, Bun included; still verify each path. Same on-disk `.node` requirement. |
| `sqlite-vec` | loadable SQLite ext (`.so`) | via its release assets | Extra resource file loaded by `better-sqlite3.loadExtension()`; must ship beside the DB in every path; under Bun it couples to Bun's bundled SQLite build. |

## Results

| Option | Size (measured here) | Native-module story | Updater impact | Dev parity | Verdict |
|---|---|---|---|---|---|
| 1. Node SEA | injected binary ≈ node binary (65 MB this dev build) + blob 0.5 KB; pure-JS deps folded into blob | Natives can't be in blob → ship `.node`/`.so` on disk adjacent to binary; resolution recipe needs a real-natives spike | One injected single file; smallest extra payload after runtime | Snapshot mode diverges from dev (resolution, `__dirname`, execPath); needs its own smoke pass | **Second** — pending native-resolution spike |
| 2. `bun build --compile` | n/a here (no bun) | N-API ok in principle; `better-sqlite3` (V8) + sqlite-vec under Bun **unverified** | Single file, updater-friendly | Bun ≠ Node; separate test pass mandatory | Needs verification; not chosen now |
| 3. Bundled Node runtime | node 65 MB + prod `node_modules` (JS + pruned natives, est. 10–25 MB); bundle 376 B baseline | Same resolution as dev — natives verified loading here | One signed bundle artifact (bigger OTA payload); ship node as the single-file `externalBin` + core under resources | **Exact dev runtime** (same ABI, same require) | **RECOMMENDED** |

## RECOMMENDATION

**Bundled Node runtime (option 3).** It is the only path whose native-module
behaviour is byte-identical to development (empirically: both natives load
under this node), and the Tauri updater still signs one bundle artifact per
target. Concretely: ship the official Node ≥22 binary as the single-file Tauri
sidecar (`externalBin`), bundle core JS with esbuild, and place the pruned
prod `node_modules` (natives only where prunable) under Tauri resources;
`main.rs` spawns node against the resource path. **SEA (option 1)** is the
second choice if the native-resolution recipe is proven on a cargo machine —
it trims the pure-JS footprint to one injected file but still needs `.node`
files on disk, so its real size win over option 3 is modest. **bun compile
(option 2)** stays open only as an experiment: `better-sqlite3` is a V8 addon
on a Bun (N-API) runtime — unverified. Fallback if a cargo machine disproves
all three: Electron (recorded in PLAN, not preferred).

## Open follow-ups

1. Cargo machine: run the 1a postject recipe with real natives from an
   adjacent dir; confirm SEA resolution + sqlite-vec `.so` loading.
2. Measure the official node binary; decide pruned `node_modules` layout and
   platform-prebuild pruning for option 3.
3. Bun machine: `bun build --compile` a core importing all three natives;
   record binary size + sqlite-vec coupling.
4. Wire `bundle.externalBin` triple naming + `createUpdaterArtifacts`;
   re-verify when core actually imports the natives (M1).

## Artifacts

`shell/spike/` — `sea-entry.mjs`, `bundle-entry.mjs`, `bundle.cjs`,
`bundle.min.cjs`, `sea-config.json`, `sea-config.rawmjs.json` (config output
recorded above; `.blob` regenerable, not committed).
