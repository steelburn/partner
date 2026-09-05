/**
 * M10 W1 whole-file encryption tests (Decision A): a live file database is
 * opened with a 32-byte hex key via the SQLCipher-compatible alias build —
 * fresh files are created encrypted, reopen with the same key round-trips,
 * a wrong key fails cleanly, and a pre-M10 PLAINTEXT Partner database is
 * refused with a migration message. `:memory:` stays untouched.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, openEncryptedDatabase } from '../../src/stores/db.js';
import { SCHEMA_VERSION } from '@partner/shared';
import { ensureDbKey } from '../../src/keychain/dbKey.js';
import { createKeychainFake } from '../../src/keychain/keychain.js';
import type { Keychain } from '@partner/shared';

const KEY_A = '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff';
const KEY_B = 'ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-cipher-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
  }
});

describe('openEncryptedDatabase (M10 W1)', () => {
  it('creates an encrypted file and round-trips across reopens with the key', () => {
    const dir = tempDir();
    const location = join(dir, 'live.db');
    const first = openEncryptedDatabase(location, KEY_A);
    first.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run(
      'greeting',
      'secret-hello',
      1,
    );
    first.close();

    // Reopen with the SAME key: data readable, schema version stamped.
    const second = openEncryptedDatabase(location, KEY_A);
    const greeting = second
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get('greeting') as { value: string } | undefined;
    expect(greeting?.value).toBe('secret-hello');
    const meta = second
      .prepare('SELECT value FROM meta WHERE key = ?')
      .get('schema_version') as { value: string };
    expect(meta.value).toBe(String(SCHEMA_VERSION));
    second.close();
  });

  it('rejects a WRONG key with a clear error (no silent corruption)', () => {
    const dir = tempDir();
    const location = join(dir, 'live.db');
    const db = openEncryptedDatabase(location, KEY_A);
    db.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('k', 'v', 1);
    db.close();
    expect(() => openEncryptedDatabase(location, KEY_B)).toThrow(/wrong database key/);
  });

  it('refuses a pre-M10 PLAINTEXT partner database with a migration message', () => {
    const dir = tempDir();
    const location = join(dir, 'plain.db');
    const plain = openDatabase(location); // the pre-M10 path
    plain.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('k', 'v', 1);
    plain.close();
    expect(() => openEncryptedDatabase(location, KEY_A)).toThrow(/plaintext Partner database/i);
  });

  it('refuses a non-Partner plaintext file and :memory: misuse', () => {
    const dir = tempDir();
    const location = join(dir, 'random.db');
    writeFileSync(location, 'this is not a database at all, just bytes');
    expect(() => openEncryptedDatabase(location, KEY_A)).toThrow(/not an encrypted Partner database/);
    expect(() => openEncryptedDatabase(':memory:', KEY_A)).toThrow(/file path/);
  });
});

describe('ensureDbKey (M10 W1)', () => {
  it('creates a 64-hex key on first use and reuses the persisted one', async () => {
    const keychain: Keychain = createKeychainFake();
    const first = await ensureDbKey(keychain);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    const second = await ensureDbKey(keychain);
    expect(second).toBe(first); // read back, not rotated
  });

  it('ignores a malformed stored value and writes a fresh key', async () => {
    const keychain: Keychain = createKeychainFake();
    await keychain.set('partner', 'db-key', 'not-hex');
    const key = await ensureDbKey(keychain);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});
