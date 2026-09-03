import { beforeEach, describe, expect, it } from 'vitest';
import { readLocal, removeLocal, setStorageBackend, writeLocal, type StorageLike } from '../src/lib/storage.js';
import { clearStoredToken, readStoredToken, storeToken, TOKEN_STORAGE_KEY } from '../src/lib/token.js';

function fakeStorage(): StorageLike {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

describe('storage', () => {
  beforeEach(() => {
    setStorageBackend(null);
  });

  it('degrades gracefully when no backend is available (node)', () => {
    expect(readLocal('a')).toBeNull();
    expect(writeLocal('a', '1')).toBe(false);
    expect(() => removeLocal('a')).not.toThrow();
  });

  it('round-trips through an injected backend', () => {
    const backend = fakeStorage();
    setStorageBackend(backend);
    expect(writeLocal('k', 'v')).toBe(true);
    expect(readLocal('k')).toBe('v');
    removeLocal('k');
    expect(readLocal('k')).toBeNull();
  });

  it('treats a throwing backend as unavailable instead of crashing', () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    setStorageBackend(throwing);
    expect(readLocal('k')).toBeNull();
    expect(writeLocal('k', 'v')).toBe(false);
    expect(() => removeLocal('k')).not.toThrow();
  });
});

describe('token persistence', () => {
  beforeEach(() => {
    setStorageBackend(fakeStorage());
  });

  it('stores and reads the pairing token under partner.token', () => {
    expect(storeToken('tok-abc')).toBe(true);
    expect(readStoredToken()).toBe('tok-abc');
    expect(readLocal(TOKEN_STORAGE_KEY)).toBe('tok-abc');
  });

  it('clears the token', () => {
    storeToken('tok-abc');
    clearStoredToken();
    expect(readStoredToken()).toBeNull();
  });

  it('refuses to store an empty token', () => {
    expect(storeToken('')).toBe(false);
    expect(readStoredToken()).toBeNull();
  });
});
