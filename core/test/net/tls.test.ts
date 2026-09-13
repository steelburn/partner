import { describe, expect, it } from 'vitest';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { certFingerprint } from '../../src/net/trust.js';
import { loadTls, parseTlsMaterial, sanCovers, transportRefusal, uncoveredHosts } from '../../src/net/tls.js';

/**
 * Throwaway fixtures, generated with `openssl` for this suite only (EC P-256,
 * self-signed, SAN `DNS:localhost, DNS:partner.local, IP:127.0.0.1`).
 * A test key is not a secret and is used by no runtime path — but it is still
 * a private key, so never replace these with a real one.
 */
const CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBrTCCAVSgAwIBAgIUOoAISrE2cU5g7baaf5bLna+M9fEwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMcGFydG5lci10ZXN0MB4XDTI2MDkxMjE1NDAwNloXDTM2MDkw
OTE1NDAwNlowFzEVMBMGA1UEAwwMcGFydG5lci10ZXN0MFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEr8810T4bI/inT7c/juc/10mL3NleRd7m2NCZoBKrDbo3StbC
pGX09rvmLsZkpYXR49+vaU7Mw2lZ2IGC64bUbKN+MHwwHQYDVR0OBBYEFC5Anpta
BFfz5FKc9mordKX0psPzMB8GA1UdIwQYMBaAFC5AnptaBFfz5FKc9mordKX0psPz
MA8GA1UdEwEB/wQFMAMBAf8wKQYDVR0RBCIwIIIJbG9jYWxob3N0gg1wYXJ0bmVy
LmxvY2FshwR/AAABMAoGCCqGSM49BAMCA0cAMEQCICXBOlCW/y4ALp8K67dgiopN
VpzFzoJ2mSXQtPGSRAxDAiBt7MgPnqgFOZPJ3Y011+fw1eejMufYBt1y63sDt/xd
xQ==
-----END CERTIFICATE-----`;
/** Matches CERT_PEM. */
const KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIDTIbltaDLffGYbF10BeaJsR/mILDcaFa/EO8appHihMoAoGCCqGSM49
AwEHoUQDQgAEr8810T4bI/inT7c/juc/10mL3NleRd7m2NCZoBKrDbo3StbCpGX0
9rvmLsZkpYXR49+vaU7Mw2lZ2IGC64bUbA==
-----END EC PRIVATE KEY-----`;
/** A second, unrelated key: pairing it with CERT_PEM must be refused. */
const OTHER_KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIAp5A4vmQHPsi4B7BrgxcftIni23EHCdNt19m2fY9vm3oAoGCCqGSM49
AwEHoUQDQgAES7xjijWai/dgQfXBOdtN18cP2r/wHpdjTKuG8js4YZ0pXfkYkIBH
aEeNQ7t1Fm1qabhc/7f8sGq2MUWlESJaEw==
-----END EC PRIVATE KEY-----`;
/** Independently computed: `openssl x509 -outform DER | sha256sum` → base64url. */
const CERT_FINGERPRINT = '4vlo9EhB9gTOB9OviWZ3FmFXhI73f9VWm2-konugr2I';

/** A path that cannot exist in this checkout (this suite writes no files). */
const missingFile = (name: string): string => fileURLToPath(new URL(`./${name}`, import.meta.url));
/** An existing file that is NOT certificate material: this test file. */
const THIS_FILE = fileURLToPath(import.meta.url);

const errnoError = (code: string): Error => Object.assign(new Error(`${code}: mock`), { code });

/** In-memory reader: the read → parse → fingerprint path without touching disk. */
const readerFor = (files: Record<string, string>) => (path: string): string => {
  const content = files[path];
  if (content === undefined) throw errnoError('ENOENT');
  return content;
};
const CERT_FILE = '/tmp/partner-test/cert.pem';
const KEY_FILE = '/tmp/partner-test/key.pem';

describe('loadTls', () => {
  it('reads a matching pair and reports the trust fingerprint + SANs', () => {
    const result = loadTls(
      { certFile: CERT_FILE, keyFile: KEY_FILE },
      { readFile: readerFor({ [CERT_FILE]: CERT_PEM, [KEY_FILE]: KEY_PEM }) },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fingerprint).toBe(CERT_FINGERPRINT);
    expect([...result.sanHosts].sort()).toEqual(['127.0.0.1', 'localhost', 'partner.local']);
    expect(result.certFile).toBe(CERT_FILE);
    expect(result.keyFile).toBe(KEY_FILE);
  });

  it('refuses a missing certificate file', () => {
    const result = loadTls({ certFile: CERT_FILE, keyFile: KEY_FILE }, { readFile: readerFor({}) });
    expect(result).toEqual({ ok: false, reason: 'cert_missing' });
  });

  it('refuses a missing key file', () => {
    const result = loadTls(
      { certFile: CERT_FILE, keyFile: KEY_FILE },
      { readFile: readerFor({ [CERT_FILE]: CERT_PEM }) },
    );
    expect(result).toEqual({ ok: false, reason: 'key_missing' });
  });

  it('refuses an unreadable file with a distinct reason', () => {
    const unreadable = (): string => {
      throw errnoError('EACCES');
    };
    const result = loadTls({ certFile: CERT_FILE, keyFile: KEY_FILE }, { readFile: unreadable });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cert_unreadable');
  });

  it('refuses mismatched material read from disk', () => {
    const result = loadTls(
      { certFile: CERT_FILE, keyFile: KEY_FILE },
      { readFile: readerFor({ [CERT_FILE]: CERT_PEM, [KEY_FILE]: OTHER_KEY_PEM }) },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('key_mismatch');
  });

  it('refuses real files that are not PEM material', () => {
    const result = loadTls({ certFile: THIS_FILE, keyFile: THIS_FILE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('cert_invalid');
  });

  it('reports a genuinely missing path on disk as missing, not malformed', () => {
    const result = loadTls({
      certFile: missingFile('no-such-cert.pem'),
      keyFile: missingFile('no-such-key.pem'),
    });
    expect(result).toEqual({ ok: false, reason: 'cert_missing' });

    // Both files are read BEFORE parsing, so a missing path is never reported
    // as malformed material.
    const keysOnly = loadTls({ certFile: THIS_FILE, keyFile: missingFile('no-such-key.pem') });
    expect(keysOnly.ok).toBe(false);
    if (!keysOnly.ok) expect(keysOnly.reason).toBe('key_missing');
  });
});

describe('parseTlsMaterial', () => {
  it('accepts a matching cert/key pair and derives the trust fingerprint', () => {
    const result = parseTlsMaterial({ certPem: CERT_PEM, keyPem: KEY_PEM });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fingerprint).toBe(CERT_FINGERPRINT);
    // One spelling of the fingerprint: trust.ts hashing the same DER.
    expect(result.fingerprint).toBe(certFingerprint(new X509Certificate(CERT_PEM).raw));
  });

  it('refuses a malformed certificate without echoing key material', () => {
    const result = parseTlsMaterial({ certPem: 'not a certificate', keyPem: KEY_PEM });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cert_invalid');
      expect(JSON.stringify(result)).not.toContain('PRIVATE KEY');
      expect(JSON.stringify(result)).not.toContain(KEY_PEM.slice(30, 60));
    }
  });

  it('refuses a malformed key', () => {
    const result = parseTlsMaterial({ certPem: CERT_PEM, keyPem: 'not a key' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('key_invalid');
  });

  it('refuses a key that does not match the certificate', () => {
    const result = parseTlsMaterial({ certPem: CERT_PEM, keyPem: OTHER_KEY_PEM });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('key_mismatch');

    // The matching key is accepted, so key_mismatch is not vacuous.
    expect(parseTlsMaterial({ certPem: CERT_PEM, keyPem: KEY_PEM }).ok).toBe(true);
  });

  it('refuses empty material', () => {
    for (const input of [
      { certPem: '', keyPem: KEY_PEM },
      { certPem: CERT_PEM, keyPem: '' },
      { certPem: '', keyPem: '' },
    ]) {
      const result = parseTlsMaterial(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(['cert_invalid', 'key_invalid']).toContain(result.reason);
    }
  });
});

describe('SAN coverage against an allowlist', () => {
  const sanHostsOf = (): string[] => {
    const result = parseTlsMaterial({ certPem: CERT_PEM, keyPem: KEY_PEM });
    if (!result.ok) throw new Error(`fixture must parse: ${result.reason}`);
    return [...result.sanHosts];
  };

  it('covers the allowlisted hosts, ignoring ports and case', () => {
    expect(uncoveredHosts(sanHostsOf(), ['localhost:4390', 'LOCALHOST', '127.0.0.1:4390'])).toEqual(
      [],
    );
  });

  it('names every host the certificate does not cover', () => {
    expect(uncoveredHosts(sanHostsOf(), ['localhost', 'evil.example'])).toEqual(['evil.example']);
  });

  it('honours a wildcard SAN for exactly ONE left-most label (RFC 6125)', () => {
    // Wildcards are REQUIRED in practice — Let's Encrypt and mesh CAs issue
    // `*.example.com`, so refusing them makes the TLS path unusable for the
    // common case rather than safer.
    expect(sanCovers(['*.example.com'], 'a.example.com')).toBe(true);
    expect(sanCovers(['*.example.com'], 'partner.example.com')).toBe(true);
    expect(sanCovers(['*.example.com'], 'PARTNER.EXAMPLE.COM:4390')).toBe(true);

    // …but NOT the bare domain, and NOT a deeper name.
    expect(sanCovers(['*.example.com'], 'example.com')).toBe(false);
    expect(sanCovers(['*.example.com'], 'a.b.example.com')).toBe(false);

    // The suffix attack: a naive `endsWith('.example.com')` matches this because
    // the character before the suffix is '-' rather than '.'. The label bound is
    // what rejects it.
    expect(sanCovers(['*.example.com'], 'evil-example.com')).toBe(false);
    expect(sanCovers(['*.example.com'], 'notexample.com')).toBe(false);
    expect(sanCovers(['*.example.com'], 'xexample.com')).toBe(false);

    // A bare `*` is not a wildcard label and covers nothing.
    expect(sanCovers(['*'], 'anything.example')).toBe(false);
    expect(sanCovers(['*.'], 'anything.example')).toBe(false);

    // A non-wildcard entry is still exact-only.
    expect(sanCovers(['a.example.com'], 'b.example.com')).toBe(false);
  });

  it('REFUSES a non-array host list instead of reporting everything covered', () => {
    // The only permissive default this module could have had: `[]` reads as
    // "all covered". The caller feeds this a parsed allowlist, so a non-array is
    // a programming error about a security control.
    expect(() => uncoveredHosts(sanHostsOf(), undefined as never)).toThrow(TypeError);
    expect(() => uncoveredHosts(sanHostsOf(), 'localhost' as never)).toThrow(TypeError);
  });

  it('covers nothing when the host or the SAN list is unusable', () => {
    expect(sanCovers([], 'localhost')).toBe(false);
    expect(sanCovers(['localhost'], '')).toBe(false);
    expect(sanCovers(['localhost'], '   ')).toBe(false);
    expect(sanCovers(['localhost'], 'localhost.evil.example')).toBe(false);
    expect(sanCovers(['localhost'], 'localhost:4390')).toBe(true);
  });
});

describe('transportRefusal (remote without TLS)', () => {
  it('accepts a plaintext loopback bind', () => {
    expect(transportRefusal({ remote: false, tls: false })).toBeNull();
  });

  it('accepts a remote bind with TLS', () => {
    expect(transportRefusal({ remote: true, tls: true })).toBeNull();
  });

  it('refuses remote without TLS', () => {
    expect(transportRefusal({ remote: true, tls: false })).toEqual({
      reason: 'remote_requires_tls',
    });
  });

  it('refuses anything that does not prove local-only or carry TLS', () => {
    // Absent/unknown flags are not evidence of a loopback bind, and only
    // `tls: true` counts as TLS.
    expect(transportRefusal({})).toEqual({ reason: 'remote_requires_tls' });
    expect(transportRefusal({ remote: undefined, tls: true })).toBeNull();
    expect(transportRefusal({ remote: false, tls: false })).toBeNull();
    expect(transportRefusal({ remote: true, tls: 'yes' as unknown as boolean })).toEqual({
      reason: 'remote_requires_tls',
    });
    expect(transportRefusal({ remote: false, tls: 'yes' as unknown as boolean })).toBeNull();
  });
});
