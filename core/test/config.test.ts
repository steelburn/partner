import { describe, expect, it } from 'vitest';
import { CORE_VERSION, loadConfig } from '../src/config.js';
import type { CoreConfig } from '../src/config.js';

const NO_ENV: Record<string, string | undefined> = {};

describe('loadConfig', () => {
  it('defaults: demo on, loopback 4390, in-memory DB, fake keychain', () => {
    const cfg = loadConfig(NO_ENV);
    expect(cfg.port).toBe(4390);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.demo).toBe(true);
    expect(cfg.dbPath).toBe(':memory:');
    expect(cfg.keychain).toBe('fake');
    expect(cfg.hostAllowlist).toEqual(['127.0.0.1:4390', 'localhost:4390']);
    expect(cfg.codeTtlMs).toBe(120_000);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.lockMs).toBe(300_000);
    expect(cfg.sessionTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(cfg.version).toBe(CORE_VERSION);
  });

  it('live mode: DEMO_MODE=0 disables demo, picks native keychain + file DB', () => {
    const cfg = loadConfig({ ...NO_ENV, DEMO_MODE: '0' });
    expect(cfg.demo).toBe(false);
    expect(cfg.keychain).toBe('native');
    expect(cfg.dbPath).toBe('./data/partner.db');
  });

  it('rejects a non-loopback HOST in live mode (sidecar binds loopback by construction)', () => {
    expect(() => loadConfig({ ...NO_ENV, HOST: '0.0.0.0', DEMO_MODE: '0' })).toThrow(/loopback/);
    expect(() => loadConfig({ ...NO_ENV, HOST: '192.168.1.5', DEMO_MODE: '0' })).toThrow(/loopback/);
  });

  it('refuses a malformed or out-of-range PORT instead of quietly binding 4390', () => {
    // The old behaviour clamped through `readInt`, so `PORT=0` (read by a caller
    // as "any free port"), `PORT=70000` and `PORT=http` all silently became 4390
    // — three core test files asked for an ephemeral port and got the default,
    // which is why they only passed while 4390 happened to be free. A wrong port
    // is a misconfiguration an operator must see, not a fallback.
    for (const value of ['0', '70000', '-1', 'http', '80x']) {
      expect(() => loadConfig({ ...NO_ENV, PORT: value }), value).toThrow(/PORT must be an integer/);
    }
    // …and a real port is taken as given, with the loopback allowlist following
    // it (the reason 0 cannot be supported implicitly).
    const cfg = loadConfig({ ...NO_ENV, PORT: '8123' });
    expect(cfg.port).toBe(8123);
    expect(cfg.hostAllowlist).toEqual(['127.0.0.1:8123', 'localhost:8123']);
  });

  it('demo mode MAY bind outward (container/dev webapp) with loopback still default', () => {
    const bound = loadConfig({ ...NO_ENV, HOST: '0.0.0.0' });
    expect(bound.host).toBe('0.0.0.0');
    expect(bound.demo).toBe(true);
    // Session/UI origins stay loopback-derived regardless of the bind.
    expect(bound.hostAllowlist).toEqual(['127.0.0.1:4390', 'localhost:4390']);
    expect(loadConfig(NO_ENV).host).toBe('127.0.0.1');
  });

  it('DEMO_MODE accepts explicit truthy/falsy spellings', () => {
    expect(loadConfig({ ...NO_ENV, DEMO_MODE: 'false' }).demo).toBe(false);
    expect(loadConfig({ ...NO_ENV, DEMO_MODE: 'off' }).demo).toBe(false);
    expect(loadConfig({ ...NO_ENV, DEMO_MODE: '1' }).demo).toBe(true);
    expect(loadConfig({ ...NO_ENV, DEMO_MODE: 'yes' }).demo).toBe(true);
  });

  it('PORT drives the host allowlist; explicit DB_PATH wins in demo; KEYCHAIN_KIND is a live-mode override', () => {
    const cfg = loadConfig({
      ...NO_ENV,
      DEMO_MODE: '1',
      PORT: '4711',
      DB_PATH: '/tmp/live.db',
    });
    expect(cfg.port).toBe(4711);
    expect(cfg.hostAllowlist).toEqual(['127.0.0.1:4711', 'localhost:4711']);
    expect(cfg.dbPath).toBe('/tmp/live.db');
    // Demo always uses the fake keychain.
    expect(cfg.keychain).toBe('fake');
  });

  it('M10 W1: live + fake keychain is refused for FILE dbs (in-memory ok)', () => {
    // A live file DB needs the OS keychain to hold the cipher key.
    expect(() => loadConfig({ ...NO_ENV, DEMO_MODE: '0', KEYCHAIN_KIND: 'fake' })).toThrow(
      /fake keychain cannot protect a file database/,
    );
    expect(() =>
      loadConfig({ ...NO_ENV, DEMO_MODE: '0', KEYCHAIN_KIND: 'fake', DB_PATH: ':memory:' }),
    ).not.toThrow();
  });

  it('M21: KEYCHAIN_KIND=file is accepted with a path and CAN protect a file DB', () => {
    const cfg = loadConfig({
      ...NO_ENV,
      DEMO_MODE: '0',
      KEYCHAIN_KIND: 'file',
      KEYCHAIN_FILE: '/data/keychain.json',
    });
    expect(cfg.keychain).toBe('file');
    expect(cfg.keychainFile).toBe('/data/keychain.json');
    // The container case: a persistent file DB with no OS keyring available.
    expect(cfg.dbPath).toBe('./data/partner.db');
  });

  it('M21: KEYCHAIN_KIND=file without a path, or a path without the kind, is refused', () => {
    expect(() => loadConfig({ ...NO_ENV, DEMO_MODE: '0', KEYCHAIN_KIND: 'file' })).toThrow(
      /KEYCHAIN_KIND=file requires KEYCHAIN_FILE/,
    );
    expect(() =>
      loadConfig({ ...NO_ENV, DEMO_MODE: '0', KEYCHAIN_FILE: '/data/keychain.json' }),
    ).toThrow(/only meaningful with KEYCHAIN_KIND=file/);
    expect(() =>
      loadConfig({ ...NO_ENV, DEMO_MODE: '0', KEYCHAIN_KIND: 'native', KEYCHAIN_FILE: '/x' }),
    ).toThrow(/only meaningful with KEYCHAIN_KIND=file/);
  });

  it('M21: an UNKNOWN keychain kind is refused, never silently treated as native', () => {
    // A typo in a container would otherwise boot the OS-keychain path, which
    // no container has, and fail with a keyring-daemon error instead.
    expect(() => loadConfig({ ...NO_ENV, DEMO_MODE: '0', KEYCHAIN_KIND: 'fille' })).toThrow(
      /KEYCHAIN_KIND must be fake \| native \| file/,
    );
    // Demo mode ignores the knob entirely (spec: demo never touches a keychain).
    expect(loadConfig({ ...NO_ENV, KEYCHAIN_KIND: 'fille' }).keychain).toBe('fake');
  });

  it('garbage numbers fall back to defaults instead of crashing — EXCEPT the port', () => {
    // Deliberate split: a tuning knob with a nonsense value can safely take its
    // default (nothing outside the process depends on it), while the PORT is
    // what a client, a tunnel or a container port-map points at — silently
    // binding 4390 for `PORT=not-a-port` is how "the wrong port" happens, so it is
    // refused (see the test above).
    const cfg = loadConfig({ ...NO_ENV, PAIR_MAX_ATTEMPTS: '-1' });
    expect(cfg.maxAttempts).toBe(3);
    expect(() => loadConfig({ ...NO_ENV, PORT: 'not-a-port' })).toThrow(/PORT must be an integer/);
  });

  it('honors pairing/session tuning knobs', () => {
    const cfg = loadConfig({
      ...NO_ENV,
      PAIR_CODE_TTL_MS: '1000',
      PAIR_MAX_ATTEMPTS: '5',
      PAIR_LOCK_MS: '9000',
      SESSION_TTL_MS: '42',
    });
    expect(cfg).toMatchObject({
      codeTtlMs: 1000,
      maxAttempts: 5,
      lockMs: 9000,
      sessionTtlMs: 42,
    } satisfies Partial<CoreConfig>);
  });
});

