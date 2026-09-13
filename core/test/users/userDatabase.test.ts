/**
 * M20-B S1 — a per-app-user DATA PARTITION: its own encrypted database FILE,
 * its own cipher key, its own skills dir.
 *
 * Two users opened from one core must not share a byte of storage: different
 * files, different keychain-held cipher keys, a row written as A invisible to
 * B's handle, and the wrong key cannot open the other file. Also locks the
 * BOOT ROUTING: `USER_ID` selects the partition file + skills dir, and the
 * legacy single-user layout (`data/partner.db`) is byte-identical without it.
 *
 * Hermetic: temp data root + the in-memory fake keychain (no OS keychain),
 * no repo-tree writes.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createUserPartitions } from '../../src/users/partition.js';
import {
  InvalidUserIdError,
  userDbPath,
  userSkillsDir,
  usersRoot,
} from '../../src/users/paths.js';
import { DB_KEY_ACCOUNT, dbKeyAccount, ensureDbKey } from '../../src/keychain/dbKey.js';
import { KEYCHAIN_SERVICE, createKeychainFake } from '../../src/keychain/keychain.js';
import { createSettingsStore, openDatabase, openEncryptedDatabase } from '../../src/stores/db.js';
import { loadConfig } from '../../src/config.js';

const dirs: string[] = [];

function tempDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-userdb-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
  }
});

function cipherKey(keychain: ReturnType<typeof createKeychainFake>, userId: string): Promise<string | null> {
  return keychain.get(KEYCHAIN_SERVICE, dbKeyAccount(userId));
}

describe('per-user database partition (M20-B S1)', () => {
  it('two users get two DIFFERENT, encrypted files', async () => {
    const dataRoot = tempDataRoot();
    const partitions = createUserPartitions({ dataRoot, keychain: createKeychainFake() });
    const alice = await partitions.open('alice');
    const bob = await partitions.open('bob');

    expect(alice.dbPath).toBe(userDbPath(dataRoot, 'alice'));
    expect(bob.dbPath).toBe(userDbPath(dataRoot, 'bob'));
    expect(alice.dbPath).not.toBe(bob.dbPath);
    expect(existsSync(alice.dbPath)).toBe(true);
    expect(existsSync(bob.dbPath)).toBe(true);

    // Encrypted at rest: a SQLCipher file carries no plaintext SQLite header,
    // while an unencrypted core DB does.
    const header = (path: string): string => readFileSync(path).subarray(0, 16).toString('latin1');
    const plainPath = join(dataRoot, 'plain.db');
    openDatabase(plainPath).close();
    expect(header(plainPath)).toBe('SQLite format 3\u0000');
    expect(header(alice.dbPath)).not.toBe('SQLite format 3\u0000');
    expect(header(bob.dbPath)).not.toBe('SQLite format 3\u0000');
    partitions.closeAll();
  });

  it('gives each user a DIFFERENT cipher key in its OWN keychain account', async () => {
    const dataRoot = tempDataRoot();
    const keychain = createKeychainFake();
    const partitions = createUserPartitions({ dataRoot, keychain });
    await partitions.open('alice');
    await partitions.open('bob');

    const keyA = await cipherKey(keychain, 'alice');
    const keyB = await cipherKey(keychain, 'bob');
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);
    expect(keyB).toMatch(/^[0-9a-f]{64}$/);
    expect(keyA).not.toBe(keyB);

    // Distinct accounts, and NOT the legacy single-user account: opening a
    // partition must never reuse (or overwrite) the OS-profile key.
    expect(dbKeyAccount('alice')).not.toBe(dbKeyAccount('bob'));
    expect(dbKeyAccount('alice')).not.toBe(DB_KEY_ACCOUNT);
    expect(dbKeyAccount('alice')).toBe(`${DB_KEY_ACCOUNT}:alice`);
    const legacy = await ensureDbKey(keychain);
    expect(legacy).not.toBe(keyA);
    expect(legacy).not.toBe(keyB);
    expect(await keychain.get(KEYCHAIN_SERVICE, DB_KEY_ACCOUNT)).toBe(legacy);
    partitions.closeAll();
  });

  it("a row written as Alice is ABSENT from Bob's handle", async () => {
    const dataRoot = tempDataRoot();
    const partitions = createUserPartitions({ dataRoot, keychain: createKeychainFake() });
    const alice = await partitions.open('alice');
    const bob = await partitions.open('bob');

    const aliceSettings = createSettingsStore(alice.db);
    aliceSettings.set('greeting', 'alice-only', 1);
    expect(aliceSettings.get('greeting')).toBe('alice-only');
    expect(aliceSettings.get('greeting')).not.toBe(createSettingsStore(bob.db).get('greeting'));

    const bobSettings = createSettingsStore(bob.db);
    expect(bobSettings.get('greeting')).toBeNull();
    expect(
      bob.db.prepare('SELECT value FROM settings WHERE key = ?').get('greeting'),
    ).toBeUndefined();
    expect(
      alice.db.prepare('SELECT value FROM settings WHERE key = ?').get('greeting'),
    ).toEqual({ value: 'alice-only' });
    partitions.closeAll();
  });

  it("the wrong user's key cannot open the other partition's file", async () => {
    const dataRoot = tempDataRoot();
    const keychain = createKeychainFake();
    const partitions = createUserPartitions({ dataRoot, keychain });
    const alice = await partitions.open('alice');
    await partitions.open('bob');
    partitions.closeAll();

    const keyB = await cipherKey(keychain, 'bob');
    expect(() => openEncryptedDatabase(alice.dbPath, keyB as string)).toThrow(
      /wrong database key/,
    );
    // Alice's own key still opens her file (the refusal above is key-specific).
    const reopened = openEncryptedDatabase(alice.dbPath, (await cipherKey(keychain, 'alice')) as string);
    expect(
      reopened.prepare('SELECT count(*) AS n FROM sqlite_master').get(),
    ).toBeDefined();
    reopened.close();
  });

  it('reopens a partition with its STORED key (data persists, key never rotates)', async () => {
    const dataRoot = tempDataRoot();
    const keychain = createKeychainFake();
    const partitions = createUserPartitions({ dataRoot, keychain });
    const alice = await partitions.open('alice');
    createSettingsStore(alice.db).set('greeting', 'alice-only', 1);
    const keyBefore = await cipherKey(keychain, 'alice');
    partitions.close('alice');

    const reopened = await partitions.open('alice');
    expect(createSettingsStore(reopened.db).get('greeting')).toBe('alice-only');
    expect(await cipherKey(keychain, 'alice')).toBe(keyBefore);
    partitions.closeAll();
  });

  it('REFUSES a malformed stored key for one user instead of rotating it', async () => {
    const dataRoot = tempDataRoot();
    const keychain = createKeychainFake();
    await keychain.set(KEYCHAIN_SERVICE, dbKeyAccount('alice'), 'not-a-key');
    const partitions = createUserPartitions({ dataRoot, keychain });

    await expect(partitions.open('alice')).rejects.toThrow(/malformed/);
    await expect(partitions.open('alice')).rejects.toThrow(/db-key:alice/);
    expect(await cipherKey(keychain, 'alice')).toBe('not-a-key');
    expect(partitions.size).toBe(0);
  });

  it('gives each user its OWN skills dir (never shared, never the other user)', async () => {
    const dataRoot = tempDataRoot();
    const partitions = createUserPartitions({ dataRoot, keychain: createKeychainFake() });
    const alice = await partitions.open('alice');
    const bob = await partitions.open('bob');

    expect(alice.skillsDir).toBe(userSkillsDir(dataRoot, 'alice'));
    expect(bob.skillsDir).toBe(userSkillsDir(dataRoot, 'bob'));
    expect(alice.skillsDir).not.toBe(bob.skillsDir);
    expect(alice.skillsDir.startsWith(userSkillsDir(dataRoot, 'alice'))).toBe(true);
    expect(bob.skillsDir.startsWith(userSkillsDir(dataRoot, 'alice'))).toBe(false);
    partitions.closeAll();
  });
});

describe('boot routing: USER_ID selects a partition (M20-B S1)', () => {
  it('derives the partition file + skills dir from DB_PATH’s directory', () => {
    const dataRoot = tempDataRoot();
    const cfg = loadConfig({
      DEMO_MODE: '0',
      DB_PATH: join(dataRoot, 'partner.db'),
      USER_ID: 'alice',
    });
    expect(cfg.userId).toBe('alice');
    expect(cfg.dataRoot).toBe(dataRoot);
    expect(cfg.usersRoot).toBe(usersRoot(dataRoot));
    expect(cfg.dbPath).toBe(userDbPath(dataRoot, 'alice'));
    expect(cfg.skillsDir).toBe(userSkillsDir(dataRoot, 'alice'));
  });

  it('DATA_ROOT overrides the partition parent', () => {
    const dataRoot = tempDataRoot();
    const cfg = loadConfig({ DEMO_MODE: '0', DATA_ROOT: dataRoot, USER_ID: 'alice' });
    expect(cfg.dataRoot).toBe(dataRoot);
    expect(cfg.dbPath).toBe(userDbPath(dataRoot, 'alice'));
  });

  it('without USER_ID the legacy single-user layout is byte-identical', () => {
    const cfg = loadConfig({ DEMO_MODE: '0' });
    expect(cfg.dbPath).toBe('./data/partner.db');
    expect(cfg.dataRoot).toBe(dirname(cfg.dbPath));
    expect(cfg.skillsDir).toBe(join(dirname(cfg.dbPath), 'skills'));
    expect(cfg.userId).toBeUndefined();

    const explicit = loadConfig({ DEMO_MODE: '0', DB_PATH: join(tempDataRoot(), 'live.db') });
    expect(explicit.dbPath.endsWith('live.db')).toBe(true);
    expect(explicit.dbPath).not.toContain('users');
  });

  it('demo mode keeps its single in-memory DB (partitions are a LIVE-mode concept)', () => {
    const cfg = loadConfig({ DEMO_MODE: '1' });
    expect(cfg.dbPath).toBe(':memory:');
    expect(cfg.userId).toBeUndefined();
    const withUser = loadConfig({ DEMO_MODE: '1', USER_ID: 'alice' });
    expect(withUser.dbPath).toBe(':memory:');
    expect(withUser.skillsDir).toBe(cfg.skillsDir);
  });

  it('refuses an invalid USER_ID at boot (fail fast, never a silent fallback)', () => {
    expect(() => loadConfig({ DEMO_MODE: '0', USER_ID: '../evil' })).toThrow(InvalidUserIdError);
    expect(() => loadConfig({ DEMO_MODE: '0', USER_ID: '../../etc/passwd' })).toThrow(
      /path separators/,
    );
    expect(() => loadConfig({ DEMO_MODE: '0', USER_ID: 'alice/bob' })).toThrow(/path separators/);
    // A blank value follows the config trim rule: unset (legacy layout), never
    // a partition literally named '   '.
    expect(loadConfig({ DEMO_MODE: '0', USER_ID: '   ' }).userId).toBeUndefined();
  });
});
