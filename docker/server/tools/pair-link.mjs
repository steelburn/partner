#!/usr/bin/env node
/**
 * Issue a networked-pairing link from INSIDE the container (M21).
 *
 *   docker compose exec partner node tools/pair-link.mjs
 *
 * Why this is a container-side tool and not a button in the UI: `POST
 * /v1/pair/payload` is deliberately loopback-only (M20-B S7) — only a caller on
 * the machine may mint a pairing secret. In this deployment the published
 * surface is the tunnel, and the tunnel sidecar lives in its OWN network
 * namespace, so a request that arrives from the internet is NOT loopback and
 * cannot mint anything. Shell access to the container (`compose exec`) is the
 * operator's proof of "at the machine", and it is the intended pairing path.
 *
 * The printed link carries a 256-bit single-use secret in the URL fragment. Send
 * it to the phone and open it: the device pairs as a PHONE session (chat + read +
 * notes/memory/personas + schedules), which is what this topology can issue —
 * see the README's "what class of session can I get?" section.
 */
import { partnerEnv, partnerJson } from './partner-request.mjs';

/** base64url of a UTF-8 string — mirrors web/src/lib/pair-link.ts. */
function base64UrlEncode(text) {
  return Buffer.from(text, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

const env = partnerEnv();
const info = await partnerJson({
  method: 'POST',
  path: '/v1/pair/payload',
  body: '{}',
  env,
});

const link = `https://${env.host}/#pair=${base64UrlEncode(info.payload)}`;
console.log('');
console.log('Pairing link (single use, expires in ~2 minutes):');
console.log('');
console.log(`  ${link}`);
console.log('');
console.log(`Certificate fingerprint the device will pin: ${info.certFingerprint}`);
console.log('');
console.log('Open it on the device. If it expires, run this again.');
