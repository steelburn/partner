/**
 * Networked-pairing QR payload (PLAN-M20-B S7 / PLAN-M20 §8.1 item 5) — PURE,
 * no imports beyond the two shape guards it must agree with.
 *
 * The payload is exactly `{ coreUrl, certFingerprint, secret }`:
 *  - `coreUrl` — where the phone should send the secret.
 *  - `certFingerprint` — the value `loadTls()` reports, i.e. trust.ts's
 *    SHA-256-of-DER base64url. This module never hashes a certificate itself:
 *    one spelling of the fingerprint, guarded here by `isCertFingerprint`.
 *  - `secret` — a pairSecret.ts secret, guarded by `isPairSecret`.
 *
 * https ONLY. The payload exists to carry a one-time secret to a device that
 * is NOT this machine, and a non-loopback bind without TLS is refused by S6 —
 * so a plaintext coreUrl is refused here (at issue time, before a QR is
 * rendered) instead of being discovered at scan time on the phone. This is the
 * trust-on-pair direction of PLAN-M20 Q4: pin the certificate by fingerprint
 * rather than asking the user to click through a warning.
 *
 * Fail-closed rules: an unparsable body, a non-object body, a missing or
 * non-https URL, a URL carrying credentials, a malformed fingerprint and a
 * malformed secret each get their OWN named refusal — none of them is a
 * default. Unknown extra fields are ignored and never returned, so a body can
 * only ever yield the three validated fields.
 */
import { isCertFingerprint } from '../net/trust.js';
import { isPairSecret } from './pairSecret.js';

export interface PairPayload {
  coreUrl: string;
  certFingerprint: string;
  secret: string;
}

export type PairPayloadRefusalReason =
  | 'not_json'
  | 'not_an_object'
  | 'invalid_core_url'
  | 'insecure_core_url'
  | 'invalid_cert_fingerprint'
  | 'invalid_secret';

export type PairPayloadResult =
  | { ok: true; payload: PairPayload }
  | { ok: false; reason: PairPayloadRefusalReason };

/** The single validator both build and parse go through. */
function refusalOf(input: unknown): PairPayloadRefusalReason | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return 'not_an_object';
  const candidate = input as Record<string, unknown>;

  const coreUrl = candidate.coreUrl;
  if (typeof coreUrl !== 'string' || coreUrl.length === 0) return 'invalid_core_url';
  let parsed: URL;
  try {
    parsed = new URL(coreUrl);
  } catch {
    return 'invalid_core_url';
  }
  // A core URL never carries credentials, and must be TLS: it is about to be
  // handed a one-time secret over a network.
  if (parsed.username.length > 0 || parsed.password.length > 0) return 'invalid_core_url';
  if (parsed.hostname.length === 0) return 'invalid_core_url';
  if (parsed.protocol !== 'https:') return 'insecure_core_url';

  if (!isCertFingerprint(candidate.certFingerprint)) return 'invalid_cert_fingerprint';
  if (!isPairSecret(candidate.secret)) return 'invalid_secret';
  return null;
}

/**
 * Serialize the payload for a QR code / link. Throws on input this module
 * would refuse to produce — a caller bug at issue time, not user input.
 */
export function buildPairPayload(input: PairPayload): string {
  const refusal = refusalOf(input);
  if (refusal) throw new TypeError(`pair payload: ${refusal}`);
  return JSON.stringify({
    coreUrl: input.coreUrl,
    certFingerprint: input.certFingerprint,
    secret: input.secret,
  });
}

/** Parse a scanned payload. Returns only the three validated fields. */
export function parsePairPayload(raw: unknown): PairPayloadResult {
  if (typeof raw !== 'string') return { ok: false, reason: 'not_json' };
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  const refusal = refusalOf(body);
  if (refusal) return { ok: false, reason: refusal };
  const { coreUrl, certFingerprint, secret } = body as PairPayload;
  return { ok: true, payload: { coreUrl, certFingerprint, secret } };
}
