/**
 * M20-B S7 — NETWORKED PAIRING (the wiring).
 *
 * `pairSecret.ts` / `rateLimit.ts` / `pairPayload.ts` are the pure primitives;
 * this file proves the routes actually use them and that the client-class rule
 * holds end to end:
 *
 *  - `{code}` is the LOCAL ceremony: refused from a non-loopback peer BEFORE
 *    the code is verified (so a remote caller can neither consume nor lock the
 *    code the user is reading off their own screen) and mints `desktop`.
 *  - `{secret}` is issued only to a loopback caller, accepted from anywhere,
 *    and NEVER mints desktop — it mints `mobile`. A real phone can therefore
 *    obtain a mobile session for the first time.
 *  - both paths are per-peer rate limited BEFORE any verification, with the
 *    bucket reset on success;
 *  - the payload route refuses without remote access + TLS (no dead
 *    credentials, no plaintext-carried secret);
 *  - no secret, code or token reaches an audit row.
 *
 * The peer is injected (`peerAddress`) because a hermetic test cannot dial a
 * non-loopback address. The realistic topology — the secret is ISSUED from the
 * machine and REDEEMED by the phone — is modelled by keying the injected peer
 * on the request path; the DEFAULT path (the real socket address) is exercised
 * by every other pairing test in the suite, which pairs over loopback.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Request } from 'express';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness, HarnessOptions } from '../helpers.js';
import { isCertFingerprint } from '../../src/net/trust.js';
import { isPairSecret } from '../../src/http/pairSecret.js';
import { parsePairPayload } from '../../src/http/pairPayload.js';

const LOOPBACK = '127.0.0.1';
const REMOTE = '198.51.100.7';

/** A canonical 43-char base64url fingerprint (what tls.ts produces). */
const FINGERPRINT = Buffer.alloc(32, 7).toString('base64url');

/** The local-issue / remote-redeem topology: only the payload route is local. */
const localIssueRemoteRedeem = (req: Request): string =>
  req.path === '/v1/pair/payload' ? LOOPBACK : REMOTE;

/** A harness with the networked-pairing lane fully configured. */
function networkedHarness(extra: HarnessOptions = {}): Harness {
  return demoHarness({
    remoteAccess: true,
    tlsFingerprint: FINGERPRINT,
    pairCoreUrl: 'https://core.example.com',
    peerAddress: localIssueRemoteRedeem,
    ...extra,
  });
}

/** Ask the local payload route for a fresh secret (the QR/link contents). */
async function issuePayload(h: Harness): Promise<string> {
  const res = await request(h.app)
    .post('/v1/pair/payload')
    .set('Host', ALLOWED_HOST)
    .send({});
  expect(res.status).toBe(200);
  return res.body.payload as string;
}

function secretOf(payload: string): string {
  const parsed = parsePairPayload(payload);
  if (!parsed.ok) throw new Error(`payload refused: ${parsed.reason}`);
  return parsed.payload.secret;
}

/** Pair with a secret (the phone side, by default a remote peer). */
function pairWithSecret(h: Harness, secret: string, extra: Record<string, unknown> = {}) {
  return request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ secret, ...extra });
}

