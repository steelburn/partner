/**
 * Pairing-link tests (M20-B S7).
 *
 * The payload arrives from outside (a QR/link), so the refusals matter as much
 * as the happy path: each malformed field must be named, and the base64url
 * decoder must be canonical (a value whose decode re-encodes differently is
 * refused instead of being "cleaned up" into something we then post at a core).
 *
 * FALSIFICATION NOTE (this file's first version was VACUOUS): it built the
 * fingerprint and secret with `base64UrlEncode('x'.repeat(32))` — ASCII filler.
 * That encodes to 32 bytes AND decodes to 32 characters, so a validator that
 * compared the decoded *string* length to 32 passed the tests and still refused
 * every real payload, because a random 32-byte value decodes to ~28 characters
 * (UTF-8 multi-byte sequences collapse). The container deployment hit exactly
 * that: every genuine pairing link rendered "missing a valid certificate
 * fingerprint". The fixtures below therefore use **random bytes**, the shape the
 * core actually produces (crypto.randomBytes(32).toString('base64url')), and
 * `isCanonical32Bytes` is asserted on the BYTE length.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  base64UrlDecode,
  base64UrlEncode,
  base64UrlToBytes,
  bytesToBase64Url,
  deviceLabelFrom,
  isSameCoreOrigin,
  pairLinkFor,
  parsePairPayload,
  readPairHash,
  stripPairHash,
} from '../src/lib/pair-link.js';

/** The core's own shape: 32 crypto-random bytes, unpadded base64url (43 chars). */
const realBytes = (): string => randomBytes(32).toString('base64url');

const FINGERPRINT = realBytes();
const SECRET = realBytes();
const PAYLOAD = { coreUrl: 'https://core.example.com', certFingerprint: FINGERPRINT, secret: SECRET };

function link(payload: object = PAYLOAD): string {
  return pairLinkFor(JSON.stringify(payload), PAYLOAD.coreUrl);
}

describe('base64url', () => {
  it('round-trips and is canonical', () => {
    const value = base64UrlEncode(JSON.stringify(PAYLOAD));
    expect(base64UrlDecode(value)).toBe(JSON.stringify(PAYLOAD));
    expect(value).not.toContain('=');
    expect(value).not.toContain('+');
    expect(value).not.toContain('/');
  });

  it('measures a secret in BYTES, not decoded characters (regression)', () => {
    // 20 random samples: a character-based check disagrees on almost all of them.
    for (let i = 0; i < 20; i += 1) {
      const bytes = realBytes();
      expect(bytes).toHaveLength(43);
      const decoded = base64UrlToBytes(bytes);
      expect(decoded, bytes).not.toBeNull();
      expect(decoded?.byteLength, bytes).toBe(32);
      expect(bytesToBase64Url(decoded as Uint8Array)).toBe(bytes);
    }
  });

  it('refuses non-canonical, padded, spaced or non-base64url input', () => {
    const value = base64UrlEncode('hello');
    for (const bad of [
      `${value}=`,
      `${value} `,
      `${value}\n`,
      value.replace(/^./, '+'),
      'a', // length % 4 === 1
      '',
      undefined,
      42,
    ]) {
      expect(base64UrlDecode(bad), String(bad)).toBeNull();
    }
  });
});

