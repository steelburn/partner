/**
 * M20-B S2 — the SYSTEM database (PLAN-M20-B.md §2a, §6/S2).
 *
 * `data/system.db` holds the tables that must exist BEFORE a user is resolved:
 * `users` and `user_credentials` (a user list cannot live inside a per-user
 * database — which file to open is decided by the user), plus the
 * `pairings`/`sessions` home (a device pairs and is enrolled before anyone has
 * identified themselves).
 *
 * These tests pin: the pre-user tables are reachable through one store bundle,
 * a file system DB is opened WHOLE-FILE ENCRYPTED under its own keychain
 * account (`system-key`, distinct from every partition key), and a keyless
 * file is refused rather than silently created.
 *
 * Hermetic: temp dirs + the in-memory fake keychain; no OS keychain is touched.
 */
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Keychain } from '@partner/shared';
import { loadConfig } from '../../src/config.js';
import { dbKeyAccount, ensureDbKey } from '../../src/keychain/dbKey.js';
import { KEYCHAIN_SERVICE, createKeychainFake } from '../../src/keychain/keychain.js';
import {
  SYSTEM_DB_FILENAME,
  SYSTEM_KEY_ACCOUNT,
  openSystemDatabase,
  systemDbPath,
} from '../../src/system/db.js';
import { createSystemStores } from '../../src/users/store.js';
import { makeTempRoot, removeTempRoot } from '../helpers.js';

const MARKER = 'system-db-marker';

const dirs: string[] = [];
const handles: Array<{ close(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function tempDir(): string {
  const dir = makeTempRoot();
  dirs.push(dir);
  return dir;
}

async function openFile(location: string, keychain: Keychain) {
  const handle = await openSystemDatabase({ location, keychain });
  handles.push(handle);
  return handle;
}

describe('M20-B S2 system database (pre-user tables)', () => {
  it('opens in memory without a keychain and carries the pre-user stores', async () => {
    const db = await openSystemDatabase({ location: ':memory:' });
    handles.push(db);
    const stores = createSystemStores(db);

    const tables = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((t) => t.name);
    // The four tables that have to exist before a user is resolved.
    for (const table of ['users', 'user_credentials', 'pairings', 'sessions']) {
      expect(tables, table).toContain(table);
    }

    stores.users.insert({
      id: '0',
      label: MARKER,
      osProfileKey: 'alice',
      createdAt: 1,
      keepUnlocked: false,
      disabledAt: null,
    });
    expect(stores.users.findByOsProfileKey('alice')?.label).toBe(MARKER);

    stores.credentials.upsert({
      userId: '0',
      salt: 'ab'.repeat(16),
      hash: 'cd'.repeat(32),
      params: '{"N":1024,"r":8,"p":1,"keylen":32}',
      failedAttempts: 0,
      lockedUntil: null,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(stores.credentials.findByUserId('0')?.hash).toBe('cd'.repeat(32));

    // Enrollment precedes any user: pairings + sessions live here too.
    expect(stores.pairings.getLatest()).toBeUndefined();
    stores.pairings.insert('code-hash', 1, 2);
    expect(stores.pairings.getLatest()?.codeHash).toBe('code-hash');
    stores.sessions.insert('token-hash', 'desktop', '127.0.0.1:4390', 1, 2, 1);
    expect(stores.sessions.findByTokenHash('token-hash')?.kind).toBe('desktop');
  });

  it('opens a FILE system database encrypted under the system-key account', async () => {
    const keychain = createKeychainFake();
    const location = `${tempDir()}/${SYSTEM_DB_FILENAME}`;

    const first = await openFile(location, keychain);
    createSystemStores(first).users.insert({
      id: '0',
      label: MARKER,
      osProfileKey: 'alice',
      createdAt: 7,
      keepUnlocked: false,
      disabledAt: null,
    });

    // At rest — the file AND its WAL, while the handle is still open — there
    // is no SQLite header and no decipherable label.
    for (const path of [location, `${location}-wal`]) {
      if (!existsSync(path)) continue;
      const bytes = readFileSync(path);
      expect(bytes.includes('SQLite format 3'), path).toBe(false);
      expect(bytes.includes(MARKER), path).toBe(false);
    }
    first.close();

    // The key lives under the system DB's OWN keychain account.
    const key = await keychain.get(KEYCHAIN_SERVICE, SYSTEM_KEY_ACCOUNT);
    expect(key).toMatch(/^[0-9a-f]{64}$/);

    // Reopen with the same keychain: readable, and the key is reused.
    const second = await openFile(location, keychain);
    expect(createSystemStores(second).users.findById('0')?.label).toBe(MARKER);
    expect(await keychain.get(KEYCHAIN_SERVICE, SYSTEM_KEY_ACCOUNT)).toBe(key);

    // A different keychain (the key is lost) cannot read it.
    await expect(openSystemDatabase({ location, keychain: createKeychainFake() })).rejects.toThrow(
      /wrong database key/,
    );
  });

  it('refuses a file system database without a keychain', async () => {
    const location = `${tempDir()}/system.db`;
    await expect(openSystemDatabase({ location })).rejects.toThrow(/without a keychain/);
  });

  it('the system key is distinct from the legacy and per-user partition keys', async () => {
    const keychain = createKeychainFake();
    await openFile(`${tempDir()}/system.db`, keychain);

    const systemKey = await keychain.get(KEYCHAIN_SERVICE, SYSTEM_KEY_ACCOUNT);
    const legacyKey = await ensureDbKey(keychain);
    const partitionKey = await ensureDbKey(keychain, dbKeyAccount('alice'));

    expect(systemKey).not.toBe(legacyKey);
    expect(systemKey).not.toBe(partitionKey);
    expect(legacyKey).not.toBe(partitionKey);
  });

  it('derives <dataRoot>/system.db', () => {
    expect(systemDbPath('/data').replace(/\\/g, '/')).toBe('/data/system.db');
  });
});

describe('M20-B S2 config: the system DB path', () => {
  it('is in memory for a demo or :memory: boot, and a sibling file otherwise', () => {
    // Demo (the default) touches no disk: the fake keychain cannot protect a
    // file, so the system DB is in memory exactly like the main DB.
    expect(loadConfig({}).systemDbPath).toBe(':memory:');
    expect(loadConfig({ DB_PATH: `${tempDir()}/partner.db` }).systemDbPath).toBe(':memory:');
    // A non-persistent live boot stays in memory too.
    expect(loadConfig({ DEMO_MODE: '0', DB_PATH: ':memory:' }).systemDbPath).toBe(':memory:');

    // A live file boot puts the system DB beside its own database.
    const dir = tempDir();
    const live = loadConfig({ DEMO_MODE: '0', DB_PATH: `${dir}/partner.db` });
    const slash = (value: string): string => value.replace(/\\/g, '/');
    expect(slash(live.systemDbPath)).toBe(slash(systemDbPath(dir)));
    expect(slash(live.systemDbPath)).toBe(`${slash(dir)}/system.db`);
    // ...which is not the user's partition database.
    expect(live.systemDbPath).not.toBe(live.dbPath);
  });
});
