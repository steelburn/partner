/**
 * Live-mode database encryption key (M10 W1, Decision A).
 *
 * The whole-file cipher key is a random 32-byte value stored ONLY in the OS
 * keychain — the same keychain that holds provider keys, so the DB cannot be
 * decrypted by another OS user or by copying the DB file off the machine.
 * The account is `db-key` for the single-user (OS-profile) database; M20-B S1
 * adds one account per app-user partition (`db-key:<userId>`).
 */
import { randomBytes } from 'node:crypto';
import { LEGACY_USER_ID } from '@partner/shared';
import type { Keychain } from '@partner/shared';
import { assertValidUserId } from '../users/paths.js';
import { KEYCHAIN_SERVICE } from './keychain.js';

/**
 * The LEGACY single-user account — one cipher key per OS user, still the
 * account a boot without USER_ID uses (existing installs stay byte-identical).
 */
export const DB_KEY_ACCOUNT = 'db-key';
const HEX_RE = /^[0-9a-f]{64}$/;

/**
 * The keychain account holding ONE app user's partition cipher key. Distinct
 * per user, and never the legacy account, so a partition open can neither
 * read nor overwrite the OS-profile database's key. The id is validated here
 * too (an unvalidated id could collide with another user's account).
 */
export function dbKeyAccount(userId: string): string {
  assertValidUserId(userId);
  // The legacy user owns the PRE-PARTITION account, so an existing install's
  // database still opens with the key it was encrypted under rather than a fresh
  // empty one under `db-key:0`. Every other id gets its own account, which is
  // what stops one user's key from opening another's file.
  if (userId === LEGACY_USER_ID) return DB_KEY_ACCOUNT;
  return `${DB_KEY_ACCOUNT}:${userId}`;
}

/**
 * Read the existing cipher key for `account` or create + persist a fresh one.
 * Returns the 32-byte key as 64 hex chars (the `PRAGMA key = "x'…'"` form —
 * no SQLCipher KDF). A stored value that is present-but-malformed is REFUSED
 * (rotating it would orphan an existing encrypted database silently).
 * Defaults to the legacy single-user account.
 */
export async function ensureDbKey(
  keychain: Keychain,
  account: string = DB_KEY_ACCOUNT,
): Promise<string> {
  const existing = await keychain.get(KEYCHAIN_SERVICE, account);
  if (existing === null) {
    const fresh = randomBytes(32).toString('hex');
    await keychain.set(KEYCHAIN_SERVICE, account, fresh);
    return fresh;
  }
  if (HEX_RE.test(existing)) return existing;
  throw new Error(
    `the stored database key (service ${KEYCHAIN_SERVICE}, account ${account}) is ` +
      'malformed — refusing to rotate it because an existing database may be ' +
      'encrypted under it. Remove the account (and the database) deliberately ' +
      'to start fresh.',
  );
}
