/**
 * M20-B S1 — per-app-user partition paths + the bounded open cache.
 *
 * `paths.ts` is PURE: it derives one directory tree per user and REFUSES any
 * id that is not usable verbatim as ONE directory name under the users root
 * (an id that escapes the root, or that two different ids would normalize
 * onto, is the exact failure partitioning exists to prevent). `partition.ts`
 * holds at most `maxOpen` open encrypted handles per core.
 *
 * Hermetic: a temp `dataRoot` + the in-memory fake keychain, so no OS keychain
 * and no repo tree is touched.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  InvalidUserIdError,
  PARTITION_DB_FILE,
  MAX_USER_ID_LENGTH,
  assertValidUserId,
  userDbPath,
  userRoot,
  userSkillsDir,
  usersRoot,
} from '../../src/users/paths.js';
import { createUserPartitions } from '../../src/users/partition.js';
import { createKeychainFake } from '../../src/keychain/keychain.js';

const dirs: string[] = [];

function tempDataRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-users-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
  }
});

/** Run `assertValidUserId` and return the refusal it threw. */
function refusal(userId: unknown): InvalidUserIdError {
  let caught: unknown;
  try {
    assertValidUserId(userId);
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${JSON.stringify(userId)} to be refused`).toBeInstanceOf(
    InvalidUserIdError,
  );
  return caught as InvalidUserIdError;
}

describe('user partition paths (M20-B S1)', () => {
  it('derives <dataRoot>/users/<userId>/{partner.db,skills}', () => {
    const root = tempDataRoot();
    expect(usersRoot(root)).toBe(join(root, 'users'));
    expect(userRoot(root, 'alice')).toBe(join(root, 'users', 'alice'));
    expect(userDbPath(root, 'alice')).toBe(join(root, 'users', 'alice', PARTITION_DB_FILE));
    expect(userSkillsDir(root, 'alice')).toBe(join(root, 'users', 'alice', 'skills'));
  });

  it('gives every user a distinct tree that stays INSIDE the data root', () => {
    const root = tempDataRoot();
    const alice = userDbPath(root, 'alice');
    const bob = userDbPath(root, 'bob');
    expect(alice).not.toBe(bob);
    for (const path of [alice, bob, userSkillsDir(root, 'alice'), userSkillsDir(root, 'bob')]) {
      expect(resolve(path).startsWith(resolve(root) + sep)).toBe(true);
    }
  });

  it('accepts dotted/underscored/dashed ids (one directory name, no separators)', () => {
    for (const id of ['alice', 'user_2', 'a.b-c', 'A9']) {
      expect(() => assertValidUserId(id)).not.toThrow();
    }
  });

  it('REFUSES an empty or whitespace-only id', () => {
    expect(refusal('').message).toMatch(/must not be empty/);
    expect(refusal('   ').message).toMatch(/leading or trailing whitespace/);
    expect(refusal('\t').message).toMatch(/whitespace/);
  });

  it('REFUSES any path separator (absolute, relative or Windows)', () => {
    for (const id of ['/', '/etc/passwd', '../alice', 'alice/../bob', 'a/b', '\\', '..\\bob',
      'C:\\Users', 'users\\alice', 'a\\..\\..\\b']) {
      expect(refusal(id).message, id).toMatch(/path separators/);
    }
  });

  it("REFUSES '..' anywhere (even without a separator)", () => {
    expect(refusal('..').message).toMatch(/must not contain '\.\.'/);
    expect(refusal('a..b').message).toMatch(/must not contain '\.\.'/);
  });

  it('REFUSES ids that a filesystem would normalize onto another partition', () => {
    expect(refusal('.').message).toMatch(/only contain letters, digits/);
    expect(refusal('.hidden').message).toMatch(/only contain letters, digits/);
    expect(refusal('alice.').message).toMatch(/must not end with a dot/);
    expect(refusal('alice bob').message).toMatch(/only contain letters, digits/);
    expect(refusal('a:b').message).toMatch(/drive\/stream separator/);
    expect(refusal('a\u0000b').message).toMatch(/only contain letters, digits/);
    expect(refusal('a\nb').message).toMatch(/only contain letters, digits/);
  });

  it('REFUSES Windows reserved device names and over-long ids', () => {
    for (const id of ['con', 'NUL', 'Prn', 'aux', 'com1', 'lpt9']) {
      expect(refusal(id).message, id).toMatch(/reserved Windows device name/);
    }
    expect(refusal('x'.repeat(MAX_USER_ID_LENGTH + 1)).message).toMatch(/at most 64 characters/);
    expect(() => assertValidUserId('x'.repeat(MAX_USER_ID_LENGTH))).not.toThrow();
  });

  it('REFUSES non-string ids', () => {
    expect(refusal(undefined).message).toMatch(/must be a string/);
    expect(refusal(null).message).toMatch(/must be a string/);
    expect(refusal(42).message).toMatch(/must be a string/);
  });

  it('names the refused id on the error (so a boot failure is actionable)', () => {
    const error = refusal('../evil');
    expect(error.name).toBe('InvalidUserIdError');
    expect(error.userId).toBe('../evil');
    expect(error.message).toContain('"../evil"');
  });

  it('validates on EVERY path helper, not only on the exported assert', () => {
    const root = tempDataRoot();
    expect(() => userRoot(root, '..')).toThrow(InvalidUserIdError);
    expect(() => userDbPath(root, '..')).toThrow(InvalidUserIdError);
    expect(() => userSkillsDir(root, '..')).toThrow(InvalidUserIdError);
  });

  it('never touches the filesystem (pure derivation)', () => {
    const root = tempDataRoot();
    const derived = [usersRoot(root), userRoot(root, 'alice'), userDbPath(root, 'alice'), userSkillsDir(root, 'alice')];
    for (const path of derived) expect(existsSync(path)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });
});

describe('bounded per-user open cache (M20-B S1)', () => {
  it('opens ONE handle per user and reuses it while it stays open', async () => {
    const partitions = createUserPartitions({
      dataRoot: tempDataRoot(),
      keychain: createKeychainFake(),
    });
    const first = await partitions.open('alice');
    const second = await partitions.open('alice');
    expect(second).toBe(first);
    expect(partitions.size).toBe(1);
    expect(first.db.open).toBe(true);
    expect(first.dbPath).toBe(userDbPath(partitions.dataRoot, 'alice'));
    partitions.closeAll();
  });

  it('closing one user leaves the other partitions open', async () => {
    const partitions = createUserPartitions({
      dataRoot: tempDataRoot(),
      keychain: createKeychainFake(),
    });
    const alice = await partitions.open('alice');
    const bob = await partitions.open('bob');
    expect(partitions.close('alice')).toBe(true);
    expect(alice.db.open).toBe(false);
    expect(bob.db.open).toBe(true);
    expect(partitions.size).toBe(1);
    // Closing an unopened partition is a no-op, not an error.
    expect(partitions.close('alice')).toBe(false);
    partitions.closeAll();
    expect(bob.db.open).toBe(false);
    expect(partitions.size).toBe(0);
  });

  it('evicts the least-recently-used handle past maxOpen (handles stay BOUNDED)', async () => {
    const partitions = createUserPartitions({
      dataRoot: tempDataRoot(),
      keychain: createKeychainFake(),
      maxOpen: 2,
    });
    const alice = await partitions.open('alice');
    const bob = await partitions.open('bob');
    // Touching alice makes bob the least recently used.
    await partitions.open('alice');
    const carol = await partitions.open('carol');

    expect(bob.db.open).toBe(false);
    expect(alice.db.open).toBe(true);
    expect(carol.db.open).toBe(true);
    expect(partitions.size).toBe(2);
    expect(partitions.openUserIds()).toEqual(['alice', 'carol']);
    partitions.closeAll();
  });

  it('shares one in-flight open between concurrent callers', async () => {
    const partitions = createUserPartitions({
      dataRoot: tempDataRoot(),
      keychain: createKeychainFake(),
    });
    const [a, b] = await Promise.all([partitions.open('alice'), partitions.open('alice')]);
    expect(a).toBe(b);
    expect(partitions.size).toBe(1);
    partitions.closeAll();
  });

  it('refuses an invalid id BEFORE any key or file is created', async () => {
    const partitions = createUserPartitions({
      dataRoot: tempDataRoot(),
      keychain: createKeychainFake(),
    });
    await expect(partitions.open('../etc')).rejects.toBeInstanceOf(InvalidUserIdError);
    expect(partitions.size).toBe(0);
    expect(existsSync(join(partitions.dataRoot, 'etc'))).toBe(false);
  });

  it('refuses a nonsensical maxOpen instead of holding an unbounded cache', () => {
    const options = { dataRoot: tempDataRoot(), keychain: createKeychainFake() };
    expect(() => createUserPartitions({ ...options, maxOpen: 0 })).toThrow(/maxOpen/);
    expect(() => createUserPartitions({ ...options, maxOpen: -1 })).toThrow(/maxOpen/);
    expect(() => createUserPartitions({ ...options, maxOpen: 1.5 })).toThrow(/maxOpen/);
    expect(() => createUserPartitions(options)).not.toThrow();
  });
});
