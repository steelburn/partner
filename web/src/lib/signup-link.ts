/**
 * Sign-up invite link primitives (M22) — PURE, no DOM, no fetch.
 *
 * The operator mints an invite on the machine (`tools/signup-link.mjs`) and the
 * core hands back a single-use code; the tool wraps it in a link the person can
 * receive and open:
 *
 *     https://<host>/#signup=<code>
 *
 * The fragment, not a query string: a fragment is never sent to a server, so the
 * one-time code stays out of the core's access log and out of any proxy between
 * the sender and the person. The client clears it once the account exists.
 *
 * The code is a canonical 32-byte base64url secret — the same shape the pairing
 * lane issues, validated the same way and for the same reason: a value whose
 * decode re-encodes differently (padding bits, `+`/`/`, whitespace, `=`) is
 * REFUSED by name rather than cleaned up into something we then post at a core.
 * The core re-validates it, because a link is not a form.
 */
import { base64UrlToBytes } from './pair-link.js';

/** Bytes a sign-up code carries (matches the core's 256-bit secret). */
const CODE_BYTES = 32;

export type SignupLinkRefusal = 'not_a_link' | 'invalid_code';

export type SignupLinkResult = { ok: true; code: string } | { ok: false; reason: SignupLinkRefusal };

/** True when `value` is exactly what the core's `issue()` produces. */
export function isSignupCode(value: unknown): value is string {
  const bytes = base64UrlToBytes(value);
  return bytes !== null && bytes.byteLength === CODE_BYTES;
}

/**
 * Read the invite out of a URL fragment (`#signup=…`; a query form is accepted
 * too, because the same value may be pasted either way).
 *
 * A fragment without a `signup` parameter is `not_a_link` — the ordinary "no
 * invite here" answer that leaves the sign-in form alone — while a PRESENT but
 * broken value names its own reason, because someone handed the person a link
 * that cannot work and they need to be told that rather than shown a form that
 * will fail on submit.
 */
export function readSignupHash(fragment: unknown): SignupLinkResult {
  if (typeof fragment !== 'string' || fragment.length === 0) {
    return { ok: false, reason: 'not_a_link' };
  }
  const params = new URLSearchParams(fragment.replace(/^[#?]/, ''));
  const value = params.get('signup');
  if (value === null || value === '') return { ok: false, reason: 'not_a_link' };
  return isSignupCode(value) ? { ok: true, code: value } : { ok: false, reason: 'invalid_code' };
}

/** The link the operator sends: `https://<host>/#signup=<code>`. */
export function signupLinkFor(code: string, host: string): string {
  return `https://${host}/#signup=${code}`;
}

/**
 * The form's starting values, derived from the fragment — ONE function, so the
 * "opened the link" path and the "pasted it into an open tab" path cannot
 * disagree. (They did: the tab-paste path filled the code field and the
 * fresh-load path did not, so a person who opened their invite link in a new tab
 * got a form whose hint said "filled in from the link you opened" above an EMPTY
 * code field, and a submit that could never succeed. Found in the container
 * walk, not by a unit test — the test below now pins the invariant.)
 *
 * A broken link yields no code (the caller renders the refusal instead).
 */
export function initialSignupFields(fragment: unknown): { code: string; invited: boolean } {
  const parsed = readSignupHash(fragment);
  return parsed.ok ? { code: parsed.code, invited: true } : { code: '', invited: false };
}

/** `href` with the invite fragment removed (the code is one-time and secret). */
export function stripSignupHash(href: string): string {
  const url = new URL(href);
  url.hash = '';
  return url.toString();
}
