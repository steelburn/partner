/**
 * Native OS-keychain Keychain implementation backed by `@napi-rs/keyring` v2.
 *
 * The v2 API surface used here is the synchronous {@link Entry} class:
 * `new Entry(service, account)` with `setPassword` / `getPassword`
 * (`null` when absent) / `deletePassword` (no-op boolean when absent).
 *
 * Platform caveats:
 *  - macOS: Keychain · Windows: DPAPI / Credential Manager.
 *  - Linux: libsecret (Secret Service) — requires a keyring daemon such as
 *    gnome-keyring or kwallet to be running. Without one, every operation
 *    throws, and we surface a clear, actionable error rather than a bare
 *    platform code.
 *
 * `Entry` is constructed lazily inside each operation so that
 * {@link createKeychainNative} itself never touches platform storage — callers
 * that only inspect the shape (tests, config wiring) are safe even when no
 * keyring daemon is present.
 */
import type { Keychain } from '@partner/shared';
import { Entry } from '@napi-rs/keyring';

/** Keyring service name used for every Partner secret. */
export const KEYCHAIN_SERVICE = 'partner';

/** Wrap any platform-storage failure in a single actionable error. */
export function keychainUnavailableError(cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `OS keychain unavailable: ${detail} — start a keyring daemon (Linux) or use demo mode`,
    { cause },
  );
}

export function createKeychainNative(): Keychain {
  return {
    async get(service, account) {
      try {
        return new Entry(service, account).getPassword();
      } catch (cause) {
        throw keychainUnavailableError(cause);
      }
    },
    async set(service, account, value) {
      try {
        new Entry(service, account).setPassword(value);
      } catch (cause) {
        throw keychainUnavailableError(cause);
      }
    },
    async delete(service, account) {
      try {
        // Returns false when the credential is absent — a no-op, not an error.
        new Entry(service, account).deletePassword();
      } catch (cause) {
        throw keychainUnavailableError(cause);
      }
    },
  };
}
