/**
 * Pairing-link primitives (M20-B S7) — PURE, no DOM, no fetch.
 *
 * The core issues a networked-pairing payload
 * (`core/src/http/pairPayload.ts`: `{coreUrl, certFingerprint, secret}`) to a
 * caller on the machine. For a phone to USE it, the payload has to travel as
 * something tappable, so it is carried in the URL fragment:
 *
 *     https://<coreUrl>/#pair=<base64url(payload JSON)>
 *
 * The fragment, not the query string: a fragment is never sent to a server, so
 * the one-time secret does not land in the core's access log or in any proxy
 * between the phone and the core. (The client clears it after pairing too.)
 *
 * This module deliberately RE-VALIDATES the payload rather than trusting it.
 * The value arrives from a QR code or a link — i.e. from outside — and the
 * core's own validator lives in a Node-only module this bundle cannot import.
 * The rules mirror it exactly: https only, no URL credentials, a canonical
 * 32-byte base64url fingerprint and a canonical 32-byte base64url secret. A
 * payload that does not satisfy all of them is refused BY NAME, never
 * "best-effort" decoded and posted at a core.
 */
/** The three validated fields a pairing payload carries. */
export interface PairPayload {
  coreUrl: string;
  certFingerprint: string;
  secret: string;
}

export type PairLinkRefusal =
  | 'not_a_link'
  | 'not_json'
  | 'not_an_object'
  | 'invalid_core_url'
  | 'insecure_core_url'
  | 'invalid_cert_fingerprint'
  | 'invalid_secret';

export type PairLinkResult =
  | { ok: true; payload: PairPayload }
  | { ok: false; reason: PairLinkRefusal };

const B64URL = /^[A-Za-z0-9_-]+$/;
const SECRET_BYTES = 32; // 256 bits — what the core's pairSecret.ts issues
const FINGERPRINT_BYTES = 32; // SHA-256 of the certificate DER

/** base64url of a UTF-8 string, unpadded. Throws only on a non-string. */
export function base64UrlEncode(text: string): string {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

/** base64url of raw bytes, unpadded. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Decode base64url to BYTES, and only when the value is CANONICAL: a value whose
 * decode re-encodes differently (padding bits, `+`/`/`, whitespace, `=`) is
 * refused, so anything this module accepts is exactly what the core produced.
 *
 * BYTES, not text: the first version of this module decoded to a string and
 * compared `decoded.length` to 32, which rejects every REAL 32-byte value —
 * random bytes decode to ~28 UTF-8 characters (multi-byte sequences collapse) —
 * while accepting ASCII filler. The pairing link of a real deployment was
 * refused with "missing a valid certificate fingerprint" because of it.
 */
export function base64UrlToBytes(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0 || !B64URL.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  if (padded.length % 4 === 1) return null;
  let binary: string;
  try {
    binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return bytesToBase64Url(bytes) === value ? bytes : null;
}

/**
 * Inverse of {@link base64UrlEncode} as TEXT, for the payload JSON. Canonical by
 * construction (it goes through {@link base64UrlToBytes}). TextDecoder replaces
 * invalid sequences rather than throwing, which is fine here: a payload that is
 * not valid UTF-8 JSON fails at `JSON.parse` with a named refusal.
 */
export function base64UrlDecode(value: unknown): string | null {
  const bytes = base64UrlToBytes(value);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** Canonical base64url of exactly `count` bytes. */
function isCanonicalBytes(value: unknown, count: number): value is string {
  const bytes = base64UrlToBytes(value);
  return bytes !== null && bytes.byteLength === count;
}

function isCertFingerprint(value: unknown): value is string {
  return isCanonicalBytes(value, FINGERPRINT_BYTES);
}

function isPairSecret(value: unknown): value is string {
  return isCanonicalBytes(value, SECRET_BYTES);
}

/** One validator, shared by the JSON and the whole-link entry points. */
function refusalOf(input: unknown): PairLinkRefusal | null {
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
  if (parsed.username.length > 0 || parsed.password.length > 0) return 'invalid_core_url';
  if (parsed.hostname.length === 0) return 'invalid_core_url';
  if (parsed.protocol !== 'https:') return 'insecure_core_url';

  if (!isCertFingerprint(candidate.certFingerprint)) return 'invalid_cert_fingerprint';
  if (!isPairSecret(candidate.secret)) return 'invalid_secret';
  return null;
}

/** Validate an already-parsed payload object (or the JSON string of one). */
export function parsePairPayload(raw: unknown): PairLinkResult {
  let body: unknown = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'not_json' };
    }
  }
  const refusal = refusalOf(body);
  if (refusal !== null) return { ok: false, reason: refusal };
  const { coreUrl, certFingerprint, secret } = body as PairPayload;
  return { ok: true, payload: { coreUrl, certFingerprint, secret } };
}

/**
 * Read the payload out of a URL fragment (`#pair=…`; a query form is accepted
 * too, since the same value may be pasted either way). Anything without a
 * `pair` parameter is `not_a_link` — the ordinary "no link here" answer — while
 * a PRESENT but broken value names its own reason.
 */
export function readPairHash(fragment: unknown): PairLinkResult {
  if (typeof fragment !== 'string' || fragment.length === 0) {
    return { ok: false, reason: 'not_a_link' };
  }
  const params = new URLSearchParams(fragment.replace(/^[#?]/, ''));
  const value = params.get('pair');
  if (value === null || value === '') return { ok: false, reason: 'not_a_link' };
  const json = base64UrlDecode(value);
  if (json === null) return { ok: false, reason: 'not_json' };
  return parsePairPayload(json);
}

/** The tappable link a phone opens: `<coreUrl>/#pair=<base64url(payload)>`. */
export function pairLinkFor(payloadJson: string, coreUrl: string): string {
  const url = new URL(coreUrl);
  url.hash = `pair=${base64UrlEncode(payloadJson)}`;
  return url.toString();
}

/**
 * True when the payload's core is the origin this page is being served from.
 * A mismatch is refused rather than attempted: the secret was issued for one
 * core, and posting it at another would both fail and hand that core a
 * credential it was never given.
 */
export function isSameCoreOrigin(coreUrl: string, origin: string): boolean {
  try {
    return new URL(coreUrl).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * A short, human device label derived from a user agent, for the S5 registry
 * ("Pixel 9", "iPhone"). Best-effort by nature — a UA is not a device database
 * — so an unrecognised agent yields null and the user names the device.
 */
export function deviceLabelFrom(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string' || userAgent.length === 0) return null;
  const android = /Android[^;)]*;\s*([^;)]+?)(?:\s+Build[/)]|\s*\))/i.exec(userAgent);
  if (android) {
    const model = android[1].replace(/\s*wv$/i, '').trim();
    if (model.length > 0) return model.slice(0, 64);
  }
  for (const [needle, label] of [
    ['iPhone', 'iPhone'],
    ['iPad', 'iPad'],
    ['Android', 'Android device'],
    ['Macintosh', 'Mac'],
    ['Windows', 'Windows PC'],
    ['CrOS', 'Chromebook'],
    ['Linux', 'Linux device'],
  ] as const) {
    if (userAgent.includes(needle)) return label;
  }
  return null;
}

/** Drop the fragment from the address bar without adding a history entry. */
export function stripPairHash(href: string): string {
  const url = new URL(href);
  url.hash = '';
  return url.toString();
}