describe('POST /v1/pair/payload — issuing a networked pairing secret', () => {
  it('issues a valid payload to the local caller', async () => {
    const h = networkedHarness();
    try {
      const res = await request(h.app).post('/v1/pair/payload').set('Host', ALLOWED_HOST).send({});
      expect(res.status).toBe(200);
      expect(res.body.coreUrl).toBe('https://core.example.com');
      expect(res.body.certFingerprint).toBe(FINGERPRINT);

      const parsed = parsePairPayload(res.body.payload);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        // The payload agrees with the modules that own its parts.
        expect(parsed.payload.certFingerprint).toBe(FINGERPRINT);
        expect(isPairSecret(parsed.payload.secret)).toBe(true);
        expect(isCertFingerprint(parsed.payload.certFingerprint)).toBe(true);
      }
    } finally {
      h.close();
    }
  });

  it('refuses the payload route to a remote caller', async () => {
    const h = networkedHarness({ peerAddress: () => REMOTE });
    try {
      const res = await request(h.app).post('/v1/pair/payload').set('Host', ALLOWED_HOST).send({});
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'loopback_required' });
    } finally {
      h.close();
    }
  });

  it('refuses without remote access (a secret nobody can reach is not issued)', async () => {
    const h = demoHarness({ tlsFingerprint: FINGERPRINT, pairCoreUrl: 'https://core.example.com' });
    try {
      const res = await request(h.app).post('/v1/pair/payload').set('Host', ALLOWED_HOST).send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'remote_access_disabled' });
    } finally {
      h.close();
    }
  });

  it('refuses without TLS material (the pin is the point of the payload)', async () => {
    const h = demoHarness({ remoteAccess: true });
    try {
      const res = await request(h.app).post('/v1/pair/payload').set('Host', ALLOWED_HOST).send({});
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: 'tls_required' });
    } finally {
      h.close();
    }
  });

  it('derives the https core URL from the allowlist when not overridden', async () => {
    const h = demoHarness({ remoteAccess: true, tlsFingerprint: FINGERPRINT });
    try {
      const res = await request(h.app).post('/v1/pair/payload').set('Host', ALLOWED_HOST).send({});
      expect(res.status).toBe(200);
      // ALLOWLIST's first entry is 127.0.0.1:4390.
      expect(res.body.coreUrl).toBe('https://127.0.0.1:4390');
    } finally {
      h.close();
    }
  });

  it('issues a single active secret: a new payload invalidates the previous one', async () => {
    const h = networkedHarness();
    try {
      const first = secretOf(await issuePayload(h));
      const second = secretOf(await issuePayload(h));
      expect(first).not.toBe(second);

      const stale = await pairWithSecret(h, first);
      expect(stale.status).toBe(401);

      const fresh = await pairWithSecret(h, second);
      expect(fresh.status).toBe(200);
      expect(fresh.body.clientClass).toBe('mobile');
    } finally {
      h.close();
    }
  });

  it('consumes the secret on first use (single use)', async () => {
    const h = networkedHarness();
    try {
      const secret = secretOf(await issuePayload(h));
      expect((await pairWithSecret(h, secret)).status).toBe(200);
      const replay = await pairWithSecret(h, secret);
      expect(replay.status).toBe(401);
      expect(replay.body.reason).toBe('not_found');
    } finally {
      h.close();
    }
  });

  it('never writes the secret, the payload or a token into an audit row', async () => {
    const h = networkedHarness();
    try {
      const payload = await issuePayload(h);
      const secret = secretOf(payload);
      const paired = await pairWithSecret(h, secret);
      const token = paired.body.token as string;

      const rows = h.audit.query({ actor: 'pair', limit: 100 });
      const text = JSON.stringify(rows);
      expect(rows.length).toBeGreaterThan(0);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(payload);
      expect(text).not.toContain(token);
    } finally {
      h.close();
    }
  });
});

