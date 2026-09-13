/**
 * M20-B S9 — wrapped partition keys and the per-user key vault.
 *
 * The promise under test: **no live session ⇒ the partition cannot be opened**
 * (unless the user explicitly chose to keep it unlocked), and the record that
 * proves the passphrase cannot be used to unwrap the key.
 */
import { describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  deriveWrappingKey,
  isKeyWrap,
  newWrapSalt,
  unwrapKeyHex,
  wrapKeyHex,
} from '../../src/users/keyWrap.js';
import { createCredentialManager, SCRYPT_PARAMS } from '../../src/users/credentials.js';
import { createKeyVault } from '../../src/users/unlock.js';
import { createKeychainFake, KEYCHAIN_SERVICE } from '../../src/keychain/keychain.js';
import { dbKeyAccount } from '../../src/keychain/dbKey.js';
import { openDatabase } from '../../src/stores/db.js';
import { createSystemStores } from '../../src/users/store.js';
import type { SystemStores } from '../../src/users/store.js';
import type { UserRow } from '../../src/stores/types.js';

const KEY_HEX = 'a'.repeat(64);
const PASSPHRASE = 'correct horse battery staple';

function system(): { db: Database.Database; stores: SystemStores } {
  const db = openDatabase(':memory:');
  return { db, stores: createSystemStores(db) };
}

function userRow(id: string, keepUnlocked = false): UserRow {
  return {
    id,
    label: id,
    osProfileKey: null,
    createdAt: 1,
    disabledAt: null,
    keepUnlocked,
  };
}

describe('key wrapping', () => {
  it('round-trips a 64-hex key', async () => {
    const salt = newWrapSalt();
    const wrap = wrapKeyHex(await deriveWrappingKey(PASSPHRASE, salt), KEY_HEX, salt);
    expect(isKeyWrap(wrap)).toBe(true);
    expect(unwrapKeyHex(await deriveWrappingKey(PASSPHRASE, salt), wrap)).toBe(KEY_HEX);
  });

  it('a wrong passphrase unwraps to null, never to garbage', async () => {
    const salt = newWrapSalt();
    const wrap = wrapKeyHex(await deriveWrappingKey(PASSPHRASE, salt), KEY_HEX, salt);
    expect(unwrapKeyHex(await deriveWrappingKey('not-the-passphrase', salt), wrap)).toBeNull();
  });

  it('THE POINT: the stored credential verifier cannot unwrap it', async () => {
    // The system DB holds scrypt(passphrase, verifySalt). If the wrap reused that
    // derivation, reading the DB would hand over the key-encryption key — the
    // operator-readable store in a new costume.
    const { db, stores } = system();
    try {
      await createCredentialManager(stores.credentials).create('ama', PASSPHRASE);
      const row = stores.credentials.findByUserId('ama');
      expect(row).toBeDefined();

      const wrapSalt = newWrapSalt();
      const wrap = wrapKeyHex(await deriveWrappingKey(PASSPHRASE, wrapSalt), KEY_HEX, wrapSalt);

      // Attempt 1: use the stored verifier bytes as if they were a KEK.
      const verifierAsKek = Buffer.from(String(row?.hash ?? ''), 'hex');
      expect(verifierAsKek).toHaveLength(SCRYPT_PARAMS.keylen);
      expect(unwrapKeyHex(verifierAsKek, wrap)).toBeNull();
      // Attempt 2: derive with the CREDENTIAL's salt instead of the wrap's.
      expect(
        unwrapKeyHex(await deriveWrappingKey(PASSPHRASE, String(row?.salt ?? '')), wrap),
      ).toBeNull();
    } finally {
      db.close();
    }
  });

  it('refuses a tampered, truncated or malformed wrap', async () => {
    const salt = newWrapSalt();
    const kek = await deriveWrappingKey(PASSPHRASE, salt);
    const wrap = wrapKeyHex(kek, KEY_HEX, salt);
    expect(unwrapKeyHex(kek, { ...wrap, ciphertext: `${wrap.ciphertext.slice(0, -4)}AAAA` })).toBeNull();
    expect(unwrapKeyHex(kek, { ...wrap, tag: 'AAAA' })).toBeNull();
    expect(unwrapKeyHex(kek, { ...wrap, nonce: '' })).toBeNull();
    expect(isKeyWrap({ salt: 'x', nonce: 'y', tag: 'z' })).toBe(false);
    expect(isKeyWrap(null)).toBe(false);
  });

  it('refuses a key that is not 32 bytes of hex (a caller bug, not data)', async () => {
    const salt = newWrapSalt();
    const kek = await deriveWrappingKey(PASSPHRASE, salt);
    expect(() => wrapKeyHex(kek, 'short', salt)).toThrow(/64 hex/);
    expect(() => wrapKeyHex(kek, KEY_HEX, '')).toThrow(/salt/);
  });
});

