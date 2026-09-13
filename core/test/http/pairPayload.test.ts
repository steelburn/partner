import { describe, expect, it } from 'vitest';
import { certFingerprint } from '../../src/net/trust.js';
import { createPairSecretManager } from '../../src/http/pairSecret.js';
import { buildPairPayload, parsePairPayload } from '../../src/http/pairPayload.js';

const CORE_URL = 'https://partner.local:4390';
/** sha256('partner-m20b') as base64url — a well-formed placeholder value. */
const CERT_FP = certFingerprint(Buffer.from('partner-m20b', 'utf8'));
const SECRET = `${'A'.repeat(42)}E`;

describe('pair payload', () => {
  it('is exactly the three fields the plan specifies, in order', () => {
    const raw = buildPairPayload({ coreUrl: CORE_URL, certFingerprint: CERT_FP, secret: SECRET });
    expect(Object.keys(JSON.parse(raw) as object)).toEqual([
      'coreUrl',
      'certFingerprint',
      'secret',
    ]);
    expect(JSON.parse(raw)).toEqual({
      coreUrl: CORE_URL,
      certFingerprint: CERT_FP,
      secret: SECRET,
    });
  });

  it('round-trips through parse', () => {
    const raw = buildPairPayload({ coreUrl: CORE_URL, certFingerprint: CERT_FP, secret: SECRET });
    expect(parsePairPayload(raw)).toEqual({
      ok: true,
      payload: { coreUrl: CORE_URL, certFingerprint: CERT_FP, secret: SECRET },
    });
  });

  it('carries a secret the core can still consume after the round trip', async () => {
    const secrets = createPairSecretManager({ now: () => 1_000 });
    const secret = await secrets.issue();
    const raw = buildPairPayload({ coreUrl: CORE_URL, certFingerprint: CERT_FP, secret });

    const parsed = parsePairPayload(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(await secrets.verify(parsed.payload.secret)).toEqual({ ok: true });
  });

  it('ignores unknown fields instead of passing them through', () => {
    const raw = JSON.stringify({
      coreUrl: CORE_URL,
      certFingerprint: CERT_FP,
      secret: SECRET,
      extra: 'must not reach the caller',
    });
    const parsed = parsePairPayload(raw);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.payload).sort()).toEqual(['certFingerprint', 'coreUrl', 'secret']);
    expect(JSON.stringify(parsed.payload)).not.toContain('must not reach the caller');
  });

  it('accepts a URL with a port, a path and no port', () => {
    for (const coreUrl of ['https://partner.local', 'https://partner.local:4390/', 'https://10.0.0.5:4390']) {
      expect(parsePairPayload(JSON.stringify({ coreUrl, certFingerprint: CERT_FP, secret: SECRET })).ok).toBe(true);
    }
  });
});

describe('pair payload refusals', () => {
  const bad = (body: unknown, reason: string): void => {
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    expect(parsePairPayload(raw)).toEqual({ ok: false, reason });
  };

  it('refuses anything that is not JSON', () => {
    expect(parsePairPayload('{oops')).toEqual({ ok: false, reason: 'not_json' });
    expect(parsePairPayload('')).toEqual({ ok: false, reason: 'not_json' });
    expect(parsePairPayload(7)).toEqual({ ok: false, reason: 'not_json' });
    expect(parsePairPayload(undefined)).toEqual({ ok: false, reason: 'not_json' });
  });

  it('refuses JSON that is not an object', () => {
    bad('null', 'not_an_object');
    bad('[]', 'not_an_object');
    bad('"https://partner.local"', 'not_an_object');
    bad('42', 'not_an_object');
  });

  it('refuses a core URL that is missing, unusable or not https', () => {
    bad({ certFingerprint: CERT_FP, secret: SECRET }, 'invalid_core_url');
    bad({ coreUrl: '', certFingerprint: CERT_FP, secret: SECRET }, 'invalid_core_url');
    bad({ coreUrl: 'partner.local:4390', certFingerprint: CERT_FP, secret: SECRET }, 'invalid_core_url');
    bad({ coreUrl: 'https://', certFingerprint: CERT_FP, secret: SECRET }, 'invalid_core_url');
    bad({ coreUrl: 'https://user:pw@partner.local', certFingerprint: CERT_FP, secret: SECRET }, 'invalid_core_url');
    bad({ coreUrl: 4390, certFingerprint: CERT_FP, secret: SECRET }, 'invalid_core_url');
    // The payload carries a one-time secret off this machine: plaintext is
    // refused here (S6), not at scan time.
    bad({ coreUrl: 'http://partner.local:4390', certFingerprint: CERT_FP, secret: SECRET }, 'insecure_core_url');
    bad({ coreUrl: 'ws://partner.local:4390', certFingerprint: CERT_FP, secret: SECRET }, 'insecure_core_url');
  });

  it('refuses a fingerprint that is not one', () => {
    for (const certFingerprintValue of ['', 'abc', `${CERT_FP}=`, `${'A'.repeat(42)}B`, 42, null]) {
      bad({ coreUrl: CORE_URL, certFingerprint: certFingerprintValue, secret: SECRET }, 'invalid_cert_fingerprint');
    }
  });

  it('refuses a secret that is not a 32-byte base64url secret', () => {
    for (const secret of ['', 'abc', 'A'.repeat(42), `${SECRET}=`, `${'A'.repeat(42)}B`, null]) {
      bad({ coreUrl: CORE_URL, certFingerprint: CERT_FP, secret }, 'invalid_secret');
    }
  });
});

describe('buildPairPayload guards', () => {
  it('throws instead of emitting a payload the phone must reject', () => {
    expect(() =>
      buildPairPayload({ coreUrl: 'http://partner.local', certFingerprint: CERT_FP, secret: SECRET }),
    ).toThrow(/insecure_core_url/);
    expect(() =>
      buildPairPayload({ coreUrl: CORE_URL, certFingerprint: 'nope', secret: SECRET }),
    ).toThrow(/invalid_cert_fingerprint/);
    expect(() => buildPairPayload({ coreUrl: CORE_URL, certFingerprint: CERT_FP, secret: '' })).toThrow(
      /invalid_secret/,
    );
  });

  it('emits the payload for valid input', () => {
    expect(() =>
      buildPairPayload({ coreUrl: CORE_URL, certFingerprint: CERT_FP, secret: SECRET }),
    ).not.toThrow();
  });
});
