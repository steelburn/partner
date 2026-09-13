/**
 * Certificate trust primitives (PLAN-M20-B S6/S7) — PURE, node:crypto only.
 *
 * There is exactly ONE spelling of "the certificate fingerprint":
 * SHA-256 over the DER bytes, base64url, unpadded (43 chars). S7's QR payload
 * carries this value, so a phone pins the certificate at pair time instead of
 * clicking through a self-signed warning (PLAN-M20 §12 Q4: a mesh VPN gives
 * real TLS; the LAN fallback is only allowed with fingerprint pinning).
 *
 * Fail-closed rules:
 *  - `certFingerprint` REFUSES an empty or non-byte DER: sha256('') would
 *    happily produce a fingerprint that can only ever mismatch, which reads
 *    downstream as a pin failure instead of a bug.
 *  - `fingerprintMatches` returns FALSE for anything that is not a canonical
 *    fingerprint (missing, empty, wrong length, padded, non-canonical tail
 *    bits) — it never "defaults to equal".
 */
import { createHash, timingSafeEqual } from 'node:crypto';

const FINGERPRINT_BYTES = 32;
const FINGERPRINT_CHARS = 43; // 32 bytes as base64url, no padding

/** SHA-256 of the DER bytes as unpadded base64url. Throws on unusable input. */
export function certFingerprint(der: Uint8Array): string {
  if (!(der instanceof Uint8Array) || der.byteLength === 0) {
    throw new TypeError('certFingerprint: non-empty DER bytes are required');
  }
  return createHash('sha256').update(der).digest('base64url');
}

/**
 * Shape guard: a canonical 32-byte base64url fingerprint. The re-encode check
 * rejects strings that decode but carry non-zero padding bits (and any other
 * base64 variant), so a value accepted here is exactly what
 * `certFingerprint` produces.
 */
export function isCertFingerprint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== FINGERPRINT_CHARS) return false;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.byteLength === FINGERPRINT_BYTES && bytes.toString('base64url') === value;
}

/**
 * Constant-time comparison of two fingerprints. False — never a throw and
 * never true — when either side is missing or malformed.
 */
export function fingerprintMatches(a: unknown, b: unknown): boolean {
  if (!isCertFingerprint(a) || !isCertFingerprint(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'base64url'), Buffer.from(b, 'base64url'));
}
