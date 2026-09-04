/**
 * Resolver tests (PLAN-M1 "resolver"): picks the FIRST enabled provider by
 * creation order when any exist; null when none do. Full persona routing is
 * M3 — this stays a tiny, deterministic function.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase, createAuditStore, createProviderStore } from '../../src/stores/db.js';
import { createKeychainFake } from '../../src/keychain/keychain.js';
import { auditLog } from '../../src/services/redaction.js';
import { createProviderManager } from '../../src/providers/providerManager.js';
import { resolveChatProvider } from '../../src/gateway/resolver.js';

function makeManager() {
  const db = openDatabase(':memory:');
  const store = createProviderStore(db);
  const manager = createProviderManager({
    store,
    keychain: createKeychainFake(),
    audit: auditLog({ store: createAuditStore(db) }),
  });
  return manager;
}

describe('resolveChatProvider (M1)', () => {
  it('returns the first ENABLED provider by creation order', async () => {
    const manager = makeManager();
    const first = await manager.create({ name: 'first', endpoint: 'https://a.example/v1' });
    await manager.create({ name: 'second', endpoint: 'https://b.example/v1', enabled: false });
    const third = await manager.create({ name: 'third', endpoint: 'https://c.example/v1' });

    expect(resolveChatProvider(manager)?.id).toBe(first.id);
    // A requested model string is accepted but does not route in M1.
    expect(resolveChatProvider(manager, 'anything')?.id).toBe(first.id);
    expect(third.id).not.toBe(first.id);
  });

  it('skips disabled providers entirely', async () => {
    const manager = makeManager();
    await manager.create({ name: 'off1', endpoint: 'https://a.example/v1', enabled: false });
    const on = await manager.create({ name: 'on', endpoint: 'https://b.example/v1' });
    await manager.create({ name: 'off2', endpoint: 'https://c.example/v1', enabled: false });
    expect(resolveChatProvider(manager)?.id).toBe(on.id);
  });

  it('returns null when no provider exists or none are enabled', async () => {
    const manager = makeManager();
    expect(resolveChatProvider(manager)).toBeNull();
    await manager.create({ name: 'off', endpoint: 'https://a.example/v1', enabled: false });
    expect(resolveChatProvider(manager)).toBeNull();
  });
});
