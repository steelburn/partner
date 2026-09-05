/**
 * Live-mode database encryption key (M10 W1, Decision A).
 *
 * The whole-file cipher key is a random 32-byte value stored ONLY in the OS
 * keychain under service `partner` / account `db-key` — the same keychain
 * that holds provider keys, so the DB cannot be decrypted by another OS user
 * or by copying the DB file off the machine.
 */
import { randomBytes } from 'node:crypto';
import type { Keychain } from '@partner/shared';
import { KEYCHAIN_SERVICE } from './keychain.js';

export const DB_KEY_ACCOUNT = 'db-key';
const HEX_RE = /^[0-9a-f]{64}$/;

/**
 * Read the existing DB cipher key or create + persist a fresh one. Returns
 * the 32-byte key as 64 hex chars (the `PRAGMA key = "x'…'"` form — no
 * SQLCipher KDF). A stored value that is present-but-malformed is REFUSED
 * (rotating it would orphan an existing encrypted database silently).
 */
export async function ensureDbKey(keychain: Keychain): Promise<string> {
  const existing = await keychain.get(KEYCHAIN_SERVICE, DB_KEY_ACCOUNT);
  if (existing === null) {
    const fresh = randomBytes(32).toString('hex');
    await keychain.set(KEYCHAIN_SERVICE, DB_KEY_ACCOUNT, fresh);
    return fresh;
  }
  if (HEX_RE.test(existing)) return existing;
  throw new Error(
    `the stored database key (service ${KEYCHAIN_SERVICE}, account ${DB_KEY_ACCOUNT}) is ` +
      'malformed — refusing to rotate it because an existing database may be ' +
      'encrypted under it. Remove the account (and the database) deliberately ' +
      'to start fresh.',
  );
}
