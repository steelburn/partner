/**
 * M22 — the auth-mode cache behind the "session expired" copy.
 *
 * The copy has to name the action the user will actually be offered: a hosted
 * core shows a sign-in gate, the desktop core shows the pairing ceremony. The
 * message lives in nine views that never fetch `/v1/health`, so `PairGate`
 * records the mode once and these helpers read it.
 *
 * The storage rule (PLAN-M20 §11) is that browser storage holds UI metadata and
 * the session token — never content. This key holds one word.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  AUTH_MODE_KEY,
  cachedAuthMode,
  rememberAuthMode,
  sessionLostAction,
  sessionLostSentence,
} from '../src/lib/auth-mode.js';
import { setStorageBackend } from '../src/lib/storage.js';

/** An in-memory backend, so nothing here depends on a DOM. */
function fakeStorage(): Map<string, string> {
  const map = new Map<string, string>();
  map.clear = () => map.clear();
  setStorageBackend({
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  });
  return map;
}

let storage: Map<string, string> | null = null;

afterEach(() => {
  storage = null;
  setStorageBackend(null);
});

describe('session-lost copy follows the core mode', () => {
  it('defaults to the pairing wording when nothing is cached', () => {
    storage = fakeStorage();
    expect(cachedAuthMode()).toBe('pairing');
    expect(sessionLostAction()).toBe('Pair again');
    expect(sessionLostSentence('manage roots')).toBe(
      'Your session with the Partner core has expired. Pair again to manage roots.',
    );
  });

  it('uses the sign-in wording once a login-mode core has been seen', () => {
    storage = fakeStorage();
    rememberAuthMode('login');
    expect(cachedAuthMode()).toBe('login');
    expect(sessionLostAction()).toBe('Sign in again');
    expect(sessionLostSentence('continue')).toBe(
      'Your session with the Partner core has expired. Sign in again to continue.',
    );
  });

  it('ignores an unrecognised stored value (older install, hand-edited storage)', () => {
    storage = fakeStorage();
    setStorageBackend({
      getItem: () => 'something-else',
      setItem: () => {},
      removeItem: () => {},
    });
    expect(cachedAuthMode()).toBe('pairing');
    expect(AUTH_MODE_KEY).toBe('partner.authMode');
  });
});
