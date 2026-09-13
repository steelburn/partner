/**
 * M20-B S2 — the app-user registry (PLAN-M20-B.md §2).
 *
 * Pins the store contract (`users` rows in the SYSTEM database) and the
 * manager semantics that make disabling safe: a disabled user REFUSES a
 * request resolution while every row of theirs is still present, and enabling
 * them restores access. Also pins first run — on an empty core the OS-profile
 * holder becomes user #0 — and the registry rule that one OS user maps to
 * exactly one app user.
 *
 * Hermetic: a ':memory:' system DB, an injected OS-profile key and clock.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { UserRow } from '../../src/stores/types.js';
import { createKeychainFake } from '../../src/keychain/keychain.js';
import { FIRST_USER_ID, createUserManager } from '../../src/users/manager.js';
import { createSystemStores } from '../../src/users/store.js';
import { openSystemDatabase } from '../../src/system/db.js';
import { makeTempRoot, removeTempRoot } from '../helpers.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

function tempDir(): string {
  const dir = makeTempRoot();
  dirs.push(dir);
  return dir;
}

/** The system DB's user store over a fresh in-memory system database. */
async function memoryUsers() {
  return createSystemStores(await openSystemDatabase({ location: ':memory:' })).users;
}

async function memoryManager(options: { username?: string; now?: () => number } = {}) {
  const users = await memoryUsers();
  const manager = createUserManager({
    store: users,
    osProfileUsername: () => options.username ?? 'alice',
    now: options.now,
  });
  return { users, manager };
}

/** Narrow an `{ok:false}` result away, so the assertions read as intent. */
function expectOk<T extends { ok: boolean }>(result: T): Extract<T, { ok: true }> {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result as Extract<T, { ok: true }>;
}

function row(userId: string, overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: userId,
    label: userId,
    osProfileKey: null,
    createdAt: 1,
    disabledAt: null,
    keepUnlocked: false,
    ...overrides,
  };
}

describe('M20-B S2 users store (system DB rows)', () => {
  it('round-trips rows: create, list oldest-first, find by id and by profile', async () => {
    const users = await memoryUsers();
    users.insert(row('bob', { label: 'Bob', osProfileKey: 'bob', createdAt: 20 }));
    users.insert(row(FIRST_USER_ID, { label: 'alice', osProfileKey: 'alice', createdAt: 10 }));

    expect(users.list().map((u) => u.id)).toEqual([FIRST_USER_ID, 'bob']);
    expect(users.findById('bob')?.label).toBe('Bob');
    expect(users.findByOsProfileKey('alice')?.id).toBe(FIRST_USER_ID);
    expect(users.findByOsProfileKey('nobody')).toBeUndefined();
    expect(users.findById('ghost')).toBeUndefined();
  });

  it('never deletes: disable stamps the row, enable clears the stamp', async () => {
    const users = await memoryUsers();
    users.insert(row('bob', { label: 'Bob' }));

    expect(users.disable('bob', 500)).toBe(true);
    const disabled = users.findById('bob');
    expect(disabled).toBeDefined();
    expect(disabled?.disabledAt).toBe(500);
    expect(disabled?.label).toBe('Bob');

    expect(users.enable('bob')).toBe(true);
    expect(users.findById('bob')?.disabledAt).toBeNull();
    // Unknown ids are refused rather than silently "updated".
    expect(users.disable('ghost', 1)).toBe(false);
    expect(users.enable('ghost')).toBe(false);
  });

  it('a NULL os_profile_key allows many users; a set one is unique', async () => {
    const users = await memoryUsers();
    users.insert(row('a'));
    users.insert(row('b'));
    expect(users.list()).toHaveLength(2);

    users.insert(row('c', { osProfileKey: 'carol' }));
    expect(() => users.insert(row('d', { osProfileKey: 'carol' }))).toThrow(/UNIQUE/i);
  });

  it('the store is a live view of the handle, not a cache', async () => {
    const handle = await openSystemDatabase({
      location: `${tempDir()}/view.db`,
      keychain: createKeychainFake(),
    });
    const stores = createSystemStores(handle);
    stores.users.insert(row('x', { createdAt: 7 }));
    // A second store over the SAME handle sees the row (no per-store cache).
    expect(createSystemStores(handle).users.findById('x')?.createdAt).toBe(7);
    handle.close();
  });
});

