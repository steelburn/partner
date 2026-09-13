/**
 * M20-B S2/S1 — the LEGACY user owns the pre-partition layout.
 *
 * This is the upgrade guarantee, and it is the highest-consequence property in
 * the whole partitioning change: an existing install's data lives at
 * `<dataRoot>/partner.db` under the legacy `db-key` keychain account. If user #0
 * were treated like every other user, booting with `USER_ID=0` would open a
 * NEW EMPTY database under `db-key:0` while the owner's real data sat orphaned
 * at the legacy path — silent data disappearance, with no error to notice.
 *
 * An adversarial review caught that the plan asserted this property while no
 * code implemented it. These tests pin the implementation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_USER_ID } from '@partner/shared';
import { FIRST_USER_ID } from '../../src/users/manager.js';
import { DB_KEY_ACCOUNT, dbKeyAccount } from '../../src/keychain/dbKey.js';
import {
  PARTITION_DB_FILE,
  PARTITION_SKILLS_DIRNAME,
  USERS_DIRNAME,
  isLegacyUser,
  userDbPath,
  userRoot,
  userSkillsDir,
  usersRoot,
} from '../../src/users/paths.js';

const roots: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-legacy-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop() as string, { recursive: true, force: true });
});

describe('the legacy user owns the pre-partition layout', () => {
  it('is the same user the first-run flow creates — the two cannot drift', () => {
    // If these diverged, the first user created on an empty core would not be
    // the user that owns the existing database.
    expect(FIRST_USER_ID).toBe(LEGACY_USER_ID);
    expect(isLegacyUser(FIRST_USER_ID)).toBe(true);
  });

  it('resolves to the legacy database path, not a users/<id> directory', () => {
    const dataRoot = tempRoot();
    expect(userRoot(dataRoot, LEGACY_USER_ID)).toBe(dataRoot);
    expect(userDbPath(dataRoot, LEGACY_USER_ID)).toBe(join(dataRoot, PARTITION_DB_FILE));
    // …and explicitly NOT the partitioned shape.
    expect(userDbPath(dataRoot, LEGACY_USER_ID)).not.toContain(USERS_DIRNAME);
  });

  it('resolves to the legacy skills directory, so installed skills are not orphaned', () => {
    const dataRoot = tempRoot();
    // Matches the historical `skillsDir = dirname(dbPath)/skills` rule.
    expect(userSkillsDir(dataRoot, LEGACY_USER_ID)).toBe(
      join(dataRoot, PARTITION_SKILLS_DIRNAME),
    );
    expect(userSkillsDir(dataRoot, LEGACY_USER_ID)).not.toContain(USERS_DIRNAME);
  });

  it('opens under the legacy keychain account, so the existing key still works', () => {
    // A fresh `db-key:0` account would mean a new cipher key, which cannot open
    // a database encrypted under `db-key` — the data would look like corruption.
    expect(dbKeyAccount(LEGACY_USER_ID)).toBe(DB_KEY_ACCOUNT);
    expect(dbKeyAccount(LEGACY_USER_ID)).not.toContain(':');
  });

  it('leaves every OTHER user on the partitioned layout and its own account', () => {
    const dataRoot = tempRoot();
    for (const id of ['alice', 'bob', '1']) {
      expect(isLegacyUser(id)).toBe(false);
      expect(userRoot(dataRoot, id)).toBe(join(usersRoot(dataRoot), id));
      expect(userDbPath(dataRoot, id)).toBe(
        join(usersRoot(dataRoot), id, PARTITION_DB_FILE),
      );
      expect(userSkillsDir(dataRoot, id)).toBe(
        join(usersRoot(dataRoot), id, PARTITION_SKILLS_DIRNAME),
      );
      // Distinct account per user: this is what stops one key opening another file.
      expect(dbKeyAccount(id)).toBe(`${DB_KEY_ACCOUNT}:${id}`);
      expect(dbKeyAccount(id)).not.toBe(dbKeyAccount(LEGACY_USER_ID));
    }
  });

  it('keeps the legacy user and a numerically-similar id apart', () => {
    // '0' is the legacy user; '00' is not — it is an ordinary partition. Both
    // are valid ids, so the check must be exact rather than numeric.
    const dataRoot = tempRoot();
    expect(isLegacyUser('00')).toBe(false);
    expect(userRoot(dataRoot, '00')).toBe(join(usersRoot(dataRoot), '00'));
    expect(dbKeyAccount('00')).toBe(`${DB_KEY_ACCOUNT}:00`);
  });
});
