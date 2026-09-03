/**
 * Safe localStorage wrapper.
 *
 * Backend is injected (see `setStorageBackend`) so the same logic is
 * unit-testable in Node; in the browser it defaults to window.localStorage.
 * All access is wrapped so a throwing/quota-full storage never crashes the
 * UI — callers degrade to "not persisted".
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

let backend: StorageLike | null = null;

/** Test seam: point storage at an in-memory fake. Pass null to reset. */
export function setStorageBackend(next: StorageLike | null): void {
  backend = next;
}

function current(): StorageLike | null {
  if (backend) return backend;
  if (typeof window !== 'undefined' && typeof window.localStorage === 'object') {
    return window.localStorage;
  }
  return null;
}

/** Read a key; returns null when missing, unavailable, or throwing. */
export function readLocal(key: string): string | null {
  try {
    return current()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** Write a key; returns false when storage is unavailable or throws. */
export function writeLocal(key: string, value: string): boolean {
  try {
    const store = current();
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Remove a key (no-op when storage is unavailable). */
export function removeLocal(key: string): void {
  try {
    current()?.removeItem(key);
  } catch {
    // Ignore — nothing useful to do if storage is unavailable.
  }
}
