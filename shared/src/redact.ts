/**
 * Redaction — the single place secrets are scrubbed before they reach logs,
 * audit rows, or UI transcripts. Every log/audit serializer in the core must
 * funnel through these helpers (see core/src/services/redaction.ts).
 */

/** Scrubs key-like tokens and bearer headers from a string. */
export function redactString(input: string): string {
  return input
    .replace(/sk-[A-Za-z0-9_\-]{8,}/g, 'sk-***[redacted]')
    .replace(/sk-demo-[A-Za-z0-9_\-]+/g, 'sk-demo-***[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, '$1***[redacted]')
    .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._~+\/-]{8,}/gi, '$1***[redacted]');
}

const SENSITIVE_KEY = /(password|passwordcipher|api_?key|key_?token|secret|authorization|token|key)$/i;

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
