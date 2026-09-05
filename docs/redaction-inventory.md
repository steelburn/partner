# Redaction inventory (M10 W2)

The single serialization point: every audit row funnels through
`auditLog` (`core/src/services/redaction.ts`) → `redactJson`/`redactValue`/
`redactString` (`shared/src/redact.ts`). Nothing else writes audit rows, so
a secret that reaches a `details` object is scrubbed before storage — the
API, logs and UI can only ever read redacted rows.

## Call-site families (85 `audit.log` call sites in `core/src`)

| Family | Audit actions | Secret-bearing risk | Notes |
|---|---|---|---|
| Pairing/session (`http/`) | `pair.verify`, `session.revoke`… | code hashes only; never codes/tokens | session rows store token **hashes** |
| Providers/gateway | `provider.create/update/remove/health` | key material | providers store `key_ref` (keychain); routes never echo keys |
| Broker/files | `tool.exec`, `grant.*`, `roots.*`, `proposal.*` | params may carry content | callsites log ids/labels/counts only |
| Personas/conversations | `persona.*`, `conversation.*` | persona JSON is public | content never audited (ids/lengths only) |
| Memory/notes/plans | `memory.*`, `note.*`, `plan.*` | note/plan bodies | ids/titles/lengths only |
| Skills (M8) | `skill.install/enable/…`, `skill.run` | skill args/results | ids/versions/status only; invocation meta holds no content |
| Playbooks/deploy (M9) | `playbook.run/resume`, `deploy-profile.*` | tool args/results | decisions + ids + counts; `pendingId`/`runId` only |
| Browser/scopes (M7) | `browser.*`, `scope.*` | page URLs (titles only by design) | origin strings |

## Scrub patterns (`shared/src/redact.ts`)

- `sk-…` / `sk-demo-…` tokens
- `Authorization: Bearer …` headers
- PEM `-----BEGIN * PRIVATE KEY----- … END` blocks
- embedded JSON/header secret fields (`"client_secret":"…"`,
  `apiKey=…`, `passwordCipher`… — word-boundary guarded so prose like
  `monkey: banana` is untouched)
- secret query params (`?token=…&api_key=…`)
- connection-string credentials (`scheme://user:pass@host`)
- whole-value replacement for sensitive object keys (`token`,
  `passwordCipher`, `privateKey`, `credential`, `passphrase`,
  `client_secret`, `authorization`, `cookie`, `signature`…)

## Test coverage

- `shared`/core unit matrix — `core/test/redaction.test.ts` (10 cases incl.
  PEM, embedded JSON, query strings, connection strings, prose safety,
  call-site-shaped payloads)
- service-level — audit rows redacted before the table (`redaction.test.ts`)
- route-level — `core/test/server.test.ts` “GET /v1/audit never leaks a
  secret seeded straight into the audit service”
- chat/pairing suites assert the session token never appears in responses

## Guarantee

Over-redaction is the safe direction: when a value could be a secret it is
scrubbed; audit rows intentionally never carry message/note/tool content
(structural, enforced by tests above). Any future audit callsite must pass
ids/labels/counts only and rely on this single serialization point.
