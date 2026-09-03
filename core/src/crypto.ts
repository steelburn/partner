/**
 * crypto — small CSPRNG + hashing helpers shared by the security spine.
 *
 * Session tokens and pairing codes must never be derived from anything
 * guessable: everything here funnels through node:crypto's CSPRNG. Only
 * SHA-256 digests of secrets are ever persisted (see http/pairing.ts and
 * http/session.ts).
 */

import { createHash, randomBytes, randomInt } from 'node:crypto';

/** SHA-256 hex digest — the only representation of secrets stored at rest. */
export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** 256-bit random session token, hex-encoded (64 chars). */
export function randomTokenHex(): string {
  return randomBytes(32).toString('hex');
}

/** CSPRNG 6-digit pairing code, zero-padded to a fixed width. */
export function randomPairCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}
