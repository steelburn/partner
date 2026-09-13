#!/usr/bin/env node
/**
 * Container healthcheck (M21, wired as the Dockerfile HEALTHCHECK).
 *
 * Exits 0 only when the core answers /v1/health over HTTPS with the allowlisted
 * public hostname. That single check covers three deployment mistakes at once:
 * the listener is not up, the certificate does not match the hostname, or
 * ALLOWED_HOSTS does not contain the hostname the tunnel sends (which would 403
 * every browser request while the process still looked "running").
 */
import { partnerEnv, partnerJson } from './partner-request.mjs';

try {
  const env = partnerEnv();
  const health = await partnerJson({ method: 'GET', path: '/v1/health', env });
  if (health.status !== 'ok') {
    console.error(`unexpected health body: ${JSON.stringify(health)}`);
    process.exit(1);
  }
} catch (cause) {
  console.error(`healthcheck failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
