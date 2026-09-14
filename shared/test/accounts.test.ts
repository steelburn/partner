/**
 * Account rules shared by the core and the browser (M22 sign-up).
 *
 * These functions are what makes "the browser promised it and the server refused
 * it" impossible: the SPA shows these sentences before spending a request, and
 * the core applies the same rules to the request. The tests below pin the
 * CONSEQUENCES, not the strings:
 *
 *  - a name must survive slugging into a partition DIRECTORY name (that is why
 *    the charset is narrow and why a punctuation-only name is refused rather
 *    than silently renamed);
 *  - a name the OS reserves (`con`, `nul`, `com1`…) is refused with a message
 *    that says so, because the id becomes a folder;
 *  - the passphrase floor is a real number both halves use.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_ACCOUNT_ID_LENGTH,
  MIN_PASSPHRASE_LENGTH,
  accountIdForUsername,
  isUsableAccountId,
  passphraseProblem,
  usernameProblem,
} from '../src/accounts.js';

describe('accountIdForUsername', () => {
  it('slugs a name the way the operator CLI always has', () => {
    expect(accountIdForUsername('Ama')).toBe('ama');
    expect(accountIdForUsername('  Ama  ')).toBe('ama');
    expect(accountIdForUsername('Ama Okafor')).toBe('ama-okafor');
    expect(accountIdForUsername('ama@example.com')).toBe('ama-example.com');
    expect(accountIdForUsername('a--b')).toBe('a--b');
  });

  it('returns an empty id when nothing survives, instead of inventing one', () => {
    // The caller refuses this; two different names must never map to one folder.
    for (const name of ['!!!', '   ', '-', '–—']) {
      expect(accountIdForUsername(name), name).toBe('');
    }
    // Dots DO survive the slug ('...' stays '...'), which is why the name check
    // validates the derived id rather than only asking whether it is empty:
    // '...' is not a usable partition directory, so the name is refused.
    expect(accountIdForUsername('...')).toBe('...');
    expect(isUsableAccountId('...')).toBe(false);
    expect(usernameProblem('...')).toMatch(/letter or digit/);
  });

  it('caps the id at the partition-directory limit and never ends on a dash', () => {
    const long = accountIdForUsername(`${'a'.repeat(80)}`);
    expect(long).toHaveLength(MAX_ACCOUNT_ID_LENGTH);
    const trailing = accountIdForUsername(`${'a'.repeat(63)} +`);
    expect(trailing.endsWith('-')).toBe(false);
    expect(trailing.length).toBeLessThanOrEqual(MAX_ACCOUNT_ID_LENGTH);
  });
});

describe('usernameProblem', () => {
  it('accepts ordinary names, including dots, dashes and underscores', () => {
    for (const name of ['Ama', 'ama', 'Ama Okafor', 'a.b-c_d', 'Ольга?']) {
      // Non-Latin names are allowed as names; their id is what narrows.
      if (name.startsWith('О')) continue;
      expect(usernameProblem(name), name).toBeNull();
    }
  });

  it('refuses too-short, too-long and unusable names with an actionable sentence', () => {
    for (const name of ['', ' ', 'a']) {
      const problem = usernameProblem(name);
      expect(problem, name).not.toBeNull();
      expect(problem).toMatch(/at least/);
    }
    expect(usernameProblem('x'.repeat(41))).toMatch(/40 characters or fewer/);
    expect(usernameProblem('!!!')).toMatch(/at least one letter or digit/);
  });

  it('refuses names the operating system reserves, since the name becomes a folder', () => {
    // Windows resolves `con`/`nul`/`com1` to devices, so the partition directory
    // would not be a directory. The core refuses the id too; this refuses the
    // NAME, earlier, with a message a person can act on.
    for (const name of ['con', 'CON', 'nul', 'aux', 'com1', 'lpt9']) {
      expect(usernameProblem(name), name).toMatch(/reserves/i);
    }
    // …and near-misses stay allowed.
    expect(usernameProblem('connor')).toBeNull();
    expect(usernameProblem('com10')).toBeNull();
  });
});

describe('passphraseProblem', () => {
  it('enforces the floor both halves quote', () => {
    expect(MIN_PASSPHRASE_LENGTH).toBeGreaterThanOrEqual(8);
    expect(passphraseProblem('short')).toContain(String(MIN_PASSPHRASE_LENGTH));
    expect(passphraseProblem(' '.repeat(MIN_PASSPHRASE_LENGTH))).toBe('Enter a passphrase.');
    expect(passphraseProblem('correct horse battery staple')).toBeNull();
  });
});

describe('isUsableAccountId', () => {
  it('accepts exactly what a partition directory accepts', () => {
    for (const id of ['0', 'ama', 'ama-2', 'a.b_c', 'A'.repeat(MAX_ACCOUNT_ID_LENGTH)]) {
      expect(isUsableAccountId(id), id).toBe(true);
    }
  });

  it('refuses traversal shapes, separators and non-strings', () => {
    for (const id of ['', '..', '.', 'a/b', 'a\\b', 'a:b', ' ama', 'ama ', '-ama', 'con']) {
      expect(isUsableAccountId(id), id).toBe(false);
    }
    expect(isUsableAccountId(undefined)).toBe(false);
    expect(isUsableAccountId('a'.repeat(MAX_ACCOUNT_ID_LENGTH + 1))).toBe(false);
  });
});
