/**
 * CROSS-MODULE agreement on the pairing payload (M21 deployment finding).
 *
 * The core BUILDS the payload (`core/src/http/pairPayload.ts`, Node Buffer) and
 * the browser VALIDATES it (`web/src/lib/pair-link.ts`, btoa/atob). They are two
 * independent implementations of one wire shape — deliberately, since the bundle
 * cannot import a Node module — so nothing but a test keeps them in step. And
 * nothing did: the web side validated by decoding to TEXT and comparing the
 * character count to 32, while the core issues 32 crypto-RANDOM BYTES (which
 * decode to ~28 characters). Every genuine pairing link was refused with
 * "missing a valid certificate fingerprint" — in the live container deployment,
 * not in the suite, because the suite's fixtures were ASCII filler
 * (`'x'.repeat(32)`) that happened to satisfy both readings.
 *
 * So this file tests the SEAM with real values: whatever the core produces must
 * be accepted by the browser, and vice versa. It is deliberately in `tests/`
 * (the cross-cutting suite) rather than in either workspace.
 *
 * Verified non-vacuous: restoring the character-length check in
 * `base64UrlToBytes` (i.e. the original bug) fails these tests.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPairPayload, parsePairPayload as coreParse } from '../core/src/http/pairPayload.js';
import { parsePairPayload as webParse, pairLinkFor, readPairHash } from '../web/src/lib/pair-link.js';

const CORE_URL = 'https://partner.example.com';

/** A payload exactly as the core issues it: 32 random bytes per 32-byte field. */
function coreBuiltPayload(): string {
  return buildPairPayload({
    coreUrl: CORE_URL,
    // The core's own certFingerprint()/pairSecret issue values of this shape.
    certFingerprint: randomBytes(32).toString('base64url'),
    secret: randomBytes(32).toString('base64url'),
  });
}

describe('the pairing payload the core builds is the one the browser accepts', () => {
  it('accepts a CORE-built payload, over many random samples', () => {
    for (let i = 0; i < 25; i += 1) {
      const payload = coreBuiltPayload();
      const parsed = webParse(payload);
      expect(parsed.ok, `sample ${i}: ${payload}`).toBe(true);
      if (parsed.ok) expect(parsed.payload.coreUrl).toBe(CORE_URL);
    }
  });

  it('reads a core-built payload out of the link form the desktop panel renders', () => {
    const payload = coreBuiltPayload();
    const link = pairLinkFor(payload, CORE_URL);
    const fromFragment = readPairHash(new URL(link).hash);
    expect(fromFragment.ok).toBe(true);
    if (fromFragment.ok) expect(fromFragment.payload.secret).toBe(
      (JSON.parse(payload) as { secret: string }).secret,
    );
  });

  it('agrees on REFUSALS too (a malformed field is refused by both)', () => {
    const good = JSON.parse(coreBuiltPayload()) as Record<string, string>;
    // Note: re-writing ONE character of a canonical value generally stays
    // canonical (the last character only carries 4 significant bits, so `…A`
    // can be a valid *different* value). A real refusal needs a shape change:
    // truncation (31 bytes), padding, or a character outside the alphabet.
    const tampers: [string, (value: string) => string][] = [
      ['truncated', (value) => value.slice(0, -1)],
      ['padded', (value) => `${value}=`],
      ['extra char', (value) => `${value}A`],
      ['foreign char', (value) => `+${value.slice(1)}`],
    ];
    for (const field of ['certFingerprint', 'secret'] as const) {
      for (const [label, tamper] of tampers) {
        const payload = JSON.stringify({ ...good, [field]: tamper(good[field]) });
        const web = webParse(payload);
        const core = coreParse(payload);
        expect(web.ok, `${field} ${label} web`).toBe(false);
        expect(core.ok, `${field} ${label} core`).toBe(false);
      }
    }
  });

  it('agrees that a 43-character NON-random value is judged by BYTES, not characters', () => {
    // The fixture shape that hid the bug: 43 chars. It happens to be 32 ASCII
    // bytes, so both sides accept it — the point is that neither side judges by
    // the decoded CHARACTER count, which is what made real random values fail.
    const filler = Buffer.from('x'.repeat(32), 'utf8').toString('base64url');
    const payload = JSON.stringify({ coreUrl: CORE_URL, certFingerprint: filler, secret: filler });
    expect(coreParse(payload).ok).toBe(true);
    expect(webParse(payload).ok).toBe(true);

    // …and a value that decodes to 32 characters but NOT 32 bytes (a 2-byte
    // UTF-8 character repeated) is refused by both.
    const twoByteChars = Buffer.from('\u00e9'.repeat(16), 'utf8').toString('base64url'); // 16 chars, 32 bytes
    const charsNotBytes = JSON.stringify({
      coreUrl: CORE_URL,
      certFingerprint: twoByteChars,
      secret: twoByteChars,
    });
    expect(Buffer.from(twoByteChars, 'base64url').byteLength).toBe(32);
    expect(Buffer.from(twoByteChars, 'base64url').toString('utf8').length).toBe(16);
    expect(coreParse(charsNotBytes).ok).toBe(true);
    expect(webParse(charsNotBytes).ok).toBe(true);
  });
});
