# VERIFY-LIVE — the four env-gated walks, run for real

Date: 2026-09-17 · Specs: `PLAN-M26.md`, `PLAN-M27.md` (§S2, §S5) · Index:
`PLAN.md` §15 · Prior records: `docs/VERIFY-M26.md`, `docs/VERIFY-M27.md`,
`docs/UNFINISHED.md` §3 (the list this document closes out).

`docs/UNFINISHED.md` §3 listed four env-gated walks as *not verified*. This
document records what was **actually observed** when they were attempted against
the machine's own model targets. Two are verified, two are NOT RUN with a stated
reason. Nothing here is inferred from a fake client.

**Credential rule:** the remote key was read **in-process** from the pi auth
store (`%USERPROFILE%/.pi/agent/auth.json`, `litellm.key`) and passed straight
to the scratch core's `POST /v1/providers/:id/key`; it was never printed, echoed,
logged, or written into this document. No prompt or completion **content** is
recorded anywhere below — ids and counts only.

**FALLBACKS:** `CUDA → CPU → remote` — **the CUDA rung was used** (llama.cpp
CUDA-12 build on the RTX 5060 Ti). It needed one fix the brief did not name: the
LM Studio vendor CUDA-12 DLL directory on `PATH` (see *Target 1*). The CPU binary
was never needed; the remote LiteLLM target was exercised as a second target, not
as a fallback.

## Scratch core (both model walks)

The walks deliberately did **not** touch the running docker `partner` container
(ports unpublished; untouched, still `Up (healthy)`) or the user's dev core on
`:4390` (still answering `/v1/boot`). A throwaway LIVE core was booted from the
working tree on another port with a temporary data dir, reachable only from
loopback:

```
PORT=4399 HOST=127.0.0.1 DEMO_MODE=0 KEYCHAIN_KIND=file \
KEYCHAIN_FILE=<tmp>/keychain.json DB_PATH=<tmp>/partner.db DATA_ROOT=<tmp>/data \
SKILLS_DIR=<tmp>/skills SKILL_RUNS_DIR=<tmp>/skill-runs \
PARTNER_DEVICE_SECRET=<random, in-process> PARTNER_CORE_NONCE=scratch-core \
node_modules/.bin/tsx core/src/index.ts
```

Observed banner: `partner-core v0.1.19 up on http://127.0.0.1:4399 demo=off
schema=v22 · device pairing: GET /v1/pair/device (shell tray)`.

Session: `GET /v1/pair/device` (header `x-partner-device`) → 6-digit code →
`POST /v1/pair {code}` → desktop session token. **LIVE mode is what makes this
walk meaningful** — the same routes in demo mode return the canned bundle
(`model: 'demo'`) without ever calling a provider (`skills/generate.ts`,
`if (options.demo) return demoBundle`).

Every step below was a real HTTP call against that core, which called the real
model endpoint. A provider was configured through the public API
(`POST /v1/providers`, `POST /v1/providers/:id/key`, `POST /v1/providers/:id/test`),
and exactly one provider was left enabled so `resolveChatModel` could not pick
the other target.

---

## Target 1 — local llama.cpp, `gemma-4-E4B-it-Q4_K_M.gguf`

File served (exact name kept; **Q4_K_M**, not QAT):

```
C:/Users/USER/.lmstudio/models/lmstudio-community/gemma-4-E4B-it-GGUF/gemma-4-E4B-it-Q4_K_M.gguf
5,335,291,936 bytes · llama-server reports ftype "Q4_K - Medium", n_params 7,518,069,290
```

Binary (CUDA, used):

```
C:/Users/USER/.lmstudio/extensions/backends/llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.38.0/llama-server.exe
```

Command (Windows `cmd`; the vendor CUDA-12 DLLs are **not** beside the exe — the
first attempt exited `0xC0000135 STATUS_DLL_NOT_FOUND`):

```
set PATH=C:\Users\USER\.lmstudio\extensions\backends\vendor\win-llama-cuda12-vendor-v2;%PATH%
cd /d C:\Users\USER\.lmstudio\extensions\backends\llama.cpp-win-x86_64-nvidia-cuda12-avx2-2.38.0
llama-server.exe -m <the .gguf above> --host 127.0.0.1 --port 8080 -ngl 99 -c 8192 --alias gemma-4-E4B-it-Q4_K_M
```

`GET http://127.0.0.1:8080/health` → **200**. Offload proved by
`nvidia-smi --query-compute-apps` listing `llama-server.exe` (PID 23840) as a
CUDA compute app; model id served: `gemma-4-E4B-it-Q4_K_M`. Killed after the
walks (`taskkill /PID 23840 /F`; port 8080 and the GPU compute-app list are
empty again — see *Cleanup*).

### (a) M26 LIVE-ENDPOINT GENERATION — **verified**