describe('POST /v1/pair — the client-class rule (S7)', () => {
  it('a secret pairs a MOBILE session from a remote peer (a real phone can now connect)', async () => {
    const h = networkedHarness();
    try {
      const secret = secretOf(await issuePayload(h));
      const res = await pairWithSecret(h, secret, { deviceLabel: 'Pixel 9', platform: 'android' });
      expect(res.status).toBe(200);
      expect(res.body.clientClass).toBe('mobile');
      expect(res.body.kind).toBe('web');

      // The class is not decorative: the minted session is refused a
      // desktop-only capability by the S4 envelope, by name.
      const denied = await request(h.app)
        .post('/v1/roots')
        .set({ Host: ALLOWED_HOST, Authorization: `Bearer ${res.body.token as string}` })
        .send({ label: 'x', path: '/tmp' });
      expect(denied.status).toBe(403);
      expect(denied.body.error).toBe('capability_denied');
      expect(denied.body.clientClass).toBe('mobile');
    } finally {
      h.close();
    }
  });

  it('the registry records the pair-time device metadata', async () => {
    const h = networkedHarness();
    try {
      const secret = secretOf(await issuePayload(h));
      await pairWithSecret(h, secret, { deviceLabel: 'Pixel 9', platform: 'android' });
      const devices = await h.sessions.listDevices(null);
      expect(devices).toHaveLength(1);
      expect(devices[0]).toMatchObject({
        clientClass: 'mobile',
        deviceLabel: 'Pixel 9',
        platform: 'android',
      });
    } finally {
      h.close();
    }
  });

  it('a 6-digit CODE from a remote peer is refused and NOT consumed', async () => {
    const h = networkedHarness();
    try {
      const code = await h.pairing.issue();
      const remote = await request(h.app)
        .post('/v1/pair')
        .set('Host', ALLOWED_HOST)
        .send({ code });
      expect(remote.status).toBe(403);
      expect(remote.body).toEqual({ error: 'loopback_required' });
      // No session was minted by the refusal.
      expect(await h.sessions.listDevices(null)).toHaveLength(0);
      // The code is still live: the refusal did not verify or lock it.
      expect((await h.pairing.verify(code)).ok).toBe(true);
    } finally {
      h.close();
    }
  });

  it('a loopback code still mints desktop (unchanged local ceremony)', async () => {
    const h = demoHarness();
    try {
      const code = await h.pairing.issue();
      const res = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ kind: 'web', clientClass: 'desktop' });
    } finally {
      h.close();
    }
  });

  it('refuses an ambiguous or missing credential before spending one', async () => {
    const h = networkedHarness();
    try {
      const secret = secretOf(await issuePayload(h));
      const code = await h.pairing.issue();

      const both = await request(h.app)
        .post('/v1/pair')
        .set('Host', ALLOWED_HOST)
        .send({ code, secret });
      expect(both.status).toBe(400);
      expect(both.body).toEqual({ error: 'invalid_pairing_request', reason: 'ambiguous_credential' });

      const neither = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({});
      expect(neither.status).toBe(400);
      expect(neither.body).toEqual({ error: 'invalid_pairing_request', reason: 'missing_credential' });

      // Neither refusal consumed a credential: the code and the secret are
      // both still live.
      const paired = await pairWithSecret(h, secret);
      expect(paired.status).toBe(200);
      expect((await h.pairing.verify(code)).ok).toBe(true);
    } finally {
      h.close();
    }
  });

  it('accepts a literal "invalid" device label (only the sentinel is refused)', async () => {
    const h = networkedHarness();
    try {
      const secret = secretOf(await issuePayload(h));
      const res = await pairWithSecret(h, secret, { deviceLabel: 'invalid' });
      expect(res.status).toBe(200);
      expect((await h.sessions.listDevices(null))[0]?.deviceLabel).toBe('invalid');
    } finally {
      h.close();
    }
  });

  it('refuses malformed device metadata without consuming the secret', async () => {
    const h = networkedHarness();
    try {
      const secret = secretOf(await issuePayload(h));
      const long = await pairWithSecret(h, secret, { deviceLabel: 'x'.repeat(65) });
      expect(long.status).toBe(400);
      expect(long.body.reason).toBe('invalid_device_label');

      const control = await pairWithSecret(h, secret, { platform: 'a\u0000b' });
      expect(control.status).toBe(400);
      expect(control.body.reason).toBe('invalid_platform');

      const ok = await pairWithSecret(h, secret);
      expect(ok.status).toBe(200);
    } finally {
      h.close();
    }
  });

  it('refuses an unattributable peer instead of pooling it', async () => {
    const h = networkedHarness({
      peerAddress: (req) => (req.path === '/v1/pair/payload' ? LOOPBACK : ''),
    });
    try {
      const secret = secretOf(await issuePayload(h));
      const res = await pairWithSecret(h, secret);
      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'forbidden_peer' });
    } finally {
      h.close();
    }
  });
});

describe('POST /v1/pair — per-peer rate limit', () => {
  it('refuses after the window budget and reports when to retry', async () => {
    const h = networkedHarness({ pairRateLimit: { limit: 2, windowMs: 60_000 } });
    try {
      for (let i = 0; i < 2; i += 1) {
        const res = await pairWithSecret(h, 'not-a-secret');
        expect(res.status).toBe(401);
      }
      const limited = await pairWithSecret(h, 'not-a-secret');
      expect(limited.status).toBe(429);
      expect(limited.body.error).toBe('too_many_attempts');
      expect(limited.body.reason).toBe('rate_limited');
      expect(limited.body.retryAfterMs).toBeGreaterThan(0);
      expect(limited.headers['retry-after']).toBeDefined();
    } finally {
      h.close();
    }
  });

  it('limits each peer separately', async () => {
    const h = demoHarness({ peer: REMOTE, pairRateLimit: { limit: 1, windowMs: 60_000 } });
    try {
      expect((await pairWithSecret(h, 'nope')).status).toBe(401);
      expect((await pairWithSecret(h, 'nope')).status).toBe(429);

      const other = demoHarness({
        peer: '198.51.100.8',
        pairRateLimit: { limit: 1, windowMs: 60_000 },
      });
      try {
        expect((await pairWithSecret(other, 'nope')).status).toBe(401);
      } finally {
        other.close();
      }
    } finally {
      h.close();
    }
  });

  it('limits the code path too, and a SUCCESSFUL pair resets the bucket', async () => {
    const h = demoHarness({ peer: LOOPBACK, pairRateLimit: { limit: 3, windowMs: 60_000 } });
    try {
      // Two wrong codes consume two of three.
      await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code: '000000' });
      await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code: '000001' });

      // A successful pairing is the third attempt and resets the window.
      const code = await h.pairing.issue();
      const ok = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
      expect(ok.status).toBe(200);

      // The budget is fresh again (would be 429 without the reset).
      const after = await pairWithSecret(h, 'not-a-secret');
      expect(after.status).toBe(401);
    } finally {
      h.close();
    }
  });
});