describe('the key vault', () => {
  async function vaultFor(options: { keepUnlocked?: boolean } = {}) {
    const { db, stores } = system();
    const keychain = createKeychainFake();
    stores.users.insert(userRow('ama', options.keepUnlocked === true));
    // The pre-S9 shape: the partition key exists in the keychain in plaintext.
    await keychain.set(KEYCHAIN_SERVICE, dbKeyAccount('ama'), KEY_HEX);
    const vault = createKeyVault({ keychain, wraps: stores.keyWraps, users: stores.users });
    return { db, stores, keychain, vault };
  }

  it('adopt wraps the existing keychain key and REMOVES the plaintext', async () => {
    const { db, keychain, vault, stores } = await vaultFor();
    try {
      expect(await vault.adopt('ama', PASSPHRASE)).toBe(true);
      expect(vault.hasWrap('ama')).toBe(true);
      // The promise: signed out means unreadable. Without this delete it is
      // decorative.
      expect(await keychain.get(KEYCHAIN_SERVICE, dbKeyAccount('ama'))).toBeNull();
      // The wrap carries its own salt, not the credential's (none exists here).
      expect(stores.keyWraps.findByUser('ama')?.salt).toBeTruthy();
      // Adopting is idempotent.
      expect(await vault.adopt('ama', PASSPHRASE)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('adopt KEEPS the plaintext for a user who chose to stay unlocked', async () => {
    const { db, keychain, vault } = await vaultFor({ keepUnlocked: true });
    try {
      expect(await vault.adopt('ama', PASSPHRASE)).toBe(true);
      expect(await keychain.get(KEYCHAIN_SERVICE, dbKeyAccount('ama'))).toBe(KEY_HEX);
    } finally {
      db.close();
    }
  });

  it('a locked user has no key; the right passphrase unlocks, a wrong one does not', async () => {
    const { db, vault } = await vaultFor();
    try {
      await vault.adopt('ama', PASSPHRASE);
      vault.lock('ama');
      expect(vault.isUnlocked('ama')).toBe(false);
      expect(await vault.keyFor('ama')).toBeUndefined();

      expect(await vault.unlock('ama', 'not-the-passphrase')).toBe(false);
      expect(await vault.keyFor('ama')).toBeUndefined();

      expect(await vault.unlock('ama', PASSPHRASE)).toBe(true);
      expect(await vault.keyFor('ama')).toBe(KEY_HEX);
      expect(vault.unlockedIds()).toEqual(['ama']);
      expect(vault.lock('ama')).toBe(true);
      expect(vault.lock('ama')).toBe(false); // idempotent
    } finally {
      db.close();
    }
  });

  it('keep-unlocked is PER USER: it does not unlock anyone else', async () => {
    const { db, stores, keychain, vault } = await vaultFor({ keepUnlocked: true });
    try {
      stores.users.insert(userRow('bo', false));
      await keychain.set(KEYCHAIN_SERVICE, dbKeyAccount('bo'), 'b'.repeat(64));
      await vault.adopt('ama', PASSPHRASE); // keeps ama's plaintext
      await vault.adopt('bo', PASSPHRASE); // removes bo's plaintext…
      vault.lock('bo'); // …and their session ends: the key leaves memory too

      expect(await vault.keyFor('ama')).toBe(KEY_HEX); // no sign-in needed
      expect(await vault.keyFor('bo')).toBeUndefined(); // signed out = locked
    } finally {
      db.close();
    }
  });

  it('without a wrap the keychain answers (pairing mode, and pre-S9 installs)', async () => {
    const { db, vault } = await vaultFor();
    try {
      // No adopt() call: this is what a desktop/pairing boot does.
      expect(vault.hasWrap('ama')).toBe(false);
      expect(await vault.unlock('ama', 'anything')).toBe(true);
      expect(await vault.keyFor('ama')).toBe(KEY_HEX);
    } finally {
      db.close();
    }
  });
});