```
POST /v1/providers        {name, endpoint:"http://127.0.0.1:8080/v1",
                           defaultModels:["gemma-4-E4B-it-Q4_K_M"], enabled:true}
POST /v1/providers/:id/key {key:"sk-local-no-auth-needed"}   -> 204 (llama.cpp needs none)
POST /v1/providers/:id/test                                 -> 200
POST /v1/skills/drafts    {mode:"generate", name:"Verify Live Generation",
                           description:"Adds two numbers given as args.a and args.b ..."}
```

Observed:

| Step | Result |
|---|---|
| `provider.test` | `health.ok: true`, models seen `["gemma-4-E4B-it-Q4_K_M"]`, 4854 ms |
| generation | **201**, origin `generated`, `model: "gemma-4-E4B-it-Q4_K_M"` (NOT `demo`), 3863 ms |
| draft validation | **`ok: true`**, 0 errors, entry `entry.mjs`, 528 code bytes, exports `run`, permissions clamped to a pure skill (`tools: []`, `network: false`, `risk: low`) |
| `POST .../install` | **200**, `mode: "created"`, `skillId: "verify-live-generation"`, empty `permissionDiff` |

A real model reply parsed, normalised, validated and **installed**. Model id:
`gemma-4-E4B-it-Q4_K_M`.

### (b) M27 S5 LIVE-MODEL SKILL RUN — **verified**

An installed skill whose manifest declares `permissions.llm: true` calls
`partner.llm.complete({prompt})`; the entry returns **counts only**
(`textLength`, `usage`) so the harness never records completion text.

```
POST /v1/skills/drafts {mode:"manual", name:"live-llm-probe-local-normal"}
PUT  /v1/skills/drafts/:id {manifestText:{... "llm":true, budget:{timeMs:60000,maxTokens:50000}}, code:<entry>}
POST /v1/skills/drafts/:id/validate   -> ok:true
POST /v1/skills/drafts/:id/install {acknowledgePermissions:true} -> 200 created
POST /v1/skills/:id/invoke {args:{}}  -> 200
```

1. **Text comes back** — `{ok: true, result: {textLength: 4, usage: {promptTokens:27,
   completionTokens:2, totalTokens:29}}}`; `meta.toolCalls: 0` (a model call is not a
   tool call, by design), 403 ms.
