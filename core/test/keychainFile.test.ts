import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createKeychainFile, keychainFileError } from '../src/keychain/file.js';
import { ensureDbKey, DB_KEY_ACCOUNT } from '../src/keychain/dbKey.js';
import { KEYCHAIN_SERVICE } from '../src/keychain/keychain.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'partner-keychain-'));
}

/** The 0600 bit check is POSIX-only; Windows has no mode bits to assert. */
const POSIX = process.platform !== 'win32';

describe('createKeychainFile', () => {
  it('round-trips a secret and persists it to the file', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'keychain.json');
      const kc = createKeychainFile(path);
      expect(await kc.get('svc', 'acct')).toBeNull();
      await kc.set('svc', 'acct', 's3cret');

      expect(await kc.get('svc', 'acct')).toBe('s3cret');
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>;
      expect(onDisk.svc?.acct).toBe('s3cret');
      if (POSIX) expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is readable by a SECOND instance over the same file (a restart keeps working)', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'keychain.json');
      await createKeychainFile(path).set(KEYCHAIN_SERVICE, DB_KEY_ACCOUNT, 'a'.repeat(64));
      // A fresh instance is what a container restart builds.
      const reopened = createKeychainFile(path);
      expect(await reopened.get(KEYCHAIN_SERVICE, DB_KEY_ACCOUNT)).toBe('a'.repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('isolates services/accounts and supports delete', async () => {
    const dir = tempDir();
    try {
      const kc = createKeychainFile(join(dir, 'keychain.json'));
      await kc.set('svc', 'a', 'value-a');
      await kc.set('svc', 'b', 'value-b');
      await kc.set('other', 'a', 'value-c');
      expect(await kc.get('svc', 'a')).toBe('value-a');
      expect(await kc.get('svc', 'b')).toBe('value-b');
      expect(await kc.get('other', 'a')).toBe('value-c');
      await kc.delete('svc', 'a');
      expect(await kc.get('svc', 'a')).toBeNull();
      expect(await kc.get('svc', 'b')).toBe('value-b');
      // Deleting an absent secret is a no-op, not an error.
      await expect(kc.delete('missing', 'nope')).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('creates the parent directory when needed (first boot)', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'nested', 'deeper', 'keychain.json');
      await createKeychainFile(path).set('svc', 'acct', 'v');
      expect(existsSync(path)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a MALFORMED file is refused, never silently replaced', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'keychain.json');
      writeFileSync(path, '{ not json');
      expect(() => createKeychainFile(path)).toThrow(/malformed/i);
      // The file is left exactly as it was — replacing it would orphan a DB.
      expect(readFileSync(path, 'utf8')).toBe('{ not json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-object or non-string-valued file is refused', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'keychain.json');
      writeFileSync(path, '"a string"');
      expect(() => createKeychainFile(path)).toThrow(/object/i);
      writeFileSync(path, JSON.stringify({ svc: { acct: 42 } }));
      expect(() => createKeychainFile(path)).toThrow(/string/i);
      writeFileSync(path, JSON.stringify({ svc: 'not-an-object' }));
      expect(() => createKeychainFile(path)).toThrow(/object/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an empty path at construction (a config bug, not a runtime surprise)', () => {
    expect(() => createKeychainFile('')).toThrow(/path/i);
    expect(() => createKeychainFile('   ')).toThrow(/path/i);
  });

  it('serialises concurrent writes so no secret is lost', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'keychain.json');
      const kc = createKeychainFile(path);
      await Promise.all(
        Array.from({ length: 25 }, (_, i) => kc.set('svc', `acct-${i}`, `value-${i}`)),
      );
      const reopened = createKeychainFile(path);
      for (let i = 0; i < 25; i += 1) {
        expect(await reopened.get('svc', `acct-${i}`)).toBe(`value-${i}`);
      }
      // Every write landed: a lost update would leave fewer keys on disk.
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, string>>;
      expect(Object.keys(onDisk.svc ?? {})).toHaveLength(25);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('carries a named error so a boot failure points at the file', () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'keychain.json');
      writeFileSync(path, '[]');
      try {
        createKeychainFile(path);
        throw new Error('expected a refusal');
      } catch (cause) {
        const error = keychainFileError(cause, path);
        expect(error.message).toContain(path);
        expect(error.message).toMatch(/malformed|object/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createKeychainFile + ensureDbKey', () => {
  it('the database key lives in the file and is stable across instances', async () => {
    const dir = tempDir();
    try {
      const path = join(dir, 'keychain.json');
      const first = await ensureDbKey(createKeychainFile(path));
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      const second = await ensureDbKey(createKeychainFile(path));
      expect(second).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