/**
 * PLAN-M20-B S6 — the transport refusal matrix (REMOTE_ACCESS / TLS /
 * ALLOWED_HOSTS). Fixtures are the same throwaway self-signed pair as
 * `test/net/tls.test.ts` (EC P-256, SAN `DNS:localhost, DNS:partner.local,
 * IP:127.0.0.1`, thrown away by no runtime path), read through the injectable
 * `readFile` so the matrix is provable without writing certificate material.
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

const CERT_FILE = '/tls/cert.pem';
const KEY_FILE = '/tls/key.pem';

/** In-memory reader, mirroring test/net/tls.test.ts. */
const readerFor =
  (files: Record<string, string>) =>
  (path: string): string => {
    const content = files[path];
    if (content === undefined) throw Object.assign(new Error('ENOENT: mock'), { code: 'ENOENT' });
    return content;
  };
const GOOD_TLS = readerFor({ [CERT_FILE]: CERT_PEM, [KEY_FILE]: KEY_PEM });

const LIVE: Record<string, string | undefined> = { ...NO_ENV, DEMO_MODE: '0' };
/** Remote access fully configured: non-loopback bind + TLS + explicit hosts. */
const REMOTE: Record<string, string | undefined> = {
  ...LIVE,
  HOST: '0.0.0.0',
  REMOTE_ACCESS: '1',
  ALLOWED_HOSTS: 'partner.local:4390',
  TLS_CERT_FILE: CERT_FILE,
  TLS_KEY_FILE: KEY_FILE,
};

