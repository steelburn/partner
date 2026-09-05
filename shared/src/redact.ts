/**
 * Redaction — the single place secrets are scrubbed before they reach logs,
 * audit rows, or UI transcripts. Every log/audit serializer in the core must
 * funnel through these helpers (see core/src/services/redaction.ts).
 *
 * Over-redaction is the safe direction: when in doubt a value is scrubbed.
 * These helpers are cheap on the small detail objects audit rows carry.
 */

const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\s*[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
/** Embedded JSON/query/header-style secret assignments inside any string.
 *  A boundary lookbehind keeps prose safe ("monkey: x" is untouched) while
 *  {"client_secret":"…"} / token=…-style text is scrubbed. */
const EMBEDDED_SECRET_FIELD =
  /(?<=^|[\s"'{,\[;])("?\s*(?:passwordcipher|password_?cipher|password|passphrase|client_?secret|api_?key|access_?key|auth_?token|refresh_?token|access_?token|authorization|cookie|credential|private_?key|token|secret|key)\s*"?\s*[:=]\s*"?)([^"\s,;&]{8,})/gi;
/** Secret values in a URL query string. */
const QUERY_SECRET =
  /([?&](?:api[_-]?key|key|token|secret|signature|auth)=)[^&\s]+/gi;
/** Password in a connection-string style URL (scheme://user:pass@host). */
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/[^:\/\s@]+:)[^@\s]+@/gi;

/** Scrubs key-like tokens, bearer headers and secret assignments. */
export function redactString(input: string): string {
  return input
    .replace(PEM_BLOCK, '***[redacted pem private key]')
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***[redacted]')
    .replace(/sk-demo-[A-Za-z0-9_\-]+/g, 'sk-demo-***[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1***[redacted]')
    .replace(QUERY_SECRET, '$1***[redacted]')
    .replace(URL_CREDENTIALS, '$1***[redacted]@')
    .replace(EMBEDDED_SECRET_FIELD, '$1***[redacted]');
}

const SENSITIVE_KEY =
  /(password|passwordcipher|api_?key|key_?token|access_?key|auth_?token|refresh_?token|client_?secret|private_?key|credential|passphrase|authorization|cookie|signature|secret|token|key)$/i;

/** Deep-copies a JSON-ish value, scrubbing values under sensitive keys. */
export function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(v));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY.test(k) ? '***[redacted]' : redactValue(v);
    }
    return out;
  }
  return value;
}

/** Serialize a value to a log/audit-safe string. */
export function redactJson(value: unknown): string {
  return JSON.stringify(redactValue(value));
}