2. **Ceiling enforced** — the same entry installed under
   `budget.maxTokens: 1` (the validate warning is exactly *"may spend at most 1
   model tokens per invocation"*): invoke → **`{ok:false, error:"budget_exceeded"}`**,
   `meta.ok:false`. The invocation failed; no partial success was returned.
3. **Audit carries ids and counts, never content** — one `skill.llm` row per
   accounted call, actor `skill`:

```json
{"action":"skill.llm","target":"live-llm-probe-local-tiny/gemma-4-E4B-it-Q4_K_M",
 "details":{"skillId":"live-llm-probe-local-tiny","model":"gemma-4-E4B-it-Q4_K_M",
            "promptTokens":27,"completionTokens":2,"totalTokens":29,"ms":76}}
```

A scan of **all 55 audit rows** produced by the walks found **zero** occurrences
of the prompt text, the completion text, or the keys `prompt` / `completion` /
`text`; the `skill.llm` details key set is exactly
`{skillId, model, promptTokens, completionTokens, totalTokens, ms}`.

---

## Target 2 — remote LiteLLM gateway

Endpoint `https://api.ne1.dev/v1` (base from the pi auth store plus `/v1`;
`provider.test` saw `deepseek-v4-flash`, `gemma-4-E4B`, `Qwen3.8-27B`,
`deepseek-v4-flash-vision-exp`, `deepseek-flash`). Key read in-process; never
printed. Model used: **`deepseek-v4-flash`**.

### (a) M26 LIVE-ENDPOINT GENERATION — **verified**

Same calls as Target 1 with `endpoint: "https://api.ne1.dev/v1"` and
`defaultModels: ["deepseek-v4-flash"]`.

| Step | Result |
|---|---|
| `provider.test` | `health.ok: true`, latency 1442 ms |
| generation | **201**, origin `generated`, **`model: "deepseek-v4-flash"`**, 2379 ms |
| draft validation | **`ok: true`**, 0 errors, `entry.mjs`, 407 code bytes, exports `run`, permissions `{tools: [], network: false, risk: low}` |
| install | **200**, `mode: "created"`, `skillId: "verify-live-generation-2"` |

### (b) M27 S5 LIVE-MODEL SKILL RUN — **verified**

1. **Text comes back** — `{ok:true, result:{textLength:4, usage:{promptTokens:42,
   completionTokens:34, totalTokens:76}}}`, 1440 ms. (The gateway reports 34
   completion tokens against 4 visible characters — it counts reasoning tokens in
   `completion_tokens`. Observation, not a defect claim.)
2. **Ceiling enforced** — `budget.maxTokens: 1` → invoke **`{ok:false,
   error:"budget_exceeded"}`** after 2233 ms, `meta.ok:false`.
3. **Audit** — `skill.llm` row target `live-llm-probe-remote-tiny/deepseek-v4-flash`
   with `{model, promptTokens:42, completionTokens:34, totalTokens:76, ms}` and no
   content (same whole-audit scan as above).

---

## (c) M27 S2 REAL MCP SERVER FROM A SKILL — **NOT RUN**

**Reason: no third-party MCP server is configured or available on this machine.**
Checked (all empty/absent):

| Where | Finding |
|---|---|
| `C:/Users/USER/.lmstudio/mcp.json` | `{"mcpServers": {}}` |
| `C:/Users/USER/.lmstudio/.internal/last-synced-mcp-state.json` | `{"mcpServers": {}}` |
| Cursor / Claude Code / Codex / Gemini / Zed configs, repo & parent `.mcp.json` | do not exist |
| `mcp`, `mcp-server*`, `mcp-proxy` on `PATH` | none |
| npx cache + `~/.pi/agent/npm/node_modules` | no `@modelcontextprotocol/*` packages |
| Python `mcp` package | Python not installed |

The LM Studio plugins present (`js-code-sandbox`, `rag-v1`) are not MCP servers.
A fresh scratch core has an empty MCP store, so there was nothing to declare in a
skill's `permissions.mcpServers`. **The local stdio fixture the unit tests use was
not substituted** (explicitly excluded). To run this walk, the owner must
configure and enable a real server first (Partner → MCP, or an LM Studio MCP
server); the S2/S4 tests already prove the seam itself.

## (d) PACKAGED-APP STUDIO — **NOT RUN**

**Reason: a packaged build/installer exists, but every one on this machine
predates M26 (the Studio) — so it cannot contain the screen being walked.** The
only Studio-capable package would have to be rebuilt.

| Artifact | Built |
|---|---|
| `shell/src-tauri/target/release/bundle/nsis/Partner_0.0.0_x64-setup.exe` (35,283,029 B) | 2026-09-06 |
| `shell/src-tauri/target/release/partner-shell.exe` + `resources/` | 2026-09-06 |
| Installed per-user app `%LOCALAPPDATA%/Partner/` (`partner-shell.exe`, `resources/core-bundle.cjs`, `resources/web-dist`) | 2026-09-13 |
| App data from a previous packaged run `%LOCALAPPDATA%/dev.ne1.partner/partner.db` | 2026-09-14 |

Evidence that these builds predate the Studio (M26 landed 2026-09-16):

- `resources/core-bundle.cjs` contains **0** occurrences of `v1/skills/drafts`,
  `v1/skills/templates` and `skill.author`, while the pre-M26 route
  `v1/skills/catalog` **is** present (the grep is sound).
- `resources/web-dist/assets/*.js` contains **0** occurrences of `SkillStudio` /
  `skills/drafts`.

Two further obstacles to a live packaged walk **today**, even after a rebuild:
the shell hardcodes `CORE_URL = http://127.0.0.1:4390` and its M15 boot-nonce
check refuses a foreign core on that port — and `:4390` is currently held by the
user's dev core (`/v1/boot` → `{"bootNonce":null,"demo":true}`), which this walk
must not stop. No GUI screenshot/capture surface was available to this worker
either. Recommended: `npm run build -w web` + a fresh `tauri build`, then launch
the installer with `:4390` free, and walk Studio → generate → validate → install
the same way as walk (a).

---

## Cleanup (recorded)

- `llama-server.exe` (PID 23840) **killed**; port 8080 has no listener and
  `nvidia-smi` lists no compute apps.
- Scratch core (PID 5216) **killed**; port 4399 has no listener; the whole
  temporary data dir (DB, keychain file, skills, logs, token) was **removed**.
- Docker `partner` container: **not stopped, not recreated** — `Up (healthy)`
  before and after. Host `:4390` dev core untouched (still answers `/v1/boot`).
- No source file was modified.

## Residual uncertainty

- The generated bundle's text comes from the model and is frozen by
  `parseAuthoringReply` + `normalizeAuthoredBundle`; the draft is a **pure**
  skill (permissions clamped). This walk proves the pipeline, not that either
  model writes a *useful* skill.
- The remote model id is the gateway's alias; which upstream weights served
  `deepseek-v4-flash` is not observable from here.
- `budget_exceeded` fires on the provider's `usage` event (after the stream
  completed) and kills the worker; the run failed with no partial result, but the
  tokens were already spent at the provider — bounded, not free.
- The "no content in audit" claim covers this scratch core's audit store (55
  rows). It is evidence for the shipped code path, not a proof about other
  deployments or log sinks.
- The packaged-app result is a **stale-artifact** finding: the walk is unrun, not
  failed.
