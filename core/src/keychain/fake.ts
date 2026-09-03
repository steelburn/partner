/**
 * In-memory Keychain implementation for tests and DEMO_MODE.
 *
 * Implements the shared {@link Keychain} contract with no platform storage.
 * Keys are namespaced by `service \u0000 account` so two accounts never
 * collide.
 */
import type { Keychain } from '@partner/shared';

export function createKeychainFake(): Keychain {
  const secrets = new Map<string, string>();
  const keyFor = (service: string, account: string): string => `${service}\u0000${account}`;

  return {
    async get(service, account) {
      return secrets.get(keyFor(service, account)) ?? null;
    },
    async set(service, account, value) {
      secrets.set(keyFor(service, account), value);
    },
    async delete(service, account) {
      secrets.delete(keyFor(service, account));
    },
  };
}
