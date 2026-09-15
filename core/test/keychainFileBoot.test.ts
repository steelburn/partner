/**
 * M21 — a LIVE boot with the file keychain (the container deployment path).
 *
 * The unit tests prove the keychain file round-trips. This test proves the thing
 * that actually matters for a container: an encrypted database, keyed from a
 * JSON file, is opened by a SECOND boot with a key that outlived the first — and
 * a missing/tampered keychain does not silently produce a fresh key beside a
 * real database.
 *
 * That last case is the data-loss scenario: `ensureDbKey` mints a fresh key when
 * the account is absent, so a "repair an empty/malformed keychain" shortcut
 * would encrypt a NEW database and orphan the old one. The malformed case is
 * refused at construction (keychainFile.test.ts pins it); here we pin the boot
 * behaviour when the keychain file is DELETED while the database remains: the
 * open fails (wrong key), it does not overwrite the database.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, startServer } from '../src/index.js';
import { KEYCHAIN_SERVICE } from '../src/keychain/keychain.js';
import { closeServer, freePort, removeTempRoot } from './helpers.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-filekeychain-'));
  dirs.push(dir);
  return dir;
}

/** A live config whose secrets live in a JSON file inside `dir`. */
async function configFor(dir: string) {
  // A NAMED free port: `PORT=0` is refused by loadConfig (the loopback
  // allowlist is derived from this number), and the old silent fallback to 4390
  // made these boots depend on 4390 being free.
  const port = await freePort();
  return {
    ...loadConfig({
      DEMO_MODE: '0',
      KEYCHAIN_KIND: 'file',
      KEYCHAIN_FILE: join(dir, 'keychain.json'),
      DB_PATH: join(dir, 'partner.db'),
      DATA_ROOT: dir,
      PORT: String(port),
      SCHEDULER_TICK_MS: '0',
    }),
  };
}

describe('live boot with KEYCHAIN_KIND=file', () => {
  it('keys an encrypted DB from the file and reopens it on a second boot', async () => {
    const dir = tempDir();
    const config = await configFor(dir);
    expect(config.keychain).toBe('file');

    const first = await startServer(config);
    try {
      // A marker written through a real store, so persistence is observable.
      first.bundle.settingsStore.set('deploy.marker', 'first-boot', 1);
      expect(readFileSync(join(dir, 'keychain.json'), 'utf8')).toContain('db-key');
    } finally {
      // Awaited: the second boot below binds the SAME port, and a listener that
      // is still closing would now fail the boot loudly (EADDRINUSE) instead of
      // being papered over.
      await closeServer(first.server);
      first.bundle.close();
    }

    const second = await startServer(config);
    try {
      // Same key from the same file → the same database, decrypted.
      expect(second.bundle.settingsStore.get('deploy.marker')).toBe('first-boot');
      // A plaintext DB would have been refused by openEncryptedDatabase; a
      // wrong key would have thrown. Assert the file is NOT a plaintext SQLite
      // file (the SQLite magic must not be present in the clear).
      const bytes = readFileSync(join(dir, 'partner.db'));
      expect(bytes.subarray(0, 15).toString('utf8')).not.toBe('SQLite format 3');
    } finally {
      await closeServer(second.server);
      second.bundle.close();
    }
  });

  it('a lost keychain FAILS the open instead of minting a key beside the data', async () => {
    const dir = tempDir();
    const config = await configFor(dir);

    const first = await startServer(config);
    first.bundle.settingsStore.set('deploy.marker', 'keep-me', 1);
    await closeServer(first.server);
    first.bundle.close();

    // Simulate the operator deleting the secrets file (or mounting a fresh
    // volume): the DB is intact, the key is gone.
    unlinkSync(join(dir, 'keychain.json'));

    await expect(startServer(config)).rejects.toThrow(/file is not a database|not a database|key/i);

    // The database was NOT recreated empty: the marker is unreachable but the
    // file is still the same non-plaintext bytes.
    const bytes = readFileSync(join(dir, 'partner.db'));
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.subarray(0, 15).toString('utf8')).not.toBe('SQLite format 3');
  });

  it('the file keychain also backs provider secrets (service partner)', async () => {
    const dir = tempDir();
    const config = await configFor(dir);
    const { bundle, server } = await startServer(config);
    try {
      await bundle.keychain.set(KEYCHAIN_SERVICE, 'provider:demo', 'sk-test-value');
      const onDisk = JSON.parse(readFileSync(join(dir, 'keychain.json'), 'utf8')) as Record<
        string,
        Record<string, string>
      >;
      expect(onDisk[KEYCHAIN_SERVICE]?.['provider:demo']).toBe('sk-test-value');
    } finally {
      await closeServer(server);
      bundle.close();
    }
  });
});
