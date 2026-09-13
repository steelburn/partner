import { describe, expect, it } from 'vitest';
import { certFingerprint, fingerprintMatches, isCertFingerprint } from '../../src/net/trust.js';

/** Known-answer digests: sha256 of the UTF-8 bytes, base64url, unpadded. */
const SHA256_ABC = 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0';
const SHA256_EMPTY = '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU';

describe('certificate fingerprints', () => {
  it('is base64url sha256 of the DER bytes (known answer)', () => {
    const fp = certFingerprint(Buffer.from('abc', 'utf8'));
    expect(fp).toBe(SHA256_ABC);
    expect(fp).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fp).not.toContain('='); // base64url, unpadded
    expect(Buffer.from(fp, 'base64url').byteLength).toBe(32);
  });

  it('is stable across calls and differs for different bytes', () => {
    const der = Buffer.from('abc', 'utf8');
    expect(certFingerprint(der)).toBe(certFingerprint(der));
    expect(certFingerprint(Buffer.from('abd', 'utf8'))).not.toBe(SHA256_ABC);
  });

  it('refuses an empty/non-byte DER instead of silently hashing it', () => {
    // sha256('') would succeed and produce a fingerprint that can only ever
    // mismatch — a bug that reads as a pin failure. Fail loudly instead.
    expect(() => certFingerprint(Buffer.alloc(0))).toThrow(TypeError);
    expect(() => certFingerprint(null as unknown as Uint8Array)).toThrow(TypeError);
    expect(() => certFingerprint('abc' as unknown as Uint8Array)).toThrow(TypeError);
  });
});

describe('isCertFingerprint', () => {
  it('accepts only a canonical 32-byte base64url string', () => {
    expect(isCertFingerprint(SHA256_ABC)).toBe(true);
    // Non-canonical trailing bits: decodes to 32 bytes but re-encodes
    // differently, so it is not the fingerprint of anything.
    const nonCanonical = `${SHA256_ABC.slice(0, 42)}B`;
    expect(nonCanonical).not.toBe(SHA256_ABC);
    expect(Buffer.from(nonCanonical, 'base64url').byteLength).toBe(32);
    expect(isCertFingerprint(nonCanonical)).toBe(false);
  });

  it('fails closed on unusable input', () => {
    for (const value of ['', 'abc', `${SHA256_ABC}=`, 'a'.repeat(44)]) {
      expect(isCertFingerprint(value)).toBe(false);
    }
    for (const value of [null, undefined, 42, {}, Buffer.from('abc')]) {
      expect(isCertFingerprint(value)).toBe(false);
    }
    // Uppercase is a WELL-FORMED base64url string for different bytes, so it
    // passes the shape guard and only fails the comparison (see below).
    expect(isCertFingerprint(SHA256_ABC.toUpperCase())).toBe(true);
  });});

describe('fingerprintMatches', () => {
  it('matches identical fingerprints', () => {
    expect(fingerprintMatches(SHA256_ABC, SHA256_ABC)).toBe(true);
  });

  it('refuses a different or malformed fingerprint', () => {
    expect(fingerprintMatches(SHA256_ABC, SHA256_EMPTY)).toBe(false);
    expect(fingerprintMatches(SHA256_ABC, '')).toBe(false);
    expect(fingerprintMatches(SHA256_ABC, `${SHA256_ABC}=`)).toBe(false);
    expect(fingerprintMatches(undefined, SHA256_ABC)).toBe(false);
    expect(fingerprintMatches(SHA256_ABC, SHA256_ABC.toUpperCase())).toBe(false);
  });
});
