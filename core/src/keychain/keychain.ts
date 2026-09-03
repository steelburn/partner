/**
 * Keychain surface: shared contract plus the two M0 factories.
 *
 *  - {@link createKeychainFake}  — in-memory (tests, DEMO_MODE).
 *  - {@link createKeychainNative} — OS keychain via @napi-rs/keyring (live).
 */
export type { Keychain } from '@partner/shared';
export { createKeychainFake } from './fake.js';
export { createKeychainNative, KEYCHAIN_SERVICE, keychainUnavailableError } from './native.js';