/** The config error text for a refused combination. */
function refusalOf(env: Record<string, string | undefined>, readFile = GOOD_TLS): string {
  try {
    loadConfig(env, { readFile });
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return '';
}

describe('loadConfig — M20-B S6 transport matrix', () => {
  it('live + remote OFF + non-loopback HOST is refused (today\u2019s behaviour, preserved)', () => {
    expect(() => loadConfig({ ...LIVE, HOST: '0.0.0.0' })).toThrow(/loopback/);
    expect(() => loadConfig({ ...LIVE, HOST: '192.168.1.5', REMOTE_ACCESS: '0' })).toThrow(
      /loopback/,
    );
  });

  it('live + remote ON WITHOUT TLS is REFUSED, not warned about', () => {
    const message = refusalOf({ ...LIVE, HOST: '0.0.0.0', REMOTE_ACCESS: '1' });
    expect(message).toContain('remote_requires_tls');
    expect(message).toContain('TLS_CERT_FILE');
    // A lone cert file is not TLS either.
    expect(
      refusalOf({ ...LIVE, HOST: '0.0.0.0', REMOTE_ACCESS: '1', TLS_CERT_FILE: CERT_FILE }),
    ).toContain('remote_requires_tls');
    // TLS is a transport rule, not a live-mode rule: demo is refused too.
    expect(refusalOf({ ...NO_ENV, HOST: '0.0.0.0', REMOTE_ACCESS: '1' })).toContain(
      'remote_requires_tls',
    );
  });

  it('half a TLS pair is a configuration error (tls_pair_incomplete)', () => {
    expect(refusalOf({ ...LIVE, TLS_CERT_FILE: CERT_FILE })).toContain('tls_pair_incomplete');
    expect(refusalOf({ ...LIVE, TLS_KEY_FILE: KEY_FILE })).toContain('tls_pair_incomplete');
  });

  it('malformed or missing material is refused with the named reason from loadTls', () => {
    expect(refusalOf({ ...REMOTE }, readerFor({}))).toContain('cert_missing');
    expect(refusalOf({ ...REMOTE }, readerFor({ [CERT_FILE]: CERT_PEM }))).toContain('key_missing');
    expect(
      refusalOf(
        { ...REMOTE },
        () => {
          throw Object.assign(new Error('EACCES: mock'), { code: 'EACCES' });
        },
      ),
    ).toContain('cert_unreadable');
    expect(
      refusalOf(
        { ...REMOTE },
        readerFor({ [CERT_FILE]: 'not a certificate', [KEY_FILE]: KEY_PEM }),
      ),
    ).toContain('cert_invalid');
    expect(
      refusalOf({ ...REMOTE }, readerFor({ [CERT_FILE]: CERT_PEM, [KEY_FILE]: 'not a key' })),
    ).toContain('key_invalid');
    expect(
      refusalOf(
        { ...REMOTE },
        readerFor({ [CERT_FILE]: CERT_PEM, [KEY_FILE]: OTHER_KEY_PEM }),
      ),
    ).toContain('key_mismatch');
  });

  it('live + remote ON + TLS + explicit hosts boots, and reports the TLS material', () => {
    const cfg = loadConfig(
      {
        ...REMOTE,
        ALLOWED_HOSTS: ' Partner.Local:4390 , localhost:4390 ',
      },
      { readFile: GOOD_TLS },
    );
    expect(cfg.remoteAccess).toBe(true);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.tls?.fingerprint).toBe(CERT_FINGERPRINT);
    expect([...(cfg.tls?.sanHosts ?? [])].sort()).toEqual([
      '127.0.0.1',
      'localhost',
      'partner.local',
    ]);
  });

  it('ALLOWED_HOSTS is honoured VERBATIM \u2014 no loopback fallback is appended', () => {
    const cfg = loadConfig(REMOTE, { readFile: GOOD_TLS });
    expect(cfg.hostAllowlist).toEqual(['partner.local:4390']);
    // The derived pair would also contain these two; they must NOT appear, so a
    // loopback Host header is refused while remote access is on.
    expect(cfg.hostAllowlist).not.toContain('127.0.0.1:4390');
    expect(cfg.hostAllowlist).not.toContain('localhost:4390');
    // Entry order/case is the operator's (lowercased: the Host header compare is).
    const listed = loadConfig({ ...REMOTE, ALLOWED_HOSTS: 'LOCALHOST:4390,partner.local:4390' }, {
      readFile: GOOD_TLS,
    });
    expect(listed.hostAllowlist).toEqual(['localhost:4390', 'partner.local:4390']);
  });

  it('remote ON requires an explicit ALLOWED_HOSTS list (never the derived pair)', () => {
    const { ALLOWED_HOSTS: _ignored, ...withoutHosts } = REMOTE;
    expect(refusalOf(withoutHosts)).toContain('allowed_hosts_required');
    expect(refusalOf({ ...REMOTE, ALLOWED_HOSTS: '  ' })).toContain('allowed_hosts_required');
  });

  it('an empty ALLOWED_HOSTS entry is refused rather than dropped', () => {
    expect(refusalOf({ ...REMOTE, ALLOWED_HOSTS: 'partner.local:4390,' })).toContain(
      'allowed_hosts_empty',
    );
    expect(refusalOf({ ...REMOTE, ALLOWED_HOSTS: ',' })).toContain('allowed_hosts_empty');
  });

  it('a host the certificate SAN does not cover is refused, naming the uncovered hosts', () => {
    const message = refusalOf({
      ...REMOTE,
      ALLOWED_HOSTS: 'partner.local:4390,phone.example.com:4390,localhost:4390',
    });
    expect(message).toContain('phone.example.com:4390');
    expect(message).toContain('cert_san_uncovered');
    // Only the uncovered ones are named; the covered pair is not blamed.
    expect(message).not.toContain('partner.local');
    expect(message).not.toContain('localhost');
  });

  it('ALLOWED_HOSTS without REMOTE_ACCESS is refused, never silently ignored', () => {
    expect(refusalOf({ ...LIVE, ALLOWED_HOSTS: 'partner.local:4390' })).toContain(
      'allowed_hosts_requires_remote',
    );
  });

  it('default path unchanged: remote OFF + live loopback keeps the derived pair and no TLS', () => {
    const cfg = loadConfig(LIVE);
    expect(cfg.remoteAccess).toBe(false);
    expect(cfg.tls).toBeUndefined();
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.hostAllowlist).toEqual(['127.0.0.1:4390', 'localhost:4390']);
  });

  it('TLS on a loopback-only boot is allowed and does NOT replace the derived pair', () => {
    const cfg = loadConfig({ ...LIVE, TLS_CERT_FILE: CERT_FILE, TLS_KEY_FILE: KEY_FILE }, {
      readFile: GOOD_TLS,
    });
    expect(cfg.remoteAccess).toBe(false);
    expect(cfg.tls?.fingerprint).toBe(CERT_FINGERPRINT);
    expect(cfg.hostAllowlist).toEqual(['127.0.0.1:4390', 'localhost:4390']);
  });

  it('demo mode stays permissive for a non-loopback bind (container/dev)', () => {
    const cfg = loadConfig({ ...NO_ENV, HOST: '0.0.0.0' });
    expect(cfg.demo).toBe(true);
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.tls).toBeUndefined();
    expect(cfg.hostAllowlist).toEqual(['127.0.0.1:4390', 'localhost:4390']);
  });
});
