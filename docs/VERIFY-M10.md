# M10 alpha — manual verification checklist

Walk this on a machine with a browser before calling the alpha done. Mark
each item; every env-gated line says exactly what it needs. The automated
gates (root/web/extension suites on the self-hosted Linux + Windows verify
runs, typechecks, ux_audit on new UI) are assumed green before this walk.

## A. Demo webapp (no keys)

1. Boot: `npm run build -w web` then core demo (`PORT=4390 DEMO_MODE=1
   STATIC_DIR=web/dist node --import tsx core/src/index.ts`); open
   http://127.0.0.1:4390.
2. Pair via "Get demo pairing code" → Connect. All ten views + **Audit**
   tab reachable; theme toggle works in both modes.
3. Chat a persona → streamed demo reply, usage line, conversation persists.
4. Run a text playbook (Docgen) with *Save as note* → exactly ONE
   "Saved as note — Docgen" row + the note appears in Notes with search.
5. Providers: add a profile with a budget → the row shows the cap and (after
   a charged turn with a real provider) "… of … left this window".

## B. Encryption at rest (live mode; needs a keyring daemon on Linux)

6. `DEMO_MODE=0 KEYCHAIN_KIND=native DB_PATH=…/alpha.db` + real provider
   key → boots; the DB file opens as ciphertext (open in a hex editor /
   `file` says SQLCipher data) and the key exists in the OS keychain under
   service `partner`, account `db-key`.
7. Restart the core → data survives (key read back from keychain).
8. Copy the DB file to another name and boot against it with a different OS
   user / wiped keychain → clean "wrong database key" refusal, no corruption.
9. **Migration refusal:** create a DB with the pre-M10 plaintext path
   (briefly flip core/package.json to plain better-sqlite3 and boot demo
   against a FILE db, or `openDatabase()` in a scratch script), then boot
   live against it → "plaintext Partner database detected" message with the
   documented path forward.
10. `DEMO_MODE=0 KEYCHAIN_KIND=fake DB_PATH=file.db` → refused at boot
    (fake keychain cannot protect a file).

## C. Budgets (real provider or scripted upstream)

11. Provider with `budgetCents` small enough to hit across turns: turn N+1
    is refused BEFORE streaming with a single `budget_reached` event (no
    upstream bytes); audit shows `chat.stream budgetRefused` +
    `provider.budget refused/charged` rows (ids/cents only).

## D. Audit UI + redaction

12. After the chat/playbook above: Audit tab shows the rows (chips, expand
    Details = pretty JSON); actor/action/search filters narrow; Export JSON
    and Markdown download; the exports contain no message/note content and
    no `sk-…` strings. Grep the core log after a provider-key paste: no key
    material anywhere.

## E. Session-only chat (degrade mode; any browser)

13. Clear the stored token (or use a fresh profile) → Pairing gate →
    "Use session-only chat". Note lists disabled features.
14. Point it at a CORS-open OpenAI-compatible endpoint (or run the repo's
    local CORS stub used in the W5 browser pass): multi-turn chat streams;
    the key is in memory only — refresh wipes it; localStorage shows no
    token/key after the session.
15. Point it at a non-CORS endpoint → the readable CORS/network hint, never
    a key echo. A wrong key → the 401 hint.

## F. Windows installer (self-hosted Windows runner)

16. Dispatch `.github/workflows/windows-build.yml` on the self-hosted
    Windows runner → green NSIS artifact; no RC.EXE failure, no resources
    glob warning.
17. On a Windows box: install the NSIS build; Partner opens WITHOUT
    `PARTNER_CORE_BUNDLE`/`PARTNER_STATIC_DIR` env (resources embedded);
    demo pair + chat round-trip inside the shell window. NOTE: this item
    predates M15 — the packaged shell now boots LIVE by default (persistent
    encrypted DB + native keychain under the app-local data dir, tray
    pairing code). The historical in-memory demo boot is one env away:
    `PARTNER_DEMO_MODE=1` (see PLAN-M15.md).

## G. Docs & exit

18. HANDOFF-WINDOWS.md refreshed to this state; PLAN-M10 exit boxes ticked
    after the fresh-context review closes; README "open follow-up" section
    updated (packaged-app + runner status).