describe('parsePairPayload', () => {
  it('accepts the core-shaped payload', () => {
    const result = parsePairPayload(JSON.stringify(PAYLOAD));
    expect(result).toEqual({ ok: true, payload: PAYLOAD });
  });

  it('names each refusal', () => {
    const cases: [unknown, string][] = [
      ['not json', 'not_json'],
      [JSON.stringify(['a']), 'not_an_object'],
      [JSON.stringify({ ...PAYLOAD, coreUrl: '' }), 'invalid_core_url'],
      [JSON.stringify({ ...PAYLOAD, coreUrl: 'nonsense' }), 'invalid_core_url'],
      [JSON.stringify({ ...PAYLOAD, coreUrl: 'https://u:p@core.example.com' }), 'invalid_core_url'],
      [JSON.stringify({ ...PAYLOAD, coreUrl: 'http://core.example.com' }), 'insecure_core_url'],
      [JSON.stringify({ ...PAYLOAD, certFingerprint: 'short' }), 'invalid_cert_fingerprint'],
      [JSON.stringify({ ...PAYLOAD, secret: `${SECRET}A` }), 'invalid_secret'],
    ];
    for (const [input, reason] of cases) {
      const result = parsePairPayload(input);
      expect(result.ok, JSON.stringify(input)).toBe(false);
      if (!result.ok) expect(result.reason).toBe(reason);
    }
  });

  it('ignores unknown extra fields rather than passing them through', () => {
    const result = parsePairPayload(JSON.stringify({ ...PAYLOAD, admin: true }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(Object.keys(result.payload).sort()).toEqual(['certFingerprint', 'coreUrl', 'secret']);
  });
});

describe('readPairHash', () => {
  it('reads the fragment form the desktop panel renders', () => {
    const url = link();
    const fragment = new URL(url).hash;
    expect(readPairHash(fragment)).toEqual({ ok: true, payload: PAYLOAD });
  });

  it('reads a query form too', () => {
    const value = base64UrlEncode(JSON.stringify(PAYLOAD));
    expect(readPairHash(`#pair=${value}`)).toEqual({ ok: true, payload: PAYLOAD });
    expect(readPairHash(`?pair=${value}`)).toEqual({ ok: true, payload: PAYLOAD });
  });

  it('says not_a_link when there is no pair parameter', () => {
    for (const fragment of ['', '#', '#other=1', '?q=hello', undefined]) {
      const result = readPairHash(fragment);
      expect(result.ok, String(fragment)).toBe(false);
      if (!result.ok) expect(result.reason).toBe('not_a_link');
    }
  });

  it('names the reason when a pair parameter is present but broken', () => {
    const notJson = readPairHash('#pair=!!!');
    expect(notJson.ok).toBe(false);
    if (!notJson.ok) expect(notJson.reason).toBe('not_json');

    const insecure = readPairHash(
      `#pair=${base64UrlEncode(JSON.stringify({ ...PAYLOAD, coreUrl: 'http://core.example.com' }))}`,
    );
    expect(insecure.ok).toBe(false);
    if (!insecure.ok) expect(insecure.reason).toBe('insecure_core_url');
  });
});

describe('pairLinkFor / isSameCoreOrigin / stripPairHash', () => {
  it('puts the payload in the FRAGMENT so it never reaches a server log', () => {
    const url = link();
    expect(new URL(url).search).toBe('');
    expect(new URL(url).hash.startsWith('#pair=')).toBe(true);
    expect(new URL(url).origin).toBe('https://core.example.com');
  });

  it('compares the payload core with the serving origin', () => {
    expect(isSameCoreOrigin('https://core.example.com', 'https://core.example.com')).toBe(true);
    expect(isSameCoreOrigin('https://core.example.com/', 'https://core.example.com')).toBe(true);
    expect(isSameCoreOrigin('https://core.example.com:8443', 'https://core.example.com')).toBe(false);
    expect(isSameCoreOrigin('https://other.example.com', 'https://core.example.com')).toBe(false);
    expect(isSameCoreOrigin('not a url', 'https://core.example.com')).toBe(false);
  });

  it('strips the fragment without keeping the secret in the URL', () => {
    expect(stripPairHash(link())).toBe('https://core.example.com/');
  });
});

describe('deviceLabelFrom', () => {
  it('names the devices a phone registry should show', () => {
    expect(
      deviceLabelFrom('Mozilla/5.0 (Linux; Android 14; Pixel 9 Build/UQ1A; wv) AppleWebKit/537.36'),
    ).toBe('Pixel 9');
    expect(deviceLabelFrom('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)')).toBe('iPhone');
    expect(deviceLabelFrom('Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)')).toBe('iPad');
    expect(deviceLabelFrom('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(deviceLabelFrom('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows PC');
  });

  it('yields null rather than guessing', () => {
    expect(deviceLabelFrom('something else')).toBeNull();
    expect(deviceLabelFrom('')).toBeNull();
    expect(deviceLabelFrom(undefined)).toBeNull();
  });
});
