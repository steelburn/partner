/**
 * M20-B S2 — OS-profile → app-user key (PLAN-M20-B.md §2, §2a).
 *
 * The key is what lets a single-user install keep today's experience: user #0
 * is created from the OS profile, and one OS user maps to exactly one app
 * user. These tests pin the derivation's stability (case- and whitespace-
 * insensitive, because Windows/macOS resolve `Alice` and `alice` to one
 * account) and the refusal of an empty login name, which would otherwise map
 * every profile onto one user.
 *
 * No filesystem and no OS account is touched: the pure derivation is tested
 * directly, and the machine's own profile is only read to prove that reading
 * it goes through the same normalization.
 */
import { describe, expect, it } from 'vitest';
import { createUserManager } from '../../src/users/manager.js';
import {
  currentOsProfileKey,
  currentOsProfileUsername,
  osProfileKey,
} from '../../src/users/osProfile.js';
import { createSystemStores } from '../../src/users/store.js';
import { openSystemDatabase } from '../../src/system/db.js';

describe('M20-B S2 osProfileKey', () => {
  it('is stable under case and surrounding whitespace', () => {
    expect(osProfileKey('Alice')).toBe('alice');
    expect(osProfileKey('ALICE')).toBe('alice');
    expect(osProfileKey('  alice\n')).toBe('alice');
    // Same key ⇒ same app user, whatever shape the OS hands the name over in.
    expect(osProfileKey('Alice')).toBe(osProfileKey('  ALICE '));
  });

  it('keeps the login name otherwise intact (no mangling of legal characters)', () => {
    expect(osProfileKey('jane.doe-1')).toBe('jane.doe-1');
    expect(osProfileKey('дом')).toBe('дом');
  });

  it('refuses an empty or non-string login name instead of returning an empty key', () => {
    expect(() => osProfileKey('')).toThrow(/empty login name/);
    expect(() => osProfileKey('   ')).toThrow(/empty login name/);
    expect(() => osProfileKey(undefined as unknown as string)).toThrow(/login name/);
  });

  it('derives the current profile through the same normalization', () => {
    const username = currentOsProfileUsername();
    expect(currentOsProfileKey()).toBe(osProfileKey(username));
    expect(currentOsProfileKey()).not.toBe('');
  });

  it('is injectable: a manager built with a fixed login name never reads the machine', async () => {
    const store = createSystemStores(await openSystemDatabase({ location: ':memory:' })).users;
    const manager = createUserManager({
      store,
      osProfileUsername: () => 'Injected User',
      now: () => 1,
    });

    const first = manager.ensureFirstUser();
    expect(first).not.toBeNull();
    // The injected login name is normalized by the SAME rule, so the seam
    // cannot introduce a second spelling of the key.
    expect(first?.osProfileKey).toBe('injected user');
    expect(first?.label).toBe('Injected User');
    // The machine's real profile cannot leak into the fixture.
    if (currentOsProfileKey() !== 'injected user') {
      expect(manager.list().map((u) => u.osProfileKey)).toEqual(['injected user']);
    }
  });
});