describe('M20-B S2 user manager (first run, gate, creation)', () => {
  it('first run creates user #0 from the OS profile, idempotently', async () => {
    const { manager } = await memoryManager({ username: 'Alice', now: () => 1_700 });
    const first = manager.ensureFirstUser();
    expect(first?.id).toBe(FIRST_USER_ID);
    // The label keeps the OS spelling; the key is case-folded.
    expect(first?.label).toBe('Alice');
    expect(first?.osProfileKey).toBe('alice');
    expect(first?.createdAt).toBe(1_700);
    expect(first?.disabledAt).toBeNull();

    // One OS user ⇒ one app user: a second call returns the SAME row.
    expect(manager.ensureFirstUser()?.id).toBe(first?.id);
    expect(manager.list()).toHaveLength(1);
  });

  it('does not conjure a user for a profile the core does not know', async () => {
    // A core that already has users must NOT silently adopt whoever happens to
    // be logged in (Q2: creating a user is explicit and local).
    const fresh = createSystemStores(await openSystemDatabase({ location: ':memory:' }));
    fresh.users.insert(row('bob', { label: 'Bob' }));
    const manager = createUserManager({
      store: fresh.users,
      osProfileUsername: () => 'zed',
      now: () => 1,
    });

    expect(manager.ensureFirstUser()).toBeNull();
    expect(manager.list().map((u) => u.id)).toEqual(['bob']);
  });

  it('maps a returning OS profile to the user it already owns', async () => {
    const { manager } = await memoryManager({ username: 'alice' });
    const owner = manager.ensureFirstUser();
    expectOk(manager.create({ id: 'bob', label: 'Bob', osProfileKey: 'bob' }));

    expect(manager.ensureFirstUser()?.id).toBe(owner?.id);
    expect(manager.list().map((u) => u.id)).toEqual([FIRST_USER_ID, 'bob']);
  });

  it('refuses a duplicate id, a claimed profile and a non-partition id', async () => {
    const { manager } = await memoryManager({ username: 'alice' });
    manager.ensureFirstUser();

    expect(manager.create({ id: FIRST_USER_ID, label: 'again' })).toEqual({
      ok: false,
      reason: 'duplicate_id',
    });
    expectOk(manager.create({ id: 'bob', label: 'Bob', osProfileKey: 'BOB' }));
    // Case-folded: the same OS login cannot own a second app user.
    expect(manager.create({ id: 'bobby', label: 'Bobby', osProfileKey: 'bob' })).toEqual({
      ok: false,
      reason: 'duplicate_os_profile',
    });
    // An id that cannot be one partition directory name is refused up front.
    for (const bad of ['../evil', 'a/b', 'a\\b', '', '.', 'con']) {
      expect(manager.create({ id: bad, label: 'bad' }), bad).toEqual({
        ok: false,
        reason: 'invalid_id',
      });
    }
    expect(manager.list().map((u) => u.id)).toEqual([FIRST_USER_ID, 'bob']);
  });

  it('a disabled user refuses resolution while every row of theirs remains', async () => {
    const { manager } = await memoryManager();
    expectOk(manager.create({ id: 'bob', label: 'Bob' }));

    const refused = expectOk(manager.disable('bob'));
    expect(refused.user.disabledAt).toBeGreaterThan(0);
    expect(manager.resolve('bob')).toEqual({ ok: false, reason: 'disabled' });
    // Data retained: the row, its label and its profile mapping all survive.
    expect(manager.findById('bob')?.label).toBe('Bob');
    expect(manager.list().map((u) => u.id)).toContain('bob');
    expect(manager.resolve('ghost')).toEqual({ ok: false, reason: 'unknown_user' });

    const restored = expectOk(manager.enable('bob'));
    expect(restored.user.disabledAt).toBeNull();
    expect(manager.resolve('bob').ok).toBe(true);
  });

  it('disable and enable are idempotent and keep the first stamp', async () => {
    let clock = 100;
    const { manager } = await memoryManager({ now: () => clock });
    expectOk(manager.create({ id: 'bob', label: 'Bob' }));

    expect(expectOk(manager.disable('bob')).user.disabledAt).toBe(100);
    clock = 200;
    expect(expectOk(manager.disable('bob')).user.disabledAt).toBe(100);

    expectOk(manager.enable('bob'));
    expectOk(manager.enable('bob'));
    expect(manager.disable('ghost')).toEqual({ ok: false, reason: 'not_found' });
    expect(manager.enable('ghost')).toEqual({ ok: false, reason: 'not_found' });
  });
});
