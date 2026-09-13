/**
 * PLAN-M20-B S6 wiring: `startServer` serves HTTPS when TLS is configured and
 * plain HTTP otherwise, and the Host guard is a lookup key over whatever
 * allowlist config derived or the operator listed.
 *
 * Hermetic: the certificate is a throwaway self-signed fixture written to a
 * temp dir (the same pair as `test/net/tls.test.ts` — EC P-256, SAN
 * `DNS:localhost, DNS:partner.local, IP:127.0.0.1`), the boots are demo boots
 * (in-memory DB, fake keychain — no OS keychain, no disk state), and the only
 * sockets are loopback ones this suite opens and closes itself.
 *
 * The matrix itself (which env combination is refused, and with which named
 * reason) is `test/config.test.ts`. This file proves the LISTENER half: that
 * `startServer`/`listen` serve HTTPS exactly when `config.tls` is set, and that
 * the Host guard admits only allowlisted hosts. `startServer` now also
 * re-asserts `transportRefusal` itself (defence in depth against a hand-built
 * config) — the earlier version of this comment claimed the listener "obeys the
 * matrix", which was false: `listen` branches on `config.tls` and checks nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest, Server as HttpServer } from 'node:http';
import type { RequestOptions } from 'node:http';
import { request as httpsRequest, Server as HttpsServer } from 'node:https';
import type { RequestOptions as HttpsRequestOptions } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TLSSocket } from 'node:tls';
import type { CoreConfig } from '../../src/config.js';
import { loadConfig, startServer } from '../../src/index.js';
import { certFingerprint } from '../../src/net/trust.js';

/** Matches KEY_PEM; same throwaway fixture as test/net/tls.test.ts. */
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
const KEY_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIDTIbltaDLffGYbF10BeaJsR/mILDcaFa/EO8appHihMoAoGCCqGSM49
AwEHoUQDQgAEr8810T4bI/inT7c/juc/10mL3NleRd7m2NCZoBKrDbo3StbCpGX0
9rvmLsZkpYXR49+vaU7Mw2lZ2IGC64bUbA==
-----END EC PRIVATE KEY-----`;
/** Independently computed: `openssl x509 -outform DER | sha256sum` → base64url. */
const CERT_FINGERPRINT = '4vlo9EhB9gTOB9OviWZ3FmFXhI73f9VWm2-konugr2I';

const tempDirs: string[] = [];
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Writes the fixture pair to a temp dir; the list is removed in afterEach. */
function tlsFixture(): { certFile: string; keyFile: string } {
  const dir = mkdtempSync(join(tmpdir(), 'partner-transport-'));
  tempDirs.push(dir);
  const certFile = join(dir, 'cert.pem');
  const keyFile = join(dir, 'key.pem');
  writeFileSync(certFile, CERT_PEM);
  writeFileSync(keyFile, KEY_PEM);
  return { certFile, keyFile };
}

async function boot(config: CoreConfig): Promise<{ port: number; server: HttpServer }> {
  const { bundle, server } = await startServer(config);
  cleanups.push(() => {
    server.close();
    server.closeAllConnections();
    bundle.close();
  });
  return { port: (server.address() as AddressInfo).port, server };
}

interface ProbeResult {
  status: number;
  body: string;
  /** Fingerprint of the certificate that actually answered (TLS probes only). */
  fingerprint?: string;
}

/** One-loopback request; `host` is the Host header the client claims. */
function probe(options: {
  port: number;
  secure: boolean;
  host: string;
  servername?: string;
}): Promise<ProbeResult> {
  const base: RequestOptions = {
    host: '127.0.0.1',
    port: options.port,
    path: '/v1/health',
    method: 'GET',
    // A per-request agent: no keep-alive socket outlives the test.
    agent: false,
    headers: { host: options.host },
  };
  const secure: HttpsRequestOptions = {
    ...base,
    servername: options.servername,
    // Self-signed fixture: the certificate is PINNED by fingerprint (asserted
    // below), not validated against a CA chain.
    rejectUnauthorized: false,
  };

  return new Promise((resolve, reject) => {
    const onResponse = (res: import('node:http').IncomingMessage): void => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        body += chunk;
      });
      res.on('end', () => {
        const socket = res.socket as TLSSocket | null;
        const peer =
          socket !== null && typeof socket.getPeerCertificate === 'function'
            ? socket.getPeerCertificate()
            : undefined;
        resolve({
          status: res.statusCode ?? 0,
          body,
          ...(peer?.raw === undefined ? {} : { fingerprint: certFingerprint(peer.raw) }),
        });
      });
    };
    const req = options.secure ? httpsRequest(secure, onResponse) : httpRequest(base, onResponse);
    req.on('error', reject);
    req.end();
  });
}

describe('startServer transport wiring (PLAN-M20-B S6)', () => {
  it('default path unchanged: no TLS config boots a plain HTTP listener', async () => {
    const config: CoreConfig = { ...loadConfig({ DEMO_MODE: '1' }), port: 0 };
    const { port, server } = await boot(config);

    expect(server instanceof HttpsServer).toBe(false);
    expect(server instanceof HttpServer).toBe(true);

    // PORT=0 (overridden above) lets the OS pick the port while the derived
    // allowlist keeps the CONFIGURED port, so the probe sends that entry.
    const ok = await probe({ port, secure: false, host: '127.0.0.1:4390' });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ status: 'ok' });
    expect(ok.fingerprint).toBeUndefined();

    const refused = await probe({ port, secure: false, host: 'evil.example:4390' });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ error: 'forbidden_host' });
  });

  it('TLS configured → https; an allowlisted Host is served, an unlisted one refused', async () => {
    const { certFile, keyFile } = tlsFixture();
    const config: CoreConfig = {
      ...loadConfig({
        DEMO_MODE: '1',
        REMOTE_ACCESS: '1',
        HOST: '127.0.0.1',
        ALLOWED_HOSTS: 'partner.local:4390,127.0.0.1:4390',
        TLS_CERT_FILE: certFile,
        TLS_KEY_FILE: keyFile,
      }),
      port: 0,
    };
    // The explicit list is honoured verbatim (no loopback pair appended).
    expect(config.remoteAccess).toBe(true);
    expect(config.hostAllowlist).toEqual(['partner.local:4390', '127.0.0.1:4390']);

    const { port, server } = await boot(config);
    expect(server instanceof HttpsServer).toBe(true);

    const ok = await probe({
      port,
      secure: true,
      host: 'partner.local:4390',
      servername: 'partner.local',
    });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toMatchObject({ status: 'ok' });
    // The bytes that answered are the certificate config validated + pinned.
    expect(ok.fingerprint).toBe(config.tls?.fingerprint);
    expect(ok.fingerprint).toBe(CERT_FINGERPRINT);

    // The Host header is a lookup key: the handshake succeeds (the SNI is a
    // name the certificate covers) and the guard still refuses the request.
    const refused = await probe({
      port,
      secure: true,
      host: 'phone.example.com:4390',
      servername: 'partner.local',
    });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ error: 'forbidden_host' });
  });

  it('TLS without remote access stays loopback-allowlisted (no implicit widening)', async () => {
    const { certFile, keyFile } = tlsFixture();
    const config: CoreConfig = {
      ...loadConfig({
        DEMO_MODE: '1',
        PORT: '4390',
        TLS_CERT_FILE: certFile,
        TLS_KEY_FILE: keyFile,
      }),
      port: 0,
    };
    expect(config.remoteAccess).toBe(false);
    expect(config.hostAllowlist).toEqual(['127.0.0.1:4390', 'localhost:4390']);

    const { port, server } = await boot(config);
    expect(server instanceof HttpsServer).toBe(true);

    const ok = await probe({ port, secure: true, host: '127.0.0.1:4390' });
    expect(ok.status).toBe(200);

    // Covered by the certificate's SAN, but NOT on the derived pair: refused.
    const refused = await probe({
      port,
      secure: true,
      host: 'partner.local:4390',
      servername: 'partner.local',
    });
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ error: 'forbidden_host' });
  });

  it('remote access ON + TLS can actually bind beyond loopback (the capability itself)', async () => {
    const { certFile, keyFile } = tlsFixture();
    const config: CoreConfig = {
      ...loadConfig({
        DEMO_MODE: '1',
        REMOTE_ACCESS: '1',
        HOST: '0.0.0.0',
        ALLOWED_HOSTS: 'partner.local:4390',
        TLS_CERT_FILE: certFile,
        TLS_KEY_FILE: keyFile,
      }),
      port: 0,
    };

    const { port, server } = await boot(config);
    expect(server instanceof HttpsServer).toBe(true);
    expect((server.address() as AddressInfo).address).toBe('0.0.0.0');
    // The allowlist still decides who is served on that outward socket.
    const ok = await probe({
      port,
      secure: true,
      host: 'partner.local:4390',
      servername: 'partner.local',
    });
    expect(ok.status).toBe(200);
    expect(await probe({ port, secure: true, host: 'evil.example:4390' })).toMatchObject({
      status: 403,
    });
    // Loopback is NOT special: with an explicit list, the derived pair is
    // absent, so a loopback Host header is refused like any other unlisted one.
    expect(await probe({ port, secure: true, host: '127.0.0.1:4390' })).toMatchObject({
      status: 403,
    });
    expect(await probe({ port, secure: true, host: 'localhost:4390' })).toMatchObject({
      status: 403,
    });
  });
});
