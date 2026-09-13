/**
 * Wrapping the partition key with the user's passphrase (M20-B S9) — PURE crypto.
 *
 * ## The promise this exists to keep
 *
 * PLAN-M20 §2a: *"a session may never carry a user without a user-authentication
 * event"*, and §4.4's hosted answer is that a user's partition is decryptable
 * **only while that user has signed in**. That is impossible while the cipher key
 * sits in a keychain file in plaintext: anyone who can read the volume can open
 * the database, signed in or not.
 *
 * So at first sign-in the partition key is wrapped under a key derived from the
 * passphrase, and the plaintext copy is removed. From then on the key exists in
 * two places only: inside the wrap (needs the passphrase) and in the process
 * memory of an unlocked session.
 *
 * ## Why the verifier cannot unwrap it (the part that is easy to get wrong)
 *
 * `users/credentials.ts` already stores `scrypt(passphrase, verifySalt, params)`
 * as the verifier. If the wrap reused THAT derivation, then reading the system
 * database would hand you the key-encryption key — the operator-readable-store
 * problem back in a new costume. So the wrap uses its **own random salt** and its
 * own HKDF domain separation, and `keyWrap.test.ts` asserts that a stored
 * credential cannot unwrap a wrap.
 *
 * ## Fail-closed rules
 *
 *  - AES-256-GCM with a random 12-byte nonce; the tag is verified, so a tampered
 *    or truncated wrap returns `null` rather than garbage.
 *  - A wrong passphrase returns `null` (GCM's tag check is the answer), never a
 *    throw and never a partial key.
 *  - A wrap whose fields are missing/not base64 is `null`.
 *  - The passphrase is never stored, never logged, and never part of the wrap.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, scrypt } from 'node:crypto';
import { SCRYPT_PARAMS } from './credentials.js';

/** scrypt's memory ceiling: `128 * N * r` sits just under 128 MiB with our params. */
const SCRYPT_MAXMEM = 192 * 1024 * 1024;

/** Domain separation so this key is not the credential verifier's derivation. */
const WRAP_INFO = Buffer.from('partner/key-wrap/v1', 'utf8');
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const SALT_BYTES = 16;

/** What is stored for a wrapped key. Every field is base64. */
export interface KeyWrap {
  salt: string;
  nonce: string;
  tag: string;
  ciphertext: string;
}

export function newWrapSalt(): string {
  return randomBytes(SALT_BYTES).toString('base64');
}

/**
 * Derive the key-encryption key from the passphrase and the wrap's own salt.
 *
 * scrypt first (the passphrase's work factor), then HKDF to separate the domains:
 * even if the credential verifier used the same salt (it does not), the wrap key
 * would still be a different 32 bytes.
 */
export async function deriveWrappingKey(passphrase: string, saltB64: string): Promise<Buffer> {
  if (typeof passphrase !== 'string' || passphrase === '') {
    throw new Error('deriveWrappingKey: empty passphrase');
  }
  const salt = Buffer.from(String(saltB64 ?? ''), 'base64');
  if (salt.byteLength === 0) throw new Error('deriveWrappingKey: empty salt');
  const raw = await new Promise<Buffer>((resolve, reject) => {
    scrypt(
      passphrase,
      salt,
      KEY_BYTES,
      { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, maxmem: SCRYPT_MAXMEM },
      (err, derived) => (err ? reject(err) : resolve(derived as Buffer)),
    );
  });
  return Buffer.from(hkdfSync('sha256', raw, salt, WRAP_INFO, KEY_BYTES));
}

/** Wrap a 64-hex partition key under `kek`, recording the salt it came from. */
export function wrapKeyHex(kek: Buffer, keyHex: string, saltB64: string): KeyWrap {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) throw new Error('wrapKeyHex: expected 64 hex characters');
  if (typeof saltB64 !== 'string' || saltB64 === '') throw new Error('wrapKeyHex: salt is required');
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(keyHex, 'utf8')), cipher.final()]);
  return {
    salt: saltB64,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/** Unwrap, or `null` for a wrong passphrase / tampered wrap / malformed input. */
export function unwrapKeyHex(kek: Buffer, wrap: KeyWrap): string | null {
  try {
    const nonce = Buffer.from(String(wrap?.nonce ?? ''), 'base64');
    const tag = Buffer.from(String(wrap?.tag ?? ''), 'base64');
    const ciphertext = Buffer.from(String(wrap?.ciphertext ?? ''), 'base64');
    if (nonce.byteLength !== NONCE_BYTES || tag.byteLength !== 16 || ciphertext.byteLength === 0) {
      return null;
    }
    const decipher = createDecipheriv('aes-256-gcm', kek, nonce);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    return /^[0-9a-f]{64}$/.test(plain) ? plain : null;
  } catch {
    return null;
  }
}

/** Shape guard for a stored wrap (all four fields present and base64). */
export function isKeyWrap(value: unknown): value is KeyWrap {
  if (typeof value !== 'object' || value === null) return false;
  const wrap = value as Record<string, unknown>;
  for (const field of ['salt', 'nonce', 'tag', 'ciphertext']) {
    const raw = wrap[field];
    if (typeof raw !== 'string' || raw.length === 0) return false;
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return false;
  }
  return true;
}
